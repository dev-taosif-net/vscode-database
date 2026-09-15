import * as vscode from 'vscode';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';
import { QueryHostMessage, QueryWebviewMessage } from '../shared/query';
import { BindingStore, DATA_SCHEME, RUNNER_SCHEME } from '../query/bindingStore';
import { ActiveTab } from './activeTab';
import { QueryBridge } from './queryBridge';
import { webviewHtml } from './webviewHtml';

/**
 * The results panel: one webview, in the panel area, for every tab.
 *
 * This is the load-bearing performance decision of phase 3 and it is worth
 * saying plainly. A webview is an iframe with its own share of a renderer
 * process. Ten are fine; a hundred are a laptop with the fans on. "Thousands
 * of tabs" and "one webview per tab" cannot both be true, so the grid is a
 * single view that re-projects whenever the active tab changes — the same
 * relationship Problems has with the editor, or the Debug Console with a
 * session.
 *
 * What makes the switch feel instant rather than like a reload is that this
 * page holds no result data of its own: switching tabs sends a projection and
 * a window of rows, not a re-execution and not a re-mount.
 */
export class ResultsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'databaseTools.results';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];
  /**
   * True while the panel is closed because a data tab came to the front.
   * Only what this view hid is brought back: a panel the user closed
   * themselves stays closed.
   */
  private hiddenForInline = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: QueryBridge,
    private readonly bindings: BindingStore,
    private readonly active: ActiveTab,
    private readonly execution: ExecutionService,
    private readonly results: ResultStore
  ) {
    this.disposables.push(
      this.active.onDidChange((tab) => {
        this.project();
        this.follow(tab);
      }),
      // A rebind or a `USE` renames the strip without a run.
      this.bindings.onDidChange(() => this.project()),
      this.execution.onDidChange((change) => {
        if (change.tab === this.active.value) {
          this.project();
        }
      })
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      bundle: 'workspace.js',
      stylesheet: 'workspace.css',
      title: 'Results',
      view: 'results'
    });

    // A view is resolved again when it is dragged to another container, so the
    // previous subscriptions are dropped rather than stacked.
    while (this.viewDisposables.length) {
      this.viewDisposables.pop()?.dispose();
    }
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: QueryWebviewMessage) => {
        if (message.type === 'ready') {
          this.project();
          return;
        }
        void this.bridge.handle(message, (out) => this.post(out));
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      })
    );

    this.project();
  }

  /** Brings the panel forward, for Run to land somewhere visible. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ResultsView.viewType}.focus`);
  }

  /**
   * Steps aside for a tab that draws its own grid.
   *
   * A table data view and a procedure runner hold their rows in the editor
   * area. Showing the same execution here as well was two grids for one
   * answer, and the second one had no paging controls. So the panel closes
   * while such a tab is in front and comes back, without taking focus, when a
   * query tab is. Only a panel this view closed is reopened.
   */
  private follow(tab: string | undefined): void {
    const inline = tab !== undefined && drawsItself(tab);
    if (inline) {
      const configured = vscode.workspace.getConfiguration('databaseTools').get<boolean>('hideResultsForDataTabs', true);
      if (configured && this.view?.visible) {
        this.hiddenForInline = true;
        void vscode.commands.executeCommand('workbench.action.closePanel');
      }
      return;
    }
    if (this.hiddenForInline) {
      this.hiddenForInline = false;
      this.view?.show(true);
    }
  }

  private project(): void {
    if (!this.view) {
      return;
    }
    const tab = this.active.value;
    if (tab !== undefined && drawsItself(tab)) {
      // Not the execution: the tab is drawing that itself. The page is told
      // why it is empty rather than left saying "run something".
      this.post({ type: 'project', execution: null, context: { tab, connection: null, inline: true } });
      this.view.description = undefined;
      return;
    }
    this.bridge.project(tab, (message) => this.post(message));
    const record = tab ? this.results.latestFor(tab) : undefined;
    this.view.description = record
      ? `${record.connectionName}${record.database ? ` · ${record.database}` : ''}`
      : undefined;
  }

  private post(message: QueryHostMessage): void {
    void this.view?.webview.postMessage(message);
  }
}

/** A tab whose rows live in the editor area, not in this panel. */
function drawsItself(tab: string): boolean {
  const scheme = vscode.Uri.parse(tab).scheme;
  return scheme === DATA_SCHEME || scheme === RUNNER_SCHEME;
}
