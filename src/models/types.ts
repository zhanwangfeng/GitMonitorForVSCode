/**
 * 类型定义：仓库配置、运行时状态、提交信息、文件变更、Webview 消息协议。
 * 日志时间格式遵循用户偏好：年-月-日 时:分:秒
 */

/** 仓库配置（持久化） */
export interface RepoConfig {
    /** UUID */
    id: string;
    /** 本地绝对路径 */
    path: string;
    /** 可选别名 */
    alias?: string;
    /** 添加时间戳 (ms) */
    addedAt: number;
    /** 是否参与自动轮询 */
    autoRefresh: boolean;
}

/** 仓库运行时状态（不持久化，刷新时重建） */
export interface RepoStatus {
    repoId: string;
    /** 当前分支，detached 时返回 commit hash */
    branch: string;
    /** 是否处于 detached HEAD 状态 */
    detached: boolean;
    /** 上游分支 */
    upstream?: string;
    /** 领先远端提交数 */
    ahead: number;
    /** 落后远端提交数 */
    behind: number;
    /** 工作区是否干净 */
    isClean: boolean;
    /** 暂存文件数 */
    stagedCount: number;
    /** 已修改文件数 */
    modifiedCount: number;
    /** 未跟踪文件数 */
    untrackedCount: number;
    /** origin 远端地址 */
    remoteUrl?: string;
    /** 最新一次提交 */
    lastCommit?: CommitInfo;
    /** 读取失败原因 */
    error?: string;
    /** 状态刷新时间戳 (ms) */
    updatedAt: number;
}

export interface CommitInfo {
    /** 完整 hash */
    hash: string;
    /** 短 hash */
    shortHash: string;
    author: string;
    email: string;
    /** 年-月-日 时:分:秒 */
    date: string;
    message: string;
}

export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied';

export interface FileChange {
    path: string;
    status: FileChangeStatus;
    staged: boolean;
    /** 新增行数 */
    additions?: number;
    /** 删除行数 */
    deletions?: number;
}

export interface BranchInfo {
    local: string[];
    remote: string[];
}

/** stash 条目 */
export interface StashEntry {
    /** stash@{index} 中的索引 */
    index: number;
    message: string;
}

/** 标签信息 */
export interface TagInfo {
    name: string;
    annotated: boolean;
    message?: string;
    /** 指向 commit 的短 hash */
    commit: string;
    date?: string;
}

/** 详情面板渲染所需的完整数据 */
export interface RepoDetailData {
    config: RepoConfig;
    status: RepoStatus;
    commits: CommitInfo[];
    changes: FileChange[];
    branches: BranchInfo;
    stashes: StashEntry[];
    tags: TagInfo[];
    /** 是否有写操作进行中（用于禁用按钮） */
    busy: boolean;
    /** 最近一次操作结果 */
    lastResult?: OperationResult;
    /** 冲突文件列表（非空表示存在未解决冲突） */
    conflicts: string[];
}

/** 单次操作结果反馈给 Webview */
export interface OperationResult {
    action: string;
    success: boolean;
    message?: string;
    timestamp: number;
}

/** 持久化的操作历史条目 */
export interface RepoOperation {
    repoId: string;
    action: string;
    status: 'running' | 'success' | 'failed';
    message?: string;
    startedAt: number;
    finishedAt?: number;
}

/** 主进程 → Webview 消息 */
export type DetailMessage =
    | { type: 'render'; data: RepoDetailData }
    | { type: 'loading'; repoId: string }
    | { type: 'error'; message: string }
    | { type: 'busy'; busy: boolean }
    | { type: 'operationResult'; result: OperationResult }
    | { type: 'conflict'; files: string[] };

/** Webview → 主进程消息 */
export type WebviewAction =
    | { action: 'refresh' }
    | { action: 'openInExplorer' }
    | { action: 'openInTerminal' }
    | { action: 'openInNewWindow' }
    | { action: 'copyPath' }
    // v1.1.0 写操作
    | { action: 'stage'; path: string }
    | { action: 'unstage'; path: string }
    | { action: 'stageAll' }
    | { action: 'unstageAll' }
    | { action: 'commit'; message: string; amend?: boolean }
    | { action: 'pull' }
    | { action: 'push' }
    | { action: 'fetch' }
    | { action: 'checkout'; branch: string }
    | { action: 'createBranch'; name: string; from?: string }
    | { action: 'deleteBranch'; branch: string; force?: boolean }
    | { action: 'stash'; message?: string }
    | { action: 'stashPop'; index: number }
    | { action: 'stashDrop'; index: number }
    | { action: 'merge'; branch: string }
    | { action: 'discard'; path: string }
    | { action: 'viewDiff'; path: string; staged: boolean }
    | { action: 'createTag'; name: string; message?: string; commit?: string }
    | { action: 'deleteTag'; name: string }
    | { action: 'ignore'; path: string };

/** 状态摘要级别，用于决定图标与颜色 */
export type StatusLevel = 'clean' | 'dirty' | 'ahead' | 'behind' | 'error' | 'unknown';
