import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { RepoMonitor } from '../services/RepoMonitor';
import { RepoTreeProvider } from '../views/RepoTreeProvider';
import { RepoTreeItem } from '../views/RepoTreeItem';
import { logger } from '../utils/logger';

/**
 * 「移除监控」命令：从配置与缓存中移除，不影响本地文件。
 * 支持从右键菜单触发（传入 RepoTreeItem）或命令面板触发（弹选择）。
 */
export function createRemoveRepoCommand(
    configStore: ConfigStore,
    monitor: RepoMonitor,
    provider: RepoTreeProvider,
): (item?: RepoTreeItem) => Promise<void> {
    return async (item?: RepoTreeItem) => {
        const cfg = item?.config ?? await pickRepo(configStore);
        if (!cfg) { return; }

        const name = cfg.alias || cfg.path.split(/[\\/]/).pop() || cfg.path;
        const confirm = await vscode.window.showWarningMessage(
            `确定从监控列表移除「${name}」吗？\n（不会删除本地目录文件）`,
            { modal: true },
            '移除',
        );
        if (confirm !== '移除') { return; }

        configStore.remove(cfg.id);
        monitor.removeStatus(cfg.id);
        provider.notifyConfigChanged();
        vscode.window.showInformationMessage(`已移除监控: ${name}`);
        logger.info('removeRepo command done', cfg.id);
    };
}

/** 命令面板触发时让用户从列表中选择一个仓库 */
async function pickRepo(configStore: ConfigStore) {
    const list = configStore.list();
    if (list.length === 0) {
        vscode.window.showInformationMessage('监控列表为空');
        return undefined;
    }
    const items = list.map(c => ({
        label: c.alias || c.path.split(/[\\/]/).pop() || c.path,
        description: c.path,
        config: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: '选择要移除的仓库',
        placeHolder: '选择一个仓库',
    });
    return picked?.config;
}
