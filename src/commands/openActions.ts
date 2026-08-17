import * as vscode from 'vscode';
import { RepoTreeItem } from '../views/RepoTreeItem';

/** 「在资源管理器中打开」命令 */
export function createOpenInExplorerCommand(): (item?: RepoTreeItem) => Promise<void> {
    return async (item?: RepoTreeItem) => {
        const dir = item?.config?.path;
        if (!dir) { return; }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    };
}

/** 「在终端中打开」命令 */
export function createOpenInTerminalCommand(): (item?: RepoTreeItem) => Promise<void> {
    return async (item?: RepoTreeItem) => {
        const dir = item?.config?.path;
        if (!dir) { return; }
        const term = vscode.window.createTerminal({
            name: `Git Monitor: ${item!.config.alias || dir}`,
            cwd: dir,
        });
        term.show();
    };
}

/** 「在新窗口中打开」命令 */
export function createOpenInNewWindowCommand(): (item?: RepoTreeItem) => Promise<void> {
    return async (item?: RepoTreeItem) => {
        const dir = item?.config?.path;
        if (!dir) { return; }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), true);
    };
}

/** 「打开设置」命令 */
export function createOpenSettingsCommand(): () => void {
    return () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:gitmonitor-for-vscode');
    };
}
