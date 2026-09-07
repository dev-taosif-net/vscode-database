import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { DetailsService } from '../details/detailsService';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';
import { crudScript, qualified, selectTop, tableScript } from '../catalog/script';
import { statementAt } from '../exec/splitter';
import { BindingStore, DATA_SCHEME, QUERY_SCHEME, RUNNER_SCHEME } from '../query/bindingStore';
import { DefinitionProvider, QueryFileSystem } from '../query/queryFs';
import { SavedQueryStore } from '../query/savedQueries';
import { formatSql, optionsFrom } from '../query/format';
import { FavouriteRef, KINDS } from '../shared/catalog';
import { ConnectionProfile, DriverKind, environmentLabel } from '../types';
import { ActiveTab } from './activeTab';
import { ObjectTarget, objectTarget } from './objectCommands';
import { ResultsView } from './resultsView';
import { WorkspacePanels } from './workspacePanels';

/** What Select Top offers, and what View Data does not need. */
const TOPS = [100, 1000];

/**
 * Every verb phase 3 adds.
 *
 * They are commands rather than buttons because the workbench draws the
 * toolbar and a menu item can invoke nothing but a command — the same reason
 * the object explorer's menu is nine commands rather than a quick pick. What
 * changed is that these end in rows: phase 2's actions all produced SQL and
 * said there was nowhere to put the answer, and there is now.
 */
