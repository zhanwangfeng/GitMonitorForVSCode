import * as vscode from 'vscode';
import { RepoMonitor } from './RepoMonitor';
import { logger } from '../utils/logger';

/**
 * 自动刷新调度器：依据用户配置开启/关闭轮询。
 * VSCode 失去焦点时暂停，恢复焦点时立即触发一次。
 */
export class RefreshScheduler {
    private timer: NodeJS.Timeout | undefined;
    private windowActive = true;
    private readonly disposables: vscode.Disposable[] = [];
    private started = false;

    constructor(private readonly monitor: RepoMonitor) { }

    start(): void {
        if (this.started) { return; }
        this.started = true;

        this.disposables.push(
            vscode.window.onDidChangeWindowState(state => {
                this.windowActive = state.focused;
                if (state.focused) {
                    logger.info('window focused, trigger refresh');
                    void this.monitor.refreshAll();
                } else {
                    logger.info('window unfocused, pause scheduler');
                }
                this.reschedule();
            })
        );

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gitMonitor.autoRefresh')) {
                    logger.info('autoRefresh config changed, reschedule');
                    this.reschedule();
                }
            })
        );

        this.reschedule();
    }

    private reschedule(): void {
        this.stopTimer();
        const cfg = vscode.workspace.getConfiguration('gitMonitor');
        const enabled = cfg.get<boolean>('autoRefresh.enabled', false);
        if (!enabled || !this.windowActive) {
            return;
        }
        const intervalSec = cfg.get<number>('autoRefresh.intervalSec', 60);
        const ms = Math.max(30, intervalSec) * 1000;
        this.timer = setInterval(() => {
            void this.monitor.refreshAll().catch(e => logger.error('scheduler refresh error', (e as Error).message));
        }, ms);
        logger.info('scheduler started', `interval=${intervalSec}s`);
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    dispose(): void {
        this.stopTimer();
        for (const d of this.disposables) { d.dispose(); }
    }
}
