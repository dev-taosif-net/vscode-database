import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';

/**
 * Keeps `databaseTools.hasActiveConnection` true for exactly as long as a
 * session is open, and does nothing else.
 *
 * This is what is left of the window-wide status bar entry. That entry named
 * the riskiest open connection on the left of the strip while the tab's entry
 * named the bound one on the right, and in the ordinary case — one connection,
 * one editor — they were the same sentence printed twice at opposite ends of
 * the window. The tab's entry is the one that survives: it answers for the
 * file in front of you, which is the question the strip is being asked.
 *
 * The context key had to survive the entry. It gates the connect and disconnect
 * commands in the palette and the explorer's toolbar, and it has one writer on
 * purpose: the sidebar used to set it too, from a view that may never have been
 * resolved, so the key could disagree with itself depending on which panel had
 * been opened.
 */
export class ActiveConnectionContext implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private hadActive: boolean | undefined;

  constructor(private readonly manager: ConnectionManager) {
    this.disposables.push(this.manager.onDidChange(() => this.refresh()));
    this.refresh();
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private refresh(): void {
    const active = this.manager.activeIds().length > 0;
    if (this.hadActive === active) {
      return;
    }
    this.hadActive = active;
    void vscode.commands.executeCommand('setContext', 'databaseTools.hasActiveConnection', active);
  }
}
