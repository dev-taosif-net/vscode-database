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
 */
export class SqlDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('databaseTools');
  private readonly disposables: vscode.Disposable[] = [];

  constructor(execution: ExecutionService, results: ResultStore) {
    this.disposables.push(
      this.collection,
      execution.onDidFinish((record) => this.apply(record.tab, record.error)),
      // A tab that starts running clears its last failure straight away, so a
      // squiggle never outlives the statement it belonged to.
      execution.onDidChange((change) => {
        const record = results.get(change.executionId);
        if (record?.status === 'running') {
          this.collection.delete(vscode.Uri.parse(change.tab));
        }
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
