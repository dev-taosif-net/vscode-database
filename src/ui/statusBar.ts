import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { EnvironmentId, environmentMeta } from '../types';

/**
 * Shows what is open, and how dangerous it is.
 *
 * VS Code only lets a status bar item take one of the theme's own background
 * colours, so the environment is carried by the label and by the two tints the
 * platform does allow: error for production, warning for UAT.
 */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private hadActive: boolean | undefined;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager
  ) {
    this.item = vscode.window.createStatusBarItem('databaseTools.connection', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Database connection';
    this.item.command = 'databaseTools.openConnections';

    this.disposables.push(
      this.item,
      this.manager.onDidChange(() => this.refresh()),
      this.store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('databaseTools.statusBar')) {
          this.refresh();
        }
      })
    );

    this.refresh();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private refresh(): void {
    const enabled = vscode.workspace.getConfiguration('databaseTools').get<boolean>('statusBar', true);
    const ids = this.manager.activeIds();

    // The only writer of this key. The sidebar used to set it too, from a
    // view that may never have been resolved, so the key could disagree with
    // itself depending on which panel the user had opened.
    if (this.hadActive !== ids.length > 0) {
      this.hadActive = ids.length > 0;
      void vscode.commands.executeCommand('setContext', 'databaseTools.hasActiveConnection', this.hadActive);
    }

    if (!enabled || ids.length === 0) {
      this.item.hide();
      return;
    }

    const profiles = ids.map((id) => this.store.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (profiles.length === 0) {
      this.item.hide();
      return;
    }

    // The riskiest open connection decides the tint, so a production session
    // is never hidden behind a development one.
    const rank: Record<EnvironmentId, number> = { dev: 0, qa: 1, uat: 2, prod: 3 };
    const worst = profiles.reduce((a, b) => (rank[b.environment] > rank[a.environment] ? b : a));
    const short = environmentMeta(worst.environment).short;

    const label =
      profiles.length === 1 ? `${worst.name} · ${short}` : `${profiles.length} connections · ${short}`;
    this.item.text = `$(database) ${label}`;

    const info = this.manager.infoFor(worst.id);
    const readOnly = info?.readOnly ? '\nRead-only session' : '';
    this.item.tooltip = new vscode.MarkdownString(
      `**${worst.name}**\n\n${worst.host}${worst.port ? `:${worst.port}` : ''} · ${worst.database || 'default database'}` +
        `${info ? `\n\n${info.serverVersion} · ${info.principal}` : ''}${readOnly}`
    );

    this.item.backgroundColor =
      worst.environment === 'prod'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : worst.environment === 'uat'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    this.item.show();
  }
}
