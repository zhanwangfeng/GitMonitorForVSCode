import * as vscode from 'vscode';
import { ConfigStore } from './services/ConfigStore';
import { GitInfoService } from './services/GitInfoService';
import { RepoMonitor } from './services/RepoMonitor';
import { RefreshScheduler } from './services/RefreshScheduler';
import { RepoTreeProvider } from './views/RepoTreeProvider';
import { DetailPanel } from './panels/DetailPanel';
import { createAddRepoCommand } from './commands/addRepo';
import { createRemoveRepoCommand } from './commands/removeRepo';
import { createRefreshAllCommand, createRefreshRepoCommand } from './commands/refresh';
import { createOpenDetailCommand } from './commands/openDetail';
import {
    createOpenInExplorerCommand, createOpenInTerminalCommand,
    createOpenInNewWindowCommand, createOpenSettingsCommand,
} from './commands/openActions';
import { detectGit } from './utils/gitRunner';
import { logger } from './utils/logger';

let monitor: RepoMonitor | undefined;
let scheduler: RefreshScheduler | undefined;
let detailPanel: DetailPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('activating Git Monitor');

    // 启动时探测 git 是否可用
    const gitVersion = await detectGit();
    if (!gitVersion) {
        const action = await vscode.window.showErrorMessage(
            'Git Monitor: 未检测到 git 可执行文件。请在设置中配置 "gitMonitor.git.executablePath"，或确保 git 已加入 PATH。',
            '打开设置',
        );
        if (action === '打开设置') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'gitMonitor.git.executablePath');
        }
        logger.error('git not detected, extension will still load but commands may fail');
    } else {
        logger.info('git detected', gitVersion);
    }

    // 组装服务
    const configStore = new ConfigStore(context);
    const gitService = new GitInfoService();
    monitor = new RepoMonitor(configStore, gitService);
    scheduler = new RefreshScheduler(monitor);
    detailPanel = new DetailPanel(configStore, monitor, gitService, context.extensionUri);

    // 注册视图
    const provider = new RepoTreeProvider(configStore, monitor);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('gitMonitor.repoList', provider),
    );

    // 注册命令
    const register = <T extends (...args: any[]) => any>(id: string, handler: T): void => {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    };

    register('gitMonitor.addRepo', createAddRepoCommand(configStore, monitor, provider));
    register('gitMonitor.refreshAll', createRefreshAllCommand(monitor, provider));
    register('gitMonitor.refreshRepo', createRefreshRepoCommand(monitor, provider));
    register('gitMonitor.removeRepo', createRemoveRepoCommand(configStore, monitor, provider));
    register('gitMonitor.openDetail', createOpenDetailCommand(detailPanel));
    register('gitMonitor.openInExplorer', createOpenInExplorerCommand());
    register('gitMonitor.openInTerminal', createOpenInTerminalCommand());
    register('gitMonitor.openInNewWindow', createOpenInNewWindowCommand());
    register('gitMonitor.openSettings', createOpenSettingsCommand());

    // 监听状态变化 → 同步刷新详情面板（若正在显示该仓库）
    context.subscriptions.push(
        monitor.onDidChangeStatus(e => {
            if (detailPanel && e.repoId === detailPanel.currentRepoId) {
                void detailPanel.reload();
            }
        }),
    );

    // 启动调度器
    scheduler.start();
    context.subscriptions.push({ dispose: () => scheduler?.dispose() });

    // 启动时若已有配置，做一次后台刷新
    if (configStore.list().length > 0) {
        void monitor.refreshAll().then(() => {
            provider.refresh();
            logger.info('startup refresh done');
        });
    }

    context.subscriptions.push({ dispose: () => monitor?.dispose() });
    context.subscriptions.push({ dispose: () => detailPanel?.dispose() });

    logger.info('Git Monitor activated');
}

export function deactivate(): void {
    monitor?.dispose();
    scheduler?.dispose();
    detailPanel?.dispose();
    logger.info('Git Monitor deactivated');
}
