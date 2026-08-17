import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { GitInfoService } from '../services/GitInfoService';
import { RepoMonitor } from '../services/RepoMonitor';
import { logger } from '../utils/logger';
import { DetailMessage, RepoConfig, RepoDetailData, WebviewAction } from '../models/types';

/**
 * 详情面板（Webview）。单例复用，切换仓库通过 reveal + 重新渲染。
 */
export class DetailPanel {
    public static readonly viewType = 'gitMonitor.detail';

    private panel: vscode.WebviewPanel | undefined;
    /** 当前正在显示的仓库 id（外部用于判断是否需要同步刷新） */
    currentRepoId: string | undefined;

    constructor(
        private readonly configStore: ConfigStore,
        private readonly monitor: RepoMonitor,
        private readonly gitService: GitInfoService,
        private readonly extensionUri: vscode.Uri,
    ) { }

    /** 打开或聚焦详情面板，并加载指定仓库详情 */
    async reveal(repoId: string): Promise<void> {
        const cfg = this.configStore.get(repoId);
        if (!cfg) {
            vscode.window.showWarningMessage('Git Monitor: 找不到该仓库配置');
            return;
        }
        this.currentRepoId = repoId;

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                DetailPanel.viewType,
                this.buildTitle(cfg),
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: false,
                    localResourceRoots: [this.extensionUri],
                },
            );
            this.panel.iconPath = new vscode.ThemeIcon('repo');
            this.panel.webview.html = this.getHtml(this.panel.webview);
            this.panel.onDidDispose(() => { this.panel = undefined; this.currentRepoId = undefined; });
            this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg as WebviewAction));
        } else {
            this.panel.title = this.buildTitle(cfg);
            this.panel.reveal(vscode.ViewColumn.One, false);
        }

        this.postMessage({ type: 'loading', repoId });
        await this.loadAndRender(repoId);
    }

    /** 重新加载当前已打开仓库的详情（外部刷新触发时调用） */
    async reload(): Promise<void> {
        if (!this.panel || !this.currentRepoId) { return; }
        await this.loadAndRender(this.currentRepoId);
    }

    /** 关闭面板 */
    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        this.currentRepoId = undefined;
    }

    private async loadAndRender(repoId: string): Promise<void> {
        const cfg = this.configStore.get(repoId);
        if (!cfg) { return; }
        try {
            const withStats = vscode.workspace.getConfiguration('gitMonitor')
                .get<boolean>('detail.showFileStats', true);
            const commitCount = vscode.workspace.getConfiguration('gitMonitor')
                .get<number>('detail.commitCount', 20);

            const [status, commits, changes, branches] = await Promise.all([
                this.gitService.getStatus(repoId, cfg.path),
                this.gitService.getCommits(cfg.path, commitCount),
                this.gitService.getChanges(cfg.path, withStats),
                this.gitService.getBranches(cfg.path),
            ]);

            const data: RepoDetailData = { config: cfg, status, commits, changes, branches };
            this.postMessage({ type: 'render', data });
        } catch (e) {
            const msg = (e as Error).message;
            logger.error('loadAndRender error', repoId, msg);
            this.postMessage({ type: 'error', message: msg });
        }
    }

    private async onMessage(action: WebviewAction): Promise<void> {
        if (!this.currentRepoId) { return; }
        const cfg = this.configStore.get(this.currentRepoId);
        if (!cfg) { return; }
        switch (action.action) {
            case 'refresh':
                await this.loadAndRender(this.currentRepoId);
                break;
            case 'openInExplorer':
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cfg.path));
                break;
            case 'openInTerminal':
                await this.openInTerminal(cfg);
                break;
            case 'openInNewWindow':
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cfg.path), true);
                break;
            case 'copyPath':
                await vscode.env.clipboard.writeText(cfg.path);
                vscode.window.showInformationMessage('路径已复制到剪贴板');
                break;
        }
    }

    private async openInTerminal(cfg: RepoConfig): Promise<void> {
        const term = vscode.window.createTerminal({
            name: `Git Monitor: ${cfg.alias || cfg.path}`,
            cwd: cfg.path,
        });
        term.show();
    }

    private buildTitle(cfg: RepoConfig): string {
        const name = cfg.alias || cfg.path.split(/[\\/]/).pop() || cfg.path;
        return `Git Monitor: ${name}`;
    }

    private postMessage(msg: DetailMessage): void {
        this.panel?.webview.postMessage(msg);
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Git Monitor Detail</title>
<style>${CSS}</style>
</head>
<body>
<div id="root">
  <div class="loading">加载中…</div>
</div>
<script nonce="${nonce}">
${WEBVIEW_JS}
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) { s += chars[Math.floor(Math.random() * chars.length)]; }
    return s;
}

