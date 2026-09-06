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

const GROUPED_KEY = 'databaseTools.tree.grouped';
const COLLAPSED_KEY = 'databaseTools.tree.collapsed';

/**
 * One environment heading. Present only while grouping is on, and skipped
 * entirely for an environment that holds nothing.
 */
export class EnvironmentTreeItem extends vscode.TreeItem {
  constructor(
    readonly environment: EnvironmentId,
    count: number,
    open: number,
    expanded: boolean
  ) {
    super(
      environmentLabel(environment).toUpperCase(),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.id = `environment:${environment}`;
    this.description = open > 0 ? `${count} · ${open} open` : String(count);
    this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(TINT[environment]));
    this.contextValue = 'databaseEnvironment';
    this.tooltip = `${environmentLabel(environment)} · ${count === 1 ? '1 connection' : `${count} connections`}`;
    this.accessibilityInformation = {
      label: `${environmentLabel(environment)}, ${count === 1 ? '1 connection' : `${count} connections`}`
    };
  }
}

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
    info?: ConnectionInfo,
    grouped = false,
    failure?: string
  ) {
    const label = profile.name || profile.host || 'Untitled connection';
    super(label, vscode.TreeItemCollapsibleState.None);

    const environment = profile.environment;
    const target = `${profile.host || 'no host'}${profile.port ? `:${profile.port}` : ''}`;

    this.id = profile.id;
    // Under an environment heading the short label is already overhead.
    this.description = grouped ? target : `${SHORT[environment]} · ${target}`;
    // Three states, three shapes: a filled dot for a live session, a hollow
    // one for a saved connection, a warning for one whose last attempt failed.
    // The colour says which environment; the shape says what state it is in,
    // so neither reading depends on the other.
    this.iconPath = connected
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(TINT[environment]))
      : failure
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
        : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor(TINT[environment]));
    this.contextValue = connected ? 'databaseConnection.open' : 'databaseConnection.closed';
    this.command = {
      command: 'databaseTools.openConnections',
      title: 'Open the connection',
      arguments: [profile.id]
    };
    const state = connected ? 'connected' : failure ? `last attempt failed, ${failure}` : 'saved, not connected';
    this.accessibilityInformation = {
      label: `${label}, ${environmentLabel(environment)}, ${state}`
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
    if (!connected && failure) {
      lines.push(`$(warning) ${failure}`);
    }
    const tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    tooltip.supportThemeIcons = true;
    this.tooltip = tooltip;
  }
}

/** Shown in place of the list when a filter hides everything. */
class NoMatchTreeItem extends vscode.TreeItem {
  constructor(filter: string) {
    super(`No connection matches “${filter}”`, vscode.TreeItemCollapsibleState.None);
    this.id = 'databaseTools.noMatch';
    this.iconPath = new vscode.ThemeIcon('info');
    this.description = 'Clear the filter';
    this.command = { command: 'databaseTools.clearFilter', title: 'Clear the filter' };
  }
}

export type ConnectionsNode = EnvironmentTreeItem | ConnectionTreeItem | NoMatchTreeItem;

/**
 * The activity bar view, and the only list of connections there is. It owns no
 * profile state of its own: the store holds the profiles, the manager holds the
 * sessions, and this redraws whenever either one changes. What it does own is
 * the reading of that list — the filter and whether environments are grouped.
 */
