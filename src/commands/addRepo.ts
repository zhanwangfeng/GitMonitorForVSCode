import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { RepoMonitor } from '../services/RepoMonitor';
import { RepoTreeProvider } from '../views/RepoTreeProvider';
import { isGitRepo } from '../utils/gitRunner';
import { logger } from '../utils/logger';

/**
 * 「添加目录」命令：选择目录 → 校验 Git 仓库 → 查重 → 写入配置 → 触发刷新。
 */
export function createAddRepoCommand(
    configStore: ConfigStore,
    monitor: RepoMonitor,
    provider: RepoTreeProvider,
): () => Promise<void> {
    return async () => {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: '选择一个 Git 仓库目录',
            openLabel: '添加为监控目录',
        });
        if (!uri || uri.length === 0) { return; }
        const dir = uri[0].fsPath;

        const repoOk = await isGitRepo(dir);
        if (!repoOk) {
            const choice = await vscode.window.showWarningMessage(
                `所选目录不是 Git 仓库：\n${dir}`,
                '仍然添加',
                '取消',
            );
            if (choice !== '仍然添加') { return; }
        }

        if (configStore.findByPath(dir)) {
            vscode.window.showInformationMessage('该目录已在监控列表中');
            return;
        }

        const alias = await vscode.window.showInputBox({
            prompt: '为该仓库设置别名（可选，留空使用目录名）',
            placeHolder: '可选别名',
        });

        const cfg = configStore.add(dir, alias);
        provider.notifyConfigChanged();
        vscode.window.showInformationMessage(`已添加仓库: ${cfg.alias || dir}`);
        logger.info('addRepo command done', cfg.id);

        // 立即触发该仓库状态刷新
        void monitor.refresh(cfg.id).then(() => provider.refresh());
    };
}