// ------------------- Webview 内联样式 -------------------
const CSS = `
:root {
  --gap: 12px;
}
body {
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground, #333);
  background: var(--vscode-editor-background, #fff);
  padding: 16px;
  margin: 0;
}
h2.repo-title {
  margin: 0 0 4px 0;
  font-size: 18px;
}
.subtitle {
  color: var(--vscode-descriptionForeground, #666);
  font-size: 12px;
  margin-bottom: 12px;
}
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 4px 12px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 12px;
}
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button.secondary {
  background: var(--vscode-button-secondaryBackground, #5a5d5e);
  color: var(--vscode-button-secondaryForeground, #fff);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #6c7071); }
section.card {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  border-radius: 4px;
  padding: 12px;
  margin-bottom: var(--gap);
  background: var(--vscode-sideBar-background, transparent);
}
section.card > h3 {
  margin: 0 0 8px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  border-left: 3px solid var(--vscode-focusBorder, #007acc);
  padding-left: 8px;
}
.kv {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
.kv .k { color: var(--vscode-descriptionForeground, #666); }
.kv .v { word-break: break-all; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
}
.badge.clean { background: rgba(76,175,80,.2); color: #4caf50; }
.badge.dirty { background: rgba(255,193,7,.2); color: #ffc107; }
.badge.behind { background: rgba(33,150,243,.2); color: #2196f3; }
.badge.ahead { background: rgba(76,175,80,.2); color: #4caf50; }
.badge.error { background: rgba(244,67,54,.2); color: #f44336; }
.file-group { margin-bottom: 8px; }
.file-group h4 {
  margin: 6px 0 4px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
}
ul.files { list-style: none; padding: 0; margin: 0; max-height: 280px; overflow-y: auto; }
ul.files li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
}
ul.files li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
.file-path { word-break: break-all; }
.file-stat { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; margin-left: 8px; }
.file-stat .add { color: #4caf50; }
.file-stat .del { color: #f44336; }
.status-tag {
  display: inline-block;
  width: 18px;
  text-align: center;
  font-weight: bold;
  margin-right: 6px;
  font-size: 11px;
}
.status-tag.M { color: #ffc107; }
.status-tag.A { color: #4caf50; }
.status-tag.D { color: #f44336; }
.status-tag.R { color: #2196f3; }
.status-tag.C { color: #9c27b0; }
.status-tag.Q { color: var(--vscode-descriptionForeground); }
ul.commits { list-style: none; padding: 0; margin: 0; }
ul.commits li {
  padding: 6px 4px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
  font-size: 12px;
}
.commit-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.commit-msg { word-break: break-all; }
.commit-hash {
  font-family: monospace;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
  padding: 1px 4px;
  border-radius: 2px;
}
.branch-list { columns: 2; column-gap: 16px; font-family: monospace; font-size: 12px; }
.branch-list .branch { break-inside: avoid; padding: 2px 0; }
.branch.current { font-weight: bold; color: var(--vscode-textLink-foreground, #007acc); }
.empty { color: var(--vscode-descriptionForeground, #888); font-style: italic; padding: 4px 0; }
.loading { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
.error-box {
  background: rgba(244,67,54,.1);
  border: 1px solid rgba(244,67,54,.4);
  color: #f44336;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
}
`;

// ------------------- Webview 内联脚本 -------------------
const WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'loading') {
    root.innerHTML = '<div class="loading">加载中…</div>';
  } else if (msg.type === 'render') {
    render(msg.data);
  } else if (msg.type === 'error') {
    root.innerHTML = '<div class="error-box">加载失败：' + escapeHtml(msg.message) + '</div>';
  }
});

// 事件委托：通过 data-action 触发对应操作（避免内联 onclick 被 CSP 拦截）
root.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  send(btn.getAttribute('data-action'));
});