export class ConnectionsTree implements vscode.TreeDataProvider<ConnectionsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionsNode | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly view: vscode.TreeView<ConnectionsNode>;
  private readonly disposables: vscode.Disposable[] = [];

  private filter = '';
  private grouped: boolean;
  private collapsed: Set<EnvironmentId>;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly memento: vscode.Memento
  ) {
    this.grouped = memento.get<boolean>(GROUPED_KEY, true);
    this.collapsed = new Set(memento.get<EnvironmentId[]>(COLLAPSED_KEY, []));

    this.view = vscode.window.createTreeView('databaseTools.connections', {
      treeDataProvider: this,
      showCollapseAll: false
    });

    this.disposables.push(
      this.view,
      this.changeEmitter,
      this.store.onDidChange(() => this.refresh()),
      this.manager.onDidChange(() => this.refresh()),
      this.view.onDidCollapseElement((e) => this.rememberExpansion(e.element, false)),
      this.view.onDidExpandElement((e) => this.rememberExpansion(e.element, true))
    );

    void vscode.commands.executeCommand('setContext', 'databaseTools.grouped', this.grouped);
    void vscode.commands.executeCommand('setContext', 'databaseTools.filtered', false);
    this.refresh();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /* ---------------------------------------------------------------- tree */

  getTreeItem(element: ConnectionsNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionsNode): ConnectionsNode[] {
    if (element instanceof EnvironmentTreeItem) {
      return this.itemsFor(element.environment);
    }
    if (element) {
      return [];
    }

    const matching = this.matching();
    if (matching.length === 0) {
      // An empty list would hand the view over to the welcome content, which
      // says there are no connections. There are, they are just filtered out.
      return this.filter.trim() ? [new NoMatchTreeItem(this.filter.trim())] : [];
    }

    if (!this.grouped) {
      return matching
        .sort((a, b) => RANK[b.environment] - RANK[a.environment] || a.name.localeCompare(b.name))
        .map((profile) => this.itemFor(profile, false));
    }

    const environments = [...new Set(matching.map((p) => p.environment))].sort((a, b) => RANK[b] - RANK[a]);
    return environments.map((environment) => {
      const items = matching.filter((p) => p.environment === environment);
      const open = items.filter((p) => this.manager.isConnected(p.id)).length;
      // A filter that hides the matches inside a collapsed group would read as
      // a filter that found nothing, so searching always opens what it found.
      const expanded = Boolean(this.filter.trim()) || !this.collapsed.has(environment);
      return new EnvironmentTreeItem(environment, items.length, open, expanded);
    });
  }

  getParent(element: ConnectionsNode): ConnectionsNode | undefined {
    if (!this.grouped || !(element instanceof ConnectionTreeItem)) {
      return undefined;
    }
    const environment = element.profile.environment;
    const items = this.matching().filter((p) => p.environment === environment);
    if (items.length === 0) {
      return undefined;
    }
    const open = items.filter((p) => this.manager.isConnected(p.id)).length;
    return new EnvironmentTreeItem(environment, items.length, open, true);
  }

  private itemsFor(environment: EnvironmentId): ConnectionTreeItem[] {
    return this.matching()
      .filter((p) => p.environment === environment)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => this.itemFor(profile, true));
  }

  private itemFor(profile: ConnectionProfile, grouped: boolean): ConnectionTreeItem {
    return new ConnectionTreeItem(
      profile,
      this.manager.isConnected(profile.id),
      this.manager.infoFor(profile.id),
      grouped,
      this.manager.lastFailure(profile.id)
    );
  }

  /* -------------------------------------------------------------- filter */

  /** Profiles left after the filter. Name and host, the way the rail read them. */
  private matching(): ConnectionProfile[] {
    const needle = this.filter.trim().toLowerCase();
    const profiles = this.store.all();
    if (!needle) {
      return profiles;
    }
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.host.toLowerCase().includes(needle) ||
        p.database.toLowerCase().includes(needle)
    );
  }

  /**
   * The filter box. It narrows the list on every keystroke; Enter keeps the
   * filter, Escape puts back whatever was there before. It returns as soon as
   * the box is on screen, because the list has to keep redrawing while it is.
   */
  promptForFilter(): void {
    const previous = this.filter;
    const input = vscode.window.createInputBox();
    input.title = 'Filter connections';
    input.placeholder = 'Name, host or database';
    input.prompt = 'Enter keeps the filter, Escape restores the list';
    input.value = previous;

    let accepted = false;
    input.onDidChangeValue((value) => this.applyFilter(value));
    input.onDidAccept(() => {
      accepted = true;
      input.hide();
    });
    input.onDidHide(() => {
      if (!accepted) {
        this.applyFilter(previous);
      }
      input.dispose();
    });
    input.show();
  }

  clearFilter(): void {
    this.applyFilter('');
  }

  private applyFilter(value: string): void {
    if (value === this.filter) {
      return;
    }
    this.filter = value;
    void vscode.commands.executeCommand('setContext', 'databaseTools.filtered', Boolean(value.trim()));
    this.refresh();
  }

  /* ------------------------------------------------------------ grouping */

  async setGrouped(grouped: boolean): Promise<void> {
    if (grouped === this.grouped) {
      return;
    }
    this.grouped = grouped;
    await this.memento.update(GROUPED_KEY, grouped);
    void vscode.commands.executeCommand('setContext', 'databaseTools.grouped', grouped);
    this.refresh();
  }

  private rememberExpansion(element: ConnectionsNode, expanded: boolean): void {
    if (!(element instanceof EnvironmentTreeItem)) {
      return;
    }
    if (expanded) {
      this.collapsed.delete(element.environment);
    } else {
      this.collapsed.add(element.environment);
    }
    void this.memento.update(COLLAPSED_KEY, [...this.collapsed]);
  }

  /* -------------------------------------------------------------- reveal */

  /** Keeps the list in step with the editor, whatever opened it. */
  async reveal(profileId: string): Promise<void> {
    const profile = this.store.get(profileId);
    if (!profile) {
      return;
    }
    // A filtered-out profile cannot be revealed, and dropping the filter
    // silently would be worse than leaving the selection where it is.
    if (!this.matching().some((p) => p.id === profileId)) {
      return;
    }
    try {
      await this.view.reveal(this.itemFor(profile, this.grouped), {
        select: true,
        focus: false,
        expand: true
      });
    } catch {
      // The view can be closed, or the item gone by the time this lands.
    }
  }

  /* -------------------------------------------------------------- redraw */

  private refresh(): void {
    const open = this.manager.activeIds().length;
    this.view.badge =
      open > 0
        ? { value: open, tooltip: open === 1 ? '1 open connection' : `${open} open connections` }
        : undefined;
    this.view.description = this.countLabel();
    this.changeEmitter.fire();
  }

  /** What the rail footer used to say, in the space the view title leaves. */
  private countLabel(): string | undefined {
    const total = this.store.all().length;
    if (total === 0) {
      return undefined;
    }
    const needle = this.filter.trim();
    if (!needle) {
      return total === 1 ? '1 connection' : `${total} connections`;
    }
    return `${this.matching().length} of ${total}`;
  }
}
