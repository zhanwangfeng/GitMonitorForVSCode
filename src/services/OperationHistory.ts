import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { RepoOperation } from '../models/types';

const STATE_KEY = 'gitMonitor.operationHistory';

/**
 * 操作历史持久化：记录每仓库最近 N 条写操作，便于失败诊断。
 * 存储于 globalState，跨工作区共享。
 */
export class OperationHistory {
    /** repoId -> operations[] */
    private readonly cache = new Map<string, RepoOperation[]>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.load();
    }

    private load(): void {
        const all = this.context.globalState.get<Record<string, RepoOperation[]>>(STATE_KEY, {});
        for (const [repoId, ops] of Object.entries(all)) {
            this.cache.set(repoId, ops || []);
        }
    }

    private persist(): void {
        const obj: Record<string, RepoOperation[]> = {};
        for (const [k, v] of this.cache.entries()) {
            obj[k] = v;
        }
        void this.context.globalState.update(STATE_KEY, obj);
    }

    private maxSize(): number {
        return vscode.workspace.getConfiguration('gitMonitor')
            .get<number>('operations.historySize', 50);
    }

    /** 记录一次操作的开始（status=running） */
    start(repoId: string, action: string): RepoOperation {
        const op: RepoOperation = {
            repoId,
            action,
            status: 'running',
            startedAt: Date.now(),
        };
        const list = this.cache.get(repoId) ?? [];
        list.unshift(op);
        const max = this.maxSize();
        if (list.length > max) { list.length = max; }
        this.cache.set(repoId, list);
        this.persist();
        return op;
    }

    /** 完成一次操作（按 startedAt 匹配） */
    finish(repoId: string, startedAt: number, success: boolean, message?: string): void {
        const list = this.cache.get(repoId);
        if (!list) { return; }
        const op = list.find(o => o.startedAt === startedAt);
        if (!op) { return; }
        op.status = success ? 'success' : 'failed';
        op.message = message;
        op.finishedAt = Date.now();
        this.persist();
        logger.info('op finished', repoId, op.action, op.status, op.message ?? '');
    }

    /** 读取某仓库的全部历史 */
    list(repoId: string): RepoOperation[] {
        return this.cache.get(repoId) ?? [];
    }

    /** 清空某仓库历史 */
    clear(repoId: string): void {
        this.cache.delete(repoId);
        this.persist();
    }
}
