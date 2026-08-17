import * as vscode from 'vscode';
import { ConfigStore } from '../services/ConfigStore';
import { GitInfoService, GitOpResult } from '../services/GitInfoService';
import { RepoMonitor } from '../services/RepoMonitor';
import { OperationHistory } from '../services/OperationHistory';
import { GitOpsController } from '../commands/gitOps';
import { logger } from '../utils/logger';
import { DetailMessage, OperationResult, RepoConfig, RepoDetailData, WebviewAction } from '../models/types';

/**
 * 详情面板（Webview）。单例复用，切换仓库通过 reveal + 重新渲染。
 */
export class DetailPanel {
    public static readonly viewType = 'gitMonitor.detail';

    private panel: vscode.WebviewPanel | undefined;
    /** 当前正在显示的仓库 id（外部用于判断是否需要同步刷新） */
    currentRepoId: string | undefined;
    /** 是否有写操作进行中 */
    private busy = false;
    /** 最近一次操作结果（用于渲染反馈） */
    private lastResult: OperationResult | undefined;
    /** Git 操作控制器 */
    private readonly ops: GitOpsController;

    constructor(
        private readonly configStore: ConfigStore,
        private readonly monitor: RepoMonitor,
        private readonly gitService: GitInfoService,
        private readonly extensionUri: vscode.Uri,
        history: OperationHistory,
    ) {
        this.ops = new GitOpsController(gitService, monitor, history);
    }

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
            // panel 重新可见时（如从 diff editor 切回），webview JS 上下文已销毁需重新加载
            this.panel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible && this.currentRepoId) {
                    void this.loadAndRender(this.currentRepoId);
                }
            });
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
            const config = vscode.workspace.getConfiguration('gitMonitor');
            const withStats = config.get<boolean>('detail.showFileStats', true);
            const commitCount = config.get<number>('detail.commitCount', 20);
            const enableStash = config.get<boolean>('operations.enableStash', true);
            const enableTag = config.get<boolean>('operations.enableTag', true);

            const [status, commits, changes, branches, conflicts] = await Promise.all([
                this.gitService.getStatus(repoId, cfg.path),
                this.gitService.getCommits(cfg.path, commitCount),
                this.gitService.getChanges(cfg.path, withStats),
                this.gitService.getBranches(cfg.path),
                this.gitService.getConflicts(cfg.path),
            ]);
            const stashes = enableStash ? await this.gitService.getStashes(cfg.path) : [];
            const tags = enableTag ? await this.gitService.getTags(cfg.path) : [];

            const data: RepoDetailData = {
                config: cfg,
                status,
                commits,
                changes,
                branches,
                stashes,
                tags,
                busy: this.busy,
                lastResult: this.lastResult,
                conflicts,
            };
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

        // 非写操作 action
        switch (action.action) {
            case 'refresh':
                await this.loadAndRender(this.currentRepoId);
                return;
            case 'openInExplorer':
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cfg.path));
                return;
            case 'openInTerminal':
                await this.openInTerminal(cfg);
                return;
            case 'openInNewWindow':
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cfg.path), true);
                return;
            case 'copyPath':
                await vscode.env.clipboard.writeText(cfg.path);
                vscode.window.showInformationMessage('路径已复制到剪贴板');
                return;
            case 'viewDiff':
                // viewDiff 不需要 busy 状态，但走 controller 统一入口
                await this.ops.handle(action, cfg, this.makeCallbacks());
                return;
        }

        // 写操作进行中时拒绝新操作
        if (this.busy) {
            vscode.window.showWarningMessage('Git Monitor: 当前有操作进行中，请稍候');
            return;
        }

        await this.ops.handle(action, cfg, this.makeCallbacks());
    }

    /** 构造 GitOpsController 回调 */
    private makeCallbacks() {
        return {
            onBusy: (busy: boolean) => {
                this.busy = busy;
                this.postMessage({ type: 'busy', busy });
            },
            onDone: (result: GitOpResult, actionName: string) => {
                this.lastResult = {
                    action: actionName,
                    success: result.success,
                    message: result.message,
                    timestamp: Date.now(),
                };
                // 推送结果
                this.postMessage({ type: 'operationResult', result: this.lastResult });
                // 若产生冲突，推送冲突文件列表
                if (result.conflicts && result.conflicts.length > 0) {
                    this.postMessage({ type: 'conflict', files: result.conflicts });
                }
                // toast 提示
                if (result.success) {
                    vscode.window.showInformationMessage(`Git Monitor: ${result.message}`);
                } else {
                    vscode.window.showErrorMessage(`Git Monitor: ${result.message}`);
                }
                // 操作完成后重新加载详情（拉取最新状态）
                if (this.currentRepoId) {
                    void this.loadAndRender(this.currentRepoId);
                }
            },
        };
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
.toolbar-group {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding-right: 8px;
  margin-right: 8px;
  border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
}
.toolbar-group:last-child { border-right: none; padding-right: 0; margin-right: 0; }
button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 4px 12px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 12px;
}
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
button.secondary {
  background: var(--vscode-button-secondaryBackground, #5a5d5e);
  color: var(--vscode-button-secondaryForeground, #fff);
}
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #6c7071); }
button.danger {
  background: rgba(244,67,54,.8);
  color: #fff;
}
button.danger:hover:not(:disabled) { background: #f44336; }
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.small {
  padding: 2px 6px;
  font-size: 11px;
}
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
  display: flex;
  justify-content: space-between;
  align-items: center;
}
section.card > h3 .actions { display: flex; gap: 4px; }
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
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.file-group h4 .group-actions { display: flex; gap: 4px; }
ul.files { list-style: none; padding: 0; margin: 0; max-height: 280px; overflow-y: auto; }
ul.files li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
  gap: 6px;
}
ul.files li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
ul.files li.conflict {
  background: rgba(244,67,54,.1);
  border-left: 3px solid #f44336;
}
.file-info { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.file-path { word-break: break-all; }
.file-actions { display: flex; gap: 4px; flex-shrink: 0; }
.file-stat { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.file-stat .add { color: #4caf50; }
.file-stat .del { color: #f44336; }
.status-tag {
  display: inline-block;
  width: 18px;
  text-align: center;
  font-weight: bold;
  font-size: 11px;
}
.status-tag.M { color: #ffc107; }
.status-tag.A { color: #4caf50; }
.status-tag.D { color: #f44336; }
.status-tag.R { color: #2196f3; }
.status-tag.C { color: #9c27b0; }
.status-tag.Q { color: var(--vscode-descriptionForeground); }
.status-tag.U { color: #f44336; }
ul.commits { list-style: none; padding: 0; margin: 0; }
ul.commits li {
  padding: 6px 4px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.commit-main { flex: 1; min-width: 0; }
.commit-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.commit-msg { word-break: break-all; }
.commit-hash {
  font-family: monospace;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
  padding: 1px 4px;
  border-radius: 2px;
}
.commit-actions { display: flex; gap: 4px; flex-shrink: 0; }
.branch-list { font-family: monospace; font-size: 12px; }
.branch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 4px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
  gap: 6px;
}
.branch-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
.branch-name { word-break: break-all; }
.branch-name.current { font-weight: bold; color: var(--vscode-textLink-foreground, #007acc); }
.branch-name.current::before { content: '* '; }
.branch-actions { display: flex; gap: 4px; flex-shrink: 0; }
.stash-list, .tag-list { list-style: none; padding: 0; margin: 0; }
.stash-list li, .tag-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px;
  font-size: 12px;
  border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.15));
  gap: 6px;
}
.stash-list li:hover, .tag-list li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
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
.conflict-box {
  background: rgba(255,193,7,.15);
  border: 1px solid rgba(255,193,7,.5);
  color: #b08800;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
}
.conflict-box ul { margin: 4px 0 0 16px; padding: 0; }
.result-box {
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 12px;
}
.result-box.success {
  background: rgba(76,175,80,.1);
  border: 1px solid rgba(76,175,80,.4);
  color: #4caf50;
}
.result-box.fail {
  background: rgba(244,67,54,.1);
  border: 1px solid rgba(244,67,54,.4);
  color: #f44336;
}
.busy-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,.1);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  pointer-events: none;
}
.busy-text {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 12px;
}
`;

// ------------------- Webview 内联脚本 -------------------
const WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

let lastData = null;
let busy = false;

window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'loading') {
    root.innerHTML = '<div class="loading">加载中…</div>';
  } else if (msg.type === 'render') {
    lastData = msg.data;
    busy = !!msg.data.busy;
    render(msg.data);
  } else if (msg.type === 'error') {
    root.innerHTML = '<div class="error-box">加载失败：' + escapeHtml(msg.message) + '</div>';
  } else if (msg.type === 'busy') {
    busy = msg.busy;
    applyBusyState(busy);
    if (lastData) { lastData.busy = busy; }
  } else if (msg.type === 'operationResult') {
    showResult(msg.result);
    if (lastData) { lastData.lastResult = msg.result; }
  } else if (msg.type === 'conflict') {
    if (lastData) { lastData.conflicts = msg.files; }
    showConflictBox(msg.files);
  }
});

// 事件委托：通过 data-action 触发对应操作（避免内联 onclick 被 CSP 拦截）
root.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (busy) return; // 操作进行中禁用
  const action = btn.getAttribute('data-action');
  const payload = parsePayload(btn);
  send(action, payload);
});

function parsePayload(btn) {
  const payload = {};
  for (const attr of btn.attributes) {
    if (attr.name.startsWith('data-p-')) {
      const key = attr.name.slice(7); // 'data-p-'.length === 7
      payload[key] = attr.value;
    }
  }
  // 数值字段转换
  if ('index' in payload) { payload.index = parseInt(payload.index, 10); }
  if ('staged' in payload) { payload.staged = payload.staged === 'true'; }
  if ('amend' in payload) { payload.amend = payload.amend === 'true'; }
  if ('force' in payload) { payload.force = payload.force === 'true'; }
  return payload;
}

function send(action, payload) {
  vscode.postMessage({ action, ...payload });
}

function applyBusyState(isBusy) {
  document.querySelectorAll('button[data-action]').forEach(b => {
    // 非刷新按钮在 busy 时禁用
    if (isBusy && b.getAttribute('data-action') !== 'refresh') {
      b.setAttribute('disabled', 'disabled');
    } else {
      b.removeAttribute('disabled');
    }
  });
  const overlay = document.getElementById('busyOverlay');
  if (overlay) { overlay.style.display = isBusy ? 'flex' : 'none'; }
}

function showResult(result) {
  let box = document.getElementById('resultBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'resultBox';
    root.insertBefore(box, root.firstChild);
  }
  box.className = 'result-box ' + (result.success ? 'success' : 'fail');
  box.textContent = '[' + result.action + '] ' + (result.message || '');
}

function showConflictBox(files) {
  let box = document.getElementById('conflictBox');
  if (!files || files.length === 0) {
    if (box) { box.remove(); }
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = 'conflictBox';
    box.className = 'conflict-box';
    root.insertBefore(box, root.firstChild);
  }
  box.innerHTML = '<strong>⚠️ 存在未解决冲突（' + files.length + ' 个文件）：</strong><ul>' +
    files.map(f => '<li>' + escapeHtml(f) + '</li>').join('') + '</ul>' +
    '<div style="margin-top:6px">请在编辑器中手动解决冲突后提交。</div>';
}

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

function isConflictFile(path, conflicts) {
  if (!conflicts || conflicts.length === 0) { return false; }
  return conflicts.indexOf(path) >= 0;
}

function render(data) {
  const { config, status, commits, changes, branches, stashes, tags, conflicts } = data;
  const name = config.alias || (config.path.split(/[\\\\/]/).pop() || config.path);
  const level = levelOf(status);
  const conflictList = conflicts || [];

  const staged = changes.filter(c => c.staged && c.status !== 'untracked');
  const unstaged = changes.filter(c => !c.staged && c.status !== 'untracked');
  const untracked = changes.filter(c => c.status === 'untracked');

  root.innerHTML = \`
    <div id="busyOverlay" class="busy-overlay" style="display:\${busy ? 'flex' : 'none'}">
      <div class="busy-text">操作进行中…</div>
    </div>
    \${data.lastResult ? \`<div id="resultBox" class="result-box \${data.lastResult.success ? 'success' : 'fail'}">[\${escapeHtml(data.lastResult.action)}] \${escapeHtml(data.lastResult.message || '')}</div>\` : ''}
    \${conflictList.length > 0 ? \`<div id="conflictBox" class="conflict-box"><strong>⚠️ 存在未解决冲突（\${conflictList.length} 个文件）：</strong><ul>\${conflictList.map(f => '<li>' + escapeHtml(f) + '</li>').join('')}</ul><div style="margin-top:6px">请在编辑器中手动解决冲突后提交。</div></div>\` : ''}

    <h2 class="repo-title">\${escapeHtml(name)}</h2>
    <div class="subtitle">\${escapeHtml(config.path)}</div>
    <div class="toolbar">
      <div class="toolbar-group">
        <button data-action="commit">提交</button>
        <button data-action="pull">拉取</button>
        <button data-action="push">推送</button>
        <button data-action="fetch" class="secondary">获取</button>
        <button data-action="stash" class="secondary">暂存改动</button>
      </div>
      <div class="toolbar-group">
        <button data-action="refresh" class="secondary">刷新</button>
        <button data-action="openInTerminal" class="secondary">终端</button>
        <button data-action="openInExplorer" class="secondary">资源管理器</button>
        <button data-action="openInNewWindow" class="secondary">新窗口</button>
        <button data-action="copyPath" class="secondary">复制路径</button>
      </div>
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
      <h3>文件变更 <span class="actions"><button data-action="stageAll" class="small">全部暂存</button><button data-action="unstageAll" class="small secondary">取消全部暂存</button></span></h3>
      \${renderFileGroup('已暂存', staged, conflictList, true)}
      \${renderFileGroup('已修改（未暂存）', unstaged, conflictList, false)}
      \${renderFileGroup('未跟踪', untracked, conflictList, false)}
      \${changes.length === 0 ? '<div class="empty">没有文件变更</div>' : ''}
    </section>

    \${(stashes && stashes.length > 0) ? renderStashSection(stashes) : ''}

    \${(tags && tags.length > 0) ? renderTagSection(tags) : ''}

    <section class="card">
      <h3>最近提交</h3>
      \${commits.length === 0 ? '<div class="empty">暂无提交历史</div>' :
        '<ul class="commits">' + commits.map(c => renderCommit(c)).join('') + '</ul>'}
    </section>

    <section class="card">
      <h3>分支列表 <span class="actions"><button data-action="createBranch" class="small">新建分支</button></span></h3>
      \${renderBranchList(branches, status.branch)}
    </section>

    \${status.error ? \`<div class="error-box">⚠️ \${escapeHtml(status.error)}</div>\` : ''}
    \${status.lastCommit ? \`<div class="subtitle">最新提交：\${escapeHtml(status.lastCommit.shortHash)} \${escapeHtml(status.lastCommit.date)} \${escapeHtml(status.lastCommit.message)}</div>\` : ''}
  \`;
  applyBusyState(busy);
}

function renderFileGroup(title, files, conflicts, isStagedGroup) {
  if (!files || files.length === 0) return '';
  const items = files.map(f => {
    const stat = (f.additions != null || f.deletions != null)
      ? '<span class="file-stat"><span class="add">+' + (f.additions ?? 0) + '</span> <span class="del">-' + (f.deletions ?? 0) + '</span></span>'
      : '';
    const conflict = isConflictFile(f.path, conflicts);
    const actions = renderFileActions(f, isStagedGroup, conflict);
    return '<li class="' + (conflict ? 'conflict' : '') + '">'
      + '<span class="file-info"><span class="status-tag ' + statusTag(f.status) + (conflict ? ' U' : '') + '">' + (conflict ? 'U' : statusTag(f.status)) + '</span><span class="file-path">' + escapeHtml(f.path) + '</span></span>'
      + '<span class="file-actions">' + stat + actions + '</span>'
      + '</li>';
  }).join('');
  return '<div class="file-group"><h4>' + escapeHtml(title) + ' (' + files.length + ')</h4><ul class="files">' + items + '</ul></div>';
}

function renderFileActions(f, isStagedGroup, conflict) {
  let btns = '';
  if (conflict) { return '<span class="file-stat" style="color:#f44336">冲突</span>'; }
  // 查看差异按钮（已暂存看 vs HEAD，未暂存看 vs 工作区）
  if (f.status !== 'untracked') {
    btns += '<button class="small secondary" data-action="viewDiff" data-p-path="' + escapeAttr(f.path) + '" data-p-staged="' + (isStagedGroup ? 'true' : 'false') + '">差异</button>';
  }
  if (f.status === 'untracked') {
    btns += '<button class="small" data-action="stage" data-p-path="' + escapeAttr(f.path) + '">+暂存</button>';
    btns += '<button class="small secondary" data-action="ignore" data-p-path="' + escapeAttr(f.path) + '">忽略</button>';
  } else if (isStagedGroup) {
    btns += '<button class="small secondary" data-action="unstage" data-p-path="' + escapeAttr(f.path) + '">-取消暂存</button>';
  } else {
    btns += '<button class="small" data-action="stage" data-p-path="' + escapeAttr(f.path) + '">+暂存</button>';
    btns += '<button class="small danger" data-action="discard" data-p-path="' + escapeAttr(f.path) + '">撤销</button>';
  }
  return btns;
}

function renderCommit(c) {
  return '<li>'
    + '<div class="commit-main">'
    +   '<div class="commit-meta"><span class="commit-hash">' + escapeHtml(c.shortHash) + '</span> ' + escapeHtml(c.author) + ' · ' + escapeHtml(c.date) + '</div>'
    +   '<div class="commit-msg">' + escapeHtml(c.message) + '</div>'
    + '</div>'
    + '<div class="commit-actions"><button class="small secondary" data-action="createTag" data-p-commit="' + escapeAttr(c.shortHash) + '">打标签</button></div>'
    + '</li>';
}

function renderBranchList(branches, currentBranch) {
  const local = (branches.local || []).map(b => {
    const name = b.replace(/^\\*/, '').trim();
    const isCurrent = name === currentBranch;
    const btn = isCurrent ? '' : '<button class="small" data-action="checkout" data-p-branch="' + escapeAttr(name) + '">切换</button><button class="small danger" data-action="deleteBranch" data-p-branch="' + escapeAttr(name) + '">删除</button>';
    return '<div class="branch-row"><span class="branch-name ' + (isCurrent ? 'current' : '') + '">' + escapeHtml(name) + '</span><span class="branch-actions">' + btn + '</span></div>';
  }).join('');
  const remote = (branches.remote || []).map(b => {
    return '<div class="branch-row"><span class="branch-name">' + escapeHtml(b) + '</span><span class="branch-actions"><button class="small" data-action="checkout" data-p-branch="' + escapeAttr(b) + '">切换</button></span></div>';
  }).join('');
  return '<div class="branch-list">' + local + remote + '</div>';
}

function renderStashSection(stashes) {
  const items = stashes.map(s => {
    return '<li><span>stash@{' + s.index + '} ' + escapeHtml(s.message || '') + '</span>'
      + '<span class="branch-actions"><button class="small" data-action="stashPop" data-p-index="' + s.index + '">恢复</button><button class="small danger" data-action="stashDrop" data-p-index="' + s.index + '">丢弃</button></span></li>';
  }).join('');
  return '<section class="card"><h3>暂存区 (Stash)</h3><ul class="stash-list">' + items + '</ul></section>';
}

function renderTagSection(tags) {
  const items = tags.map(t => {
    const meta = (t.annotated ? '注解' : '轻量') + ' · ' + escapeHtml(t.commit) + (t.date ? ' · ' + escapeHtml(t.date) : '');
    return '<li><span><strong>' + escapeHtml(t.name) + '</strong> <span class="file-stat">' + meta + '</span>' + (t.message ? '<div class="file-stat">' + escapeHtml(t.message) + '</div>' : '') + '</span>'
      + '<span class="branch-actions"><button class="small danger" data-action="deleteTag" data-p-name="' + escapeAttr(t.name) + '">删除</button></span></li>';
  }).join('');
  return '<section class="card"><h3>标签 (Tags) <span class="actions"><button data-action="createTag" class="small">新建标签</button></span></h3><ul class="tag-list">' + items + '</ul></section>';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
`;

