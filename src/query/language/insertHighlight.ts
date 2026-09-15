import * as vscode from 'vscode';
import { insertPairAt } from './insertPairs';

/**
 * Highlights the value behind an `INSERT` column, and the column behind a value.
 *
 * With the caret on `strLoginId` in the column list, that name and the second
 * entry of every `VALUES` row light up together; with the caret on the entry,
 * the same. The value takes the stronger of the editor's two highlight colours
 * so it is the one the eye lands on, which is the point of clicking the column
 * in the first place.
 *
 * Anywhere else in the file this answers nothing, and the editor's ordinary
 * word highlighting carries on as before.
 */
export class InsertHighlightProvider implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.DocumentHighlight[] | undefined {
    const pair = insertPairAt(document.getText(), document.offsetAt(position));
    if (!pair) {
      return undefined;
    }
    const highlights: vscode.DocumentHighlight[] = [];
    if (pair.column && pair.column.end > pair.column.start) {
      highlights.push(
        new vscode.DocumentHighlight(
          new vscode.Range(document.positionAt(pair.column.start), document.positionAt(pair.column.end)),
          vscode.DocumentHighlightKind.Read
        )
      );
    }
    for (const value of pair.values) {
      if (value.end > value.start) {
        highlights.push(
          new vscode.DocumentHighlight(
            new vscode.Range(document.positionAt(value.start), document.positionAt(value.end)),
            vscode.DocumentHighlightKind.Write
          )
        );
      }
    }
    return highlights.length > 0 ? highlights : undefined;
  }
}
