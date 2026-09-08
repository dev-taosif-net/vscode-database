import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionStore } from '../store/connectionStore';
import { DetailsService } from '../details/detailsService';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';
import { FavouriteRef, KINDS } from '../shared/catalog';
import { QueryHostMessage, QueryWebviewMessage, RunnerValue } from '../shared/query';
import { DATA_SCHEME, RUNNER_SCHEME, objectAddress, objectRefOf } from '../query/bindingStore';
import { errorMessage } from '../types';
import { ActiveTab } from './activeTab';
import { QueryBridge } from './queryBridge';
import { buildCall, buildForm } from './runnerForm';
import { selectPage } from './tableSql';
import { webviewHtml } from './webviewHtml';

const RUNNER_VALUES_KEY = 'databaseTools.runnerValues.v1';

interface Managed {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  kind: 'data' | 'runner';
  profileId: string;
  ref: FavouriteRef;
}

/**
 * The two surfaces that are tabs of their own: a table's data, and a routine's
 * execution form.
 *
 * Both are addressed by URI and both are one-per-address, so opening View Data
 * on the same table twice reveals the first tab rather than stacking a second.
 * A query editor is deliberately not like this — its name is generated, so two
 * are two different documents by construction.
 *
 * Memory is the workbench's job here, not this class's. `retainContextWhenHidden`
 * is off, so a hidden tab's iframe is already torn down by VS Code and rebuilt
 * from the host's state when it is revealed. There used to be a "budget" here
 * that disposed the least recently seen panel past sixteen — and disposing a
 * `WebviewPanel` closes the tab, so what it actually did was close the user's
 * seventeenth data tab without a word.
 */
export class WorkspacePanels implements vscode.Disposable {
  static readonly dataViewType = 'databaseTools.data';
  static readonly runnerViewType = 'databaseTools.runner';

  private readonly panels = new Map<string, Managed>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly catalog: CatalogService,
    private readonly details: DetailsService,
    private readonly execution: ExecutionService,
    private readonly results: ResultStore,
    private readonly bridge: QueryBridge,
    private readonly active: ActiveTab,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.disposables.push(
      this.execution.onDidChange((change) => {
        const managed = this.panels.get(change.tab);
        if (managed) {
          this.project(managed);
        }
      })
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    for (const managed of this.panels.values()) {
      managed.panel.dispose();
    }
    this.panels.clear();
  }

  /* --------------------------------------------------------------- opening */

