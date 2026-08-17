import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitInfoService, GitOpResult, PullStrategy } from '../services/GitInfoService';
import { OperationHistory } from '../services/OperationHistory';
import { RepoMonitor } from '../services/RepoMonitor';
import { RepoConfig, WebviewAction } from '../models/types';
import { logger } from '../utils/logger';

/** 操作结果回调（用于通知 DetailPanel 刷新 UI） */
export interface GitOpsCallbacks {
    /** 操作开始：禁用按钮 */
    onBusy: (busy: boolean) => void;
    /** 操作完成：传递结果并触发刷新 */
    onDone: (result: GitOpResult, action: string) => void;
}

/**
 * 集中处理详情面板 Webview 发起的 Git 写操作。
 * 负责：危险操作二次确认、上游检测、调用 GitInfoService、记录操作历史。
 */
export class GitOpsController {

    constructor(
        private readonly gitService: GitInfoService,
        private readonly monitor: RepoMonitor,
        private readonly history: OperationHistory,
    ) { }

    /** 处理 Webview 写操作 action */
    async handle(action: WebviewAction, cfg: RepoConfig, cb: GitOpsCallbacks): Promise<void> {
        switch (action.action) {
            case 'stage':
                await this.run(cfg, action.action, cb, () => this.gitService.stageFile(cfg.path, action.path));
                break;
            case 'unstage':
                await this.run(cfg, action.action, cb, () => this.gitService.unstageFile(cfg.path, action.path));
                break;
            case 'stageAll':
                await this.run(cfg, action.action, cb, () => this.gitService.stageAll(cfg.path));
                break;
            case 'unstageAll':
                await this.run(cfg, action.action, cb, () => this.gitService.unstageAll(cfg.path));
                break;
            case 'commit': {
                const input = await this.promptCommit();
                if (!input) { return; }
                await this.run(cfg, action.action, cb, () => this.gitService.commit(cfg.path, input.message, input.amend));
                break;
            }
            case 'pull': {
                // 冲突预检查
                const conflicts = await this.gitService.getConflicts(cfg.path);
                if (conflicts.length > 0) {
                    cb.onDone({ success: false, message: '存在未解决冲突，请先解决后再拉取', conflicts }, action.action);
                    return;
                }
                const strategy = this.getPullStrategy();
                await this.run(cfg, action.action, cb, () => this.gitService.pull(cfg.path, strategy));
                break;
            }
            case 'push': {
                const hasUpstream = await this.gitService.hasUpstream(cfg.path);
                let setUpstream = false;
                if (!hasUpstream) {
                    const choice = await vscode.window.showWarningMessage(
                        '当前分支无上游分支。是否设置并推送到 origin？',
                        { modal: true },
                        '设置并推送',
                        '取消',
                    );
                    if (choice !== '设置并推送') { return; }
                    setUpstream = true;
                }
                const status = this.monitor.getStatus(cfg.id);
                const branch = status?.branch || '';
                await this.run(cfg, action.action, cb, () => this.gitService.push(cfg.path, branch, setUpstream));
                break;
            }
            case 'fetch':
                await this.run(cfg, action.action, cb, () => this.gitService.fetch(cfg.path));
                break;
            case 'checkout':
                await this.run(cfg, action.action, cb, () => this.gitService.checkout(cfg.path, action.branch));
                break;
            case 'createBranch': {
                const name = await vscode.window.showInputBox({
                    prompt: '输入新分支名',
                    placeHolder: 'feature/xxx',
                    validateInput: v => v.trim() ? '' : '分支名不能为空',
                });
                if (!name) { return; }
                await this.run(cfg, action.action, cb, () => this.gitService.createBranch(cfg.path, name, action.from));
                break;
            }
            case 'deleteBranch': {
                // 二次确认
                const confirmDangerous = this.shouldConfirm();
                if (confirmDangerous) {
                    const choice = await vscode.window.showWarningMessage(
                        `确定删除分支「${action.branch}」吗？`,
                        { modal: true },
                        '安全删除',
                    );
                    if (choice !== '安全删除') { return; }
                }
                // 先尝试安全删除
                let result = await this.gitService.deleteBranch(cfg.path, action.branch, false);
                if (!result.success && /not fully merged|contains commits/i.test(result.message)) {
                    // 含未合并提交，询问是否强制
                    const forceChoice = await vscode.window.showWarningMessage(
                        `分支「${action.branch}」包含未合并提交，是否强制删除？`,
                        { modal: true },
                        '强制删除',
                        '取消',
                    );
                    if (forceChoice === '强制删除') {
                        result = await this.gitService.deleteBranch(cfg.path, action.branch, true);
                    }
                }
                await this.runWithResult(cfg, action.action, cb, result);
                break;
            }
            case 'stash': {
                const message = await vscode.window.showInputBox({
                    prompt: '暂存说明（可选）',
                    placeHolder: 'WIP: ...',
                });
                await this.run(cfg, action.action, cb, () => this.gitService.stash(cfg.path, message || undefined));
                break;
            }
            case 'stashPop':
                await this.run(cfg, action.action, cb, () => this.gitService.stashPop(cfg.path, action.index));
                break;
            case 'stashDrop': {
                if (this.shouldConfirm()) {
                    const choice = await vscode.window.showWarningMessage(
                        `确定丢弃 stash@{${action.index}} 吗？此操作不可恢复。`,
                        { modal: true },
                        '丢弃',
                    );
                    if (choice !== '丢弃') { return; }
                }
                await this.run(cfg, action.action, cb, () => this.gitService.stashDrop(cfg.path, action.index));
                break;
            }
            case 'merge': {
                const branches = (await this.gitService.getBranches(cfg.path)).local.filter(b => !b.startsWith('*'));
                if (branches.length === 0) {
                    cb.onDone({ success: false, message: '没有可合并的本地分支' }, action.action);
                    return;
                }
                const picked = await vscode.window.showQuickPick(branches, {
                    title: `选择合并到当前分支的源分支`,
                    placeHolder: '选择分支',
                });
                if (!picked) { return; }
                await this.run(cfg, action.action, cb, () => this.gitService.merge(cfg.path, picked));
                break;
            }
            case 'discard': {
                if (this.shouldConfirm()) {
                    const choice = await vscode.window.showWarningMessage(
                        `确定撤销「${action.path}」的修改吗？此操作不可恢复。`,
                        { modal: true },
                        '撤销',
                    );
                    if (choice !== '撤销') { return; }
                }
                await this.run(cfg, action.action, cb, () => this.gitService.discardFile(cfg.path, action.path));
                break;
            }
            case 'viewDiff':
                await this.viewDiff(cfg, action.path, action.staged);
                break;
            case 'createTag': {
                const name = await vscode.window.showInputBox({
                    prompt: '输入标签名',
                    placeHolder: 'v1.0.0',
                    validateInput: v => v.trim() ? '' : '标签名不能为空',
                });
                if (!name) { return; }
                const message = await vscode.window.showInputBox({
                    prompt: '注解信息（可选，留空则创建轻量标签）',
                    placeHolder: 'release v1.0.0',
                });
                await this.run(cfg, action.action, cb, () => this.gitService.createTag(cfg.path, name, message || undefined, action.commit));
                break;
            }
            case 'deleteTag': {
                if (this.shouldConfirm()) {
                    const choice = await vscode.window.showWarningMessage(
                        `确定删除标签「${action.name}」吗？`,
                        { modal: true },
                        '删除',
                    );
                    if (choice !== '删除') { return; }
                }
                await this.run(cfg, action.action, cb, () => this.gitService.deleteTag(cfg.path, action.name));
                break;
            }
            default:
                // 非写操作 action（refresh/openIn* 等）由调用方处理
                break;
        }
    }

