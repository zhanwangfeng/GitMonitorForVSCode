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
                await this.run(cfg, action.action, cb, () => this.viewDiff(cfg, action.path, action.staged));
                break;
            case 'ignore': {
                const pattern = await this.pickIgnorePattern(action.path);
                if (!pattern) { return; }
                await this.run(cfg, action.action, cb, () => this.gitService.ignoreFile(cfg.path, pattern));
                break;
            }
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

    /** 调用 VSCode 内置 diff editor 展示文件差异，返回 GitOpResult 供 run() 流程消费 */
    private async viewDiff(cfg: RepoConfig, file: string, staged: boolean): Promise<GitOpResult> {
        try {
            const pair = await this.gitService.getDiffPair(cfg.path, file);
            const fullPath = path.join(cfg.path, file);

            let leftContent: string | undefined;
            let rightContent: string | undefined;
            let rightIsWorkspaceFile = false;
            let title: string;

            if (staged) {
                // staged=true: 比较「HEAD」 vs 「暂存区 :0:」
                if (pair.head === undefined && pair.index === undefined) {
                    return { success: false, message: `无法读取 ${file} 的 HEAD 与暂存区版本` };
                }
                // 新增文件场景：HEAD 不存在，只有暂存区
                if (pair.head === undefined) {
                    leftContent = '';
                    rightContent = pair.index;
                    title = `${file} · (空) ↔ 暂存区（新增）`;
                } else if (pair.index === undefined) {
                    return { success: false, message: `暂存区中不存在 ${file}` };
                } else {
                    leftContent = pair.head;
                    rightContent = pair.index;
                    title = `${file} · HEAD ↔ 暂存区`;
                    if (leftContent === rightContent) {
                        return { success: true, message: `${file} 的暂存区内容与 HEAD 一致，无差异` };
                    }
                }
            } else {
                // staged=false: 比较「HEAD」 vs 「工作区文件」
                if (pair.head === undefined) {
                    // 新增未暂存文件（untracked 或新 add 前），直接打开
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
                    return { success: true, message: '已打开（新增文件）' };
                }
                leftContent = pair.head;
                rightIsWorkspaceFile = true;
                title = `${file} · HEAD ↔ 工作区`;
            }

            const baseName = path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_');
            const ts = Date.now();
            const leftUri = this.writeTmp(`gitmonitor_diff_${ts}_left_${baseName}`, leftContent || '');
            let rightUri: vscode.Uri;
            if (rightIsWorkspaceFile) {
                rightUri = vscode.Uri.file(fullPath);
            } else {
                rightUri = this.writeTmp(`gitmonitor_diff_${ts}_right_${baseName}`, rightContent || '');
            }
            // 在侧边列打开 diff editor，避免覆盖详情 webview panel
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: false,
            });
            return { success: true, message: '已打开差异视图' };
        } catch (e) {
            const msg = (e as Error).message;
            logger.error('viewDiff error', msg);
            return { success: false, message: `查看差异失败: ${msg}` };
        }
    }

    /** 写临时文件并返回 Uri */
    private writeTmp(suffix: string, content: string): vscode.Uri {
        const tmpFile = path.join(os.tmpdir(), suffix);
        fs.writeFileSync(tmpFile, content);
        return vscode.Uri.file(tmpFile);
    }

    /**
     * 弹出路径层级选择列表，让用户选择要忽略到哪一级。
     * 例如路径 a/b/c/d.txt 会列出：
     *   a/b/c/d.txt   (精确文件)
     *   a/b/c/        (目录)
     *   a/b/
     *   a/
     * 文件名也会额外提供 *.ext 形式的通配选项。
     * 返回选中的 pattern，取消则返回 undefined。
     */
    private async pickIgnorePattern(filePath: string): Promise<string | undefined> {
        const norm = filePath.replace(/\\/g, '/');
        const parts = norm.split('/').filter(Boolean);
        if (parts.length === 0) { return undefined; }

        const items: { label: string; description: string; pattern: string }[] = [];
        // 1. 精确文件路径
        items.push({
            label: norm,
            description: '精确文件',
            pattern: norm,
        });
        // 2. 文件名通配（如果是文件且带扩展名）
        const last = parts[parts.length - 1];
        const dotIdx = last.lastIndexOf('.');
        if (dotIdx > 0 && dotIdx < last.length - 1) {
            const ext = last.slice(dotIdx + 1);
            items.push({
                label: `*.${ext}`,
                description: '所有同扩展名文件',
                pattern: `*.${ext}`,
            });
        }
        // 3. 各级目录（从深到浅，目录形式以 / 结尾）
        for (let i = parts.length - 1; i >= 1; i--) {
            const dir = parts.slice(0, i).join('/') + '/';
            items.push({
                label: dir,
                description: `目录（共 ${i} 级）`,
                pattern: dir,
            });
        }
        // 4. 仅文件名
        items.push({
            label: last,
            description: '仅文件名（匹配任意目录下同名文件）',
            pattern: last,
        });

        const picked = await vscode.window.showQuickPick(
            items,
            {
                title: `添加到 .gitignore：${norm}`,
                placeHolder: '选择要忽略的路径层级',
            },
        );
        return picked?.pattern;
    }
}
