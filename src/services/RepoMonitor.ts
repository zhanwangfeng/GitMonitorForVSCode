import * as vscode from 'vscode';
import { ConfigStore } from './ConfigStore';
import { GitInfoService } from './GitInfoService';
import { logger } from '../utils/logger';
import { RepoConfig, RepoStatus } from '../models/types';

/** 状态变更事件 */
export interface StatusChangeEvent {
    repoId: string;
    status: RepoStatus | undefined;
}

/**
 * 仓库监控协调层：持有运行时状态缓存、对外暴露刷新与事件。
 * 依赖 ConfigStore（持久化配置）与 GitInfoService（纯 git 调用）。
 */
export class RepoMonitor {
    private readonly cache = new Map<string, RepoStatus>();
    private readonly _onDidChangeStatus = new vscode.EventEmitter<StatusChangeEvent>();
    readonly onDidChangeStatus = this._onDidChangeStatus.event;

    /** 单仓库刷新串行队列 */
    private readonly refreshLocks = new Map<string, Promise<void>>();

    constructor(
        private readonly configStore: ConfigStore,
        private readonly gitService: GitInfoService,
    ) { }

    dispose(): void {
        this._onDidChangeStatus.dispose();
    }

    /** 取最新缓存状态（未刷新过则返回 undefined） */
    getStatus(repoId: string): RepoStatus | undefined {
        return this.cache.get(repoId);
    }

    /** 监听状态变化 */
    subscribe(listener: (e: StatusChangeEvent) => void): vscode.Disposable {
        return this.onDidChangeStatus(listener);
    }

    /** 刷新单个仓库（串行，避免并发 git 进程过多） */
    async refresh(repoId: string): Promise<RepoStatus | undefined> {
        // 同仓库串行
        const existing = this.refreshLocks.get(repoId);
        if (existing) {
            await existing;
            return this.cache.get(repoId);
        }
        const p = this.doRefresh(repoId).finally(() => this.refreshLocks.delete(repoId));
        this.refreshLocks.set(repoId, p);
        await p;
        return this.cache.get(repoId);
    }

    private async doRefresh(repoId: string): Promise<void> {
        const cfg = this.configStore.get(repoId);
        if (!cfg) {
            this.cache.delete(repoId);
            this._onDidChangeStatus.fire({ repoId, status: undefined });
            return;
        }
        const status = await this.gitService.getStatus(repoId, cfg.path);
        this.cache.set(repoId, status);
        this._onDidChangeStatus.fire({ repoId, status });
        logger.info('refresh ok', cfg.alias || cfg.path,
            `branch=${status.branch} staged=${status.stagedCount} modified=${status.modifiedCount} untracked=${status.untrackedCount}`);
    }

    /** 全部刷新（带并发上限） */
    async refreshAll(): Promise<void> {
        const configs = this.configStore.list();
        const concurrency = this.getConcurrency();
        logger.info('refreshAll start', `count=${configs.length} concurrency=${concurrency}`);

        let cursor = 0;
        const workers: Promise<void>[] = [];
        const run = async (): Promise<void> => {
            while (cursor < configs.length) {
                const idx = cursor++;
                await this.refresh(configs[idx].id);
            }
        };
        for (let i = 0; i < Math.min(concurrency, configs.length); i++) {
            workers.push(run());
        }
        await Promise.all(workers);
        logger.info('refreshAll done');
    }

    /** 移除仓库状态（从监控列表移除时调用） */
    removeStatus(repoId: string): void {
        this.cache.delete(repoId);
        this._onDidChangeStatus.fire({ repoId, status: undefined });
    }

    private getConcurrency(): number {
        const cfg = vscode.workspace.getConfiguration('gitMonitor');
        const c = cfg.get<number>('refresh.concurrency', 4);
        return Math.max(1, Math.min(16, c));
    }

    /** 获取全部配置（便于外部读取） */
    listConfigs(): RepoConfig[] {
        return this.configStore.list();
    }

    getConfig(id: string): RepoConfig | undefined {
        return this.configStore.get(id);
    }
}