    /** 通用执行：禁用按钮 → 执行 → 记录历史 → 刷新状态 → 反馈结果 */
    private async run(
        cfg: RepoConfig,
        actionName: string,
        cb: GitOpsCallbacks,
        executor: () => Promise<GitOpResult>,
    ): Promise<void> {
        cb.onBusy(true);
        const op = this.history.start(cfg.id, actionName);
        try {
            const result = await executor();
            this.history.finish(cfg.id, op.startedAt, result.success, result.message);
            // 操作后刷新该仓库状态（确保列表与详情同步）
            await this.monitor.refresh(cfg.id);
            cb.onDone(result, actionName);
        } catch (e) {
            const msg = (e as Error).message;
            this.history.finish(cfg.id, op.startedAt, false, msg);
            logger.error('gitOps error', cfg.id, actionName, msg);
            cb.onDone({ success: false, message: `操作异常: ${msg}` }, actionName);
        } finally {
            cb.onBusy(false);
        }
    }

    /** 直接使用已有结果（如 deleteBranch 的两阶段流程） */
    private async runWithResult(
        cfg: RepoConfig,
        actionName: string,
        cb: GitOpsCallbacks,
        result: GitOpResult,
    ): Promise<void> {
        const op = this.history.start(cfg.id, actionName);
        this.history.finish(cfg.id, op.startedAt, result.success, result.message);
        await this.monitor.refresh(cfg.id);
        cb.onDone(result, actionName);
    }

