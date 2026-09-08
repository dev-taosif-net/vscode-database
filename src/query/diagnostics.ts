import * as vscode from 'vscode';
import { ExecutionService } from '../exec/executionService';
import { ResultStore } from '../exec/resultStore';

/**
 * Server errors, underlined where the server put them.
 *
 * Nothing is validated before it runs. A client-side SQL validator has to
 * choose a dialect, a version and a set of extensions, and one that disagrees
 * with the server is worse than none: it underlines correct SQL and stays
 * quiet on the statement that actually fails. So the only thing that ever
 * appears here is what the server itself rejected, mapped back to the line of
 * the batch that produced it.
 *
 * It listens to every change rather than to `onDidFinish`, because the quiet
 * runs — Refresh, Run again for more — never finish loudly, and a squiggle
 * that ignored them would outlive a statement that has since succeeded, or
 * miss one that has since failed.
 */
export class SqlDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('databaseTools');
  private readonly disposables: vscode.Disposable[] = [];

  constructor(execution: ExecutionService, results: ResultStore) {
    this.disposables.push(
      this.collection,
      execution.onDidChange((change) => {
        const record = results.peek(change.executionId);
        if (!record) {
          return;
        }
        // A tab that starts running clears its last failure straight away, so a
        // squiggle never outlives the statement it belonged to.
        this.apply(record.tab, record.status === 'running' ? undefined : record.error);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.collection.delete(document.uri))
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private apply(tab: string, error: { text: string; line?: number } | undefined): void {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(tab);
    } catch {
      return;
    }
    if (!error) {
      this.collection.delete(uri);
      return;
    }

    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === tab);
    if (!document) {
      // A data or runner tab has no document to underline. The Messages pane
      // is where its errors live.
      return;
    }
    const line = Math.max(0, Math.min(document.lineCount - 1, (error.line ?? 1) - 1));
    // The whole line rather than a guessed span: the server reports a line and
    // a statement, never a column, and inventing a range would underline the
    // wrong token often enough to be worse than underlining all of them.
    const range = document.lineAt(line).range;
    const diagnostic = new vscode.Diagnostic(range, error.text, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'Database Tools';
    this.collection.set(uri, [diagnostic]);
  }
}
