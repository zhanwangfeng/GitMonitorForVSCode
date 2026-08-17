import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { logger } from './logger';

export interface GitRunOptions {
    /** 工作目录（仓库根） */
    cwd: string;
    /** 超时（ms），默认从配置读取 */
    timeoutMs?: number;
}

export interface GitRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** 读取 VSCode 配置中的 git 可执行文件路径 */
function getGitExecutable(): string {
    const cfg = vscode.workspace.getConfiguration('gitMonitor');
    const custom = cfg.get<string>('git.executablePath', '').trim();
    return custom || 'git';
}

function getConfigTimeout(): number {
    const cfg = vscode.workspace.getConfiguration('gitMonitor');
    const ms = cfg.get<number>('refresh.timeoutMs', 5000);
    return ms > 0 ? ms : 5000;
}

/**
 * 执行一次 git 子进程命令。
 * 使用 execFile + 参数数组，避免 shell 注入与路径空格/中文问题。
 */
export function gitRun(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
    const timeoutMs = opts.timeoutMs ?? getConfigTimeout();
    const executable = getGitExecutable();
    return new Promise((resolve) => {
        execFile(executable, args, {
            cwd: opts.cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        }, (err, stdout, stderr) => {
            if (err) {
                resolve({
                    stdout: stdout ?? '',
                    stderr: stderr ?? err.message,
                    exitCode: (err as NodeJS.ErrnoException & { code?: number }).code ? -1 : (err as any).status ?? -1,
                });
                return;
            }
            resolve({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode: 0,
            });
        });
    });
}

/** 探测 git 是否可用，返回 git 版本字符串（不可用返回 null） */
export async function detectGit(): Promise<string | null> {
    const r = await gitRun(['--version'], { cwd: process.cwd(), timeoutMs: 3000 });
    if (r.exitCode === 0 && r.stdout) {
        return r.stdout.trim();
    }
    logger.error('detectGit failed', r.stderr);
    return null;
}

/** 判断给定路径是否为 git 仓库（存在 .git 目录或文件，兼容 worktree/submodule） */
export async function isGitRepo(dir: string): Promise<boolean> {
    const r = await gitRun(['rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: 3000 });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
}
