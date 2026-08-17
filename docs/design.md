# GitMonitorForVSCode 设计文档

> 版本：v1.0
> 日期：2026-08-17
> 状态：草案

---

## 1. 概述

### 1.1 项目简介
GitMonitorForVSCode 是一个 VSCode 扩展，用于在 VSCode 侧边栏集中管理并监控多个本地 Git 仓库。用户可以添加任意受 Git 管理的本地目录，插件会在侧边栏列表中展示每个仓库的实时状态，点击条目后在详情区域查看分支、提交、文件变更等明细信息。

### 1.2 设计目标
- 一站式查看多个 Git 仓库状态，无需逐个打开目录。
- 轻量、低侵入，不修改用户仓库内容，只读取 Git 元信息。
- 交互直观，符合 VSCode 原生使用习惯。

### 1.3 名词约定
| 名词 | 含义 |
| --- | --- |
| 仓库条目 (Repo Item) | 侧边栏列表中的一行，对应一个被监控的本地 Git 仓库 |
| 详情视图 (Detail View) | 点击条目后展示的明细区域，使用 Webview 实现 |
| 监控列表 (Monitor List) | 侧边栏中所有仓库条目的集合 |

---

## 2. 用户场景

### 场景 A：多项目开发者
用户同时维护 5 个本地仓库，希望一眼看出哪个仓库有未提交修改、哪个分支落后远端，避免切换目录逐个 `git status`。

### 场景 B：代码审查者
用户添加需审查的仓库目录，点击条目查看最近提交历史与文件变更明细，决定是否需要拉取代码。

### 场景 C：仓库整理
用户清理不再关心的仓库，从监控列表中移除条目（不删除本地文件）。

---

## 3. 功能需求

### 3.1 功能清单
| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| F1 | 侧边栏入口 | P0 | 在活动栏注册图标，点击展开 Git Monitor 视图 |
| F2 | 仓库列表展示 | P0 | 以树形/列表方式展示已添加的仓库条目 |
| F3 | 添加本地目录 | P0 | 通过按钮选择目录，校验是否为 Git 仓库后加入监控 |
| F4 | 条目状态摘要 | P0 | 列表条目上展示分支名、是否干净、领先/落后远端提交数 |
| F5 | 点击查看详情 | P0 | 点击条目打开详情 Webview |
| F6 | 详情-基本信息 | P0 | 仓库路径、当前分支、远端地址、仓库大小 |
| F7 | 详情-文件变更 | P0 | 已修改/已暂存/未跟踪文件清单与行变更统计 |
| F8 | 详情-提交历史 | P0 | 最近 N 条提交（hash、作者、时间、消息） |
| F9 | 详情-分支列表 | P1 | 本地分支与远程分支列表，可切换检出 |
| F10 | 移除监控条目 | P0 | 从列表移除（不删本地文件） |
| F11 | 刷新状态 | P0 | 单条刷新 + 全部刷新 |
| F12 | 快捷操作 | P1 | 在资源管理器/终端/新窗口中打开目录 |
| F13 | 自动轮询刷新 | P2 | 可配置间隔自动刷新仓库状态 |
| F14 | 状态栏提示 | P2 | 状态栏显示有变更的仓库数量 |

### 3.2 非功能需求
- 性能：单仓库状态读取 < 300ms；列表 ≤ 50 个仓库时整体刷新 < 2s。
- 安全：不读取或上传仓库文件内容，只读取 Git 元信息；不写任何内容到目标仓库。
- 兼容：VSCode 1.80+；Windows / macOS / Linux 三平台。
- 可配置：所有可调参数通过 `settings.json` 暴露。

---

## 4. 系统架构

### 4.1 分层结构
```
┌─────────────────────────────────────────────────┐
│  表现层 (UI Layer)                              │
│  - ActivityBar图标                              │
│  - TreeView 仓库列表 (TreeDataProvider)         │
│  - Webview 详情面板                             │
├─────────────────────────────────────────────────┤
│  业务层 (Service Layer)                         │
│  - RepoService       仓库增删改查                │
│  - GitInfoService    Git 元信息读取              │
│  - RefreshScheduler  轮询刷新                    │
├─────────────────────────────────────────────────┤
│  数据层 (Data Layer)                            │
│  - ConfigStore    globalState/workspaceState     │
│  - Git CLI        调用本地 git 可执行文件        │
└─────────────────────────────────────────────────┘
```

