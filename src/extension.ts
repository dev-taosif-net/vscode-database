import * as vscode from 'vscode';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionStore } from './store/connectionStore';
import { ConnectionsPanel } from './ui/connectionsPanel';
import { ConnectionsView } from './ui/connectionsView';
import { ConnectionStatusBar } from './ui/statusBar';
import { ConnectionProfile, environmentLabel } from './types';

/**
 * A command arrives from the palette with nothing, from the sidebar with a
 * profile id, and from the row's right-click menu with the object that row
 * put in its `data-vscode-context`. The webview replaced the tree, so a
 * `TreeItem` is no longer one of the shapes.
 */
type CommandTarget = string | { connectionId?: unknown } | undefined;

/**
 * Phase 1: everything up to and including an open connection. Nothing here
 * runs a query. Activation does no work beyond wiring, and neither driver is
 * loaded until the first connection is opened.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Database Tools', { log: true });
  const store = new ConnectionStore(context);
  const manager = new ConnectionManager(store, output);
  const statusBar = new ConnectionStatusBar(store, manager);
  const view = new ConnectionsView(context, store, manager);

  context.subscriptions.push(output, store, manager, statusBar, view);

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
