import * as vscode from 'vscode';
import { AttemptResult, ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore, blankProfile } from '../store/connectionStore';
import { probeServer } from '../connections/probe';
import { DraftPayload, EditorState, HostMessage, WebviewMessage } from '../shared/protocol';
import { ConnectionProfile, DriverKind, FailureActionId, defaultPort } from '../types';

const VIEW_TYPE = 'databaseTools.connections';

const CERT_DOCS = {
  mssql: 'https://learn.microsoft.com/sql/database-engine/configure-windows/certificate-requirements',
  postgres: 'https://www.postgresql.org/docs/current/libpq-ssl.html'
};

/**
 * The connection editor, hosted in its own editor tab. One panel per window:
 * opening it again reveals the existing tab rather than stacking copies.
 *
 * A new connection lives here as `pending` and nowhere else. It reaches the
 * store, and so the sidebar, only when it is saved, so an abandoned draft
 * leaves nothing behind.
 */
export class ConnectionsPanel {
  private static current: ConnectionsPanel | undefined;

  private static readonly selectionEmitter = new vscode.EventEmitter<string>();
  /**
   * Fires with the stored profile the editor moved to, so the sidebar can
   * follow it. An unsaved draft is never announced, because the list does not
   * hold one until it is saved.
   */
  static readonly onDidChangeSelection = ConnectionsPanel.selectionEmitter.event;