export class QueryCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly catalog: CatalogService,
    private readonly details: DetailsService,
    private readonly execution: ExecutionService,
    private readonly results: ResultStore,
    private readonly files: QueryFileSystem,
    private readonly definitions: DefinitionProvider,
    private readonly bindings: BindingStore,
    private readonly saved: SavedQueryStore,
    private readonly panels: WorkspacePanels,
    private readonly resultsView: ResultsView,
    private readonly active: ActiveTab,
    private readonly output: vscode.LogOutputChannel
  ) {}

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  register(): vscode.Disposable[] {
    const on = (id: string, run: (...args: unknown[]) => Promise<void> | void) =>
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await run(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.output.error(`${id}: ${message}`);
          void vscode.window.showErrorMessage(message);
        }
      });

    return [
      on('databaseTools.run', () => this.run(false)),
      on('databaseTools.runStatement', () => this.run(true)),
      on('databaseTools.cancelQuery', () => this.cancel()),
      on('databaseTools.explainPlan', () => this.explain('estimated')),
      on('databaseTools.explainActual', () => this.explain('actual')),
      on('databaseTools.formatQuery', () => this.format()),
      on('databaseTools.newQuery', (target) => this.newQuery(target)),
      on('databaseTools.bindConnection', () => this.bind()),
      on('databaseTools.saveQuery', () => this.saveQuery()),
      on('databaseTools.shareQuery', () => this.share()),
      on('databaseTools.disconnectTab', () => this.disconnectTab()),

      on('databaseTools.viewData', (target) => this.withObject(target, (t) => this.panels.openData(t.profileId, t.ref))),
      on('databaseTools.runRoutine', (target) =>
        this.withObject(target, (t) => this.panels.openRunner(t.profileId, t.ref))
      ),
      on('databaseTools.selectTop1000', (target) => this.withObject(target, (t) => this.selectTopRows(t, TOPS[1]))),
      on('databaseTools.countRows', (target) => this.withObject(target, (t) => this.countExactly(t))),
      on('databaseTools.scriptCreate', (target) => this.withObject(target, (t) => this.script(t, 'create'))),
      on('databaseTools.scriptDrop', (target) => this.withObject(target, (t) => this.script(t, 'drop'))),
      on('databaseTools.viewDependencies', (target) => this.withObject(target, (t) => this.dependencies(t))),
      on('databaseTools.compareWith', (target) => this.withObject(target, (t) => this.compare(t))),
      on('databaseTools.showDetails', (target) =>
        this.withObject(target, async (t) => {
          await vscode.commands.executeCommand(`${'databaseTools.details'}.focus`);
          this.onShowDetails?.(t.profileId, t.ref);
        })
      ),

      vscode.languages.registerDocumentFormattingEditProvider(
        { language: 'sql' },
        {
          provideDocumentFormattingEdits: (document, options) => this.formatEdits(document, options)
        }
      ),
      vscode.languages.registerDocumentRangeFormattingEditProvider(
        { language: 'sql' },
        {
          provideDocumentRangeFormattingEdits: (document, range, options) =>
            this.formatEdits(document, options, range)
        }
      )
    ];
  }

  /** Set by the extension so Show Details can reach the panel. */
  onShowDetails: ((profileId: string, ref: FavouriteRef) => void) | undefined;

  /* -------------------------------------------------------------- running */

  /**
   * Run, from the toolbar, F5 or Ctrl+Enter.
   *
   * A selection wins over the document, because selecting three lines and
   * pressing F5 has meant "run these three lines" in every database tool since
   * Query Analyzer, and a tool that ran the whole file instead would be
   * remembered for it.
   */
  private async run(currentStatementOnly: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a SQL file to run a statement.');
      return;
    }
    const profile = await this.requireBinding(editor.document);
    if (!profile) {
      return;
    }

    const text = editor.document.getText();
    let sql = editor.selection.isEmpty ? text : editor.document.getText(editor.selection);
    if (currentStatementOnly && editor.selection.isEmpty) {
      const statement = statementAt(text, editor.document.offsetAt(editor.selection.active), profile.driver);
      sql = statement?.text ?? sql;
    }
    if (!sql.trim()) {
      return;
    }

    await this.resultsView.reveal();
    await this.execution.run({
      tab: editor.document.uri.toString(),
      profileId: profile.id,
      sql,
      source: 'query'
    });
  }

  private async cancel(): Promise<void> {
    const tab = this.active.value;
    if (tab) {
      await this.execution.cancelTab(tab);
    }
  }

  private async explain(mode: 'estimated' | 'actual'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const profile = await this.requireBinding(editor.document);
    if (!profile) {
      return;
    }
    const sql = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    if (!sql.trim()) {
      return;
    }

    // An actual plan on PostgreSQL runs the statement for real. Anything that
    // writes is wrapped in a transaction that rolls back, and the person is
    // told that before it happens rather than after.
    if (mode === 'actual' && profile.driver === 'postgres') {
      const choice = await vscode.window.showWarningMessage(
        'An actual plan runs the statement.',
        {
          modal: true,
          detail:
            'PostgreSQL has no way to measure a plan without executing it. A statement that writes is wrapped in a transaction that is rolled back, but triggers, sequences and side effects outside the transaction still happen.'
        },
        'Run it'
      );
      if (choice !== 'Run it') {
        return;
      }
    }

    await this.resultsView.reveal();
    await this.execution.run({
      tab: editor.document.uri.toString(),
      profileId: profile.id,
      sql,
      source: 'query',
      plan: mode
    });
  }

  /* ------------------------------------------------------------ formatting */

  private async format(): Promise<void> {
    await vscode.commands.executeCommand('editor.action.formatDocument');
  }

  private formatEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    range?: vscode.Range
  ): vscode.TextEdit[] {
    const profileId = this.bindings.get(document.uri);
    const driver: DriverKind = profileId ? (this.store.get(profileId)?.driver ?? 'mssql') : 'mssql';
    const target = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const source = document.getText(target);
    const formatted = formatSql(source, driver, optionsFrom(document, options));
    if (formatted === source) {
      return [];
    }
    return [vscode.TextEdit.replace(target, formatted)];
  }

  /* --------------------------------------------------------------- binding */

  /**
   * The connection a tab runs on.
   *
   * Changing it never re-runs anything and never closes a session. It changes
   * which pool the next execution asks, and nothing else — which is why a tab
   * can be pointed at UAT, run, pointed at production and run again without
   * anything being reconnected in between.
   */
  private async bind(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri ?? (this.active.value ? vscode.Uri.parse(this.active.value) : undefined);
    if (!uri) {
      return;
    }
    if (uri.scheme === QUERY_SCHEME || uri.scheme === DATA_SCHEME || uri.scheme === RUNNER_SCHEME) {
      void vscode.window.showInformationMessage(
        'This tab is bound to the connection it was opened from. Open a new query to use a different one.'
      );
      return;
    }
    const profile = await this.pick('Run this file against');
    if (profile) {
      await this.bindings.set(uri, profile.id);
    }
  }

  private async requireBinding(document: vscode.TextDocument): Promise<ConnectionProfile | undefined> {
    const existing = this.bindings.get(document.uri);
    const profile = existing ? this.store.get(existing) : undefined;
    if (profile) {
      return profile;
    }
    // A `.sql` file the user opened themselves has no connection yet, and the
    // moment they press Run is exactly the moment to ask.
    const chosen = await this.pick('Run this file against');
    if (chosen) {
      await this.bindings.set(document.uri, chosen.id);
    }
    return chosen;
  }

  private async pick(title: string): Promise<ConnectionProfile | undefined> {
    const open = this.manager.activeIds();
    const profiles = this.store.all();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage('There are no connections yet. Open the Connections tab to add one.');
      return undefined;
    }
    const items = profiles.map((profile) => ({
      label: `${open.includes(profile.id) ? '$(circle-filled)' : '$(circle-outline)'} ${profile.name || profile.host}`,
      description: `${profile.host}${profile.database ? ` · ${profile.database}` : ''}`,
      detail: environmentLabel(profile.environment),
      id: profile.id
    }));
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    if (!picked) {
      return undefined;
    }
    const profile = this.store.get(picked.id);
    if (profile && !this.manager.isConnected(profile.id)) {
      await vscode.commands.executeCommand('databaseTools.connect', profile.id);
    }
    return profile;
  }

  private async disconnectTab(): Promise<void> {
    const tab = this.active.value;
    if (!tab) {
      return;
    }
    await this.execution.closeTab(tab);
    this.results.dropTab(tab);
  }

  /* ---------------------------------------------------------- new and save */

  private async newQuery(target?: unknown): Promise<void> {
    const id = typeof target === 'string' ? target : (target as { connectionId?: string })?.connectionId;
    const profile = id ? this.store.get(id) : await this.pick('New query against');
    if (!profile) {
      return;
    }
    const uri = this.files.uniqueQuery(profile.id, 'Query');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async saveQuery(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const profileId = this.bindings.get(editor.document.uri);
    if (!profileId) {
      void vscode.window.showInformationMessage('Choose a connection for this query first.');
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Save query as',
      value: editor.document.uri.path.replace(/^\//, '').replace(/\.sql$/i, ''),
      prompt: `Saved under ${this.saved.folder().fsPath}`
    });
    if (!name) {
      return;
    }
    const description = await vscode.window.showInputBox({
      title: 'Description',
      prompt: 'One line, written into the file as a comment. Leave empty to skip.'
    });
    const uri = await this.saved.save(name, editor.document.getText(), profileId, description || undefined);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(`Saved to ${vscode.workspace.asRelativePath(uri)}.`);
  }

  /**
   * Share, and deliberately local.
   *
   * There is no upload here and there is not going to be one. The extension
   * has never made a network request, the content security policy in every
   * webview forbids one, and a Share button that posted somebody's production
   * SQL somewhere would be the first time any of that stopped being true.
   */
  private async share(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const profileId = this.bindings.get(editor.document.uri);
    const profile = profileId ? this.store.get(profileId) : undefined;
    const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(clippy) Copy the SQL', id: 'sql' },
        { label: '$(comment) Copy with the connection header', id: 'header' },
        { label: '$(markdown) Copy as a Markdown block', id: 'markdown' },
        { label: '$(save-as) Save it as a query file', id: 'save' }
      ],
      { title: 'Share' }
    );
    if (!choice) {
      return;
    }
    if (choice.id === 'save') {
      await this.saveQuery();
      return;
    }
    const header = profile ? `-- @connection ${profile.name || profile.host}\n` : '';
    const text =
      choice.id === 'markdown'
        ? `\`\`\`sql\n${header}${sql.trim()}\n\`\`\`\n`
        : choice.id === 'header'
          ? `${header}${sql}`
          : sql;
    await vscode.env.clipboard.writeText(text);
  }

  /* --------------------------------------------------------------- objects */

  private async withObject(target: unknown, run: (target: ObjectTarget) => Promise<void>): Promise<void> {
    const resolved = objectTarget(target);
    if (!resolved) {
      void vscode.window.showInformationMessage('Right-click an object in the explorer to use this.');
      return;
    }
    await run(resolved);
  }

  /**
   * Select Top, which now executes rather than scaffolding.
   *
   * It opens the statement in a query tab and runs it, so the SQL stays
   * visible and editable — which is the difference between a tool that shows
   * you rows and one that shows you how it got them.
   */
  private async selectTopRows(target: ObjectTarget, limit: number): Promise<void> {
    const profile = this.store.get(target.profileId);
    if (!profile) {
      return;
    }
    const sql = selectTop(profile.driver, target.ref, limit);
    const uri = this.files.uniqueQuery(profile.id, `${target.ref.name} top ${limit}`, sql);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    await this.resultsView.reveal();
    await this.execution.run({ tab: uri.toString(), profileId: profile.id, sql, source: 'query', limit });
  }

  private async countExactly(target: ObjectTarget): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Counting ${target.ref.schema}.${target.ref.name}` },
      async () => {
        const count = await this.details.exactCount(target.profileId, target.ref);
        void vscode.window.showInformationMessage(
          count === undefined
            ? 'The count could not be read.'
            : `${target.ref.schema}.${target.ref.name} holds ${count.toLocaleString('en-US')} rows.`
        );
      }
    );
  }

  private async script(target: ObjectTarget, kind: 'create' | 'drop'): Promise<void> {
    const profile = this.store.get(target.profileId);
    if (!profile) {
      return;
    }
    if (kind === 'drop') {
      // Always the guarded form, and always in an editor. Nothing in phase 3
      // drops anything without a person pressing Run on a statement they can
      // read first.
      const name = qualified(profile.driver, target.ref);
      const sql =
        profile.driver === 'mssql'
          ? `IF OBJECT_ID(N'${target.ref.schema}.${target.ref.name}') IS NOT NULL\n    DROP ${sqlNoun(target.ref)} ${name};\n`
          : `DROP ${sqlNoun(target.ref)} IF EXISTS ${name};\n`;
      await this.openScratch(profile.id, `Drop ${target.ref.name}`, sql);
      return;
    }

    if (target.ref.kind === 'table') {
      const columns = await this.catalog.columns(target.profileId, target.ref);
      await this.openScratch(
        profile.id,
        `${target.ref.name} CREATE`,
        tableScript(profile.driver, target.ref, columns)
      );
      return;
    }
    const uri = DefinitionProvider.address(profile.id, target.ref);
    this.definitions.refresh(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async dependencies(target: ObjectTarget): Promise<void> {
    const details = await this.details.describe(target.profileId, target.ref);
    const lines: string[] = [
      `-- ${target.ref.schema}.${target.ref.name}`,
      '',
      `-- Depends on (${details.dependsOn?.length ?? 0})`
    ];
    for (const dependency of details.dependsOn ?? []) {
      lines.push(`--   ${dependency.schema}.${dependency.name}  -- ${dependency.why}`);
    }
    lines.push('', `-- Used by (${details.usedBy?.length ?? 0})`);
    for (const dependency of details.usedBy ?? []) {
      lines.push(
        `--   ${dependency.schema}.${dependency.name}  -- ${dependency.why}${
          dependency.inferred ? ' (matched in source, not tracked by the server)' : ''
        }`
      );
    }
    await this.openScratch(target.profileId, `${target.ref.name} dependencies`, `${lines.join('\n')}\n`);
  }

  /**
   * Compare With, and honest about what it is.
   *
   * Schema comparison is a feature the size of this whole phase. What this
   * does is open two definitions in the workbench's own diff editor, which is
   * genuinely useful and is a diff of two scripts rather than a comparison of
   * two schemas — so it says so.
   */
  private async compare(target: ObjectTarget): Promise<void> {
    const others = this.manager
      .activeIds()
      .filter((id) => id !== target.profileId)
      .map((id) => this.store.get(id))
      .filter((profile): profile is ConnectionProfile => Boolean(profile));

    if (others.length === 0) {
      void vscode.window.showInformationMessage(
        'Open a second connection to compare against. This compares two scripted definitions, not two schemas.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      others.map((profile) => ({
        label: profile.name || profile.host,
        detail: environmentLabel(profile.environment),
        id: profile.id
      })),
      { title: `Compare ${target.ref.schema}.${target.ref.name} with` }
    );
    if (!picked) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      DefinitionProvider.address(target.profileId, target.ref),
      DefinitionProvider.address(picked.id, target.ref),
      `${target.ref.name}: ${this.store.get(target.profileId)?.name} ↔ ${picked.label}`
    );
  }

  /** Opens a scratch query bound to a connection. Never saved anywhere. */
  async openScratch(profileId: string, name: string, content: string): Promise<vscode.Uri> {
    const uri = this.files.uniqueQuery(profileId, name, content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return uri;
  }

  /** Generate CRUD, moved here so it opens a runnable tab rather than a buffer. */
  async generateCrud(target: ObjectTarget): Promise<void> {
    const profile = this.store.get(target.profileId);
    if (!profile) {
      return;
    }
    const columns = await this.catalog.columns(target.profileId, target.ref);
    if (columns.length === 0) {
      throw new Error(`${target.ref.schema}.${target.ref.name} has no columns to script.`);
    }
    await this.openScratch(
      profile.id,
      `${target.ref.name} CRUD`,
      crudScript(profile.driver, target.ref, columns)
    );
  }
}

function sqlNoun(ref: FavouriteRef): string {
  return KINDS[ref.kind].singular.toUpperCase();
}
