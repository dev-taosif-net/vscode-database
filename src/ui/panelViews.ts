import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { DetailsService } from '../details/detailsService';
import { HistoryStore } from '../query/historyStore';
import { SavedQueryStore } from '../query/savedQueries';
import { FavouriteRef } from '../shared/catalog';
import { PanelHostMessage, PanelWebviewMessage } from '../shared/details';
import { webviewHtml } from './webviewHtml';

/**
 * The two side bar views, sharing one bundle.
 *
 * They share a bundle and not a view: the workbench draws each `WebviewView`
 * in its own iframe, and a user can drag either of them to the secondary side
 * bar independently. What they share is a stylesheet, a store and a handful of
 * primitives, which is exactly the sharing that made two entry points cheaper
 * than one for the editor and the sidebar in phase 1.
 *
 * Neither carries the grid. That is why they are not in the workspace bundle:
 * the side bar is resolved at startup, and a list of connections should not
 * pay for a virtualised grid, a plan renderer and a spreadsheet writer.
 */
abstract class PanelView implements vscode.WebviewViewProvider {
  protected view: vscode.WebviewView | undefined;
  private readonly viewDisposables: vscode.Disposable[] = [];

  constructor(
    protected readonly context: vscode.ExtensionContext,
    private readonly viewName: string,
    private readonly title: string
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      bundle: 'panels.js',
      stylesheet: 'panels.css',
      title: this.title,
      view: this.viewName
    });

    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: PanelWebviewMessage) => void this.onMessage(message)),
      view.onDidDispose(() => {
        this.view = undefined;
      })
    );
    void this.refresh();
  }

  protected post(message: PanelHostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  protected abstract onMessage(message: PanelWebviewMessage): Promise<void>;
  abstract refresh(): Promise<void>;

  disposeView(): void {
    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
  }
}

/**
 * The object details panel.
 *
 * It follows the explorer's cursor and, failing that, the object of the active
 * tab. Every section is lazy: opening the panel costs the header block and the
 * badges, and the columns come from the cache the explorer already filled, so
 * expanding a table in the tree and then opening details is one round trip
 * rather than two.
 */
export class DetailsView extends PanelView implements vscode.Disposable {
  static readonly viewType = 'databaseTools.details';

  private target: { profileId: string; ref: FavouriteRef } | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly details: DetailsService,
    private readonly onAction: (profileId: string, ref: FavouriteRef, action: string) => void
  ) {
    super(context, 'details', 'Database object');
  }

  dispose(): void {
    this.disposeView();
  }

  show(profileId: string, ref: FavouriteRef): void {
    this.target = { profileId, ref };
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.target) {
      this.post({ type: 'details', details: null });
      return;
    }
    const { profileId, ref } = this.target;
    try {
      const details = await this.details.describe(profileId, ref);
      // A late answer for an object the user has moved off is dropped rather
      // than drawn: the panel would otherwise flicker between two objects as
      // somebody arrows down a folder.
      if (this.target?.ref.name === ref.name && this.target.ref.schema === ref.schema) {
        this.post({ type: 'details', details });
      }
    } catch (error) {
      this.post({
        type: 'details',
        details: {
          profileId,
          connectionName: '',
          environment: 'dev',
          driver: 'mssql',
          ref,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  protected async onMessage(message: PanelWebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.refresh();
      return;
    }
    if (message.type === 'action' && this.target) {
      this.onAction(this.target.profileId, this.target.ref, message.action);
    }
  }
}

/**
 * Query history and saved queries, in one view.
 *
 * They are one view because they answer the same question from two directions
 * — what did I run, and what did I keep — and because a side bar with two more
 * headers in it is a side bar where the connections list has lost thirty
 * pixels for no reason.
 */
export class HistoryView extends PanelView implements vscode.Disposable {
  static readonly viewType = 'databaseTools.history';

  private filter: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly history: HistoryStore,
    private readonly saved: SavedQueryStore,
    private readonly onOpen: (profileId: string, sql: string) => void
  ) {
    super(context, 'history', 'Query history');
    this.disposables.push(
      this.history.onDidChange(() => void this.refresh()),
      this.saved.onDidChange(() => void this.refresh())
    );
  }

  dispose(): void {
    this.disposeView();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  async refresh(): Promise<void> {
    const entries = (this.filter ? this.history.read(this.filter) : this.history.all()).slice(0, 200);
    this.post({
      type: 'history',
      entries,
      connections: this.store.all().map((profile) => ({
        id: profile.id,
        name: profile.name || profile.host,
        environment: profile.environment
      }))
    });
    const saved = await this.saved.list();
    this.post({
      type: 'saved',
      entries: saved.map((entry) => ({
        uri: entry.uri.toString(),
        name: entry.name,
        connectionName: entry.connectionName,
        description: entry.description
      }))
    });
  }

  protected async onMessage(message: PanelWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.refresh();
        return;

      case 'filterHistory':
        this.filter = message.profileId;
        await this.refresh();
        return;

      case 'openHistory': {
        const entry = this.history.all().find((candidate) => candidate.id === message.id);
        if (entry && !entry.redacted) {
          this.onOpen(entry.profileId, entry.sql);
        }
        return;
      }

      case 'copyHistory': {
        const entry = this.history.all().find((candidate) => candidate.id === message.id);
        if (entry?.sql) {
          await vscode.env.clipboard.writeText(entry.sql);
        }
        return;
      }

      case 'saveHistory': {
        const entry = this.history.all().find((candidate) => candidate.id === message.id);
        if (!entry || entry.redacted) {
          return;
        }
        const name = await vscode.window.showInputBox({ title: 'Save query as', value: 'Query' });
        if (name) {
          const uri = await this.saved.save(name, entry.sql, entry.profileId);
          await vscode.window.showTextDocument(uri);
        }
        return;
      }

      case 'clearHistory': {
        const choice = await vscode.window.showWarningMessage(
          message.profileId ? 'Clear this connection history?' : 'Clear all query history?',
          { modal: true, detail: 'The statements and their timings are deleted. Nothing on any server changes.' },
          'Clear'
        );
        if (choice === 'Clear') {
          this.history.clear(message.profileId);
        }
        return;
      }

      case 'openSaved':
        await vscode.window.showTextDocument(vscode.Uri.parse(message.uri));
        return;

      default:
        return;
    }
  }
}
