# Git Monitor for VSCode

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/zhanwangfeng.gitmonitor-for-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=zhanwangfeng.gitmonitor-for-vscode)
[![Installs](https://vsmarketplacebadges.dev/installs/zhanwangfeng.gitmonitor-for-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=zhanwangfeng.gitmonitor-for-vscode)
[![Downloads](https://vsmarketplacebadges.dev/downloads/zhanwangfeng.gitmonitor-for-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=zhanwangfeng.gitmonitor-for-vscode)
[![Rates](https://vsmarketplacebadges.dev/rating-star/zhanwangfeng.gitmonitor-for-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=zhanwangfeng.gitmonitor-for-vscode)

> 在 VSCode 侧边栏集中监控多个本地 Git 仓库的状态、分支、提交与文件变更，无需逐个切换目录。

- GitHub: https://github.com/zhanwangfeng/GitMonitorForVSCode
- VSCode: https://marketplace.visualstudio.com/items?itemName=zhanwangfeng.gitmonitor-for-vscode

## 简介

Git Monitor 是一个 VSCode 扩展，帮助你在一处查看所有关心的 Git 仓库的实时状态。无论是同时维护多个项目，还是需要定期审查若干仓库的代码变更，都可以将它作为统一的 Git 监控面板。

- **一眼掌握**：列表条目直接显示分支、领先/落后远端提交数、未提交文件计数
- **低侵入**：只读取 Git 元信息，不修改、不上传你的仓库内容
- **原生体验**：符合 VSCode 交互习惯，支持主题色与图标

## 功能特性

### 侧边栏列表
- 活动栏图标点击展开「仓库监控」视图
- 每个仓库条目展示：目录名 · 分支 · 领先↑N · 落后↓N · 文件计数（+暂存 / ~修改 / ?未跟踪）
- 鼠标悬停显示完整路径、远端地址、最新提交摘要
- 状态图标：✅ 干净 / 🖉 有修改 / ↑ 领先 / ↓ 落后 / ⚠️ 读取失败

### 详情面板（点击条目打开）
分块展示该仓库的完整明细：

| 区块 | 内容 |
| --- | --- |
| 基本信息 | 分支、上游、远端地址、状态徽章 |
| 同步状态 | 领先/落后远端提交数、工作区是否干净、文件计数汇总 |
| 文件变更 | 已暂存 / 已修改 / 未跟踪 三组文件清单，附增删行数 |
| 最近提交 | 最近 20 条提交（短 hash、作者、时间、消息） |
| 分支列表 | 本地分支与远程分支，当前分支高亮 |

详情面板内置快捷操作：刷新、在终端中打开、在资源管理器中打开、在新窗口打开、复制路径。

### 仓库管理
- **添加目录**：选择本地目录，自动校验是否为 Git 仓库，支持设置别名
- **移除监控**：从列表移除（不影响本地文件）
- **刷新**：单条刷新 + 全部刷新（带并发上限）
- **自动轮询**：可配置间隔自动刷新，窗口失焦时自动暂停

## 安装

### 方式一：从 Marketplace 安装
在 VSCode 扩展面板搜索 `Git Monitor`，点击安装。

### 方式二：从 VSIX 安装
```bash
code --install-extension gitmonitor-for-vscode-0.1.0.vsix
```

## 使用指南

### 1. 添加第一个仓库
1. 点击活动栏的 Git Monitor 图标
2. 点击视图标题栏的 `+` 按钮
3. 在弹出的目录选择器中选中一个 Git 仓库
4. （可选）为该仓库输入别名
5. 仓库立即出现在列表中并自动刷新状态

> 如果选择的目录不是 Git 仓库，会弹出提示询问是否仍要添加。

### 2. 查看仓库详情
- **单击**列表条目，打开详情面板
- 详情面板复用同一实例，切换仓库不重新创建窗口
- 仓库状态变化时，若详情面板正显示该仓库，会自动同步刷新

### 3. 刷新状态
- **全部刷新**：点击视图标题栏的 🔄 按钮
- **单条刷新**：右键条目 → 「刷新该仓库」
- 刷新过程在状态栏显示进度，多仓库并发执行（默认并发 4）

### 4. 移除监控
- 右键条目 → 「移除监控」
- 二次确认后从列表移除，**本地目录文件不会被删除**
- 重启 VSCode 后监控列表依然保留（globalState 持久化）

### 5. 快捷操作
右键仓库条目，可快速：
- 在资源管理器中打开（系统文件管理器）
- 在终端中打开（以该仓库为工作目录）
- 在新窗口中打开（VSCode 新窗口加载该目录）

## 配置项

在 `settings.json` 中可调整以下参数：

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitMonitor.autoRefresh.enabled` | boolean | `false` | 是否启用自动轮询刷新 |
| `gitMonitor.autoRefresh.intervalSec` | number | `60` | 自动刷新间隔（秒），范围 30~3600 |
| `gitMonitor.refresh.concurrency` | number | `4` | 全部刷新时的并发上限，范围 1~16 |
| `gitMonitor.refresh.timeoutMs` | number | `5000` | 单次 git 命令超时（毫秒） |
| `gitMonitor.detail.commitCount` | number | `20` | 详情面板显示的提交历史条数 |
| `gitMonitor.detail.showFileStats` | boolean | `true` | 详情面板是否展示文件增删行数 |
| `gitMonitor.git.executablePath` | string | `""` | git 可执行文件路径，留空使用 PATH 中的 git |

### 配置示例
```jsonc
{
  "gitMonitor.autoRefresh.enabled": true,
  "gitMonitor.autoRefresh.intervalSec": 120,
  "gitMonitor.refresh.concurrency": 8,
  "gitMonitor.detail.commitCount": 50
}
```

## 常见问题

**Q：启动后看不到任何仓库？**
A：首次使用列表为空，点击视图标题栏的 `+` 添加你的第一个仓库。

**Q：提示「未检测到 git 可执行文件」？**
A：请确保系统已安装 git 并加入 PATH，或在设置中指定 `gitMonitor.git.executablePath`。

**Q：某个仓库显示「读取失败」？**
A：可能是仓库路径被移动/删除，或 git 命令执行超时。右键「刷新该仓库」重试；若路径已不存在，请「移除监控」。

**Q：列表会修改我的仓库吗？**
A：不会。插件只读取 Git 元信息（分支、状态、提交历史等），不会执行任何写操作（不 pull、不 push、不 commit）。

**Q：重启 VSCode 后仓库列表还在吗？**
A：在。仓库配置通过 VSCode 的 globalState 持久化，跨工作区共享。

## 命令面板

所有功能也可通过命令面板（`Ctrl+Shift+P`）调用，前缀 `Git Monitor:`：
- `Git Monitor: 添加目录`
- `Git Monitor: 全部刷新`
- `Git Monitor: 刷新该仓库`
- `Git Monitor: 移除监控`
- `Git Monitor: 打开详情`
- `Git Monitor: 在资源管理器中打开`
- `Git Monitor: 在终端中打开`
- `Git Monitor: 打开设置`

## 兼容性

- VSCode 1.80+
- Windows / macOS / Linux

## 许可证

MIT
