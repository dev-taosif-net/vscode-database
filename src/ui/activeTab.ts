import * as vscode from 'vscode';
import { BindingStore, isOwnScheme } from '../query/bindingStore';

/**
 * Which tab the results panel is showing for.
 *
 * There is one grid and many tabs, so something has to say which tab owns it,
 * and that something cannot be `window.activeTextEditor` alone: a table data
 * tab and a procedure runner are webviews, and the workbench does not report
 * them as active editors. So the two sources are merged here — text editors
 * report themselves, webview panels announce themselves — and everything
 * downstream reads one value.
 */
export class ActiveTab implements vscode.Disposable {
  private current: string | undefined;
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly bindings: BindingStore) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          // An editor group emptied, or focus moved to a webview that will
          // announce itself in a moment. The panel keeps showing what it was
          // showing rather than blanking and then filling again.
          return;
        }
        this.set(this.tabOf(editor.document));
      })
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.emitter.dispose();
  }

  get value(): string | undefined {
    return this.current;
  }

  /** Announced by a webview panel when it becomes visible and focused. */
  set(tab: string | undefined): void {
    if (tab === this.current) {
      return;
    }
    this.current = tab;
    this.emitter.fire(tab);
  }

  /**
   * The tab a document belongs to, or undefined when it is not ours.
   *
   * An unbound `.sql` file is deliberately still a tab: its results are shown,
   * and the status bar offers to bind it. A README is not.
   */
  tabOf(document: vscode.TextDocument): string | undefined {
    if (isOwnScheme(document.uri.scheme)) {
      return document.uri.toString();
    }
    if (document.languageId !== 'sql') {
      return undefined;
    }
    return this.bindings.get(document.uri) ? document.uri.toString() : undefined;
  }
}
