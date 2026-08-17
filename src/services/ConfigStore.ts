import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { RepoConfig } from '../models/types';
import { logger } from '../utils/logger';

const STATE_KEY_REPOS = 'gitMonitor.repos';

/**
 * 持久化仓库列表。使用 context.globalState 跨工作区共享。
 */
export class ConfigStore {
    constructor(private readonly context: vscode.ExtensionContext) { }

    /** 读取全部仓库配置（按添加时间升序） */
    list(): RepoConfig[] {
        const arr = this.context.globalState.get<RepoConfig[]>(STATE_KEY_REPOS, []);
        return [...arr].sort((a, b) => a.addedAt - b.addedAt);
    }

    /** 根据 id 获取单个配置 */
    get(id: string): RepoConfig | undefined {
        return this.list().find(r => r.id === id);
    }

    /** 按路径查重 */
    findByPath(absPath: string): RepoConfig | undefined {
        return this.list().find(r => r.path === absPath);
    }

    /**
     * 新增仓库配置。返回新配置；若路径已存在则返回 undefined。
     */
    add(absPath: string, alias?: string): RepoConfig {
        const existing = this.findByPath(absPath);
        if (existing) {
            logger.warn('addRepo skipped, path already exists', absPath);
            return existing;
        }
        const config: RepoConfig = {
            id: crypto.randomUUID(),
            path: absPath,
            alias: alias?.trim() || undefined,
            addedAt: Date.now(),
            autoRefresh: true,
        };
        const list = this.list();
        list.push(config);
        void this.context.globalState.update(STATE_KEY_REPOS, list);
        logger.info('addRepo ok', config.id, config.path);
        return config;
    }

    /** 移除仓库配置 */
    remove(id: string): boolean {
        const list = this.list();
        const next = list.filter(r => r.id !== id);
        if (next.length === list.length) {
            return false;
        }
        void this.context.globalState.update(STATE_KEY_REPOS, next);
        logger.info('removeRepo ok', id);
        return true;
    }

    /** 更新别名或 autoRefresh 等字段 */
    update(id: string, patch: Partial<Omit<RepoConfig, 'id' | 'path' | 'addedAt'>>): boolean {
        const list = this.list();
        const idx = list.findIndex(r => r.id === id);
        if (idx < 0) { return false; }
        list[idx] = { ...list[idx], ...patch };
        void this.context.globalState.update(STATE_KEY_REPOS, list);
        return true;
    }
}
