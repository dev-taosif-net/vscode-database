import * as vscode from 'vscode';
import { CatalogService } from './catalog/catalogService';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionStore } from './store/connectionStore';
import { DetailsService } from './details/detailsService';
import { ExecutionService } from './exec/executionService';
import { ResultStore } from './exec/resultStore';
import { SessionPool } from './exec/sessionPool';
import { BindingStore, QUERY_SCHEME, OBJECT_SCHEME } from './query/bindingStore';
import { DefinitionProvider, QueryFileSystem } from './query/queryFs';
import { HistoryStore } from './query/historyStore';
import { SavedQueryStore } from './query/savedQueries';
import { SqlDiagnostics } from './query/diagnostics';
import { MetadataIndex } from './query/language/index';
import { SqlLanguageProviders } from './query/language/providers';
import { ActiveTab } from './ui/activeTab';
import { ConnectionsPanel } from './ui/connectionsPanel';
import { ConnectionsView } from './ui/connectionsView';
import { DetailsView, HistoryView } from './ui/panelViews';
import { ObjectCommands } from './ui/objectCommands';
import { QueryBridge } from './ui/queryBridge';
import { QueryCommands } from './ui/queryCommands';
import { ResultsView } from './ui/resultsView';
import { ConnectionStatusBar } from './ui/statusBar';
import { WorkspacePanels } from './ui/workspacePanels';
import { WorkspaceStatusBar } from './ui/workspaceStatusBar';
import { FavouriteRef } from './shared/catalog';
import { ConnectionProfile, environmentLabel } from './types';

/**
 * A command arrives from the palette with nothing, from the sidebar with a
 * profile id, and from the row's right-click menu with the object that row
 * put in its `data-vscode-context`. The webview replaced the tree, so a
 * `TreeItem` is no longer one of the shapes.
 */
type CommandTarget = string | { connectionId?: unknown } | undefined;

/**
 * An object, in the shape a `webview/context` command expects.
 *
 * The details panel does not have a row to right-click, so it builds the same
 * payload the row would have put in its attribute. One shape, checked in one
 * place — `objectTarget` — however the command was invoked.
 */
function contextOf(target: { profileId: string; ref: FavouriteRef }): Record<string, string> {
  return {
    connectionId: target.profileId,
    objectKind: target.ref.kind,
    objectSchema: target.ref.schema,
    objectName: target.ref.name
  };
}

