import * as vscode from 'vscode';
import { DetailPanel } from '../panels/DetailPanel';
import { RepoTreeItem } from '../views/RepoTreeItem';
import { logger } from '../utils/logger';

/**
 * 「打开详情」命令：点击列表条目或右键触发，打开/聚焦 Webview 详情面板。
 */
export function createOpenDetailCommand(
    panel: DetailPanel,
): (item?: RepoTreeItem | string) => Promise<void> {
    return async (item?: RepoTreeItem | string) => {
        let repoId: string | undefined;
        if (typeof item === 'string') {
            repoId = item;
        } else if (item?.config?.id) {
            repoId = item.config.id;
        }
        if (!repoId) {
            logger.warn('openDetail called without repoId');
            return;
        }
        logger.info('openDetail command', repoId);
        await panel.reveal(repoId);
    };
}