### 4.2 关键模块
| 模块 | 职责 |
| --- | --- |
| `extension.ts` | 插件入口，注册命令、视图、事件监听 |
| `RepoTreeProvider` | 实现 `TreeDataProvider`，提供列表数据 |
| `RepoTreeItem` | 单个条目模型，承载状态摘要与图标 |
| `DetailPanel` | 管理 Webview 详情面板的生命周期与消息通信 |
| `GitInfoService` | 封装 Git 命令调用，返回结构化数据 |
| `ConfigStore` | 仓库列表与用户偏好的持久化 |
| `RefreshScheduler` | 定时刷新调度 |

### 4.3 Git 信息获取策略
- 不引入第三方 Git 库，统一调用系统 `git` CLI。
- 单次刷新合并多个查询（分支、状态、log、remote）以减少进程启动开销。
- 命令执行设置超时（默认 5s），失败时降级显示「读取失败」。

---

## 5. UI 设计

### 5.1 活动栏与侧边栏
- 活动栏注册图标：分支状 SVG 图标，主题色适配。
- 侧边栏标题：`GIT MONITOR`。
- 视图操作栏按钮（右上角）：
  - `+` 添加目录
  - `🔄` 全部刷新
  - `⚙️` 设置（跳转 `settings.json`）
- 列表视图 ID：`gitMonitor.repoList`。

### 5.2 仓库条目样式
单行结构：
```
[图标] 目录名 (分支名)  [状态徽章]
        路径摘要 · 领先↑2 落后↓1
```
- 图标：干净 ✅ / 有修改 🖉 / 读取失败 ⚠️ / 落后远端 ⬇️
- 状态徽章：未跟踪文件数、已修改文件数小角标。
- 鼠标悬停 tooltip 显示完整路径与最后提交摘要。

### 5.3 详情视图（点击条目后）
采用 Webview 渲染，分块布局：

```
┌────────────────────────────────────────────┐
│ 仓库标题 + 当前分支 + [刷新][终端][资源管理器] │
├────────────────────────────────────────────┤
│ ▌基本信息                                    │
│   路径 / 远端地址 / 仓库大小 / 默认分支       │
├────────────────────────────────────────────┤
│ ▌同步状态                                    │
│   领先上游 ↑2  落后 ↓1  [拉取] [推送]         │
├────────────────────────────────────────────┤
│ ▌文件变更                                    │
│   已暂存(3)  已修改(5)  未跟踪(2)            │
│   ─ 文件列表 + 增/删行数                      │
├────────────────────────────────────────────┤
│ ▌最近提交                                    │
│   提交列表：hash · 作者 · 时间 · 消息          │
├────────────────────────────────────────────┤
│ ▌分支列表                                    │
│   本地分支 / 远程分支  点击可切换检出           │
└────────────────────────────────────────────┘
```

详情面板复用同一 Webview 实例，通过 `reveal` + 消息更新内容切换仓库，避免反复创建。

---

## 6. 数据模型

### 6.1 仓库配置（持久化）
```ts
interface RepoConfig {
  id: string;            // UUID
  path: string;          // 本地绝对路径
  alias?: string;        // 可选别名
  addedAt: number;       // 添加时间戳 (ms)
  autoRefresh: boolean;  // 是否参与自动轮询
}
```