function send(action) { vscode.postMessage({ action }); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function statusTag(s) {
  const map = { modified:'M', added:'A', deleted:'D', renamed:'R', copied:'C', untracked:'Q' };
  return map[s] || '?';
}

function levelOf(status) {
  if (status.error) return 'error';
  if (status.behind > 0) return 'behind';
  if (status.ahead > 0) return 'ahead';
  if (!status.isClean) return 'dirty';
  return 'clean';
}

function levelLabel(level) {
  return { clean:'干净', dirty:'有修改', ahead:'领先远端', behind:'落后远端', error:'读取失败' }[level] || level;
}

function render(data) {
  const { config, status, commits, changes, branches } = data;
  const name = config.alias || (config.path.split(/[\\\\/]/).pop() || config.path);
  const level = levelOf(status);

  const staged = changes.filter(c => c.staged && c.status !== 'untracked');
  const unstaged = changes.filter(c => !c.staged && c.status !== 'untracked');
  const untracked = changes.filter(c => c.status === 'untracked');

  root.innerHTML = \`
    <h2 class="repo-title">\${escapeHtml(name)}</h2>
    <div class="subtitle">\${escapeHtml(config.path)}</div>
    <div class="toolbar">
      <button data-action="refresh">刷新</button>
      <button class="secondary" data-action="openInTerminal">在终端中打开</button>
      <button class="secondary" data-action="openInExplorer">在资源管理器中打开</button>
      <button class="secondary" data-action="openInNewWindow">在新窗口打开</button>
      <button class="secondary" data-action="copyPath">复制路径</button>
    </div>

    <section class="card">
      <h3>基本信息</h3>
      <div class="kv">
        <span class="k">分支</span><span class="v">\${escapeHtml(status.branch || '-')}\${status.detached ? ' (detached)' : ''}</span>
        <span class="k">上游</span><span class="v">\${escapeHtml(status.upstream || '无')}</span>
        <span class="k">远端地址</span><span class="v">\${escapeHtml(status.remoteUrl || '无')}</span>
        <span class="k">状态</span><span class="v"><span class="badge \${level}">\${escapeHtml(levelLabel(level))}</span></span>
      </div>
    </section>

    <section class="card">
      <h3>同步状态</h3>
      <div class="badges">
        <span class="badge ahead">↑ 领先 \${status.ahead}</span>
        <span class="badge behind">↓ 落后 \${status.behind}</span>
        <span class="badge \${status.isClean ? 'clean' : 'dirty'}">\${status.isClean ? '工作区干净' : '有未提交变更'}</span>
      </div>
      <div class="kv" style="margin-top:8px">
        <span class="k">已暂存</span><span class="v">\${status.stagedCount} 个文件</span>
        <span class="k">已修改</span><span class="v">\${status.modifiedCount} 个文件</span>
        <span class="k">未跟踪</span><span class="v">\${status.untrackedCount} 个文件</span>
      </div>
    </section>

    <section class="card">
      <h3>文件变更</h3>
      \${renderFileGroup('已暂存', staged)}
      \${renderFileGroup('已修改（未暂存）', unstaged)}
      \${renderFileGroup('未跟踪', untracked)}
      \${changes.length === 0 ? '<div class="empty">没有文件变更</div>' : ''}
    </section>

    <section class="card">
      <h3>最近提交</h3>
      \${commits.length === 0 ? '<div class="empty">暂无提交历史</div>' :
        '<ul class="commits">' + commits.map(c => \`
          <li>
            <div class="commit-meta">
              <span class="commit-hash">\${escapeHtml(c.shortHash)}</span>
              \${escapeHtml(c.author)} · \${escapeHtml(c.date)}
            </div>
            <div class="commit-msg">\${escapeHtml(c.message)}</div>
          </li>
        \`).join('') + '</ul>'}
    </section>

    <section class="card">
      <h3>分支列表</h3>
      <div class="branch-list">
        \${branches.local.map(b => \`<div class="branch \${b.replace(/^\\*/,'').trim() === status.branch ? 'current' : ''}">\${escapeHtml(b)}</div>\`).join('')}
        \${branches.remote.map(b => \`<div class="branch">\${escapeHtml(b)}</div>\`).join('')}
      </div>
    </section>

    \${status.error ? \`<div class="error-box">⚠️ \${escapeHtml(status.error)}</div>\` : ''}
    \${status.lastCommit ? \`<div class="subtitle">最新提交：\${escapeHtml(status.lastCommit.shortHash)} \${escapeHtml(status.lastCommit.date)} \${escapeHtml(status.lastCommit.message)}</div>\` : ''}
  \`;
}

function renderFileGroup(title, files) {
  if (!files || files.length === 0) return '';
  const items = files.map(f => {
    const stat = (f.additions != null || f.deletions != null)
      ? '<span class="file-stat"><span class="add">+' + (f.additions ?? 0) + '</span> <span class="del">-' + (f.deletions ?? 0) + '</span></span>'
      : '';
    return '<li><span><span class="status-tag ' + statusTag(f.status) + '">' + statusTag(f.status) + '</span><span class="file-path">' + escapeHtml(f.path) + '</span></span>' + stat + '</li>';
  }).join('');
  return '<div class="file-group"><h4>' + escapeHtml(title) + ' (' + files.length + ')</h4><ul class="files">' + items + '</ul></div>';
}
`;