/**
 * Phase 1 opened a connection, phase 2 browsed what is inside it, and phase 3
 * runs statements against it. Activation still does no work beyond wiring:
 * neither driver is loaded until the first connection is opened, the catalog
 * reads nothing until a folder is expanded, and no execution session is opened
 * until somebody presses Run.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Database Tools', { log: true });
  const store = new ConnectionStore(context);
  const manager = new ConnectionManager(store, output);
  const catalog = new CatalogService(store, manager, output);
  const statusBar = new ConnectionStatusBar(store, manager);
  const view = new ConnectionsView(context, store, manager, catalog);

  context.subscriptions.push(output, store, manager, catalog, statusBar, view);

  /*
   * Phase 3.
   *
   * The order below is the dependency order and is worth reading as one: the
   * pool sits on the manager, execution sits on the pool, the store holds what
   * comes back, and every view is a projection of that store. Nothing here
   * reaches around another layer — which is what lets a tab be closed
   * mid-query and leave nothing behind.
   */
  const storageDir = vscode.Uri.joinPath(context.globalStorageUri, 'results').fsPath;
  const historyDir = vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath;

  const details = new DetailsService(store, manager, catalog, output);
  const pool = new SessionPool(manager, output);
  const results = new ResultStore(storageDir);
  const execution = new ExecutionService(store, manager, pool, results, output);
  const history = new HistoryStore(historyDir);
  const bindings = new BindingStore(context);
  const files = new QueryFileSystem();
  const definitions = new DefinitionProvider(store, catalog);
  const saved = new SavedQueryStore(context, store);
  const index = new MetadataIndex(store, manager, catalog, details);
  const active = new ActiveTab(bindings);
  const bridge = new QueryBridge(store, results, execution, details, output);
  const resultsView = new ResultsView(context, bridge, active, execution, results);
  const panels = new WorkspacePanels(
    context,
    store,
    catalog,
    details,
    execution,
    results,
    bridge,
    active,
    output
  );
  const workspaceStatus = new WorkspaceStatusBar(store, bindings, results, execution, active);
  const language = new SqlLanguageProviders(store, bindings, index);
  const diagnostics = new SqlDiagnostics(execution, results);

  const detailsView = new DetailsView(context, details, (profileId, ref, action) => {
    void runDetailsAction(profileId, ref, action);
  });
  const historyView = new HistoryView(context, store, history, saved, (profileId, sql) => {
    void commands.openScratch(profileId, 'History', sql);
  });

  const commands = new QueryCommands(
    store,
    manager,
    catalog,
    details,
    execution,
    results,
    files,
    definitions,
    bindings,
    saved,
    panels,
    resultsView,
    active,
    output
  );
  commands.onShowDetails = (profileId, ref) => detailsView.show(profileId, ref);

  /**
   * The details panel's quick actions, routed to the commands that already do
   * them.
   *
   * They go through `executeCommand` rather than calling the methods directly
   * so that a keybinding, the palette and the panel all take the same path —
   * and so the panel cannot drift into being a second implementation of Script
   * As ALTER.
   */
  async function runDetailsAction(profileId: string, ref: FavouriteRef, action: string): Promise<void> {
    const target = { profileId, ref };
    switch (action) {
      case 'viewData':
        return panels.openData(profileId, ref);
      case 'run':
        return panels.openRunner(profileId, ref);
      case 'generateCrud':
        return commands.generateCrud(target);
      case 'scriptCreate':
        return vscode.commands.executeCommand('databaseTools.scriptCreate', contextOf(target));
      case 'scriptAlter':
        return vscode.commands.executeCommand('databaseTools.scriptAsAlter', contextOf(target));
      case 'scriptDrop':
        return vscode.commands.executeCommand('databaseTools.scriptDrop', contextOf(target));
      case 'dependencies':
        return vscode.commands.executeCommand('databaseTools.viewDependencies', contextOf(target));
      case 'compare':
        return vscode.commands.executeCommand('databaseTools.compareWith', contextOf(target));
      default:
        return undefined;
    }
  }

  context.subscriptions.push(
    details,
    pool,
    results,
    execution,
    history,
    bindings,
    files,
    definitions,
    saved,
    index,
    active,
    resultsView,
    panels,
    workspaceStatus,
    language,
    diagnostics,
    detailsView,
    historyView,
    commands
  );

  // A finished execution becomes a history entry, once. Paging and Fetch more
  // are marked quiet and never reach here, so a table browsed for ten minutes
  // leaves one entry rather than a hundred.
  context.subscriptions.push(execution.onDidFinish((record) => history.record(record)));

  // The explorer's cursor drives the details panel, through a notification the
  // explorer does not know anybody is listening to.
  context.subscriptions.push(view.onDidSelectObject(({ profileId, ref }) => detailsView.show(profileId, ref)));

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(QUERY_SCHEME, files, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(OBJECT_SCHEME, definitions),
    vscode.window.registerWebviewViewProvider(ResultsView.viewType, resultsView),
    vscode.window.registerWebviewViewProvider(DetailsView.viewType, detailsView),
    vscode.window.registerWebviewViewProvider(HistoryView.viewType, historyView),
    // A data or runner tab restores from its address alone, so a window reload
    // brings back forty tabs for the cost of forty empty frames.
    vscode.window.registerWebviewPanelSerializer(WorkspacePanels.dataViewType, {
      deserializeWebviewPanel: async (panel, state) => panels.restore(panel, 'data', state)
    }),
    vscode.window.registerWebviewPanelSerializer(WorkspacePanels.runnerViewType, {
      deserializeWebviewPanel: async (panel, state) => panels.restore(panel, 'runner', state)
    })
  );

  context.subscriptions.push(...commands.register());
  context.subscriptions.push(...language.register());
  context.subscriptions.push(...new ObjectCommands(store, catalog, output).register());

  // A tab that closes releases its lease, cancels what it was running and
  // drops its rows. Nothing else has to remember to.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      const tab = active.tabOf(document);
      if (tab) {
        void execution.closeTab(tab);
      }
    }),
    // Disconnecting frees every execution session for that connection. The
    // tabs stay open, because the SQL in them is the user's work.
    manager.onDidChange(() => {
      for (const profile of store.all()) {
        if (!manager.isConnected(profile.id)) {
          void pool.releaseProfile(profile.id);
        }
      }
    })
  );

  // No `retainContextWhenHidden`. It costs thirty to sixty megabytes for a view
  // many people have open at startup, and it buys nothing here: grouping, sort
  // and folding live in the host's memento, and scroll position lives in the
  // webview's own `setState`, so a hidden panel has nothing left to keep.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConnectionsView.viewType, view)
  );

  // The list follows the editor rather than the click that opened it, so it
  // stays right when the editor declines to move or a first save renames the id.
  context.subscriptions.push(ConnectionsPanel.onDidChangeSelection((id) => void view.select(id)));

  context.subscriptions.push(
    vscode.commands.registerCommand('databaseTools.openConnections', (target?: CommandTarget) => {
      ConnectionsPanel.show(context, store, manager, targetId(target));
    }),

    // Search is a box inside the panel now, not a QuickInput over the window.
    // The command only puts the caret in it, which is why it can leave focus
    // alone everywhere else.
    vscode.commands.registerCommand('databaseTools.filterConnections', () => view.focusSearch()),

    vscode.commands.registerCommand('databaseTools.clearFilter', () => view.clearSearch()),

    vscode.commands.registerCommand('databaseTools.refreshConnections', () => view.refresh()),

    vscode.commands.registerCommand('databaseTools.viewOptions', () => view.showViewOptions()),

    vscode.commands.registerCommand('databaseTools.collapseAllGroups', () => view.collapseAll(true)),

    vscode.commands.registerCommand('databaseTools.groupByEnvironment', () => view.setGrouped(true)),

    vscode.commands.registerCommand('databaseTools.showFlatList', () => view.setGrouped(false)),

    // Straight into the editor. The server type is a field on the form, and
    // nothing reaches the list until the connection is saved.
    vscode.commands.registerCommand('databaseTools.newConnection', () => {
      ConnectionsPanel.showNew(context, store, manager);
    }),

    vscode.commands.registerCommand('databaseTools.connect', async (target?: CommandTarget) => {
      const id = targetId(target);
      const profile = id ? store.get(id) : await pickProfile(store, 'Connect to');
      if (!profile) {
        return;
      }
      await connectWithProgress(context, store, manager, profile);
    }),

    vscode.commands.registerCommand('databaseTools.disconnect', async (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        await manager.disconnect(id);
        return;
      }
      const open = manager.activeIds();
      if (open.length === 0) {
        void vscode.window.showInformationMessage('Nothing is connected.');
        return;
      }
      if (open.length === 1) {
        await manager.disconnect(open[0]);
        return;
      }
      const items = open
        .map((id) => store.get(id))
        .filter((p): p is ConnectionProfile => Boolean(p))
        .map((p) => ({ label: p.name, description: `${p.host} · ${environmentLabel(p.environment)}`, id: p.id }));
      const pick = await vscode.window.showQuickPick(items, { title: 'Disconnect', placeHolder: 'Choose a connection' });
      if (pick) {
        await manager.disconnect(pick.id);
      }
    }),

    vscode.commands.registerCommand('databaseTools.disconnectAll', async () => {
      await manager.disconnectAll();
    }),

    vscode.commands.registerCommand('databaseTools.deleteConnection', async (target?: CommandTarget) => {
      const id = targetId(target);
      const profile = id ? store.get(id) : await pickProfile(store, 'Delete');
      if (!profile) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete ${profile.name || profile.host}?`,
        {
          modal: true,
          detail: 'The profile and any credential stored for it are removed. Nothing on the server changes.'
        },
        'Delete'
      );
      if (choice !== 'Delete') {
        return;
      }
      await manager.disconnect(profile.id);
      await store.remove(profile.id);
    }),

    /*
     * The rest of the row's right-click menu.
     *
     * These five were a quick pick behind a `⋯` button until the menu became a
     * real workbench menu, and a menu item can invoke nothing but a command —
     * so each of them is one, contributed to `webview/context` and hidden from
     * the palette, where there would be no row to act on.
     */

    vscode.commands.registerCommand('databaseTools.editConnection', (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        ConnectionsPanel.show(context, store, manager, id);
      }
    }),

    vscode.commands.registerCommand('databaseTools.addFavourite', async (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        await store.setFavourite(id, true);
      }
    }),

    vscode.commands.registerCommand('databaseTools.removeFavourite', async (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        await store.setFavourite(id, false);
      }
    }),

    vscode.commands.registerCommand('databaseTools.duplicateConnection', async (target?: CommandTarget) => {
      const id = targetId(target);
      const copy = id ? await store.duplicate(id) : undefined;
      if (copy) {
        // Straight into the editor on the copy: it carries neither the source's
        // credential nor a name anyone means to keep.
        ConnectionsPanel.show(context, store, manager, copy.id);
      }
    }),

    vscode.commands.registerCommand('databaseTools.copyServerAddress', async (target?: CommandTarget) => {
      const id = targetId(target);
      const profile = id ? store.get(id) : undefined;
      if (profile) {
        await vscode.env.clipboard.writeText(`${profile.host}${profile.port ? `:${profile.port}` : ''}`);
      }
    }),

    /*
     * The explorer's two connection-level actions.
     *
     * Schema-focused mode is deliberately not a toolbar toggle. A toolbar
     * button applies to the view, and this applies to one connection: the
     * estate that needs schema mode is the forty-schema ERP database, and the
     * three little service databases beside it in the same list do not. Two
     * commands rather than one that flips, because a menu item has to say what
     * it will do before you click it, and `when` clauses are how a menu chooses
     * between them.
     */

    vscode.commands.registerCommand('databaseTools.enableSchemaMode', async (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        await store.setExplorerMode(id, 'schema');
      }
    }),

    vscode.commands.registerCommand('databaseTools.disableSchemaMode', async (target?: CommandTarget) => {
      const id = targetId(target);
      if (id) {
        await store.setExplorerMode(id, 'general');
      }
    }),

    /**
     * Re-reads one connection's catalog, or every connection's.
     *
     * It empties the cache and nothing more. The tree asks again for the
     * folders that are actually on screen, so refreshing a connection with
     * forty schemas and one folder open is one query rather than forty.
     */
    vscode.commands.registerCommand('databaseTools.refreshCatalog', (target?: CommandTarget) => {
      catalog.invalidate(targetId(target));
    })
  );

  output.info('Database Tools activated.');
}

export function deactivate(): void {
  // Sessions are closed by ConnectionManager.dispose through the subscriptions.
}

/**
 * The profile id behind a command argument. Commands are invoked dynamically,
 * so the shape is checked rather than trusted: the palette passes nothing, the
 * sidebar passes an id, and the row menu passes an object. Anything that is
 * not one of those lands on `undefined` so `pickProfile` takes over, instead
 * of a connection being opened against a stringified object.
 */
function targetId(target: CommandTarget): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  // The workbench hands a context menu's whole context object to the command,
  // and the row is the only thing in this extension that writes one — but it
  // reaches the host as JSON parsed out of an attribute, so the id is checked
  // rather than trusted, exactly as a string argument is.
  const id = target && typeof target === 'object' ? target.connectionId : undefined;
  return typeof id === 'string' ? id : undefined;
}

async function pickProfile(store: ConnectionStore, verb: string): Promise<ConnectionProfile | undefined> {
  const profiles = store.all();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('There are no connections yet. Open the Connections tab to add one.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.name,
      description: `${p.host}${p.port ? `:${p.port}` : ''} · ${p.database || 'default database'}`,
      detail: environmentLabel(p.environment),
      id: p.id
    })),
    { title: verb, placeHolder: 'Choose a connection', matchOnDescription: true }
  );
  return pick ? store.get(pick.id) : undefined;
}

/**
 * The palette path to a connection. The editor has its own result strip, so
 * this one reports through a notification and offers the editor as the place
 * to fix a failure.
 */
async function connectWithProgress(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  manager: ConnectionManager,
  profile: ConnectionProfile
): Promise<void> {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${profile.name}`,
      cancellable: true
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => manager.cancel(profile.id));
      return manager.connect(profile);
    }
  );

  if (result.ok) {
    void vscode.window.showInformationMessage(
      `Connected to ${profile.name} in ${result.info.latencyMs} ms. ${result.info.serverVersion}`
    );
    return;
  }

  if (result.failure.kind === 'cancelled') {
    return;
  }

  const choice = await vscode.window.showErrorMessage(
    result.failure.title,
    { detail: result.failure.detail, modal: false },
    'Open the connection',
    'Copy the driver error'
  );
  if (choice === 'Open the connection') {
    ConnectionsPanel.show(context, store, manager, profile.id);
  } else if (choice === 'Copy the driver error') {
    await vscode.env.clipboard.writeText(result.failure.raw);
  }
}
