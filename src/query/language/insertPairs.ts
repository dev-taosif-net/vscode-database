import { Token, tokenize } from './context';

/**
 * A column in an `INSERT` list and the value written for it, paired up.
 *
 * `INSERT INTO t (a, b, c) VALUES (1, 2, 3)` is the one statement in SQL where
 * the name of a thing and the thing itself are written a screen apart, and the
 * only way to check that `strLoginId` really is the second value is to count
 * commas in both lists. This does the counting: the caret on a column name
 * finds the value in that position in every row, and the caret on a value
 * finds its column.
 *
 * It is a scan over the same tokens completion uses, not a parser, so it
 * survives a statement that is still being typed. A values row that has fewer
 * entries than the column list simply has nothing to show for the columns past
 * its end.
 */
export interface Span {
  start: number;
  end: number;
}

export interface InsertPair {
  /** The column name, when the statement has a column list. */
  column?: Span;
  /** The value in that position, one per `VALUES` row that reaches it. */
  values: Span[];
}

/**
 * Words that begin the next statement, so a scan for `VALUES` stops before it
 * borrows one from the `INSERT` below.
 */
const STOP = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'CREATE', 'ALTER', 'DROP', 'DECLARE',
  'SET', 'EXEC', 'EXECUTE', 'CALL', 'BEGIN', 'IF', 'WHILE', 'USE', 'GO', 'TRUNCATE', 'DEFAULT',
  'RETURN', 'COMMIT', 'ROLLBACK'
]);

interface InsertShape {
  columns: Span[];
  rows: Span[][];
}

/** The column and values this offset sits on, or nothing when it is not in an `INSERT` list. */
export function insertPairAt(text: string, offset: number): InsertPair | undefined {
  const tokens = tokenize(text).filter((token) => token.kind !== 'comment');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].upper !== 'INSERT' || tokens[i].kind !== 'word') {
      continue;
    }
    const shape = readInsert(tokens, i + 1);
    if (!shape) {
      continue;
    }
    const pair = pairAt(shape, offset);
    if (pair) {
      return pair;
    }
  }
  return undefined;
}

function pairAt(shape: InsertShape, offset: number): InsertPair | undefined {
  let index = shape.columns.findIndex((span) => within(span, offset));
  if (index === -1) {
    for (const row of shape.rows) {
      index = row.findIndex((span) => within(span, offset));
      if (index !== -1) {
        break;
      }
    }
  }
  if (index === -1) {
    return undefined;
  }
  const values = shape.rows.map((row) => row[index]).filter((span): span is Span => span !== undefined);
  const column = shape.columns[index];
  if (!column && values.length === 0) {
    return undefined;
  }
  return { column, values };
}

function within(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
}

/**
 * The column list and the values rows after one `INSERT`.
 *
 * Reads past the optional `INTO`, the target's name, a SQL Server table hint
 * in `WITH (...)`, and an `OUTPUT` clause between the columns and `VALUES`.
 * Gives up at the start of the next statement, and on an `INSERT ... SELECT`,
 * which has no values to pair with.
 */
function readInsert(tokens: Token[], from: number): InsertShape | undefined {
  let i = from;
  if (tokens[i]?.upper === 'INTO') {
    i++;
  }
  // The target name, up to the column list or `VALUES`. A hint group after
  // `WITH` is skipped whole so its parenthesis is not mistaken for the columns.
  let columns: Span[] = [];
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'word' && token.upper === 'VALUES') {
      break;
    }
    if (token.kind === 'word' && token.upper === 'WITH' && tokens[i + 1]?.text === '(') {
      i = closeOf(tokens, i + 1) + 1;
      continue;
    }
    if (token.kind === 'word' && STOP.has(token.upper)) {
      return undefined;
    }
    if (token.kind === 'punct' && token.text === ';') {
      return undefined;
    }
    if (token.kind === 'punct' && token.text === '(') {
      const group = readGroup(tokens, i);
      columns = group.segments;
      i = group.next;
      break;
    }
    i++;
  }

  // Between the columns and `VALUES`: nothing, or an `OUTPUT` clause.
  while (i < tokens.length && tokens[i].upper !== 'VALUES') {
    const token = tokens[i];
    if ((token.kind === 'word' && STOP.has(token.upper)) || (token.kind === 'punct' && token.text === ';')) {
      return undefined;
    }
    i++;
  }
  if (tokens[i]?.upper !== 'VALUES') {
    return undefined;
  }
  i++;

  const rows: Span[][] = [];
  while (tokens[i]?.kind === 'punct' && tokens[i].text === '(') {
    const group = readGroup(tokens, i);
    rows.push(group.segments);
    i = group.next;
    if (tokens[i]?.kind === 'punct' && tokens[i].text === ',') {
      i++;
      continue;
    }
    break;
  }
  if (columns.length === 0 && rows.length === 0) {
    return undefined;
  }
  return { columns, rows };
}

/** The index of the parenthesis that closes the one at `open`, or one past the last token when it never closes. */
function closeOf(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'punct') {
      continue;
    }
    if (token.text === '(') {
      depth++;
    } else if (token.text === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return tokens.length;
}

/**
 * The comma-separated entries of the group opened at `open`, each as the span
 * from its first token to its last, and the index just past the closing
 * parenthesis. Nested parentheses — a function call, a subquery — stay inside
 * their entry. An empty entry, as in `(1, , 3)`, keeps its place with a span
 * of nothing so the entries after it still count from the right position.
 */
function readGroup(tokens: Token[], open: number): { segments: Span[]; next: number } {
  const close = closeOf(tokens, open);
  const segments: Span[] = [];
  let depth = 0;
  let current: Span | undefined;
  const flush = (at: number) => {
    segments.push(current ?? { start: at, end: at });
    current = undefined;
  };
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i];
    if (token.kind === 'punct' && token.text === '(') {
      depth++;
    } else if (token.kind === 'punct' && token.text === ')') {
      depth--;
    } else if (token.kind === 'punct' && token.text === ',' && depth === 0) {
      flush(token.start);
      continue;
    }
    current = current ? { start: current.start, end: token.end } : { start: token.start, end: token.end };
  }
  if (current || segments.length > 0) {
    // An unclosed group, as in a statement still being typed, ends where the
    // text does.
    flush(tokens[close]?.start ?? tokens[close - 1].end);
  }
  return { segments, next: close + 1 };
}
