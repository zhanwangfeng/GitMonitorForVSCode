import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { RepoMonitor } from '../services/RepoMonitor';
import { RepoTreeItem } from './RepoTreeItem';
import { RepoConfig } from '../models/types';

/**
 * 侧边栏仓库列表数据提供者。
 * 监听 ConfigStore 变更与 RepoMonitor 状态事件，触发视图刷新。
 */
export class RepoTreeProvider implements vscode.TreeDataProvider<RepoTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<RepoTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** 配置变更（增删）时整体刷新 */
    private configVersion = 0;

    constructor(
        private readonly configStore: ConfigStore,
        private readonly monitor: RepoMonitor,
    ) {
        // 监听状态变化：仅更新对应条目
        this.monitor.onDidChangeStatus(e => {
            // 整体刷新树以保证顺序与计数一致（成本可接受）
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    /** 配置发生增删后由命令层调用 */
    notifyConfigChanged(): void {
        this.configVersion++;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: RepoTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: RepoTreeItem): Promise<RepoTreeItem[]> {
        if (element) { return []; }
        const configs: RepoConfig[] = this.configStore.list();
        if (configs.length === 0) { return []; }
        return configs.map(cfg => new RepoTreeItem(cfg, this.monitor.getStatus(cfg.id)));
    }

    /** 触发整个树刷新 */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }
}
