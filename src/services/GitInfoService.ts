import * as vscode from 'vscode';
import { gitRun } from '../utils/gitRunner';
import { logger } from '../utils/logger';
import {
    BranchInfo, CommitInfo, FileChange, FileChangeStatus, RepoStatus,
} from '../models/types';

/**
 * 纯 Git 命令封装层：无状态，仅负责调用 git CLI 并解析为结构化数据。
 * 所有方法失败时不抛出，而是返回带 error 字段的结果，避免单仓库异常影响整体刷新。
 */
export class GitInfoService {

    /** 读取仓库运行时状态（不含完整文件清单，用于列表摘要） */
    async getStatus(repoId: string, repoPath: string): Promise<RepoStatus> {
        const base: RepoStatus = {
            repoId,
            branch: '',
            detached: false,
            upstream: undefined,
            ahead: 0,
            behind: 0,
            isClean: true,
            stagedCount: 0,
            modifiedCount: 0,
            untrackedCount: 0,
            remoteUrl: undefined,
            lastCommit: undefined,
            error: undefined,
            updatedAt: Date.now(),
        };

        try {
            // 1. 工作区状态 + 分支 + ahead/behind
            const statusRes = await gitRun(['status', '--porcelain=v1', '-b'], { cwd: repoPath });
            if (statusRes.exitCode !== 0) {
                base.error = `git status 失败: ${statusRes.stderr.trim() || '未知错误'}`;
                return base;
            }
            this.applyPorcelain(statusRes.stdout, base);

            // 2. 远端地址（非致命）
            const remoteRes = await gitRun(['remote', 'get-url', 'origin'], { cwd: repoPath });
            if (remoteRes.exitCode === 0) {
                base.remoteUrl = remoteRes.stdout.trim();
            }

            // 3. 最新提交（非致命）
            const lastRes = await this.getCommits(repoPath, 1);
            if (lastRes.length > 0) {
                base.lastCommit = lastRes[0];
            }

            // 4. detached 时补全分支显示为短 hash
            if (base.detached && !base.branch) {
                const headRes = await gitRun(['rev-parse', '--short', 'HEAD'], { cwd: repoPath });
                if (headRes.exitCode === 0) {
                    base.branch = headRes.stdout.trim();
                }
            }
        } catch (e) {
            base.error = `读取状态异常: ${(e as Error).message}`;
            logger.error('getStatus exception', repoPath, (e as Error).message);
        }
        return base;
    }

    /** 读取最近 N 条提交 */
    async getCommits(repoPath: string, count: number): Promise<CommitInfo[]> {
        const fmt = '%H|%h|%an|%ae|%ad|%s';
        const r = await gitRun(
            ['log', `-n=${count}`, `--pretty=format:${fmt}`, '--date=format:%Y-%m-%d %H:%M:%S'],
            { cwd: repoPath }
        );
        if (r.exitCode !== 0) {
            // 空仓库或无 HEAD 时 git log 返回非 0，按空列表处理
            return [];
        }
        const lines = r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
        return lines.map(line => {
            const parts = line.split('|');
            // message 本身可能含 |
            const [hash, shortHash, author, email, date, ...rest] = parts;
            return {
                hash: hash ?? '',
                shortHash: shortHash ?? '',
                author: author ?? '',
                email: email ?? '',
                date: date ?? '',
                message: (rest.join('|')) ?? '',
            } as CommitInfo;
        });
    }

    /** 读取文件变更清单，可选附带 numstat 增删行数 */
    async getChanges(repoPath: string, withStats: boolean): Promise<FileChange[]> {
        const statusRes = await gitRun(['status', '--porcelain=v1', '-b'], { cwd: repoPath });
        if (statusRes.exitCode !== 0) { return []; }
        const changes = parsePorcelainFiles(statusRes.stdout);

        if (withStats && changes.length > 0) {
            const [unstatted, staged] = await Promise.all([
                gitRun(['diff', '--numstat'], { cwd: repoPath }),
                gitRun(['diff', '--cached', '--numstat'], { cwd: repoPath }),
            ]);
            const stats = new Map<string, { additions?: number; deletions?: number; staged: boolean }>();
            mergeNumstat(unstatted.stdout, stats, false);
            mergeNumstat(staged.stdout, stats, true);
            for (const c of changes) {
                const key = (c.status === 'renamed' || c.status === 'copied')
                    ? c.path.split(' -> ').pop()!
                    : c.path;
                const s = stats.get(key);
                if (s) {
                    c.additions = s.additions;
                    c.deletions = s.deletions;
                }
            }
        }
        return changes;
    }