  async openData(profileId: string, ref: FavouriteRef): Promise<void> {
    const uri = objectAddress(DATA_SCHEME, profileId, ref);
    const existing = this.panels.get(uri.toString());
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      WorkspacePanels.dataViewType,
      `${ref.name} [Data]`,
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
      this.panelOptions()
    );
    this.adopt(panel, uri, 'data', profileId, ref);
    await this.loadFirstPage(uri.toString(), profileId, ref);
  }

  async openRunner(profileId: string, ref: FavouriteRef): Promise<void> {
    const uri = objectAddress(RUNNER_SCHEME, profileId, ref);
    const existing = this.panels.get(uri.toString());
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      WorkspacePanels.runnerViewType,
      `${ref.name} [Run]`,
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
      this.panelOptions()
    );
    this.adopt(panel, uri, 'runner', profileId, ref);
  }

  /**
   * Rebuilds a tab after a window reload.
   *
   * It needs nothing but the address, which the URI already carries — so a
   * window that reopens with forty data tabs costs forty empty iframes, each
   * filled only when it is actually revealed.
   */
  restore(panel: vscode.WebviewPanel, kind: 'data' | 'runner', raw: unknown): void {
    const address = typeof raw === 'string' ? raw : (raw as { uri?: string })?.uri;
    if (typeof address !== 'string') {
      panel.dispose();
      return;
    }
    const uri = vscode.Uri.parse(address);
    const ref = objectRefOf(uri, kind === 'runner' ? 'procedure' : 'table');
    const profileId = uri.authority;
    if (!ref || !this.store.get(profileId)) {
      panel.dispose();
      return;
    }
    this.adopt(panel, uri, kind, profileId, ref);
  }

  private panelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      // Deliberately absent: `retainContextWhenHidden`. These pages hold no
      // state, so keeping them alive would cost megabytes to preserve nothing.
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    };
  }

  private adopt(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    kind: 'data' | 'runner',
    profileId: string,
    ref: FavouriteRef
  ): void {
    const tab = uri.toString();
    panel.iconPath = new vscode.ThemeIcon(kind === 'data' ? 'table' : 'play');
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, {
      bundle: 'workspace.js',
      stylesheet: 'workspace.css',
      title: panel.title,
      view: kind,
      address: tab
    });

    const managed: Managed = { panel, uri, kind, profileId, ref };
    this.panels.set(tab, managed);
    this.active.set(tab);

    panel.webview.onDidReceiveMessage((message: QueryWebviewMessage) => {
      void this.onMessage(managed, message);
    });

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active.set(tab);
      }
    });

    // A tab that closes releases its lease, cancels what it was running and
    // drops its rows. Nothing else has to remember to.
    panel.onDidDispose(() => {
      this.panels.delete(tab);
      void this.execution.closeTab(tab);
      if (this.active.value === tab) {
        this.active.set(undefined);
      }
    });
  }

  /**
   * Runs the runner tab the user is looking at, for the toolbar's Run key.
   *
   * The values live in the page, so the page is asked to execute rather than
   * the host reading them back. False when no runner is the active editor, so
   * the command can fall through to its ordinary meaning.
   */
  executeActiveRunner(): boolean {
    for (const managed of this.panels.values()) {
      if (managed.kind === 'runner' && managed.panel.active) {
        void managed.panel.webview.postMessage({ type: 'execute' } satisfies QueryHostMessage);
        return true;
      }
    }
    return false;
  }

  /* -------------------------------------------------------------- messages */

  private async onMessage(managed: Managed, message: QueryWebviewMessage): Promise<void> {
    const post = (out: QueryHostMessage) => void managed.panel.webview.postMessage(out);
    const tab = managed.uri.toString();

    if (message.type === 'ready') {
      if (managed.kind === 'runner') {
        await this.sendForm(managed, post);
      } else if (!this.results.latestFor(tab)) {
        await this.loadFirstPage(tab, managed.profileId, managed.ref);
      }
      this.bridge.project(tab, post);
      return;
    }

    if (message.type === 'run' && managed.kind === 'runner') {
      await this.run(managed, message.values, post);
      return;
    }

    await this.bridge.handle(message, post);
  }

  private project(managed: Managed): void {
    this.bridge.project(managed.uri.toString(), (message) => void managed.panel.webview.postMessage(message));
  }

  /* ------------------------------------------------------------ table data */

  /**
   * The first page of a table.
   *
   * The row count in the corner is the estimate, from statistics, and it is
   * fetched alongside rather than as a `COUNT(*)`. A tool that counts on open
   * takes forty seconds to show an empty grid on the one table that most
   * needed looking at.
   */
  private async loadFirstPage(tab: string, profileId: string, ref: FavouriteRef): Promise<void> {
    const profile = this.store.get(profileId);
    if (!profile) {
      return;
    }
    const [keys, estimate] = await Promise.all([
      this.details.keyColumns(profileId, ref).catch(() => ({ columns: [], usable: false })),
      this.details.estimate(profileId, ref).catch(() => undefined)
    ]);
    const pageSize = this.execution.defaultLimit(profileId);
    const page = selectPage(profile.driver, {
      ref,
      columns: [],
      keyColumns: keys.columns,
      page: 0,
      pageSize
    });

    const record = await this.execution.run({
      tab,
      profileId,
      sql: page.sql,
      params: page.params,
      source: 'data',
      limit: pageSize,
      quiet: true,
      table: { ref, estimate, keyset: keys.usable, pageSize, page: 0, hasMore: true }
    });

    if (record?.table && record.sets[0]) {
      record.table.hasMore = record.sets[0].count >= pageSize;
      this.execution.notify(record);
    }
  }

  /* ---------------------------------------------------------------- runner */

  private async sendForm(managed: Managed, post: (message: QueryHostMessage) => void): Promise<void> {
    try {
      const members = await this.catalog.members(managed.profileId, managed.ref);
      const saved = this.savedValues(managed.profileId, managed.ref);
      post({ type: 'form', form: buildForm(managed.ref, members, saved) });
    } catch (error) {
      post({ type: 'notice', level: 'error', text: errorMessage(error) });
    }
  }

  private async run(
    managed: Managed,
    values: Record<string, RunnerValue>,
    post: (message: QueryHostMessage) => void
  ): Promise<void> {
    const profile = this.store.get(managed.profileId);
    if (!profile) {
      return;
    }
    try {
      const members = await this.catalog.members(managed.profileId, managed.ref);
      const form = buildForm(managed.ref, members, values);
      const call = buildCall(profile.driver, managed.ref, form.parameters, values);
      await this.rememberValues(managed.profileId, managed.ref, values);

      const record = await this.execution.run({
        tab: managed.uri.toString(),
        profileId: managed.profileId,
        sql: call.sql,
        params: call.params,
        source: 'runner'
      });
      if (record) {
        await this.liftOutputs(record);
        this.project(managed);
      }
    } catch (error) {
      post({ type: 'notice', level: 'error', text: errorMessage(error) });
    }
  }

  /**
   * Moves the return value and the output parameters out of the grid.
   *
   * SQL Server has no way to hand them back except as a result set, so the
   * call selects them — and a runner that left that set in the grid would put
   * a one-row table called `Return value` in front of the rows the procedure
   * actually produced. They are lifted into their own tabs instead, and the
   * set they arrived in is dropped.
   */
  private async liftOutputs(record: Parameters<ResultStore['project']>[0]): Promise<void> {
    const last = record.sets[record.sets.length - 1];
    if (!last || !last.columns.some((column) => column.name === 'Return value')) {
      return;
    }
    const row = (await this.results.read(last, 0, 1))[0];
    if (!row) {
      return;
    }
    const outputs: { name: string; value: (typeof row)[number] }[] = [];
    last.columns.forEach((column, index) => {
      if (column.name === 'Return value') {
        const value = Number(row[index]);
        record.returnValue = Number.isFinite(value) ? value : undefined;
        return;
      }
      outputs.push({ name: column.name, value: row[index] ?? null });
    });
    record.outputs = outputs;
    record.sets.pop();
  }

  /**
   * Arguments are remembered per routine per connection, and never across
   * connections.
   *
   * The customer id that exists in development does not exist in production,
   * and a form that helpfully pre-fills a production run with a development id
   * is a form that will eventually be part of an incident.
   */
  private savedValues(profileId: string, ref: FavouriteRef): Record<string, RunnerValue> {
    const all = this.context.workspaceState.get<Record<string, Record<string, RunnerValue>>>(RUNNER_VALUES_KEY, {});
    return all[`${profileId}:${ref.schema}.${ref.name}`] ?? {};
  }

  private async rememberValues(
    profileId: string,
    ref: FavouriteRef,
    values: Record<string, RunnerValue>
  ): Promise<void> {
    const all = this.context.workspaceState.get<Record<string, Record<string, RunnerValue>>>(RUNNER_VALUES_KEY, {});
    all[`${profileId}:${ref.schema}.${ref.name}`] = values;
    await this.context.workspaceState.update(RUNNER_VALUES_KEY, all);
    this.output.info(`runner: ${KINDS[ref.kind].singular} ${ref.schema}.${ref.name}`);
  }
}
