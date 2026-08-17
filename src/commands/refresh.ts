import * as vscode from 'vscode';
import { RepoMonitor } from '../services/RepoMonitor';
import { RepoTreeProvider } from '../views/RepoTreeProvider';
import { RepoTreeItem } from '../views/RepoTreeItem';
import { logger } from '../utils/logger';

/** 「全部刷新」命令 */
export function createRefreshAllCommand(
    monitor: RepoMonitor,
    provider: RepoTreeProvider,
): () => Promise<void> {
    return async () => {
        logger.info('refreshAll command start');
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Git Monitor: 正在刷新全部仓库…' },
            () => monitor.refreshAll().then(() => provider.refresh()),
        );
    };
}

/** 「刷新该仓库」命令 */
export function createRefreshRepoCommand(
    monitor: RepoMonitor,
    provider: RepoTreeProvider,
): (item?: RepoTreeItem) => Promise<void> {
    return async (item?: RepoTreeItem) => {
        if (!item?.config) { return; }
        logger.info('refreshRepo command start', item.config.id);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Git Monitor: 刷新 ${item.config.alias || item.config.path}` },
            () => monitor.refresh(item.config.id).then(() => provider.refresh()),
        );
    };
}