    /** 读取本地与远程分支列表 */
    async getBranches(repoPath: string): Promise<BranchInfo> {
        const [localRes, remoteRes] = await Promise.all([
            gitRun(['branch', '--list'], { cwd: repoPath }),
            gitRun(['branch', '--remotes'], { cwd: repoPath }),
        ]);
        const parse = (out: string, isRemote: boolean): string[] =>
            out.split('\n')
                .map(l => l.replace(/^\*/, '').trim())
                .filter(l => !!l && !(isRemote && l.includes(' -> ')));
        return {
            local: parse(localRes.stdout, false),
            remote: parse(remoteRes.stdout, true),
        };
    }

    /** 解析 porcelain 输出并填充 RepoStatus（分支/计数/干净标志） */
    private applyPorcelain(out: string, base: RepoStatus): void {
        const lines = out.split('\n');
        if (lines.length === 0) { return; }
        const branchLine = lines[0];

        // 形如: ## main, ## main...origin/main, ## main...origin/main [ahead 2, behind 1], ## HEAD (no branch)
        if (branchLine.startsWith('## ')) {
            const rest = branchLine.slice(3);
            const bracketIdx = rest.indexOf(' [');
            const branchPart = bracketIdx >= 0 ? rest.slice(0, bracketIdx) : rest;
            const bracketPart = bracketIdx >= 0 ? rest.slice(bracketIdx + 2).replace(/\]$/, '') : '';

            if (branchPart === 'HEAD (no branch)') {
                base.detached = true;
                base.branch = '(detached)';
            } else {
                const [branch, upstream] = branchPart.split('...');
                base.branch = branch || '';
                if (upstream) { base.upstream = upstream; }
            }

            if (bracketPart) {
                const aheadMatch = bracketPart.match(/ahead (\d+)/);
                const behindMatch = bracketPart.match(/behind (\d+)/);
                if (aheadMatch) { base.ahead = parseInt(aheadMatch[1], 10); }
                if (behindMatch) { base.behind = parseInt(behindMatch[1], 10); }
            }
        }

        let staged = 0, modified = 0, untracked = 0;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) { continue; }
            const x = line[0];
            const y = line[1];
            if (x === '?' && y === '?') { untracked++; continue; }
            if (x === '!' && y === '!') { continue; }
            if (x !== ' ' && x !== '?') { staged++; }
            if (y !== ' ' && y !== '?') { modified++; }
        }
        base.stagedCount = staged;
        base.modifiedCount = modified;
        base.untrackedCount = untracked;
        base.isClean = staged === 0 && modified === 0 && untracked === 0;
    }
}

/** 解析 porcelain 输出的文件变更清单 */
function parsePorcelainFiles(out: string): FileChange[] {
    const lines = out.split('\n');
    const result: FileChange[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.length < 3) { continue; }
        const x = line[0];
        const y = line[1];
        const rest = line.slice(3);
        if (x === '!' && y === '!') { continue; }

        let status: FileChangeStatus;
        let staged: boolean;
        let pathStr = rest;

        if (x === '?' && y === '?') {
            status = 'untracked'; staged = false;
        } else if (x === 'A') {
            status = 'added'; staged = true;
        } else if (x === 'D') {
            status = 'deleted'; staged = true;
        } else if (x === 'R') {
            status = 'renamed'; staged = true;
        } else if (x === 'C') {
            status = 'copied'; staged = true;
        } else if (y === 'D') {
            status = 'deleted'; staged = false;
        } else if (y === 'R') {
            status = 'renamed'; staged = false;
        } else {
            status = 'modified';
            staged = x !== ' ' && x !== '?';
        }

        // renamed/copied 显示为 "old -> new"
        if (status === 'renamed' || status === 'copied') {
            pathStr = rest.split(' -> ').pop() || rest;
        }

        result.push({ path: pathStr, status, staged });
    }
    return result;
}

/** 合并 numstat 输出到 stats map */
function mergeNumstat(out: string, stats: Map<string, { additions?: number; deletions?: number; staged: boolean }>, staged: boolean): void {
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 3) { continue; }
        const [add, del, file] = parts;
        const additions = add === '-' ? undefined : parseInt(add, 10);
        const deletions = del === '-' ? undefined : parseInt(del, 10);
        stats.set(file, { additions, deletions, staged });
    }
}
