import * as vscode from 'vscode';
import { BindingStore } from '../bindingStore';

/**
 * Keywords typed in lower case, raised to upper case as they are finished.
 *
 * A word counts as finished when the character after it is typed — a space, a
 * newline, a parenthesis, a comma or a semicolon — never while it is still being
 * written, so `selection` does not become `SELECTion` on the way past `select`.
 *
 * The list is the reserved words and nothing softer. `name`, `key`, `date`,
 * `user`, `status` and `type` are keywords somewhere and column names
 * everywhere, and a column that shouts back at you after you type it is the
 * quickest way to have this setting switched off.
 */
const KEYWORDS = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'APPLY', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE',
  'CAST', 'CHECK', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CONVERT', 'CREATE', 'CROSS', 'CURSOR',
  'DECLARE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXCEPT', 'EXEC', 'EXECUTE',
  'EXISTS', 'FETCH', 'FOREIGN', 'FROM', 'FULL', 'FUNCTION', 'GO', 'GROUP', 'HAVING', 'IF', 'ILIKE', 'IN',
  'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'MERGE', 'NOT',
  'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OUTPUT', 'OVER', 'PARTITION', 'PRIMARY', 'PROCEDURE',
  'REFERENCES', 'RETURN', 'RETURNING', 'RETURNS', 'RIGHT', 'ROLLBACK', 'SELECT', 'SET', 'TABLE', 'THEN',
  'TOP', 'TRANSACTION', 'TRIGGER', 'TRUNCATE', 'UNION', 'UNIQUE', 'UPDATE', 'USE', 'USING', 'VALUES',
  'VIEW', 'WHEN', 'WHERE', 'WHILE', 'WITH',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'ISNULL', 'NULLIF', 'GETDATE', 'NOW',
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'VARCHAR', 'NVARCHAR',
  'CHAR', 'NCHAR', 'DATETIME', 'DATETIME2', 'UNIQUEIDENTIFIER', 'BOOLEAN', 'INTEGER', 'SERIAL', 'JSONB',
  'TIMESTAMP', 'TIMESTAMPTZ'
]);

/** What ends a word: one of these, and nothing else but the indentation after a newline. */
const FINISH = /^(?:[ \t(),;]|\r?\n[ \t]*)$/;

/** The word ending at the caret, and what stands immediately before it. */
const WORD_BEFORE = /(^|[^A-Za-z0-9_@#$.\[\]"`:])([A-Za-z][A-Za-z0-9_]*)$/;

export class KeywordCase implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;

  constructor(private readonly bindings: BindingStore) {
    this.subscription = vscode.workspace.onDidChangeTextDocument((event) => this.changed(event));
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private changed(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    // Undo and redo are left exactly as they are, or undoing the raise would
    // raise it again in the same breath.
    if (
      event.reason !== undefined ||
      document.languageId !== 'sql' ||
      event.contentChanges.length === 0 ||
      !this.bindings.get(document.uri) ||
      !vscode.workspace.getConfiguration('databaseTools', document).get<boolean>('editor.uppercaseKeywords', true)
    ) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
    if (!editor) {
      return;
    }

    const ranges: vscode.Range[] = [];
    for (const change of event.contentChanges) {
      if (!FINISH.test(change.text)) {
        continue;
      }
      const end = change.range.start;
      const match = WORD_BEFORE.exec(document.lineAt(end.line).text.slice(0, end.character));
      if (!match) {
        continue;
      }
      const word = match[2];
      if (word === word.toUpperCase() || !KEYWORDS.has(word.toUpperCase())) {
        continue;
      }
      const start = end.translate(0, -word.length);
      if (insideLiteral(document.getText(), document.offsetAt(start))) {
        continue;
      }
      ranges.push(new vscode.Range(start, end));
    }
    if (ranges.length === 0) {
      return;
    }

    // Folded into the keystroke's own undo step, so one Ctrl+Z takes back the
    // space and the raise together rather than leaving `select` behind.
    void editor.edit(
      (builder) => {
        for (const range of ranges) {
          builder.replace(range, document.getText(range).toUpperCase());
        }
      },
      { undoStopBefore: false, undoStopAfter: false }
    );
  }
}

/**
 * Whether an offset sits inside a string, a quoted identifier or a comment.
 *
 * `'select the rows'` is a sentence, not a query, and `-- where this came from`
 * is a note. Doubled quotes inside a string are its escape, and simply read as
 * the string closing and reopening, which lands in the same place.
 */
function insideLiteral(text: string, offset: number): boolean {
  let i = 0;
  while (i < offset) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      if (end === -1 || end >= offset) {
        return true;
      }
      i = end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1 || end + 2 > offset) {
        return true;
      }
      i = end + 2;
      continue;
    }
    const close = ch === "'" || ch === '"' || ch === '`' ? ch : ch === '[' ? ']' : undefined;
    if (close) {
      const end = text.indexOf(close, i + 1);
      if (end === -1 || end >= offset) {
        return true;
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return false;
}