  /** The last id announced, so a redraw does not re-announce the same one. */
  private announced: string | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly results = new Map<string, AttemptResult>();
  private selectedId: string | undefined;
  private busyId: string | undefined;
  private pending: ConnectionProfile | undefined;
  /** Whether the editor has typed changes the user would lose. */
  private dirty = false;

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
        void ConnectionsPanel.current.select(selectId);
      }
      return ConnectionsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Connection', column, {
      enableScripts: true,
      // The editor holds a draft the user is typing into; throwing it away
      // because they glanced at another tab would be its own bug.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
    });
    panel.iconPath = new vscode.ThemeIcon('database');

    ConnectionsPanel.current = new ConnectionsPanel(panel, context, store, manager, selectId);
    return ConnectionsPanel.current;
  }

  /** Opens the editor straight onto a blank connection. */
  static showNew(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    manager: ConnectionManager,
    driver: DriverKind = 'mssql'
  ): ConnectionsPanel {
    const panel = ConnectionsPanel.show(context, store, manager);
    void panel.startDraft(driver);
    return panel;
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
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
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

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        return;

      case 'create':
        await this.startDraft(message.driver ?? 'mssql');
        return;

      case 'dirty':
        this.dirty = Boolean(message.dirty);
        return;

      case 'menu':
        await this.showMenu(message.id);
        return;

      case 'save':
        await this.save(message);
        return;

      case 'revert':
        this.results.delete(message.id ?? '');
        this.dirty = false;
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

      case 'action':
        await this.runFailureAction(message);
        return;

      case 'probe':
        await this.probe(message.id, message.host, message.port);
        return;

      case 'signIn':
        await this.signIn(message.id);
        return;

      case 'close':
        if (await this.mayLeaveDraft()) {
          this.dispose();
        }
        return;

      default:
        return;
    }
  }

  /**
   * Answers the editor's live check of the server address. Stale answers are
   * possible, so the reply carries the target it belongs to and the editor
   * throws away anything that is no longer what is in the box.
   */
  private async probe(id: string, host: string, port: number | null): Promise<void> {
    const profile = this.effectiveProfile({ id });
    if (!profile) {
      return;
    }
    const result = await probeServer(host, port, profile.driver);
    await this.send({ type: 'probe', profileId: id, result });
  }

  private async signIn(id: string): Promise<void> {
    const profile = this.effectiveProfile({ id });
    if (!profile) {
      return;
    }
    try {
      const account = await this.manager.signIn(profile);
      if (account) {
        await this.send({ type: 'patch', profileId: id, patch: { account } });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Signing in failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async send(message: HostMessage): Promise<void> {
    await this.panel.webview.postMessage(message);
  }

  /**
   * Starts a blank connection in the editor. Nothing is written yet: the store
   * hears about it on save, and the sidebar only then.
   */
  private async startDraft(driver: DriverKind): Promise<void> {
    if (!(await this.mayLeaveDraft())) {
      return;
    }
    this.pending = blankProfile({ driver, name: this.nextName(driver), port: defaultPort(driver) });
    this.selectedId = this.pending.id;
    this.dirty = false;
    await this.postState(true);
  }

  /** Moves the editor to a stored connection, guarding an unsaved draft. */
  private async select(id: string): Promise<void> {
    if (id === this.selectedId) {
      return;
    }
    if (!(await this.mayLeaveDraft())) {
      return;
    }
    this.pending = undefined;
    this.selectedId = id;
    this.dirty = false;
    await this.postState(true);
  }

  /** True when the draft can be thrown away, either because it is untouched
   * or because the user said so. */
  private async mayLeaveDraft(): Promise<boolean> {
    if (!this.pending || !this.dirty) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'Discard this new connection?',
      {
        modal: true,
        detail: 'It has never been saved, so nothing is removed from the list. Save it first to keep it.'
      },
      'Discard'
    );
    return choice === 'Discard';
  }

  private isPending(id: string | undefined): boolean {
    return id !== undefined && this.pending !== undefined && this.pending.id === id;
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

  /** Returns the stored id the draft ended up under, or undefined if it did not save. */
  private async save(message: DraftPayload): Promise<string | undefined> {
    if (!message.id || !message.patch) {
      return undefined;
    }
    const name = (message.patch.name ?? '').trim();
    if (!name) {
      void vscode.window.showErrorMessage('A connection needs a name.');
      return undefined;
    }
    if (!this.store.isNameFree(name, message.id)) {
      void vscode.window.showErrorMessage(
        `Another connection is already called ${name}. Names have to be unique so the status bar is never ambiguous.`
      );
      return undefined;
    }

    // The first save is what puts a new connection in the list. It arrives with
    // the id of the draft, which no stored profile carries, so it creates
    // rather than updates and the editor moves to the id the store handed back.
    const saved = this.isPending(message.id)
      ? await this.store.create({ ...this.pending, ...message.patch })
      : await this.store.update(message.id, message.patch);

    if (message.secret !== undefined) {
      // An empty box means "forget it", which is different from "unchanged":
      // unchanged arrives as undefined and never reaches here.
      await this.store.writeSecret(
        saved.id,
        saved.credentialStore === 'secret' && message.secret !== '' ? message.secret : undefined
      );
    }

    // A draft that was tested before it was saved keeps its result, which is
    // filed under the id it had at the time.
    const draftResult = message.id !== saved.id ? this.results.get(message.id) : undefined;
    if (draftResult) {
      this.results.delete(message.id);
      this.results.set(saved.id, draftResult);
    }

    this.pending = undefined;
    this.selectedId = saved.id;
    this.dirty = false;
    await this.postState(true);
    return saved.id;
  }

  private async attempt(message: DraftPayload, mode: 'test' | 'connect'): Promise<void> {
    // A session is keyed by profile id, so an unsaved draft has to become a
    // real connection before it can hold one. Testing needs no such thing.
    if (mode === 'connect' && this.isPending(message.id)) {
      const savedId = await this.save(message);
      if (!savedId) {
        return;
      }
      message = { ...message, id: savedId };
    }

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

  private async reloadDatabases(message: DraftPayload): Promise<void> {
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
  private effectiveProfile(message: { id: string; patch?: Partial<ConnectionProfile> }): ConnectionProfile | undefined {
    if (!message.id) {
      return undefined;
    }
    const stored = this.isPending(message.id) ? this.pending : this.store.get(message.id);
    if (!stored) {
      return undefined;
    }
    return message.patch ? { ...stored, ...message.patch, id: stored.id } : stored;
  }

  private async runFailureAction(message: { id: string; actionId: FailureActionId; raw: string }): Promise<void> {
    const profile = this.effectiveProfile({ id: message.id });
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
        if (!this.isPending(profile.id)) {
          await this.store.writeSecret(profile.id, undefined);
        }
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
    if (this.isPending(id)) {
      await this.discardDraft();
      return;
    }
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

  private async discardDraft(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Discard this new connection?',
      { modal: true, detail: 'It has never been saved, so nothing is removed from the list.' },
      'Discard'
    );
    if (choice !== 'Discard') {
      return;
    }
    this.results.delete(this.pending?.id ?? '');
    this.pending = undefined;
    this.dirty = false;
    this.selectedId = this.store.all()[0]?.id;
    await this.postState(true);
  }

  /* --------------------------------------------------------------- state */

  reveal(selectId?: string): void {
    this.panel.reveal();
    if (selectId) {
      void this.select(selectId);
      return;
    }
    void this.postState(true);
  }

  private async postState(reload = false): Promise<void> {
    const profiles = this.store.all();
    if (this.selectedId && !this.isPending(this.selectedId) && !profiles.some((p) => p.id === this.selectedId)) {
      this.selectedId = this.pending?.id ?? profiles[0]?.id;
    }

    const selected = this.isPending(this.selectedId) ? undefined : this.store.get(this.selectedId ?? '');
    this.panel.title = this.pending && this.isPending(this.selectedId)
      ? 'New connection'
      : selected?.name || 'Connection';

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

    const storedSelection = this.isPending(this.selectedId) ? undefined : this.selectedId;
    if (storedSelection && storedSelection !== this.announced) {
      this.announced = storedSelection;
      ConnectionsPanel.selectionEmitter.fire(storedSelection);
    }

    const state: EditorState = {
      profiles,
      // The draft travels beside the stored list rather than inside it, so
      // nothing downstream mistakes it for a saved connection.
      pending: this.isPending(this.selectedId) ? this.pending ?? null : null,
      selectedId: this.selectedId ?? null,
      connected: this.manager.activeIds(),
      busy: this.busyId ?? null,
      hasSecret,
      results,
      reload
    };
    await this.send({ type: 'state', ...state });
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', ...parts));

    // Everything the page needs ships with the extension. The policy allows no
    // network at all: no remote script, no remote style, no remote font, and
    // no connections of any kind from inside the page.
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
<link href="${asset('editor.css')}" rel="stylesheet">
<title>Connection</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('editor.js')}"></script>
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
