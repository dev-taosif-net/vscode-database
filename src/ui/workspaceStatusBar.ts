import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';
import { BindingStore } from '../query/bindingStore';
import { EnvironmentId, environmentLabel } from '../types';
import { ActiveTab } from './activeTab';

/**
 * The environment's own colour, as a theme colour the workbench will honour.
 *
 * Only production and UAT get a background: a status bar item that is coloured
 * all the time is a status bar item nobody reads, and the whole point of the
 * tint is that it means something the moment it appears.
 */
const BACKGROUNDS: Partial<Record<EnvironmentId, string>> = {
  prod: 'statusBarItem.errorBackground',
  uat: 'statusBarItem.warningBackground'
};

/**
 * The second status bar entry: which connection this tab runs on, and what the
 * last thing it ran came back with.
 *
 * Phase 1's entry keeps its job — the riskiest open connection, wherever you
 * are in the window. This one is about the tab in front of you, so it appears
 * only when there is one and disappears the moment there is not.
 */
export class WorkspaceStatusBar implements vscode.Disposable {
  private readonly connection: vscode.StatusBarItem;
  private readonly result: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

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
      this.store.onDidChange(() => this.render())
    );
    this.render();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
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
    void vscode.commands.executeCommand('setContext', 'databaseTools.sqlTab', Boolean(tab));
    void vscode.commands.executeCommand(
      'setContext',
      'databaseTools.running',
      record?.status === 'running'
    );

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
      this.connection.backgroundColor = undefined;
      this.connection.show();
      this.result.hide();
      return;
    }

    const dot = profile.environment === 'prod' ? '$(circle-large-filled)' : '$(circle-filled)';
    this.connection.text = `${dot} ${profile.name || profile.host}${profile.database ? ` · ${profile.database}` : ''}`;
    this.connection.tooltip = new vscode.MarkdownString(
      `**${environmentLabel(profile.environment)}**\n\n${profile.host}${
        profile.port ? `:${profile.port}` : ''
      }${profile.readOnly ? '\n\nRead-only' : ''}\n\nClick to change the connection for this tab.`
    );
    const background = BACKGROUNDS[profile.environment];
    this.connection.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.connection.show();

    if (!record) {
      this.result.hide();
      return;
    }
    if (record.status === 'running') {
      const seconds = ((Date.now() - record.startedAt) / 1000).toFixed(1);
      this.result.text = `$(sync~spin) Executing… ${seconds} s`;
      this.result.tooltip = 'Click to cancel.';
      this.result.show();
      return;
    }
    const rows = record.sets.reduce((sum, set) => sum + set.count, 0);
    const elapsed = (record.finishedAt ?? Date.now()) - record.startedAt;
    const shape =
      record.status === 'error'
        ? '$(error) Failed'
        : record.status === 'cancelled'
          ? `$(circle-slash) Cancelled · ${rows.toLocaleString('en-US')} rows`
          : `${rows.toLocaleString('en-US')} rows · ${formatDuration(elapsed)}`;
    this.result.text = shape;
    this.result.tooltip = record.error?.text ?? 'The last statement run on this tab.';
    this.result.show();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
