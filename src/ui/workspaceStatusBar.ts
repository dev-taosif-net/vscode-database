import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';
import { BindingStore } from '../query/bindingStore';
import { environmentLabel } from '../types';
import { ActiveTab } from './activeTab';
import { paintChip } from './connectionChip';

/**
 * The status bar: which connection this tab runs on, and whether the last thing
 * it ran is still going.
 *
 * There used to be a second entry on the left naming the riskiest open
 * connection window-wide. With one connection and one editor open, which is the
 * ordinary case, the two said the same thing at opposite ends of the strip.
 * This is the one that survived, because it answers for the file in front of
 * you; `ActiveConnectionContext` inherited the context key the other one owned.
 */
export class WorkspaceStatusBar implements vscode.Disposable {
  private readonly connection: vscode.StatusBarItem;
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
    this.result = vscode.window.createStatusBarItem('databaseTools.tabResult', vscode.StatusBarAlignment.Right, 99);
    this.result.command = 'databaseTools.cancelQuery';

    this.disposables.push(
      this.connection,
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
      this.result.hide();
      return;
    }

    if (!tab) {
      this.connection.hide();
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
      this.result.hide();
      return;
    }

    /*
     * Connection, server, database, in the environment's own colour.
     *
     * The colour is the carrier here, not the label: an entry you have to read
     * before you know you are on production is an entry you read once and then
     * stop seeing. The full host, the port and the environment's name are one
     * hover away, which is where a value you only want when you are already
     * asking for it belongs.
     */
    paintChip(this.connection, profile);
    this.connection.tooltip = new vscode.MarkdownString(
      `**${environmentLabel(profile.environment)}**\n\n${profile.host}${
        profile.port ? `:${profile.port}` : ''
      }${profile.database ? ` · ${profile.database}` : ''}${profile.readOnly ? '\n\nRead-only' : ''}` +
        '\n\nClick to change the connection for this tab.'
    );
    this.connection.show();

    if (!record) {
      this.result.hide();
      return;
    }
    if (record.status === 'running') {
      this.result.text = '$(sync~spin) Executing…';
      this.result.tooltip = 'Click to cancel.';
      this.result.show();
      return;
    }

    /*
     * Only the two states you can still act on.
     *
     * A finished query used to leave its row count and its elapsed time in the
     * strip until the next one replaced them, which is the results panel's own
     * headline restated a screen away from the panel. What is left is the pair
     * the panel cannot answer from the corner of the eye: something is still
     * running, or the last thing did not finish.
     */
    if (record.status === 'done') {
      this.result.hide();
      return;
    }
    this.result.text = record.status === 'error' ? '$(error) Failed' : '$(circle-slash) Cancelled';
    this.result.tooltip = record.error?.text ?? 'The last statement run on this tab.';
    this.result.show();
  }
}