### 6.2 仓库运行时状态（不持久化，刷新时重建）
```ts
interface RepoStatus {
  repoId: string;
  branch: string;             // 当前分支
  upstream?: string;          // 上游分支
  ahead: number;              // 领先远端提交数
  behind: number;             // 落后远端提交数
  isClean: boolean;           // 工作区是否干净
  stagedCount: number;        // 暂存文件数
  modifiedCount: number;      // 已修改文件数
  untrackedCount: number;     // 未跟踪文件数
  remoteUrl?: string;         // origin 远端地址
  lastCommit?: CommitInfo;    // 最新一次提交
  error?: string;             // 读取失败原因
  updatedAt: number;          // 状态刷新时间戳
}

interface CommitInfo {
  hash: string;        // 完整 hash
  shortHash: string;   // 短 hash
  author: string;
  email: string;
  date: string;        // 年-月-日 时:分:秒
  message: string;
}

interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
  additions?: number;
  deletions?: number;
}
```

### 6.3 持久化位置
| 数据 | 存储位置 | 原因 |
| --- | --- | --- |
| 仓库列表 `RepoConfig[]` | `globalState` | 跨工作区共享，用户级配置 |
| 用户偏好 | `settings.json` | 支持 VSCode 原生配置同步 |
| 运行时状态 `RepoStatus` | 内存 Map | 不持久化，按需刷新 |

---

## 7. 详细设计

### 7.1 命令清单
| 命令 ID | 标题 | 触发位置 |
| --- | --- | --- |
| `gitMonitor.addRepo` | 添加目录 | 视图标题栏 `+`、命令面板 |
| `gitMonitor.refreshAll` | 全部刷新 | 视图标题栏 `🔄` |
| `gitMonitor.refreshRepo` | 刷新该仓库 | 条目右键菜单 |
| `gitMonitor.removeRepo` | 移除监控 | 条目右键菜单 |
| `gitMonitor.openDetail` | 打开详情 | 点击条目 |
| `gitMonitor.openInExplorer` | 在资源管理器中打开 | 详情面板按钮、右键菜单 |
| `gitMonitor.openInTerminal` | 在终端中打开 | 详情面板按钮、右键菜单 |
| `gitMonitor.openInNewWindow` | 在新窗口中打开 | 右键菜单 |
| `gitMonitor.openSettings` | 打开设置 | 视图标题栏 `⚙️` |

### 7.2 Git 命令映射
| 数据 | Git 命令 | 说明 |
| --- | --- | --- |
| 当前分支 | `git rev-parse --abbrev-ref HEAD` | detached 时返回 commit hash |
| 上游分支 | `git rev-parse --abbrev-ref @{u}` | 失败表示无上游 |
| 领先/落后 | `git rev-list --left-right --count @{u}...HEAD` | 输出 `behind\tahead` |
| 工作区状态 | `git status --porcelain=v1 -b` | 同时得到分支与文件变更 |
| 文件行变更 | `git diff --numstat` / `git diff --cached --numstat` | 仅在需要时调用 |
| 远端地址 | `git remote get-url origin` | 失败表示无 origin |
| 提交历史 | `git log -n 20 --pretty=format:"%H|%h|%an|%ae|%ad|%s" --date=format:"%Y-%m-%d %H:%M:%S"` | 日期格式遵循用户偏好 |
| 本地分支 | `git branch` | |
| 远程分支 | `git branch -r` | |

### 7.3 添加目录校验流程
1. 调用 `vscode.window.showOpenDialog` 选取目录（`canSelectFiles:false, canSelectFolders:true`）。
2. 校验 `path/.git` 是否存在（目录或文件均可，兼容 worktree/submodule）。
3. 不是 Git 仓库时提示「所选目录不是 Git 仓库，是否仍添加为普通目录？」→ 默认取消。
4. 重复添加校验：`globalState` 中已存在相同 `path` 则提示并跳过。
5. 写入 `RepoConfig`，立即触发一次状态刷新。

### 7.4 详情面板消息协议
主进程 → Webview（`postMessage`）：
```ts
type DetailMessage =
  | { type: 'render'; status: RepoStatus; commits: CommitInfo[]; changes: FileChange[]; branches: { local: string[]; remote: string[] } }
  | { type: 'error'; message: string };
```
Webview → 主进程（监听 `onDidReceiveMessage`）：
```ts
type WebviewAction =
  | { action: 'refresh' }
  | { action: 'openInExplorer' }
  | { action: 'openInTerminal' }
  | { action: 'pull' }     // P1
  | { action: 'push' }     // P1
  | { action: 'checkout'; branch: string };  // P1
```