    /** 弹出提交输入框 */
    private async promptCommit(): Promise<{ message: string; amend: boolean } | undefined> {
        const message = await vscode.window.showInputBox({
            prompt: '提交信息',
            placeHolder: 'feat: ...',
            validateInput: v => v.trim() ? '' : '提交信息不能为空',
        });
        if (message === undefined) { return undefined; }
        const amend = await vscode.window.showQuickPick(
            [{ label: '否', value: false }, { label: '是（修补上次提交）', value: true }],
            { title: '是否 amend 上次提交？', placeHolder: '否' },
        );
        return { message, amend: amend?.value ?? false };
    }

    /** 拉取策略 */
    private getPullStrategy(): PullStrategy {
        const v = vscode.workspace.getConfiguration('gitMonitor')
            .get<string>('operations.pullStrategy', 'ff-only');
        if (v === 'merge' || v === 'rebase') { return v; }
        return 'ff-only';
    }

    /** 是否对危险操作二次确认 */
    private shouldConfirm(): boolean {
        return vscode.workspace.getConfiguration('gitMonitor')
            .get<boolean>('operations.confirmDangerous', true);
    }

    /** 调用 VSCode 内置 diff editor 展示文件差异 */
    private async viewDiff(cfg: RepoConfig, file: string, staged: boolean): Promise<void> {
        const fullPath = path.join(cfg.path, file);
        const modifiedUri = vscode.Uri.file(fullPath);

        const r = await this.gitService.getDiffContent(cfg.path, file, staged);
        if (!r) {
            // 文件可能是新增的，没有 base 版本，直接打开
            await vscode.commands.executeCommand('vscode.open', modifiedUri);
            return;
        }

        // 写入临时文件作为 base
        const tmpFile = path.join(os.tmpdir(), `gitmonitor_diff_${Date.now()}_${path.basename(file)}`);
        try {
            fs.writeFileSync(tmpFile, r.left);
            const baseUri = vscode.Uri.file(tmpFile);
            const title = `${file} · ${staged ? '暂存区 vs HEAD' : '工作区 vs HEAD'}`;
            await vscode.commands.executeCommand('vscode.diff', baseUri, modifiedUri, title);
        } catch (e) {
            logger.error('viewDiff error', (e as Error).message);
            vscode.window.showErrorMessage(`查看差异失败: ${(e as Error).message}`);
        }
    }
}
