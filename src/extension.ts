import * as vscode from 'vscode';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionStore } from './store/connectionStore';
import { ConnectionsPanel } from './ui/connectionsPanel';
import { ConnectionsTree, ConnectionTreeItem } from './ui/connectionsTree';
import { ConnectionStatusBar } from './ui/statusBar';
import { ConnectionProfile, environmentLabel } from './types';

/** A command can arrive from the palette with nothing, or from the tree. */
type CommandTarget = string | ConnectionTreeItem | undefined;

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
  const tree = new ConnectionsTree(store, manager);

  context.subscriptions.push(output, store, manager, statusBar, tree);

  context.subscriptions.push(
    vscode.commands.registerCommand('databaseTools.openConnections', (target?: CommandTarget) => {
      ConnectionsPanel.show(context, store, manager, targetId(target));
    }),

    vscode.commands.registerCommand('databaseTools.newConnection', async () => {
      const driver = await pickDriver();
      if (!driver) {
        return;
      }
      const created = await store.create({ driver, name: `New ${driver === 'mssql' ? 'SQL Server' : 'PostgreSQL'} connection` });
      ConnectionsPanel.show(context, store, manager, created.id);
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
    })
  );

  output.info('Database Tools activated.');
}

export function deactivate(): void {
  // Sessions are closed by ConnectionManager.dispose through the subscriptions.
}

/** The profile id behind a command argument, whatever shape it arrived in. */
function targetId(target: CommandTarget): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  return target instanceof ConnectionTreeItem ? target.profile.id : undefined;
}

async function pickDriver(): Promise<ConnectionProfile['driver'] | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(database) Microsoft SQL Server',
        detail: '2016 and newer, Azure SQL Database, Managed Instance, and Amazon RDS',
        driver: 'mssql' as const
      },
      {
        label: '$(database) PostgreSQL',
        detail: '12 and newer, plus Aurora, Cloud SQL, Neon, Supabase and Timescale',
        driver: 'postgres' as const
      }
    ],
    { title: 'New connection', placeHolder: 'Choose a server type' }
  );
  return pick?.driver;
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
