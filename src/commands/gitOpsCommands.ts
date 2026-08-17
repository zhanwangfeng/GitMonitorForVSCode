import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { GitInfoService } from '../services/GitInfoService';
import { GitOpsController, GitOpsCallbacks } from './gitOps';
import { DetailPanel } from '../panels/DetailPanel';
import { RepoTreeItem } from '../views/RepoTreeItem';
import { RepoConfig, WebviewAction } from '../models/types';
import { gitRun } from '../utils/gitRunner';

export interface GitOpCommandDef {
    id: string;
    handler: (item?: RepoTreeItem) => Promise<void>;
}

/**
 * 为右键菜单与命令面板创建 Git 写操作命令包装器。
 * 这些命令作用于「选中仓库」或「当前详情面板显示的仓库」。
 *
 * 命令通过 GitOpsController 执行（与 Webview 消息复用同一套逻辑），
 * 区别仅在交互入口：右键菜单需要先弹出输入框，再构造 WebviewAction 交给 controller。
 */
export function createGitOpCommands(
    configStore: ConfigStore,
    gitService: GitInfoService,
    controller: GitOpsController,
    cb: GitOpsCallbacks,
    panel: DetailPanel,
): GitOpCommandDef[] {

    /** 从入参解析目标仓库：优先 RepoTreeItem，其次详情面板当前仓库，最后让用户选 */
    const resolveRepo = async (item?: RepoTreeItem): Promise<RepoConfig | undefined> => {
        if (item?.config) { return item.config; }
        if (panel.currentRepoId) {
            const cfg = configStore.get(panel.currentRepoId);
            if (cfg) { return cfg; }
        }
        return await pickRepo(configStore);
    };

    /** 通过 controller 执行 action */
    const run = async (cfg: RepoConfig, action: WebviewAction): Promise<void> => {
        await controller.handle(action, cfg, cb);
        // 操作完成后若详情面板正显示该仓库，刷新它
        if (panel.currentRepoId === cfg.id) {
            await panel.reload();
        }
    };

    return [
        {
            id: 'gitMonitor.stageFile',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const file = await pickFile(cfg, '选择要暂存的文件');
                if (!file) { return; }
                await run(cfg, { action: 'stage', path: file });
            },
        },
        {
            id: 'gitMonitor.unstageFile',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const file = await pickFile(cfg, '选择要取消暂存的文件');
                if (!file) { return; }
                await run(cfg, { action: 'unstage', path: file });
            },
        },
        {
            id: 'gitMonitor.stageAll',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                await run(cfg, { action: 'stageAll' });
            },
        },
        {
            id: 'gitMonitor.unstageAll',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                await run(cfg, { action: 'unstageAll' });
            },
        },
        {
            id: 'gitMonitor.commit',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const message = await vscode.window.showInputBox({
                    prompt: '提交信息',
                    placeHolder: 'feat: ...',
                    validateInput: v => v.trim() ? '' : '提交信息不能为空',
                });
                if (message === undefined) { return; }
                await run(cfg, { action: 'commit', message });
            },
        },
        {
            id: 'gitMonitor.pull',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                await run(cfg, { action: 'pull' });
            },
        },
        {
            id: 'gitMonitor.push',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                await run(cfg, { action: 'push' });
            },
        },
        {
            id: 'gitMonitor.fetch',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                await run(cfg, { action: 'fetch' });
            },
        },
        {
            id: 'gitMonitor.checkoutBranch',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const branches = await gitService.getBranches(cfg.path);
                const current = branches.local.find(b => b.startsWith('*'))?.replace(/^\*/, '').trim() ?? '';
                const all = [
                    ...branches.local.map(b => b.replace(/^\*/, '').trim()).filter(b => b !== current),
                    ...branches.remote,
                ];
                if (all.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有可切换的分支');
                    return;
                }
                const picked = await vscode.window.showQuickPick(all, { title: '选择要切换的分支' });
                if (!picked) { return; }
                await run(cfg, { action: 'checkout', branch: picked });
            },
        },
        {
            id: 'gitMonitor.createBranch',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const name = await vscode.window.showInputBox({
                    prompt: '新分支名',
                    placeHolder: 'feature/xxx',
                    validateInput: v => v.trim() ? '' : '分支名不能为空',
                });
                if (!name) { return; }
                await run(cfg, { action: 'createBranch', name });
            },
        },
        {
            id: 'gitMonitor.deleteBranch',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const branches = await gitService.getBranches(cfg.path);
                const current = branches.local.find(b => b.startsWith('*'))?.replace(/^\*/, '').trim() ?? '';
                const local = branches.local.map(b => b.replace(/^\*/, '').trim()).filter(b => b !== current);
                if (local.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有可删除的本地分支');
                    return;
                }
                const picked = await vscode.window.showQuickPick(local, { title: '选择要删除的分支' });
                if (!picked) { return; }
                await run(cfg, { action: 'deleteBranch', branch: picked });
            },
        },
        {
            id: 'gitMonitor.stash',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const message = await vscode.window.showInputBox({
                    prompt: '暂存说明（可选）',
                    placeHolder: 'WIP: ...',
                });
                await run(cfg, { action: 'stash', message: message || undefined });
            },
        },
        {
            id: 'gitMonitor.stashPop',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const stashes = await gitService.getStashes(cfg.path);
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有 stash 条目');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: `stash@{${s.index}}`, description: s.message, index: s.index })),
                    { title: '选择要恢复的 stash' },
                );
                if (!picked) { return; }
                await run(cfg, { action: 'stashPop', index: picked.index });
            },
        },
        {
            id: 'gitMonitor.stashDrop',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const stashes = await gitService.getStashes(cfg.path);
                if (stashes.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有 stash 条目');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    stashes.map(s => ({ label: `stash@{${s.index}}`, description: s.message, index: s.index })),
                    { title: '选择要丢弃的 stash' },
                );
                if (!picked) { return; }
                await run(cfg, { action: 'stashDrop', index: picked.index });
            },
        },
        {
            id: 'gitMonitor.merge',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const branches = await gitService.getBranches(cfg.path);
                const current = branches.local.find(b => b.startsWith('*'))?.replace(/^\*/, '').trim() ?? '';
                const local = branches.local.map(b => b.replace(/^\*/, '').trim()).filter(b => b !== current);
                if (local.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有可合并的本地分支');
                    return;
                }
                const picked = await vscode.window.showQuickPick(local, { title: '选择要合并到当前分支的源分支' });
                if (!picked) { return; }
                await run(cfg, { action: 'merge', branch: picked });
            },
        },
        {
            id: 'gitMonitor.discardFile',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const file = await pickFile(cfg, '选择要撤销修改的文件');
                if (!file) { return; }
                await run(cfg, { action: 'discard', path: file });
            },
        },
        {
            id: 'gitMonitor.viewDiff',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const file = await pickFile(cfg, '选择要查看差异的文件');
                if (!file) { return; }
                await run(cfg, { action: 'viewDiff', path: file, staged: false });
            },
        },
        {
            id: 'gitMonitor.createTag',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const name = await vscode.window.showInputBox({
                    prompt: '标签名',
                    placeHolder: 'v1.0.0',
                    validateInput: v => v.trim() ? '' : '标签名不能为空',
                });
                if (!name) { return; }
                const message = await vscode.window.showInputBox({
                    prompt: '注解信息（可选，留空则创建轻量标签）',
                    placeHolder: 'release v1.0.0',
                });
                await run(cfg, { action: 'createTag', name, message: message || undefined });
            },
        },
        {
            id: 'gitMonitor.deleteTag',
            handler: async (item) => {
                const cfg = await resolveRepo(item);
                if (!cfg) { return; }
                const tags = await gitService.getTags(cfg.path);
                if (tags.length === 0) {
                    vscode.window.showInformationMessage('Git Monitor: 没有标签');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    tags.map(t => ({ label: t.name, description: t.commit })),
                    { title: '选择要删除的标签' },
                );
                if (!picked) { return; }
                await run(cfg, { action: 'deleteTag', name: picked.label });
            },
        },
    ];
}

/** 命令面板触发时让用户从列表中选择一个仓库 */
async function pickRepo(configStore: ConfigStore): Promise<RepoConfig | undefined> {
    const list = configStore.list();
    if (list.length === 0) {
        vscode.window.showInformationMessage('Git Monitor: 监控列表为空');
        return undefined;
    }
    const items = list.map(c => ({
        label: c.alias || c.path.split(/[\\/]/).pop() || c.path,
        description: c.path,
        config: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: '选择仓库',
        placeHolder: '选择一个仓库',
    });
    return picked?.config;
}

/** 从仓库文件变更中选择一个文件 */
async function pickFile(cfg: RepoConfig, title: string): Promise<string | undefined> {
    const r = await gitRun(['status', '--porcelain=v1'], { cwd: cfg.path });
    if (r.exitCode !== 0 || !r.stdout.trim()) {
        vscode.window.showInformationMessage('Git Monitor: 没有文件变更');
        return undefined;
    }
    const files = r.stdout.split('\n').filter(Boolean).map(l => l.slice(3));
    const picked = await vscode.window.showQuickPick(files, { title });
    return picked;
}
