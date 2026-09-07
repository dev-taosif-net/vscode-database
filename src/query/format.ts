import * as vscode from 'vscode';
import { DriverKind } from '../types';

/**
 * The formatter is deliberately modest.
 *
 * A formatter that rewrites somebody's SQL into a house style they did not
 * choose is a formatter they turn off, and a formatter nobody runs is worth
 * nothing. So this one has five settings, a strong default, and one rule above
 * all the others: a statement it cannot tokenise cleanly is returned exactly
 * as it was. Mangling is the only unrecoverable failure here — an unformatted
 * statement costs a keystroke, a mangled one costs the work.
 */
export interface FormatOptions {
  keywordCase: 'upper' | 'lower' | 'preserve';
  indent: string;
  /** Commas at the end of the line, or at the start of the next one. */
  commas: 'trailing' | 'leading';
  /** `AND` and `OR` begin their line rather than trailing the one before. */
  leadingBoolean: boolean;
  maxWidth: number;
}

export function optionsFrom(document: vscode.TextDocument, formatting: vscode.FormattingOptions): FormatOptions {
  const config = vscode.workspace.getConfiguration('databaseTools', document);
  return {
    keywordCase: config.get<'upper' | 'lower' | 'preserve'>('format.keywordCase', 'upper'),
    indent: formatting.insertSpaces ? ' '.repeat(formatting.tabSize) : '\t',
    commas: config.get<'trailing' | 'leading'>('format.commas', 'trailing'),
    leadingBoolean: config.get<boolean>('format.leadingBoolean', true),
    maxWidth: config.get<number>('format.maxWidth', 100)
  };
}

type TokenType = 'word' | 'string' | 'comment' | 'number' | 'punct';

interface Token {
  type: TokenType;
  text: string;
  /** Uppercased once, because every rule below compares against it. */
  upper: string;
}

/**
 * Keywords that begin a clause and therefore begin a line.
 *
 * Two-word forms are matched as pairs so `GROUP BY` does not break between its
 * own words, which is the single most common way a naive formatter makes SQL
 * harder to read than it was.
 */
const CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'DELETE',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'RETURNING',
  'WITH',
  'WINDOW'
]);

const JOINS = new Set([
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'OUTER APPLY',
  'CROSS APPLY'
]);

const PAIRS: Record<string, string[]> = {
  GROUP: ['BY'],
  ORDER: ['BY'],
  INSERT: ['INTO'],
  DELETE: ['FROM'],
  UNION: ['ALL'],
  INNER: ['JOIN'],
  CROSS: ['JOIN', 'APPLY'],
  OUTER: ['APPLY'],
  LEFT: ['JOIN', 'OUTER'],
  RIGHT: ['JOIN', 'OUTER'],
  FULL: ['JOIN', 'OUTER']
};

const KEYWORDS = new Set([
  ...CLAUSES,
  ...JOINS,
  'AND',
  'OR',
  'NOT',
  'ON',
  'AS',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'BETWEEN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DISTINCT',
  'TOP',
  'ASC',
  'DESC',
  'INTO',
  'BY',
  'ALL',
  'ANY',
  'OUTER',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'DECLARE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'VIEW',
  'INDEX',
  'PROCEDURE',
  'FUNCTION',
  'TRIGGER',
  'EXEC',
  'EXECUTE',
  'RETURN',
  'OVER',
  'PARTITION',
  'ROWS',
  'RANGE',
  'CAST',
  'CONVERT'
]);

