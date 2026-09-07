import { DriverKind } from '../types';

/**
 * A run of SQL sent to the server as one unit, and where it came from.
 *
 * `offset` and `line` are into the whole document rather than into the batch,
 * because that is what an error has to be mapped back to: the server reports a
 * line inside the batch it was given, and the only way to underline the right
 * line in the editor is to know where that batch began.
 */
export interface Batch {
  text: string;
  offset: number;
  /** Zero-based, into the whole document. */
  line: number;
}

/**
 * The scanner both splitters run on.
 *
 * It is a real scanner rather than a regular expression, and every case it
 * carries is one that breaks a naive split. A semicolon inside `$$ … $$`,
 * inside `'…''…'`, inside `"…"`, inside `[…]`, inside `--` and inside a nested
 * block comment all have to not be a boundary. A splitter that gets dollar
 * quoting wrong cuts a PL/pgSQL function in half and runs the first half,
 * which is worse than refusing to run at all.
 */
interface Scan {
  /** True while the cursor is inside something a delimiter cannot end. */
  quoted: boolean;
  next: number;
}

function skipQuoted(text: string, i: number): Scan | null {
  const ch = text[i];

  if (ch === '-' && text[i + 1] === '-') {
    const end = text.indexOf('\n', i);
    return { quoted: true, next: end === -1 ? text.length : end };
  }

  if (ch === '/' && text[i + 1] === '*') {
    // Both engines nest block comments, so a depth counter rather than a
    // search for the first closer — which would end the comment early and leave
    // the rest of it being parsed as SQL.
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      if (text[j] === '/' && text[j + 1] === '*') {
        depth++;
        j += 2;
      } else if (text[j] === '*' && text[j + 1] === '/') {
        depth--;
        j += 2;
      } else {
        j++;
      }
    }
    return { quoted: true, next: j };
  }

  if (ch === "'") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "'") {
        if (text[j + 1] === "'") {
          j += 2;
          continue;
        }
        return { quoted: true, next: j + 1 };
      }
      j++;
    }
    return { quoted: true, next: text.length };
  }

  if (ch === '"') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '"') {
        if (text[j + 1] === '"') {
          j += 2;
          continue;
        }
        return { quoted: true, next: j + 1 };
      }
      j++;
    }
    return { quoted: true, next: text.length };
  }

  if (ch === '[') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === ']') {
        if (text[j + 1] === ']') {
          j += 2;
          continue;
        }
        return { quoted: true, next: j + 1 };
      }
      j++;
    }
    return { quoted: true, next: text.length };
  }

  if (ch === '$') {
    // `$tag$ … $tag$`, and the tag may be empty. The opening tag has to be a
    // valid identifier or this is an ordinary dollar — `$1` is a placeholder,
    // not the start of a quoted body.
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
    if (match) {
      const close = text.indexOf(match[0], i + match[0].length);
      return { quoted: true, next: close === -1 ? text.length : close + match[0].length };
    }
  }

  return null;
}

/** Zero-based line of an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * Splits a document into what the server will be sent.
 *
 * SQL Server batches on a line whose only content is `GO`, optionally followed
 * by a repeat count. That is a client convention rather than T-SQL, and the
 * server rejects it outright, so it has to be honoured here or nothing with a
 * `GO` in it runs. PostgreSQL has no batch separator and the driver accepts a
 * whole script in one round trip, so the document is one batch.
 */
export function splitBatches(text: string, driver: DriverKind): Batch[] {
  if (driver !== 'mssql') {
    return text.trim() ? [{ text, offset: 0, line: 0 }] : [];
  }

  const batches: Batch[] = [];
  let start = 0;
  let i = 0;
  let atLineStart = true;

  const push = (end: number) => {
    const slice = text.slice(start, end);
    if (slice.trim()) {
      batches.push({ text: slice, offset: start, line: lineOf(text, start) });
    }
  };

  while (i < text.length) {
    const skip = skipQuoted(text, i);
    if (skip) {
      i = skip.next;
      atLineStart = false;
      continue;
    }

    if (atLineStart) {
      const rest = text.slice(i);
      const go = /^[ \t]*(?:GO|go|Go|gO)(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(\r?\n|$)/.exec(rest);
      if (go) {
        push(i);
        i += go[0].length;
        start = i;
        continue;
      }
    }

    atLineStart = text[i] === '\n';
    i++;
  }

  push(text.length);
  return batches;
}

/**
 * The statement the caret is inside, for Run Current Statement.
 *
 * Boundaries are unquoted semicolons and, on SQL Server, `GO` lines. A caret
 * sitting on a boundary belongs to the statement before it, which is what a
 * person who has just typed the semicolon means.
 */
export function statementAt(text: string, offset: number, driver: DriverKind): Batch | null {
  const bounds: number[] = [0];
  let i = 0;
  let atLineStart = true;

  while (i < text.length) {
    const skip = skipQuoted(text, i);
    if (skip) {
      i = skip.next;
      atLineStart = false;
      continue;
    }
    if (text[i] === ';') {
      bounds.push(i + 1);
    } else if (driver === 'mssql' && atLineStart) {
      const go = /^[ \t]*(?:GO|go|Go|gO)(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(\r?\n|$)/.exec(text.slice(i));
      if (go) {
        bounds.push(i);
        bounds.push(i + go[0].length);
        i += go[0].length;
        atLineStart = true;
        continue;
      }
    }
    atLineStart = text[i] === '\n';
    i++;
  }
  bounds.push(text.length);

  for (let b = 0; b < bounds.length - 1; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    if (offset >= from && offset <= to) {
      const slice = text.slice(from, to);
      if (slice.trim()) {
        return { text: slice, offset: from, line: lineOf(text, from) };
      }
    }
  }

  // A caret in trailing whitespace: the last statement with anything in it.
  for (let b = bounds.length - 2; b >= 0; b--) {
    const slice = text.slice(bounds[b], bounds[b + 1]);
    if (slice.trim()) {
      return { text: slice, offset: bounds[b], line: lineOf(text, bounds[b]) };
    }
  }
  return null;
}

/**
 * The statements in a batch, for the read-only and production guards.
 *
 * The guards need to know what kind of statement each one is, and nothing
 * more, so this returns the leading keyword of each rather than a parse.
 */
export function leadingKeywords(text: string): { keyword: string; offset: number }[] {
  const found: { keyword: string; offset: number }[] = [];
  let i = 0;
  let expectStart = true;

  while (i < text.length) {
    const skip = skipQuoted(text, i);
    if (skip) {
      i = skip.next;
      continue;
    }
    const ch = text[i];
    if (ch === ';') {
      expectStart = true;
      i++;
      continue;
    }
    if (expectStart && /[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (word) {
        found.push({ keyword: word[0].toUpperCase(), offset: i });
        expectStart = false;
        i += word[0].length;
        continue;
      }
    }
    if (!/\s/.test(ch)) {
      expectStart = false;
    }
    i++;
  }
  return found;
}
