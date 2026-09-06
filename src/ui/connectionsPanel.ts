import * as vscode from 'vscode';
import { AttemptResult, ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { ConnectionProfile, DriverKind, FailureActionId, defaultPort } from '../types';

const VIEW_TYPE = 'databaseTools.connections';

const CERT_DOCS = {
  mssql: 'https://learn.microsoft.com/sql/database-engine/configure-windows/certificate-requirements',
  postgres: 'https://www.postgresql.org/docs/current/libpq-ssl.html'
};

interface IncomingMessage {
  type: string;
  id?: string;
  driver?: DriverKind;
  patch?: Partial<ConnectionProfile>;
  secret?: string;
  actionId?: FailureActionId;
  raw?: string;
  text?: string;
}

/**
 * The connection editor, hosted in its own editor tab. One panel per window:
 * opening it again reveals the existing tab rather than stacking copies.
 */
export class ConnectionsPanel {
  private static current: ConnectionsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly results = new Map<string, AttemptResult>();
  private selectedId: string | undefined;
  private busyId: string | undefined;

  static show(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    manager: ConnectionManager,
    selectId?: string
  ): ConnectionsPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ConnectionsPanel.current) {
      ConnectionsPanel.current.panel.reveal(column);
      if (selectId) {
        ConnectionsPanel.current.selectedId = selectId;
        void ConnectionsPanel.current.postState();
      }
      return ConnectionsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Connections', column, {
      enableScripts: true,
      // The editor holds a draft the user is typing into; throwing it away
      // because they glanced at another tab would be its own bug.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.iconPath = new vscode.ThemeIcon('database');

    ConnectionsPanel.current = new ConnectionsPanel(panel, context, store, manager, selectId);
    return ConnectionsPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    selectId?: string
  ) {
    this.selectedId = selectId ?? store.all()[0]?.id;
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => {
        void this.onMessage(message);
      }),
      this.store.onDidChange(() => void this.postState()),
      this.manager.onDidChange(() => void this.postState())
    );
  }

  dispose(): void {
    ConnectionsPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  /* ------------------------------------------------------------ messages */

  private async onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        return;

      case 'select':
        this.selectedId = message.id;
        await this.postState();
        return;

      case 'create': {
        const created = await this.store.create({
          driver: message.driver ?? 'mssql',
          name: this.nextName(message.driver ?? 'mssql'),
          port: defaultPort(message.driver ?? 'mssql')
        });
        this.selectedId = created.id;
        await this.postState(true);
        return;
      }

      case 'menu':
        await this.showMenu(message.id);
        return;

      case 'save':
        await this.save(message);
        return;

      case 'revert':
        this.results.delete(message.id ?? '');
        await this.postState(true);
        return;

      case 'test':
        await this.attempt(message, 'test');
        return;

      case 'connect':
        await this.attempt(message, 'connect');
        return;

      case 'disconnect':
        if (message.id) {
          await this.manager.disconnect(message.id);
          this.results.delete(message.id);
          await this.postState();
        }
        return;

      case 'cancel':
        if (message.id) {
          this.manager.cancel(message.id);
        }
        return;

      case 'reloadDatabases':
        await this.reloadDatabases(message);
        return;

      case 'clearSecret':
        if (message.id) {
          await this.store.writeSecret(message.id, undefined);
          void vscode.window.showInformationMessage('The stored password was removed from the keychain.');
          await this.postState();
        }
        return;

      case 'copyConnectionString':
        if (message.text) {
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage('Connection string copied. The secret stays masked.');
        }
        return;

      case 'action':
        await this.runFailureAction(message);
        return;

      default:
        return;
    }
  }

  private nextName(driver: DriverKind): string {
    const base = driver === 'mssql' ? 'New SQL Server connection' : 'New PostgreSQL connection';
    let candidate = base;
    let n = 2;
    while (!this.store.isNameFree(candidate)) {
      candidate = `${base} ${n++}`;
    }
    return candidate;
  }

  private async save(message: IncomingMessage): Promise<void> {
    if (!message.id || !message.patch) {
      return;
    }
    const name = (message.patch.name ?? '').trim();
    if (!name) {
      void vscode.window.showErrorMessage('A connection needs a name.');
      return;
    }
    if (!this.store.isNameFree(name, message.id)) {
      void vscode.window.showErrorMessage(
        `Another connection is already called ${name}. Names have to be unique so the status bar is never ambiguous.`
      );
      return;
    }

    const saved = await this.store.update(message.id, message.patch);
    if (message.secret !== undefined) {
      // An empty box means "forget it", which is different from "unchanged":
      // unchanged arrives as undefined and never reaches here.
      await this.store.writeSecret(
        saved.id,
        saved.credentialStore === 'secret' && message.secret !== '' ? message.secret : undefined
      );
    }
    await this.postState(true);
  }

  private async attempt(message: IncomingMessage, mode: 'test' | 'connect'): Promise<void> {
    const effective = this.effectiveProfile(message);
    if (!effective) {
      return;
    }

    this.busyId = effective.id;
    await this.postState();
    try {
      const result =
        mode === 'test'
          ? await this.manager.test(effective, undefined, message.secret)
          : await this.manager.connect(effective, message.secret);
      this.results.set(effective.id, result);
    } finally {
      this.busyId = undefined;
      await this.postState();
    }
  }

  private async reloadDatabases(message: IncomingMessage): Promise<void> {
    const effective = this.effectiveProfile(message);
    if (!effective) {
      return;
    }
    this.busyId = effective.id;
    await this.postState();
    try {
      const databases = await this.manager.listDatabases(effective, message.secret);
      await this.panel.webview.postMessage({ type: 'databases', profileId: effective.id, databases });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `The database list could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.busyId = undefined;
      await this.postState();
    }
  }

  /** The stored profile with the unsaved draft laid over it. Never persisted. */
  private effectiveProfile(message: IncomingMessage): ConnectionProfile | undefined {
    if (!message.id) {
      return undefined;
    }
    const stored = this.store.get(message.id);
    if (!stored) {
      return undefined;
    }
    return message.patch ? { ...stored, ...message.patch, id: stored.id } : stored;
  }

  private async runFailureAction(message: IncomingMessage): Promise<void> {
    const profile = message.id ? this.store.get(message.id) : undefined;
    if (!profile || !message.actionId) {
      return;
    }

    switch (message.actionId) {
      case 'copyError':
        await vscode.env.clipboard.writeText(message.raw ?? '');
        void vscode.window.showInformationMessage('The driver error was copied.');
        return;

      case 'openCertificateDocs':
        await vscode.env.openExternal(vscode.Uri.parse(CERT_DOCS[profile.driver]));
        return;

      case 'clearCredential':
        await this.store.writeSecret(profile.id, undefined);
        this.results.delete(profile.id);
        await this.postState();
        void vscode.window.showInformationMessage('The stored credential was removed. The next attempt will ask.');
        return;

      case 'trustOnce': {
        const confirmed = await vscode.window.showWarningMessage(
          `Stop validating the certificate for ${profile.name}?`,
          {
            modal: true,
            detail:
              'Traffic stays encrypted, but the server’s identity is no longer checked, so the connection is open ' +
              'to interception on the way. Adding the issuing authority to the machine trust store keeps it verified.'
          },
          'Trust it anyway'
        );
        if (confirmed !== 'Trust it anyway') {
          return;
        }
        await this.panel.webview.postMessage({
          type: 'patch',
          profileId: profile.id,
          patch: { trustServerCertificate: true }
        });
        return;
      }

      case 'useDefaultDatabase':
        await this.panel.webview.postMessage({
          type: 'patch',
          profileId: profile.id,
          patch: { database: '' }
        });
        return;

      case 'retryLongerTimeout':
        await this.panel.webview.postMessage({
          type: 'patch',
          profileId: profile.id,
          patch: { connectTimeoutSeconds: 60 }
        });
        return;

      default:
        return;
    }
  }

  private async showMenu(id: string | undefined): Promise<void> {
    const profile = id ? this.store.get(id) : undefined;
    if (!profile) {
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(files) Duplicate', action: 'duplicate' },
        { label: '$(trash) Delete', action: 'delete' }
      ],
      { title: profile.name, placeHolder: 'Choose an action' }
    );
    if (!pick) {
      return;
    }
    if (pick.action === 'duplicate') {
      const copy = await this.store.duplicate(profile.id);
      if (copy) {
        this.selectedId = copy.id;
        await this.postState(true);
      }
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${profile.name}?`,
      { modal: true, detail: 'The stored credential is removed from the keychain at the same time.' },
      'Delete'
    );
    if (confirmed !== 'Delete') {
      return;
    }
    await this.manager.disconnect(profile.id);
    await this.store.remove(profile.id);
    this.results.delete(profile.id);
    if (this.selectedId === profile.id) {
      this.selectedId = this.store.all()[0]?.id;
    }
    await this.postState(true);
  }

  /* --------------------------------------------------------------- state */

  reveal(selectId?: string): void {
    if (selectId) {
      this.selectedId = selectId;
    }
    this.panel.reveal();
    void this.postState(true);
  }

  private async postState(reload = false): Promise<void> {
    const profiles = this.store.all();
    if (this.selectedId && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = profiles[0]?.id;
    }

    const hasSecret: Record<string, boolean> = {};
    await Promise.all(
      profiles.map(async (p) => {
        hasSecret[p.id] = await this.store.hasSecret(p.id);
      })
    );

    const results: Record<string, AttemptResult> = {};
    for (const [id, result] of this.results) {
      results[id] = result;
    }

    await this.panel.webview.postMessage({
      type: 'state',
      profiles,
      selectedId: this.selectedId ?? null,
      connected: this.manager.activeIds(),
      busy: this.busyId ?? null,
      hasSecret,
      results,
      reload
    });
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'connections.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'connections.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Connections</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
