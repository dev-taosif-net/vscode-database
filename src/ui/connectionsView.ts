import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import {
  ConnectionRow,
  ConnectionState,
  SessionUpdate,
  SidebarHostMessage,
  SidebarState,
  SidebarWebviewMessage,
  SortOrder
} from '../shared/sidebar';
import { ObjectPageRequest } from '../shared/catalog';
import { ConnectionProfile, ENVIRONMENTS, EnvironmentId } from '../types';

const GROUPED_KEY = 'databaseTools.view.grouped';
const COLLAPSED_KEY = 'databaseTools.view.collapsed';
const SORT_KEY = 'databaseTools.view.sort';

/**
 * The connections sidebar.
 *
 * It replaced a `TreeDataProvider`, and the reason is worth writing down: a
 * tree row is a label, a description and one icon, drawn by the workbench. The
 * list this product needs carries a name, a host, a database, a state, an
 * environment and a hover rail, and it has to stay readable at a hundred rows.
 * None of that is expressible as a `TreeItem`, so the view became a webview and
 * draws itself.
 *
 * What did not change is where state lives. The store owns the profiles, the
 * manager owns the sessions, and this owns only the reading of that list —
 * grouping, sort and which environments are folded away. It holds no profile of
 * its own and no session of its own.
 */
export class ConnectionsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'databaseTools.connections';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];

  private selectedId: string | undefined;
  private grouped: boolean;
  private sort: SortOrder;
  private collapsed: Set<EnvironmentId>;
  /** Whether the panel currently has a search narrowing the list. */
  private filtered = false;
  /** How many rows survived that search. Meaningless while `filtered` is off. */
  private matched = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly catalog: CatalogService
  ) {
    const memento = context.globalState;
    this.grouped = memento.get<boolean>(GROUPED_KEY, true);
    this.sort = coerceSort(memento.get<string>(SORT_KEY));
    this.collapsed = new Set(memento.get<EnvironmentId[]>(COLLAPSED_KEY, []));
    this.selectedId = this.store.all()[0]?.id;

    // This split is the whole performance argument. A profile change rebuilds
    // the row array, and with it the panel's flattened index; a session change
    // must not, because it visually touches one row. Sending `state` from the
    // manager handed every windowed row a new identity twice per connect
    // attempt — once when `busyKind` turned on and once when it turned off.
    this.disposables.push(
      this.store.onDidChange(() => void this.postState()),
      this.manager.onDidChange(() => void this.postSessions()),
      // A dropped session or an explicit Refresh empties the tree below a
      // connection. The panel is told rather than left holding rows it can no
      // longer act on, and it re-asks for whatever is still expanded.
      this.catalog.onDidInvalidate((profileId) => void this.send({ type: 'catalogCleared', profileId }))
    );

    void vscode.commands.executeCommand('setContext', 'databaseTools.grouped', this.grouped);
    void vscode.commands.executeCommand('setContext', 'databaseTools.filtered', false);
  }

  dispose(): void {
    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /* ---------------------------------------------------------------- view */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    };
    view.webview.html = this.html(view.webview);

    // A view is resolved again when it is dragged to another container, so the
    // previous subscriptions are dropped rather than stacked.
    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
        void this.onMessage(message);
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      })
    );

    void this.postState();
  }

  /* ------------------------------------------------------------ messages */

  private async onMessage(message: SidebarWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        return;

      case 'open':
        this.selectedId = message.id;
        await vscode.commands.executeCommand('databaseTools.openConnections', message.id);
        return;

      case 'connect':
        await vscode.commands.executeCommand('databaseTools.connect', message.id);
        return;

      case 'disconnect':
        await this.manager.disconnect(message.id);
        return;

      case 'cancel':
        this.manager.cancel(message.id);
        return;

      case 'delete':
        await vscode.commands.executeCommand('databaseTools.deleteConnection', message.id);
        return;

      case 'new':
        await vscode.commands.executeCommand('databaseTools.newConnection');
        return;

      case 'filtered':
        // The query lives in the panel, so the host cannot count it. This
        // message is the only way the description can say "12 of 84" the way
        // the tree's own count label did.
        this.filtered = message.on;
        this.matched = message.matched;
        void vscode.commands.executeCommand('setContext', 'databaseTools.filtered', message.on);
        this.updateChrome();
        return;

      case 'collapse':
        if (message.on) {
          this.collapsed.add(message.environment);
        } else {
          this.collapsed.delete(message.environment);
        }
        await this.context.globalState.update(COLLAPSED_KEY, [...this.collapsed]);
        return;

      case 'loadCatalog':
        await this.loadCatalog(message.profileId);
        return;

      case 'loadNode':
        await this.loadNode(message);
        return;

      case 'loadMembers':
        await this.loadMembers(message.profileId, message.node, message.ref);
        return;

      case 'searchObjects':
        await this.searchObjects(message.query);
        return;

      default:
        return;
    }
  }

  /* ------------------------------------------------------------- explorer */

  /*
   * Four handlers, one shape.
   *
   * Each answers exactly the request it was given, addressed by the node key
   * that came in, and each reports its own failure to that node rather than to
   * the panel at large. A folder that cannot be read says so on itself and
   * leaves the rest of the tree alone — which matters most on the connection
   * where it is most likely, a production login with rights to four schemas out
   * of forty.
   */

  private async loadCatalog(profileId: string): Promise<void> {
    try {
      const summary = await this.catalog.summary(profileId);
      await this.send({ type: 'catalog', profileId, summary });
    } catch (error) {
      await this.send({ type: 'catalogError', profileId, message: reason(error) });
    }
  }

  private async loadNode(request: ObjectPageRequest): Promise<void> {
    try {
      const page = await this.catalog.page({ ...request, limit: request.limit || this.catalog.pageSize() });
      await this.send({ type: 'objects', ...page });
    } catch (error) {
      await this.send({
        type: 'nodeError',
        profileId: request.profileId,
        node: request.node,
        message: reason(error)
      });
    }
  }

  private async loadMembers(
    profileId: string,
    node: string,
    ref: { kind: ObjectPageRequest['kind']; schema: string; name: string }
  ): Promise<void> {
    try {
      const members = await this.catalog.members(profileId, ref);
      await this.send({ type: 'members', profileId, node, members });
    } catch (error) {
      await this.send({ type: 'nodeError', profileId, node, message: reason(error) });
    }
  }

  /**
   * Asks every open connection at once.
   *
   * The connections are searched in parallel and each answer is posted the
   * moment it lands, so a fast local database does not wait behind a slow
   * remote one. A connection that fails is skipped in silence: the panel is
   * already showing the matches it found locally, and an error strip per
   * unreachable server would bury them.
   */
  private async searchObjects(query: string): Promise<void> {
    const open = this.manager.activeIds();
    await Promise.all(
      open.map(async (profileId) => {
        try {
          const answer = await this.catalog.search(profileId, query);
          if (answer.objects.length > 0) {
            await this.send({ type: 'searchAnswer', ...answer });
          }
        } catch {
          // Deliberately quiet. See above.
        }
      })
    );
  }

  /* -------------------------------------------------------------- public */

  focusSearch(): void {
    this.reveal();
    void this.send({ type: 'focusSearch' });
  }

  clearSearch(): void {
    this.filtered = false;
    this.matched = 0;
    void vscode.commands.executeCommand('setContext', 'databaseTools.filtered', false);
    void this.send({ type: 'clearSearch' });
    this.updateChrome();
  }

  async setGrouped(grouped: boolean): Promise<void> {
    if (grouped === this.grouped) {
      return;
    }
    this.grouped = grouped;
    await this.context.globalState.update(GROUPED_KEY, grouped);
    void vscode.commands.executeCommand('setContext', 'databaseTools.grouped', grouped);
    await this.postState();
  }

  async setSort(sort: SortOrder): Promise<void> {
    if (sort === this.sort) {
      return;
    }
    this.sort = sort;
    await this.context.globalState.update(SORT_KEY, sort);
    await this.postState();
  }

  /**
   * Folds or unfolds every environment at once — the orientation gesture, and
   * the reason a hundred-row list can be read on one screen. The memento is
   * written before anything is sent, because the panel answers a fold with a
   * `collapse` message of its own and the two would otherwise race for the key.
   */
  async collapseAll(on: boolean): Promise<void> {
    this.collapsed = new Set(on ? ENVIRONMENTS.map((meta) => meta.id) : []);
    await this.context.globalState.update(COLLAPSED_KEY, [...this.collapsed]);
    await this.send({ type: 'collapseAll', on });
    await this.postState();
  }

  /**
   * Redraws, and forgets every remembered failure. It forgets them; it does not
   * retry anything, so a row that has gone quiet is a row nobody has tried
   * since — not a row that has just succeeded.
   */
  async refresh(): Promise<void> {
    this.manager.clearFailures();
    await this.postState();
  }

  /**
   * Sort and grouping in one list rather than two submenus, because both are
   * readings of the same list and the reading in force has to be visible for
   * the menu to be worth opening. The check column is a codicon, so it survives
   * every theme and does not depend on a glyph the font may not carry.
   */
  async showViewOptions(): Promise<void> {
    const mark = (on: boolean): string => (on ? '$(check)' : '$(blank)');
    const items: Array<vscode.QuickPickItem & { action?: string }> = [
      { label: 'Sort by', kind: vscode.QuickPickItemKind.Separator },
      {
        label: `${mark(this.sort === 'environment')} Environment`,
        description: 'Dev, QA, UAT, Production',
        action: 'sort:environment'
      },
      { label: `${mark(this.sort === 'name')} Name`, action: 'sort:name' },
      {
        label: `${mark(this.sort === 'recent')} Recently updated`,
        action: 'sort:recent'
      },
      { label: 'Grouping', kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(this.grouped)} Group by environment`, action: 'group:on' },
      { label: `${mark(!this.grouped)} Flat list`, action: 'group:off' }
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: 'Connections view',
      placeHolder: 'Choose how the list is ordered'
    });

    switch (pick?.action) {
      case 'sort:environment':
        await this.setSort('environment');
        return;
      case 'sort:name':
        await this.setSort('name');
        return;
      case 'sort:recent':
        await this.setSort('recent');
        return;
      case 'group:on':
        await this.setGrouped(true);
        return;
      case 'group:off':
        await this.setGrouped(false);
        return;
      default:
        return;
    }
  }

  /** Keeps the list in step with the editor, whatever opened it. */
  async select(id: string): Promise<void> {
    if (!this.store.get(id)) {
      return;
    }
    this.selectedId = id;
    await this.postState();
    await this.send({ type: 'reveal', id });
  }

  /** Brings the view on screen without taking focus away from the editor. */
  private reveal(): void {
    this.view?.show?.(true);
  }

  /* --------------------------------------------------------------- state */

  private async send(message: SidebarHostMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const profiles = this.store.all();
    if (this.selectedId && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = profiles[0]?.id;
    }

    const state: SidebarState = {
      rows: profiles.map((profile) => rowFor(profile, this.store)),
      selectedId: this.selectedId ?? null,
      grouped: this.grouped,
      sort: this.sort,
      collapsed: [...this.collapsed]
    };
    await this.send({ type: 'state', ...state });
    // The sessions follow the structure they annotate, in the same turn, so no
    // first paint ever shows a live connection as merely saved.
    await this.postSessions();
  }

  private async postSessions(): Promise<void> {
    if (!this.view) {
      return;
    }

    const active: SessionUpdate[] = [];
    for (const profile of this.store.all()) {
      const update = this.sessionFor(profile.id);
      if (update) {
        active.push(update);
      }
    }
    await this.send({ type: 'sessions', active });
    this.updateChrome();
  }

  /**
   * Everything about the view the webview is not allowed to draw. A webview
   * cannot set the badge, the description or the title, and the badge is the
   * only count visible when the sidebar is closed — which is why a session
   * change has to come through here even though it sends no rows.
   */
  private updateChrome(): void {
    if (!this.view) {
      return;
    }
    const total = this.store.all().length;
    const open = this.manager.activeIds().length;

    this.view.badge =
      open > 0
        ? { value: open, tooltip: open === 1 ? '1 open connection' : `${open} open connections` }
        : undefined;
    this.view.description = this.filtered ? `${this.matched} of ${total}` : describe(total, open);

    void vscode.commands.executeCommand('setContext', 'databaseTools.hasActiveConnection', open > 0);
  }

  /**
   * The volatile half of a row, or nothing at all when the profile is merely
   * saved. A profile absent from `active` is saved, so the panel replaces the
   * whole map rather than diffing it, and there is no wrong answer to get: a
   * row whose session has ended is a row that has simply stopped being sent.
   */
  private sessionFor(id: string): SessionUpdate | undefined {
    const failure = this.manager.lastFailure(id);
    const state = this.stateOf(id, failure);
    if (state === 'saved') {
      return undefined;
    }

    const update: SessionUpdate = { id, state };
    if (state === 'failed' && failure) {
      update.failure = failure;
    }
    const info = state === 'connected' ? this.manager.infoFor(id) : undefined;
    if (info) {
      update.session = {
        serverVersion: info.serverVersion,
        principal: info.principal,
        latencyMs: info.latencyMs,
        readOnly: info.readOnly,
        connectedAt: info.connectedAt
      };
    }
    return update;
  }

  /**
   * Five states, in the order they win. An attempt in flight beats everything,
   * because it is the only one that is about to change; a live session beats a
   * remembered failure, because the failure is already out of date.
   */
  private stateOf(id: string, failure: string | undefined): ConnectionState {
    const busy = this.manager.busyKind(id);
    if (busy === 'connect') {
      return 'connecting';
    }
    if (busy === 'test') {
      return 'testing';
    }
    if (this.manager.isConnected(id)) {
      return 'connected';
    }
    return failure ? 'failed' : 'saved';
  }

  /* ---------------------------------------------------------------- html */

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', ...parts));

    // The same policy the editor runs under: no network at all. Everything the
    // panel needs ships with the extension.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('codicon.css')}" rel="stylesheet">
<link href="${asset('sidebar.css')}" rel="stylesheet">
<title>Database Connections</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('sidebar.js')}"></script>
</body>
</html>`;
  }
}

/**
 * The structural projection of a profile. Forty fields go in and ten come out,
 * none of them credential-adjacent — a bug in the panel cannot leak a login
 * name it was never sent.
 */
function rowFor(profile: ConnectionProfile, store: ConnectionStore): ConnectionRow {
  return {
    id: profile.id,
    name: profile.name,
    driver: profile.driver,
    environment: profile.environment,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    favourite: store.isFavourite(profile.id),
    readOnly: profile.readOnly,
    updatedAt: profile.updatedAt,
    mode: store.explorerMode(profile.id),
    pins: store.objectFavourites(profile.id)
  };
}

function describe(total: number, open: number): string {
  if (total === 0) {
    return '';
  }
  return open > 0 ? `${total} · ${open} open` : String(total);
}

/**
 * A failure as a row can say it: one sentence, no stack, no driver preamble.
 * The output channel already has the whole thing; a tree row has forty
 * characters.
 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/)[0].trim() || 'The server did not answer.';
}

function coerceSort(value: string | undefined): SortOrder {
  return value === 'name' || value === 'recent' ? value : 'environment';
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
