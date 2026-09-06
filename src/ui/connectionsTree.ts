import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import {
  ConnectionInfo,
  ConnectionProfile,
  EnvironmentId,
  authLabel,
  environmentLabel,
  transportLabel
} from '../types';

const SHORT: Record<EnvironmentId, string> = { dev: 'DEV', qa: 'QA', uat: 'UAT', prod: 'PROD' };

/** Riskiest first, so a production profile is never scrolled out of sight. */
const RANK: Record<EnvironmentId, number> = { dev: 0, qa: 1, uat: 2, prod: 3 };

const TINT: Record<EnvironmentId, string> = {
  dev: 'charts.green',
  qa: 'charts.blue',
  uat: 'charts.orange',
  prod: 'charts.red'
};

/**
 * One saved connection.
 *
 * The environment is carried by a dot and by the short label in the
 * description, so the reading survives a monochrome screen. A filled dot means
 * there is a live session, an outlined one means there is not.
 */
export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    readonly profile: ConnectionProfile,
    readonly connected: boolean,
    info?: ConnectionInfo
  ) {
    const label = profile.name || profile.host || 'Untitled connection';
    super(label, vscode.TreeItemCollapsibleState.None);

    const environment = profile.environment;
    const target = `${profile.host || 'no host'}${profile.port ? `:${profile.port}` : ''}`;

    this.id = profile.id;
    this.description = `${SHORT[environment]} · ${target}`;
    this.iconPath = new vscode.ThemeIcon(
      connected ? 'circle-filled' : 'circle-outline',
      new vscode.ThemeColor(TINT[environment])
    );
    this.contextValue = connected ? 'databaseConnection.open' : 'databaseConnection.closed';
    this.command = {
      command: 'databaseTools.openConnections',
      title: 'Open the connection',
      arguments: [profile.id]
    };
    this.accessibilityInformation = {
      label: `${label}, ${environmentLabel(environment)}, ${connected ? 'connected' : 'not connected'}`
    };

    const lines = [
      `**${label}**`,
      `${profile.driver === 'mssql' ? 'SQL Server' : 'PostgreSQL'} · ${authLabel(profile)} · ${transportLabel(profile)}`,
      `${target} · ${profile.database || 'default database'}`,
      `${environmentLabel(environment)}${profile.readOnly ? ' · read-only' : ''}`
    ];
    if (info) {
      lines.push(`${info.serverVersion} · ${info.principal}`);
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
  }
}

/**
 * The activity bar view. It owns no state of its own: the store holds the
 * profiles, the manager holds the sessions, and this redraws whenever either
 * one changes.
 */
export class ConnectionsTree implements vscode.TreeDataProvider<ConnectionTreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly view: vscode.TreeView<ConnectionTreeItem>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager
  ) {
    this.view = vscode.window.createTreeView('databaseTools.connections', {
      treeDataProvider: this,
      showCollapseAll: false
    });

    this.disposables.push(
      this.view,
      this.changeEmitter,
      this.store.onDidChange(() => this.refresh()),
      this.manager.onDidChange(() => this.refresh())
    );

    this.refresh();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionTreeItem): ConnectionTreeItem[] {
    if (element) {
      return [];
    }
    return this.store
      .all()
      .sort((a, b) => RANK[b.environment] - RANK[a.environment] || a.name.localeCompare(b.name))
      .map(
        (profile) =>
          new ConnectionTreeItem(profile, this.manager.isConnected(profile.id), this.manager.infoFor(profile.id))
      );
  }

  private refresh(): void {
    const open = this.manager.activeIds().length;
    this.view.badge =
      open > 0
        ? { value: open, tooltip: open === 1 ? '1 open connection' : `${open} open connections` }
        : undefined;
    this.changeEmitter.fire();
  }
}
