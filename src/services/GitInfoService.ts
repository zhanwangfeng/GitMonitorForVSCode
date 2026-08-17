import * as vscode from 'vscode';
import { gitRun } from '../utils/gitRunner';
import { logger } from '../utils/logger';
import {
    BranchInfo, CommitInfo, FileChange, FileChangeStatus, RepoStatus,
    StashEntry, TagInfo,
} from '../models/types';

/** 写操作结果 */
export interface GitOpResult {
    success: boolean;
    message: string;
    /** 是否产生冲突（pull/merge 等） */
    conflicts?: string[];
}

/** 拉取策略 */
export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

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

    /** 读取 stash 列表 */
    async getStashes(repoPath: string): Promise<StashEntry[]> {
        const r = await gitRun(
            ['stash', 'list', '--pretty=format:%gd|%s'],
            { cwd: repoPath },
        );
        if (r.exitCode !== 0 || !r.stdout.trim()) { return []; }
        return r.stdout.split('\n').filter(Boolean).map(line => {
            const idx = line.indexOf('|');
            const ref = idx >= 0 ? line.slice(0, idx) : line;
            const msg = idx >= 0 ? line.slice(idx + 1) : '';
            const m = ref.match(/stash@\{(\d+)\}/);
            return { index: m ? parseInt(m[1], 10) : 0, message: msg };
        });
    }

    /** 读取标签列表 */
    async getTags(repoPath: string): Promise<TagInfo[]> {
        const fmt = '%(refname:short)|%(objecttype)|%(*objectname)|%(objectname)|%(subject)|%(creatordate:format:%Y-%m-%d %H:%M:%S)';
        const r = await gitRun(
            ['for-each-ref', `--format=${fmt}`, 'refs/tags'],
            { cwd: repoPath },
        );
        if (r.exitCode !== 0 || !r.stdout.trim()) { return []; }
        return r.stdout.split('\n').filter(Boolean).map(line => {
            const [name, type, objNameStar, objName, subject, date] = line.split('|');
            // 注解标签的 commit 在 *objectname，轻量标签在 objectname
            const commitHash = objNameStar || objName || '';
            const shortHash = commitHash ? commitHash.slice(0, 7) : '';
            const annotated = type === 'tag';
            return {
                name: name || '',
                annotated,
                message: annotated ? (subject || '') : undefined,
                commit: shortHash,
                date: date || undefined,
            } as TagInfo;
        });
    }

    /** 检测当前是否存在未解决冲突（UU/AA/DD/AU/UA/DU/UD 标记） */
    async getConflicts(repoPath: string): Promise<string[]> {
        const r = await gitRun(['status', '--porcelain=v1'], { cwd: repoPath });
        if (r.exitCode !== 0) { return []; }
        const conflicts: string[] = [];
        for (const line of r.stdout.split('\n')) {
            if (line.length < 3) { continue; }
            const x = line[0], y = line[1];
            // 冲突状态码
            if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
                conflicts.push(line.slice(3));
            }
        }
        return conflicts;
    }

    // ===================== 写操作 =====================

    /** 暂存单文件 */
    async stageFile(repoPath: string, file: string): Promise<GitOpResult> {
        const r = await gitRun(['add', '--', file], { cwd: repoPath });
        return this.toResult(r, '暂存文件');
    }

    /** 暂存全部 */
    async stageAll(repoPath: string): Promise<GitOpResult> {
        const r = await gitRun(['add', '-A'], { cwd: repoPath });
        return this.toResult(r, '暂存全部');
    }

    /** 取消暂存单文件 */
    async unstageFile(repoPath: string, file: string): Promise<GitOpResult> {
        const r = await gitRun(['reset', 'HEAD', '--', file], { cwd: repoPath });
        return this.toResult(r, '取消暂存');
    }

    /** 取消暂存全部 */
    async unstageAll(repoPath: string): Promise<GitOpResult> {
        const r = await gitRun(['reset', 'HEAD'], { cwd: repoPath });
        return this.toResult(r, '取消暂存全部');
    }

    /** 提交。amend=true 时修补上次提交。 */
    async commit(repoPath: string, message: string, amend: boolean): Promise<GitOpResult> {
        if (!message.trim() && !(amend)) {
            return { success: false, message: '提交信息不能为空' };
        }
        const args = ['commit'];
        if (amend) {
            args.push('--amend');
            if (message.trim()) { args.push('-m', message); }
            else { args.push('--no-edit'); }
        } else {
            args.push('-m', message);
        }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            // 提取短 hash
            const hashRes = await gitRun(['rev-parse', '--short', 'HEAD'], { cwd: repoPath });
            const shortHash = hashRes.exitCode === 0 ? hashRes.stdout.trim() : '';
            return { success: true, message: `提交成功 ${shortHash}` };
        }
        return { success: false, message: `提交失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 拉取。默认 ff-only。冲突时返回 conflicts。 */
    async pull(repoPath: string, strategy: PullStrategy): Promise<GitOpResult> {
        const args = ['pull'];
        if (strategy === 'ff-only') { args.push('--ff-only'); }
        else if (strategy === 'rebase') { args.push('--rebase'); }
        else { args.push('--no-edit'); }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: '拉取成功' };
        }
        // 检测冲突
        const conflicts = await this.getConflicts(repoPath);
        if (conflicts.length > 0) {
            return {
                success: false,
                message: '拉取过程中产生冲突，请手动解决',
                conflicts,
            };
        }
        // 无上游判断
        const stderr = r.stderr.toLowerCase();
        if (stderr.includes('no upstream') || stderr.includes('no remote tracking') || stderr.includes('does not have')) {
            return { success: false, message: '当前分支无上游，请先设置上游分支' };
        }
        return { success: false, message: `拉取失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 推送。无上游时可选设置 -u。 */
    async push(repoPath: string, branch: string, setUpstream: boolean): Promise<GitOpResult> {
        const remote = this.getDefaultPushRemote();
        const args = ['push'];
        if (setUpstream) { args.push('-u', remote, branch); }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: setUpstream ? `推送成功并已设置上游 ${remote}/${branch}` : '推送成功' };
        }
        const stderr = r.stderr.toLowerCase();
        if (stderr.includes('no upstream') || stderr.includes('no remote tracking') || stderr.includes('has no upstream')) {
            return { success: false, message: '当前分支无上游，建议重新推送并勾选「设置上游」' };
        }
        if (stderr.includes('rejected') && stderr.includes('fetch first')) {
            return { success: false, message: '推送被拒绝，远端有新提交，请先拉取' };
        }
        return { success: false, message: `推送失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 检测当前分支是否有上游 */
    async hasUpstream(repoPath: string): Promise<boolean> {
        const r = await gitRun(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: repoPath });
        return r.exitCode === 0 && !!r.stdout.trim();
    }

    /** 获取 */
    async fetch(repoPath: string): Promise<GitOpResult> {
        const r = await gitRun(['fetch', '--all', '--prune'], { cwd: repoPath, timeoutMs: 30000 });
        if (r.exitCode === 0) {
            return { success: true, message: '获取成功' };
        }
        return { success: false, message: `获取失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 切换分支。远程分支自动创建本地跟踪分支。 */
    async checkout(repoPath: string, branch: string): Promise<GitOpResult> {
        const r = await gitRun(['checkout', branch], { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已切换到 ${branch}` };
        }
        return { success: false, message: `切换失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 新建分支并切换。from 为空则从 HEAD。 */
    async createBranch(repoPath: string, name: string, from?: string): Promise<GitOpResult> {
        if (!name.trim()) { return { success: false, message: '分支名不能为空' }; }
        const args = ['checkout', '-b', name];
        if (from) { args.push(from); }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已创建并切换到 ${name}` };
        }
        return { success: false, message: `创建分支失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 删除分支。force=true 使用 -D。 */
    async deleteBranch(repoPath: string, branch: string, force: boolean): Promise<GitOpResult> {
        const args = ['branch', force ? '-D' : '-d', branch];
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已删除分支 ${branch}` };
        }
        return { success: false, message: `删除分支失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 暂存改动 */
    async stash(repoPath: string, message?: string): Promise<GitOpResult> {
        const args = ['stash', 'push'];
        if (message) { args.push('-m', message); }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            const out = r.stdout.trim();
            if (out.includes('No local changes to save')) {
                return { success: true, message: '无本地改动可暂存' };
            }
            return { success: true, message: '改动已暂存' };
        }
        return { success: false, message: `暂存失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 恢复暂存 */
    async stashPop(repoPath: string, index: number): Promise<GitOpResult> {
        const r = await gitRun(['stash', 'pop', `stash@{${index}}`], { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已恢复 stash@{${index}}` };
        }
        // pop 失败时可能是冲突，检测冲突
        const conflicts = await this.getConflicts(repoPath);
        if (conflicts.length > 0) {
            return { success: false, message: '恢复时产生冲突，stash 未被删除', conflicts };
        }
        return { success: false, message: `恢复失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 丢弃暂存条目 */
    async stashDrop(repoPath: string, index: number): Promise<GitOpResult> {
        const r = await gitRun(['stash', 'drop', `stash@{${index}}`], { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已丢弃 stash@{${index}}` };
        }
        return { success: false, message: `丢弃失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 合并分支。冲突时返回 conflicts。 */
    async merge(repoPath: string, branch: string): Promise<GitOpResult> {
        const r = await gitRun(['merge', '--no-edit', branch], { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已合并 ${branch}` };
        }
        const conflicts = await this.getConflicts(repoPath);
        if (conflicts.length > 0) {
            return { success: false, message: `合并 ${branch} 产生冲突，请手动解决`, conflicts };
        }
        return { success: false, message: `合并失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 撤销单文件修改（git checkout -- file） */
    async discardFile(repoPath: string, file: string): Promise<GitOpResult> {
        const r = await gitRun(['checkout', '--', file], { cwd: repoPath });
        return this.toResult(r, '撤销文件修改');
    }

    /** 整库重置 reset --hard HEAD */
    async resetHard(repoPath: string): Promise<GitOpResult> {
        const r = await gitRun(['reset', '--hard', 'HEAD'], { cwd: repoPath });
        return this.toResult(r, '重置工作区');
    }

    /** 创建标签。message 非空时创建注解标签。 */
    async createTag(repoPath: string, name: string, message?: string, commit?: string): Promise<GitOpResult> {
        if (!name.trim()) { return { success: false, message: '标签名不能为空' }; }
        const args = ['tag'];
        if (message) { args.push('-a', name, '-m', message); }
        else { args.push(name); }
        if (commit) { args.push(commit); }
        const r = await gitRun(args, { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已创建标签 ${name}` };
        }
        return { success: false, message: `创建标签失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 删除标签 */
    async deleteTag(repoPath: string, name: string): Promise<GitOpResult> {
        const r = await gitRun(['tag', '-d', name], { cwd: repoPath });
        if (r.exitCode === 0) {
            return { success: true, message: `已删除标签 ${name}` };
        }
        return { success: false, message: `删除标签失败: ${r.stderr.trim() || r.stdout.trim()}` };
    }

    /** 获取指定文件差异文本（用于调用 VSCode diff editor） */
    async getDiffContent(repoPath: string, file: string, staged: boolean): Promise<{ left: string; right: string } | undefined> {
        // 通过 git show 获取原始版本，工作区版本直接读文件
        const ref = staged ? `:0:${file}` : `HEAD:${file}`;
        const [baseRes] = await Promise.all([
            gitRun(['show', ref], { cwd: repoPath }),
        ]);
        if (baseRes.exitCode !== 0) {
            return undefined;
        }
        return { left: baseRes.stdout, right: '' }; // right 由调用方读文件
    }

    private getDefaultPushRemote(): string {
        const cfg = vscode.workspace.getConfiguration('gitMonitor');
        return cfg.get<string>('operations.defaultPushRemote', 'origin').trim() || 'origin';
    }

    private toResult(r: { exitCode: number; stdout: string; stderr: string }, label: string): GitOpResult {
        if (r.exitCode === 0) {
            return { success: true, message: `${label}成功` };
        }
        return { success: false, message: `${label}失败: ${r.stderr.trim() || r.stdout.trim()}` };
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
