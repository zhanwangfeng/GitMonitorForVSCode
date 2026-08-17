import * as vscode from 'vscode';
import * as path from 'path';

type LogLevel = 'info' | 'warn' | 'error';

const PREFIX = '[GitMonitor]';
const OUTPUT_CHANNEL_NAME = 'Git Monitor';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return channel;
}

/** 格式化时间为 年-月-日 时:分:秒 */
function formatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function write(level: LogLevel, msg: string, ...args: unknown[]): void {
    const time = formatTimestamp(new Date());
    const line = `${time} ${PREFIX} [${level.toUpperCase()}] ${msg}` +
        (args.length ? ' ' + args.map(a => {
            try { return typeof a === 'string' ? a : JSON.stringify(a); }
            catch { return String(a); }
        }).join(' ') : '');
    getChannel().appendLine(line);
}

export const logger = {
    info: (msg: string, ...args: unknown[]) => write('info', msg, ...args),
    warn: (msg: string, ...args: unknown[]) => write('warn', msg, ...args),
    error: (msg: string, ...args: unknown[]) => write('error', msg, ...args),
    show: () => getChannel().show(),
    /** 解析路径为相对仓库根的显示用短路径 */
    relPath: (full: string, root: string): string => {
        const rel = path.relative(root, full);
        return rel || path.basename(full);
    },
};