### 7.5 自动刷新调度
- 默认关闭，用户在设置中开启。
- 间隔范围 30s ~ 3600s，默认 60s。
- 采用 `setInterval` + 失活检测：VSCode 失去焦点时暂停，恢复时立即触发一次。
- 单仓库刷新串行执行（避免同时启动过多 git 进程），整体使用并发上限（默认 4）。

---

## 8. 交互流程

### 8.1 添加目录
```
用户点击 [+]
   │
   ▼
showOpenDialog(选目录)
   │
   ▼
校验 .git 是否存在 ──否──▶ 提示「非 Git 仓库」 ──▶ 结束
   │是
   ▼
查重(globalState)
   │
   ▼
写入 RepoConfig
   │
   ▼
触发该仓库状态刷新
   │
   ▼
TreeView 更新该条目
```

### 8.2 查看详情
```
用户点击条目
   │
   ▼
openDetail 命令
   │
   ▼
DetailPanel.reveal(同一面板)
   │
   ▼
显示 loading
   │
   ▼
GitInfoService.collect(repoId)
   │
   ▼
postMessage('render', data)
   │
   ▼
Webview 渲染分块内容
```

### 8.3 移除监控
```
右键条目 → 移除监控
   │
   ▼
二次确认
   │
   ▼
从 globalState 删除 RepoConfig
   │
   ▼
清空对应 RepoStatus
   │
   ▼
若详情面板正显示该仓库，关闭面板
```

---

## 9. 配置项（settings.json）

```jsonc
{
  "gitMonitor.autoRefresh.enabled": false,
  "gitMonitor.autoRefresh.intervalSec": 60,
  "gitMonitor.refresh.concurrency": 4,
  "gitMonitor.refresh.timeoutMs": 5000,
  "gitMonitor.detail.commitCount": 20,
  "gitMonitor.detail.showFileStats": true,
  "gitMonitor.git.executablePath": ""  // 留空则使用 PATH 中的 git
}
```

---

## 10. 目录结构（建议）

```
GitMonitorForVSCode/
├── package.json              # 插件清单、命令/视图/配置声明
├── tsconfig.json
├── webpack.config.js         # 打包配置
├── src/
│   ├── extension.ts          # 入口 activate/deactivate
│   ├── commands/
│   │   ├── addRepo.ts
│   │   ├── removeRepo.ts
│   │   ├── refresh.ts
│   │   └── openDetail.ts
│   ├── views/
│   │   ├── RepoTreeProvider.ts
│   │   └── RepoTreeItem.ts
│   ├── panels/
│   │   └── DetailPanel.ts    # Webview 管理
│   ├── services/
│   │   ├── ConfigStore.ts
│   │   ├── GitInfoService.ts
│   │   └── RefreshScheduler.ts
│   ├── models/
│   │   └── types.ts          # 上述 interface 定义
│   ├── webview/
│   │   ├── detail.html
│   │   ├── detail.css
│   │   └── detail.js
│   └── utils/
│       ├── gitRunner.ts      # 子进程封装
│       └── logger.ts
├── media/
│   ├── icon.svg              # 活动栏图标
│   ├── clean.svg
│   ├── dirty.svg
│   └── warning.svg
├── docs/
│   └── design.md             # 本文档
└── README.md
```

---

## 11. package.json 关键声明（草稿）

