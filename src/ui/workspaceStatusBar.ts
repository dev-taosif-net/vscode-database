import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { ExecutionService } from '../exec/executionService';
import { ExecutionRecord, ResultStore } from '../exec/resultStore';
import { BindingStore } from '../query/bindingStore';
import { effectiveDatabase, environmentLabel, switchesDatabase } from '../types';
import { ActiveTab } from './activeTab';
import { loginLabel, paintChip, paintDatabase } from './connectionChip';

/**
 * The status bar: which connection this tab runs on, as whom, in which
 * database, and what the last thing it ran came to.
 *
 * There used to be a second entry on the left naming the riskiest open
 * connection window-wide. With one connection and one editor open, which is the
 * ordinary case, the two said the same thing at opposite ends of the strip.
 * This is the one that survived, because it answers for the file in front of
 * you; `ActiveConnectionContext` inherited the context key the other one owned.
 */
export class WorkspaceStatusBar implements vscode.Disposable {
  private readonly connection: vscode.StatusBarItem;
  private readonly database: vscode.StatusBarItem;
  private readonly result: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last values written, so a progress tick does not rewrite two keys. */
  private keys = { sqlTab: undefined as boolean | undefined, running: undefined as boolean | undefined };

  constructor(
    private readonly store: ConnectionStore,
    private readonly bindings: BindingStore,
    private readonly results: ResultStore,
    private readonly execution: ExecutionService,
    private readonly active: ActiveTab
  ) {
    this.connection = vscode.window.createStatusBarItem('databaseTools.tabConnection', vscode.StatusBarAlignment.Right, 100);
    this.connection.command = 'databaseTools.bindConnection';
    // Between the connection and the result, because that is the order the
    // three are read in: which server, which database, what happened.
    this.database = vscode.window.createStatusBarItem('databaseTools.tabDatabase', vscode.StatusBarAlignment.Right, 99.5);
    this.database.command = 'databaseTools.selectDatabase';
    this.result = vscode.window.createStatusBarItem('databaseTools.tabResult', vscode.StatusBarAlignment.Right, 99);

    this.disposables.push(
      this.connection,
      this.database,
      this.result,
      this.active.onDidChange(() => this.render()),
      this.bindings.onDidChange(() => this.render()),
      this.execution.onDidChange(() => this.render()),
      this.store.onDidChange(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('databaseTools.statusBar')) {
          this.render();
        }
      })
    );
    this.render();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private setKey(key: 'sqlTab' | 'running', value: boolean): void {
    if (this.keys[key] === value) {
      return;
    }
    this.keys[key] = value;
    void vscode.commands.executeCommand('setContext', `databaseTools.${key}`, value);
  }

  render(): void {
    const tab = this.active.value;
    const record = tab ? this.results.latestFor(tab) : undefined;

    /*
     * The two keys the toolbar is built on.
     *
     * `sqlTab` is what puts Run on the editor title bar and what scopes the
     * Ctrl+Shift+F override, so it has to be false everywhere else in the
     * window — including in an unbound `.sql` file, where Find in Files must
     * keep meaning Find in Files. `running` is what swaps Run for Cancel.
     */
    this.setKey('sqlTab', Boolean(tab));
    this.setKey('running', record?.status === 'running');

    /*
     * The keys are set first and unconditionally. `databaseTools.statusBar`
     * turns off two entries in the strip, not the toolbar above it, and a
     * window with the strip switched off must still get Run on its title bar.
     */
    if (!vscode.workspace.getConfiguration('databaseTools').get<boolean>('statusBar', true)) {
      this.connection.hide();
      this.database.hide();
      this.result.hide();
      return;
    }

    if (!tab) {
      this.connection.hide();
      this.database.hide();
      this.result.hide();
      return;
    }

    const uri = vscode.Uri.parse(tab);
    const profileId = this.bindings.get(uri);
    const profile = profileId ? this.store.get(profileId) : undefined;

    if (!profile) {
      this.connection.text = '$(plug) Not connected';
      this.connection.tooltip = 'Choose a connection for this file.';
      // Both, or an unbound tab keeps the ink of whatever it was bound to last.
      this.connection.backgroundColor = undefined;
      this.connection.color = undefined;
      this.connection.show();
      // A file with no connection has no database either, and an entry left
      // over from the last file would be naming one on another server.
      this.database.hide();
      this.result.hide();
      return;
    }

    /*
     * Connection, server, login, database, in the environment's own colour.
     *
     * The colour is the carrier here, not the label: an entry you have to read
     * before you know you are on production is an entry you read once and then
     * stop seeing. The full host, the port and the environment's name are one
     * hover away, which is where a value you only want when you are already
     * asking for it belongs.
     */
    const moved = this.bindings.database(uri);
    const database = effectiveDatabase(profile, moved);
    const login = loginLabel(profile);

    paintChip(this.connection, profile);
    this.connection.tooltip = new vscode.MarkdownString(
      `**${environmentLabel(profile.environment)}** · ${profile.name.trim() || profile.host}\n\n${profile.host}${
        profile.port ? `:${profile.port}` : ''
      }${database ? ` · ${database}` : ''}` +
        (login ? `\n\nSigned in as ${login}` : '') +
        (profile.readOnly ? '\n\nRead-only' : '') +
        '\n\nClick to change the connection for this tab.'
    );
    this.connection.show();

    /*
     * Where this tab is, which the connection alone cannot say.
     *
     * The entry names the database the next Run will actually reach, and the
     * tooltip carries the part that only matters once: whether the tab got
     * there by itself. A `USE` twenty lines into a script is the easiest way
     * in this whole extension to end up somewhere you did not mean to be, and
     * the strip saying `Reporting` where it said `PeopleDeskMatador` a moment
     * ago is the cheapest possible way to notice.
     */
    paintDatabase(this.database, profile, database);
    const switchable = switchesDatabase(profile.driver);
    const away = Boolean(moved) && moved!.toLowerCase() !== profile.database.trim().toLowerCase();
    this.database.tooltip = new vscode.MarkdownString(
      `**${database || "The login's default database"}**\n\n` +
        (away
          ? `This tab has moved here from ${profile.database || "the login's default"}. It stays here until you move it again.\n\n`
          : '') +
        (switchable
          ? 'Click to run `USE` on this tab.'
          : 'PostgreSQL cannot move a session between databases; open a second connection instead.')
    );
    this.database.show();

    this.paintResult(record);
  }

  /**
   * What the tab last did, in one glance.
   *
   * Every state has a line. It used to show only running and failed, on the
   * grounds that a finished query's numbers are the results panel's own
   * headline restated. But the panel is a click away and often closed, and an
   * entry that vanishes on success reads as an entry that broke. `Ready`
   * before the first run, the row count and the time after it, the spinner
   * while it goes, and the failure when it does not come back.
   */
  private paintResult(record: ExecutionRecord | undefined): void {
    if (!record) {
      this.result.text = '$(circle-large-outline) Ready';
      this.result.tooltip = 'Nothing has run on this tab yet. F5 or Ctrl+Enter runs the file or the selection.';
      this.result.command = 'databaseTools.run';
      this.result.show();
      return;
    }

    if (record.status === 'running') {
      this.result.text = `$(sync~spin) Executing… ${elapsed(record)}`;
      this.result.tooltip = 'Click to cancel.';
      this.result.command = 'databaseTools.cancelQuery';
      this.result.show();
      return;
    }

    if (record.status === 'done') {
      this.result.text = `$(check) ${rowSummary(record)} · ${elapsed(record)}`;
      this.result.tooltip = new vscode.MarkdownString(
        `**Finished** at ${new Date(record.finishedAt ?? record.startedAt).toLocaleTimeString()}\n\n` +
          `${rowSummary(record)} in ${elapsed(record)} across ${record.sets.length} result set${
            record.sets.length === 1 ? '' : 's'
          }.\n\nClick to open the results.`
      );
      this.result.command = 'databaseTools.results.focus';
      this.result.show();
      return;
    }

    this.result.text = record.status === 'error' ? '$(error) Failed' : '$(circle-slash) Cancelled';
    this.result.tooltip = record.error?.text ?? 'The last statement run on this tab.';
    this.result.command = 'databaseTools.results.focus';
    this.result.show();
  }
}

/**
 * The rows a run produced, as the strip has room to say it.
 *
 * Rows fetched wins when there are any; a statement that returned no grid but
 * reported a count says how many it affected instead, and one that did neither
 * says `0 rows` — an empty answer, which is what it was.
 */
function rowSummary(record: ExecutionRecord): string {
  const fetched = record.sets.reduce((sum, set) => sum + set.count, 0);
  const affected = record.sets.reduce<number | undefined>(
    (sum, set) => (set.columns.length === 0 && set.total !== undefined ? (sum ?? 0) + set.total : sum),
    undefined
  );
  if (fetched > 0 || affected === undefined) {
    const truncated = record.sets.some((set) => set.truncated);
    return `${fetched.toLocaleString('en-US')}${truncated ? '+' : ''} row${fetched === 1 ? '' : 's'}`;
  }
  return `${affected.toLocaleString('en-US')} row${affected === 1 ? '' : 's'} affected`;
}

/** Milliseconds under a second, seconds to one decimal under a minute, then minutes. */
function elapsed(record: ExecutionRecord): string {
  const ms = Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt);
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
