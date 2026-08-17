import * as vscode from 'vscode';
import * as path from 'path';
import { RepoConfig, RepoStatus, StatusLevel } from '../models/types';

/**
 * 仓库列表条目。承载配置与最新状态，负责渲染为 TreeItem。
 */
export class RepoTreeItem extends vscode.TreeItem {
    constructor(
        public readonly config: RepoConfig,
        public status: RepoStatus | undefined,
    ) {
        super(RepoTreeItem.buildLabel(config), vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'repo';
        this.id = config.id;
        this.refresh(status);
    }

    /** 更新状态后重渲染描述、图标、tooltip */
    refresh(status: RepoStatus | undefined): void {
        this.status = status;
        if (!status) {
            this.description = '加载中…';
            this.tooltip = new vscode.MarkdownString(
                `**${this.escape(this.labelStr())}**\n\n路径: \`${this.config.path}\`\n\n状态: 加载中…`
            );
            this.iconPath = new vscode.ThemeIcon('loading~spin');
            return;
        }
        const level = RepoTreeItem.levelOf(status);
        this.description = RepoTreeItem.buildDescription(status);
        this.iconPath = RepoTreeItem.iconFor(level);
        this.tooltip = RepoTreeItem.buildTooltip(this.config, status);
        this.command = {
            command: 'gitMonitor.openDetail',
            title: '打开详情',
            arguments: [this.config.id],
        };
    }

    private labelStr(): string {
        return this.config.alias || path.basename(this.config.path);
    }

    private escape(s: string): string {
        return s.replace(/[\\`*_{}[\]()#+\-.!]/g, m => '\\' + m);
    }

    private static buildLabel(config: RepoConfig): string {
        return config.alias || path.basename(config.path);
    }

    private static buildDescription(status: RepoStatus): string {
        const parts: string[] = [];
        parts.push(status.branch || '-');
        if (status.ahead > 0) { parts.push(`↑${status.ahead}`); }
        if (status.behind > 0) { parts.push(`↓${status.behind}`); }
        const dirtyParts: string[] = [];
        if (status.stagedCount > 0) { dirtyParts.push(`+${status.stagedCount}`); }
        if (status.modifiedCount > 0) { dirtyParts.push(`~${status.modifiedCount}`); }
        if (status.untrackedCount > 0) { dirtyParts.push(`?${status.untrackedCount}`); }
        if (dirtyParts.length > 0) {
            parts.push(dirtyParts.join(' '));
        }
        if (status.error) {
            parts.push('[错误]');
        }
        return parts.join(' · ');
    }

    private static buildTooltip(config: RepoConfig, status: RepoStatus): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;
        md.appendMarkdown(`**${config.alias || path.basename(config.path)}**\n\n`);
        md.appendMarkdown(`- 路径: \`${config.path}\`\n`);
        md.appendMarkdown(`- 分支: \`${status.branch || '-'}\`${status.detached ? ' (detached)' : ''}\n`);
        if (status.upstream) { md.appendMarkdown(`- 上游: \`${status.upstream}\`\n`); }
        if (status.remoteUrl) { md.appendMarkdown(`- 远端: \`${status.remoteUrl}\`\n`); }
        md.appendMarkdown(`- 领先: \`${status.ahead}\`  落后: \`${status.behind}\`\n`);
        md.appendMarkdown(`- 已暂存: \`${status.stagedCount}\`  已修改: \`${status.modifiedCount}\`  未跟踪: \`${status.untrackedCount}\`\n`);
        if (status.isClean) { md.appendMarkdown(`- 工作区: \`${'干净'}\`\n`); }
        if (status.lastCommit) {
            md.appendMarkdown(`- 最新提交: \`${status.lastCommit.shortHash}\` ${status.lastCommit.date} ${this.escapeMd(status.lastCommit.message)}\n`);
            md.appendMarkdown(`  作者: ${this.escapeMd(status.lastCommit.author)}\n`);
        }
        if (status.error) { md.appendMarkdown(`\n> ⚠️ ${this.escapeMd(status.error)}\n`); }
        return md;
    }

    private static escapeMd(s: string): string {
        return s.replace(/[\\`*_{}[\]()#+\-.!]/g, m => '\\' + m);
    }

    private static iconFor(level: StatusLevel): vscode.ThemeIcon {
        switch (level) {
            case 'clean': return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            case 'dirty': return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('list.warningForeground'));
            case 'ahead': return new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.green'));
            case 'behind': return new vscode.ThemeIcon('arrow-down', new vscode.ThemeColor('charts.blue'));
            case 'error': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground'));
            default: return new vscode.ThemeIcon('circle-slash');
        }
    }

    private static levelOf(status: RepoStatus): StatusLevel {
        if (status.error) { return 'error'; }
        if (status.behind > 0) { return 'behind'; }
        if (status.ahead > 0) { return 'ahead'; }
        if (!status.isClean) { return 'dirty'; }
        return 'clean';
    }
}