```jsonc
{
  "activationEvents": ["onView:gitMonitor.repoList"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "gitMonitor", "title": "Git Monitor", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "gitMonitor": [
        { "id": "gitMonitor.repoList", "name": "仓库监控" }
      ]
    },
    "commands": [
      { "command": "gitMonitor.addRepo",        "title": "Git Monitor: 添加目录",       "icon": "$(add)" },
      { "command": "gitMonitor.refreshAll",     "title": "Git Monitor: 全部刷新",       "icon": "$(refresh)" },
      { "command": "gitMonitor.refreshRepo",    "title": "Git Monitor: 刷新该仓库",     "icon": "$(refresh)" },
      { "command": "gitMonitor.removeRepo",     "title": "Git Monitor: 移除监控",       "icon": "$(trash)" },
      { "command": "gitMonitor.openDetail",     "title": "Git Monitor: 打开详情" },
      { "command": "gitMonitor.openInExplorer", "title": "Git Monitor: 在资源管理器中打开" },
      { "command": "gitMonitor.openInTerminal", "title": "Git Monitor: 在终端中打开" },
      { "command": "gitMonitor.openSettings",   "title": "Git Monitor: 打开设置",       "icon": "$(gear)" }
    ],
    "menus": {
      "view/title": [
        { "command": "gitMonitor.addRepo",      "when": "view == gitMonitor.repoList", "group": "navigation" },
        { "command": "gitMonitor.refreshAll",   "when": "view == gitMonitor.repoList", "group": "navigation" },
        { "command": "gitMonitor.openSettings", "when": "view == gitMonitor.repoList" }
      ],
      "view/item/context": [
        { "command": "gitMonitor.refreshRepo",    "when": "view == gitMonitor.repoList" },
        { "command": "gitMonitor.removeRepo",    "when": "view == gitMonitor.repoList" },
        { "command": "gitMonitor.openInExplorer","when": "view == gitMonitor.repoList" },
        { "command": "gitMonitor.openInTerminal","when": "view == gitMonitor.repoList" }
      ]
    },
    "configuration": {
      "title": "Git Monitor",
      "properties": {
        "gitMonitor.autoRefresh.enabled":        { "type": "boolean", "default": false },
        "gitMonitor.autoRefresh.intervalSec":    { "type": "number",  "default": 60,   "minimum": 30, "maximum": 3600 },
        "gitMonitor.refresh.concurrency":        { "type": "number",  "default": 4,    "minimum": 1,  "maximum": 16 },
        "gitMonitor.refresh.timeoutMs":         { "type": "number",  "default": 5000 },
        "gitMonitor.detail.commitCount":        { "type": "number",  "default": 20 },
        "gitMonitor.detail.showFileStats":       { "type": "boolean", "default": true },
        "gitMonitor.git.executablePath":        { "type": "string",  "default": "" }
      }
    }
  }
}
```

---

## 12. 风险与对策
| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 用户机器未安装 git | 全部功能不可用 | 启动时探测 git，缺失时提示并禁用相关命令 |
| 大型仓库 `git status` 慢 | 列表刷新卡顿 | 单命令超时 + 并发上限 + 状态异步加载 |
| Webview 频繁创建内存占用高 | 内存泄漏 | 复用单例 DetailPanel，切换仓库不重建 |
| 子进程路径含空格/中文 | 命令执行失败 | 使用 `execFile` 参数数组，不拼接命令字符串 |
| 仓库被外部删除 | 列表条目失效 | 刷新失败时标记为「路径不存在」，提示用户移除 |

---

## 13. 版本演进计划
- v0.1.0（MVP）：F1~F8、F10、F11，完成核心监控与详情查看。
- v0.2.0：F9 分支切换、F12 快捷操作、F13 自动轮询。
- v0.3.0：F14 状态栏提示、文件行变更统计优化、性能调优。
- v1.0.0：稳定性与多平台兼容性验证，发布 Marketplace。

---

## 14. 验收标准
1. 安装插件后活动栏出现 Git Monitor 入口，点击展开空列表与「+」按钮。
2. 点击「+」选择一个 Git 仓库目录后，列表出现该条目并显示分支与状态徽章。
3. 选择非 Git 目录时给出明确提示且不加入列表。
4. 点击条目打开详情面板，正确展示基本信息、文件变更、提交历史、分支列表。
5. 在仓库中执行 `touch new.txt` 后刷新，详情面板的「未跟踪」数 +1。
6. 右键「移除监控」后条目消失，且本地目录文件未被删除。
7. 重启 VSCode 后仓库列表依然存在（globalState 持久化生效）。