export function formatSql(source: string, driver: DriverKind, options: FormatOptions): string {
  const statements = splitOnSemicolons(source);
  const out: string[] = [];
  for (const statement of statements) {
    out.push(formatStatement(statement, driver, options));
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function formatStatement(source: string, driver: DriverKind, options: FormatOptions): string {
  const tokens = tokenize(source, driver);
  if (!tokens) {
    // Unbalanced quoting, or something this scanner does not understand. The
    // text goes back exactly as it arrived.
    return source;
  }
  if (tokens.length === 0) {
    return source;
  }

  const lines: string[] = [];
  let line = '';
  let depth = 0;
  let listDepth = 0;
  let pendingComma = false;

  const push = () => {
    if (line.trim()) {
      lines.push(line.trimEnd());
    }
    line = '';
  };

  const startLine = (level: number) => {
    push();
    line = options.indent.repeat(Math.max(0, level));
  };

  const append = (text: string, spaced = true) => {
    if (pendingComma && options.commas === 'leading') {
      line += line.trim() ? ', ' : ', ';
      pendingComma = false;
    } else if (pendingComma) {
      pendingComma = false;
    }
    if (!line.trim()) {
      line += text;
      return;
    }
    line += spaced ? ` ${text}` : text;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const phrase = phraseAt(tokens, i);

    if (token.type === 'comment') {
      if (token.text.startsWith('--')) {
        startLine(depth + listDepth);
        line += token.text;
        push();
      } else {
        append(token.text);
      }
      continue;
    }

    if (token.type === 'punct') {
      if (token.text === '(') {
        append('(', !isFunctionCall(tokens, i));
        depth++;
        continue;
      }
      if (token.text === ')') {
        depth = Math.max(0, depth - 1);
        line += ')';
        continue;
      }
      if (token.text === ',') {
        if (options.commas === 'trailing') {
          line += ',';
        }
        if (depth === 0 && listDepth > 0) {
          pendingComma = options.commas === 'leading';
          startLine(listDepth);
        } else {
          pendingComma = options.commas === 'leading';
          if (options.commas === 'trailing') {
            // A comma inside parentheses keeps its neighbours on one line.
          }
        }
        continue;
      }
      if (token.text === ';') {
        line += ';';
        push();
        lines.push('');
        continue;
      }
      append(token.text, !'.'.includes(token.text) && !line.endsWith('.'));
      continue;
    }

    if (token.type === 'word' && phrase && depth === 0) {
      if (CLAUSES.has(phrase.upper)) {
        startLine(0);
        line += cased(phrase.text, options);
        listDepth = LIST_CLAUSES.has(phrase.upper) ? 1 : 0;
        i += phrase.length - 1;
        if (listDepth) {
          startLine(1);
        }
        continue;
      }
      if (JOINS.has(phrase.upper)) {
        startLine(0);
        line += cased(phrase.text, options);
        listDepth = 0;
        i += phrase.length - 1;
        continue;
      }
      if (phrase.upper === 'ON') {
        startLine(1);
        line += cased(phrase.text, options);
        i += phrase.length - 1;
        continue;
      }
      if (options.leadingBoolean && (phrase.upper === 'AND' || phrase.upper === 'OR')) {
        startLine(1);
        line += cased(phrase.text, options);
        i += phrase.length - 1;
        continue;
      }
    }

    if (token.type === 'word' && KEYWORDS.has(token.upper)) {
      append(cased(token.text, options));
      continue;
    }

    append(token.text, !line.endsWith('.') && !line.endsWith('('));
  }
  push();

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return wrap(body, options) + '\n';
}

/** The clauses whose items go one to a line. */
const LIST_CLAUSES = new Set(['SELECT', 'SET', 'GROUP BY', 'ORDER BY', 'RETURNING', 'VALUES']);

/**
 * A one- or two-word keyword phrase starting here.
 *
 * `GROUP BY` has to be found as a unit or the formatter breaks the line
 * between its words, which reads as two clauses where there is one.
 */
function phraseAt(tokens: Token[], i: number): { text: string; upper: string; length: number } | null {
  const first = tokens[i];
  if (first.type !== 'word') {
    return null;
  }
  const seconds = PAIRS[first.upper];
  const next = tokens[i + 1];
  if (seconds && next?.type === 'word' && seconds.includes(next.upper)) {
    const third = tokens[i + 2];
    const pair = `${first.upper} ${next.upper}`;
    if ((pair === 'LEFT OUTER' || pair === 'RIGHT OUTER' || pair === 'FULL OUTER') && third?.upper === 'JOIN') {
      return { text: `${first.text} ${next.text} ${third.text}`, upper: `${pair} JOIN`, length: 3 };
    }
    return { text: `${first.text} ${next.text}`, upper: pair, length: 2 };
  }
  return { text: first.text, upper: first.upper, length: 1 };
}

function isFunctionCall(tokens: Token[], i: number): boolean {
  const previous = tokens[i - 1];
  return previous?.type === 'word' && !KEYWORDS.has(previous.upper);
}

function cased(text: string, options: FormatOptions): string {
  if (options.keywordCase === 'preserve') {
    return text;
  }
  return options.keywordCase === 'upper' ? text.toUpperCase() : text.toLowerCase();
}

/** Lines longer than the width are left alone rather than broken badly. */
function wrap(body: string, options: FormatOptions): string {
  return body
    .split('\n')
    .map((line) => (line.length <= options.maxWidth ? line : line))
    .join('\n');
}

/**
 * The tokenizer.
 *
 * It shares its quoting rules with the batch splitter deliberately: the two
 * have to agree about what a string is, or a formatter run on a PL/pgSQL body
 * would reformat the inside of a dollar-quoted block that the splitter
 * correctly refuses to touch.
 */
function tokenize(source: string, driver: DriverKind): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, text: string) => tokens.push({ type, text, upper: text.toUpperCase() });

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      const end = source.indexOf('\n', i);
      push('comment', source.slice(i, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        return null;
      }
      push('comment', source.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = closingQuote(source, i, ch);
      if (end === -1) {
        return null;
      }
      push('string', source.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (ch === '[' && driver === 'mssql') {
      const end = source.indexOf(']', i + 1);
      if (end === -1) {
        return null;
      }
      push('word', source.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (ch === '$' && driver === 'postgres') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i));
      if (open) {
        const close = source.indexOf(open[0], i + open[0].length);
        if (close === -1) {
          return null;
        }
        push('string', source.slice(i, close + open[0].length));
        i = close + open[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(source.slice(i));
      push('number', match?.[0] ?? ch);
      i += match?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_@#$]/.test(ch)) {
      const match = /^[A-Za-z_@#$][A-Za-z0-9_@#$]*/.exec(source.slice(i));
      push('word', match?.[0] ?? ch);
      i += match?.[0].length ?? 1;
      continue;
    }
    push('punct', ch);
    i++;
  }
  return tokens;
}

function closingQuote(source: string, from: number, quote: string): number {
  let i = from + 1;
  while (i < source.length) {
    if (source[i] === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/** Statement boundaries, so one broken statement does not spoil the rest. */
function splitOnSemicolons(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i + 1] !== quote) {
        quote = null;
      } else if (ch === quote) {
        i++;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === ';') {
      parts.push(source.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  if (start < source.length) {
    parts.push(source.slice(start));
  }
  return parts.filter((part) => part.trim());
}
