/**
 * What the caret is inside, worked out well enough to rank a completion list.
 *
 * This is deliberately not a parser and does not try to become one. A full
 * T-SQL grammar that must also handle half-typed statements is a year of work
 * that fails on the exact input it exists for, which is broken SQL: the moment
 * somebody types `SELECT c.` the statement is syntactically invalid, and a
 * parser's correct answer is to refuse it.
 *
 * So this is a tolerant scanner. It finds `FROM`, `JOIN`, `UPDATE` and `INTO`
 * targets and their aliases even when everything around them is incomplete,
 * and it answers four questions: which clause, which relations are in scope,
 * what they are called, and whether the token before the caret is a dot.
 */
export type Clause =
  | 'select'
  | 'from'
  | 'join'
  | 'on'
  | 'where'
  | 'group'
  | 'order'
  | 'having'
  | 'set'
  | 'values'
  | 'insert'
  | 'exec'
  | 'use'
  | 'none';

/** A column the document itself declares, with its type when the text says one. */
export interface LocalColumn {
  name: string;
  type?: string;
}

export interface Relation {
  schema?: string;
  name: string;
  /** The alias, or the name when there is none. */
  as: string;
  /**
   * The columns, for a relation the document itself defines: a CTE, a derived
   * table, a temp table or a table variable. The catalog has never heard of
   * these, and the text is the only place their columns are written down.
   */
  columns?: LocalColumn[];
  /** The offset just past the relation's last token, for the one being typed. */
  end?: number;
}

/** An `INSERT` the caret is in, past its target. */
export interface InsertShape {
  /** The column names written in the list so far, as typed. */
  columns: string[];
  /** True while the caret is inside the column list. */
  inColumns: boolean;
  /** True at the start of a `VALUES` row with nothing in it yet. */
  atRow: boolean;
}

/** The innermost unclosed call the caret is inside. */
export interface FunctionCall {
  /** The word before the parenthesis, upper-cased. */
  name: string;
  /** Which argument the caret is on, counting from zero. */
  argument: number;
}

export interface SqlContext {
  clause: Clause;
  relations: Relation[];
  /** The identifier before an unclosed dot, if the caret follows one. */
  qualifier?: string;
  /** What the user has typed of the current word. */
  prefix: string;
  /** True when the caret sits where a schema or an object name belongs. */
  wantsObject: boolean;
  /**
   * True when the caret sits where a database name belongs, which is after
   * `USE` and nowhere else.
   *
   * It is a separate flag rather than a reading of `clause`, because `clause`
   * survives the statement it was set in: `USE Payroll` followed by a newline
   * and a half-typed `SELECT` is still `use` to the scanner, and offering a
   * list of databases there would be offering them for the rest of the file.
   */
  wantsDatabase: boolean;
  /** Where `prefix` starts, so a bracketed name can be replaced whole. */
  prefixStart?: number;
  /**
   * True when the caret sits where a routine's name belongs: straight after
   * `EXEC`, `EXECUTE` or `CALL`, or partway through the name written there.
   */
  wantsRoutine: boolean;
  /** True when the caret is inside a `CASE` that has not reached its `END`. */
  inCase: boolean;
  /** Where the `EXEC`, `EXECUTE` or `CALL` keyword starts, on its name or in its arguments. */
  callStart?: number;
  /** The routine being called, when the caret is in its argument list. */
  routine?: RoutineCall;
  /**
   * The names in the select list of the query the caret is in, lower-cased.
   *
   * `ORDER BY` and `GROUP BY` nearly always name something already selected,
   * so the list there is ranked by it.
   */
  selected: string[];
  /** The `INSERT` the caret is in, once its target has been named. */
  insert?: InsertShape;
  /** The function call the caret is inside, for signature help on built-ins. */
  func?: FunctionCall;
}

/**
 * A call the caret is inside, past the routine's name.
 *
 * It says where in the argument list the caret is, in both of the ways an
 * argument can be identified: by position, which is all PostgreSQL's default
 * notation has, and by name, which is how nearly every SQL Server call is
 * written. Signature help needs the second to highlight the right parameter in
 * `@Name = N'Ada', @CustomerId = 1`, where the positions and the declaration
 * disagree.
 */
export interface RoutineCall {
  schema?: string;
  name: string;
  /** True for `CALL name(`, whose arguments sit inside parentheses. */
  parenthesised: boolean;
  /** Which argument the caret is on, counting from zero. */
  argument: number;
  /** Lower-cased parameter names already given an argument, as written. */
  named: string[];
  /** The parameter the argument under the caret names, lower-cased. */
  current?: string;
  /**
   * `argument` where a new argument begins, so a parameter name can go there;
   * `value` once the argument has anything in it besides the word being typed.
   */
  slot: 'argument' | 'value';
}

export interface Token {
  text: string;
  upper: string;
  start: number;
  end: number;
  kind: 'word' | 'punct' | 'string' | 'number' | 'comment';
}

const CLAUSE_WORDS: Record<string, Clause> = {
  SELECT: 'select',
  FROM: 'from',
  JOIN: 'join',
  ON: 'on',
  WHERE: 'where',
  GROUP: 'group',
  ORDER: 'order',
  HAVING: 'having',
  SET: 'set',
  VALUES: 'values',
  INSERT: 'insert',
  UPDATE: 'set',
  EXEC: 'exec',
  EXECUTE: 'exec',
  CALL: 'exec',
  USE: 'use'
};

const RELATION_ANCHORS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'APPLY', 'TABLE']);

const NOT_ALIASES = new Set([
  'ON',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'OUTER',
  'UNION',
  'SET',
  'VALUES',
  'SELECT',
  'AND',
  'OR',
  'WITH',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'RETURNING',
  'APPLY',
  'AS'
]);

/**
 * The last document's tokens, kept for the next question about it.
 *
 * Completion, hover and signature help each ask about the same text within the
 * same second, and each keystroke asks again. Tokenising a long script once
 * per version rather than once per question is what keeps a migration file
 * from getting slower to type in as it grows.
 */
let cache: { text: string; tokens: Token[]; locals?: Map<string, LocalColumn[]> } | undefined;

function cached(text: string): NonNullable<typeof cache> {
  if (cache?.text !== text) {
    cache = { text, tokens: tokenize(text) };
  }
  return cache;
}

/**
 * The tokens before `offset`, with the one the caret splits cut at the caret.
 *
 * Cutting gives the same tokens as tokenising the text up to the caret would:
 * the word being typed ends at the caret, and a string or comment the caret is
 * inside is simply unterminated.
 */
function upTo(all: Token[], offset: number): Token[] {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].start < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const tokens = all.slice(0, lo);
  const last = tokens[tokens.length - 1];
  if (last && last.end > offset) {
    const text = last.text.slice(0, offset - last.start);
    tokens[tokens.length - 1] = { ...last, text, upper: text.toUpperCase(), end: offset };
  }
  return tokens;
}

export function analyse(text: string, offset: number): SqlContext {
  const document = cached(text);
  const tokens = upTo(document.tokens, offset);
  const context: SqlContext = {
    clause: 'none',
    relations: [],
    prefix: '',
    wantsObject: false,
    wantsDatabase: false,
    wantsRoutine: false,
    inCase: false,
    selected: []
  };

  // Everything before the caret in this statement. Statement boundaries are
  // unquoted semicolons; anything before the last one belongs to a statement
  // the caret is not in and would only add relations that are out of scope.
  let start = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].kind === 'punct' && tokens[i].text === ';') {
      start = i + 1;
      break;
    }
  }
  // T-SQL does not need the semicolon, so a script of queries one after another
  // is ordinarily a script with none. The statement also ends where the next
  // one begins.
  const scope = tokens.slice(statementBegins(tokens, start));
  // `CASE` and `BEGIN` both close with `END`, so both go on the stack; only a
  // `CASE` on top means the caret is inside one.
  const blocks: string[] = [];
  // Every `SELECT` still open at the caret's depth or above, and every `(`.
  const selects: { index: number; depth: number }[] = [];
  const calls: FunctionCall[] = [];
  // The depth each relation was named at. A subquery that has closed took its
  // tables with it: after `WHERE x.id IN (SELECT id FROM b y)`, `y` is gone.
  const depths: number[] = [];
  let depth = 0;
  let insertAt = -1;

  for (let i = 0; i < scope.length; i++) {
    const token = scope[i];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        const opener = scope[i - 1];
        calls.push({ name: opener?.kind === 'word' ? opener.upper : '', argument: 0 });
        depth++;
      } else if (token.text === ')') {
        calls.pop();
        depth = Math.max(0, depth - 1);
        while (selects.length > 0 && selects[selects.length - 1].depth > depth) {
          selects.pop();
        }
        while (depths.length > 0 && depths[depths.length - 1] > depth) {
          depths.pop();
          context.relations.pop();
        }
      } else if (token.text === ',' && calls.length > 0) {
        calls[calls.length - 1].argument++;
      }
      continue;
    }
    if (token.kind !== 'word') {
      continue;
    }
    if (token.upper === 'CASE' || token.upper === 'BEGIN') {
      blocks.push(token.upper);
    } else if (token.upper === 'END' && !(token.end === offset && i === scope.length - 1)) {
      blocks.pop();
    }
    const clause = CLAUSE_WORDS[token.upper];
    if (clause) {
      context.clause = clause;
    }
    if (token.upper === 'SELECT') {
      selects.push({ index: i, depth });
    } else if (token.upper === 'INSERT') {
      insertAt = i;
    }
    if (RELATION_ANCHORS.has(token.upper)) {
      const read = readRelation(scope, i + 1);
      if (read) {
        if (read.relation) {
          context.relations.push(read.relation);
          depths.push(depth);
        }
        i = read.next - 1;
      }
    }
    if (CALL_WORDS.has(token.upper)) {
      // Each call replaces the last: a batch of three `EXEC`s is in the third.
      const call = readCall(
        scope.slice(i).filter((t) => t.kind !== 'comment'),
        offset
      );
      context.wantsRoutine = call.wantsName;
      context.routine = call.routine;
      context.callStart = call.wantsName || call.routine ? token.start : undefined;
    }
  }

  context.inCase = blocks[blocks.length - 1] === 'CASE';
  context.relations.push(...relationsAfter(document.tokens, offset));

  // A CTE, a temp table or a table variable named in `FROM` is the document's
  // own relation, and the document is where its columns are.
  document.locals ??= localsOf(document.tokens);
  for (const relation of context.relations) {
    if (!relation.columns && !relation.schema) {
      relation.columns = document.locals.get(relation.name.toLowerCase());
    }
  }

  const last = scope[scope.length - 1];
  const penultimate = scope[scope.length - 2];

  if (last && last.kind === 'word' && last.end === offset) {
    context.prefix = last.text;
    context.prefixStart = last.start;
    if (penultimate?.kind === 'punct' && penultimate.text === '.') {
      const qualifier = scope[scope.length - 3];
      if (qualifier?.kind === 'word') {
        context.qualifier = strip(qualifier.text);
      }
    }
  } else if (last?.kind === 'punct' && last.text === '.') {
    const qualifier = penultimate;
    if (qualifier?.kind === 'word') {
      context.qualifier = strip(qualifier.text);
    }
  }

  // `FROM Ord▏` has read `Ord` as a relation, but it is the word being typed,
  // and a list that treats it as a table already in scope would step around
  // its own alias and rank joins to a table nobody has finished naming.
  if (context.prefixStart !== undefined) {
    context.relations = context.relations.filter((relation) => relation.end !== offset);
  }

  const select = [...selects].reverse().find((candidate) => candidate.depth === depth);
  if (select) {
    context.selected = selectListNames(scope, select.index + 1, listEnd(scope, select.index + 1, scope.length)).map(
      (column) => column.name.toLowerCase()
    );
  }

  const call = calls[calls.length - 1];
  if (call?.name) {
    context.func = call;
  }

  if (insertAt >= 0 && (context.clause === 'insert' || context.clause === 'values')) {
    context.insert = readInsertShape(scope, insertAt, context.prefixStart !== undefined);
  }

  context.wantsObject = context.clause === 'from' || context.clause === 'join' || context.clause === 'insert';

  /*
   * `USE` has to be the word immediately before the caret, ignoring whatever
   * the user is in the middle of typing.
   *
   * `USE Payr` is a database name being typed and `USE Payroll GO` is not, and
   * the difference is one token. Reading `clause` instead would leave the list
   * of databases attached to every position after a `USE` until the next
   * clause word happened to appear.
   */
  const typing = context.prefixStart !== undefined;
  const preceding = typing ? scope[scope.length - 2] : last;
  context.wantsDatabase = preceding?.kind === 'word' && preceding.upper === 'USE';

  return context;
}

/**
 * Words that begin a statement of their own, and so end the one the caret is
 * in when there is no semicolon between them.
 *
 * `SET`, `WITH`, `ELSE` and `END` are missing on purpose: each is also part of
 * the statement it follows — `UPDATE … SET`, `WITH (NOLOCK)`, and the tail of a
 * `CASE` in a select list.
 */
const STARTS_STATEMENT = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'CALL', 'USE', 'GO',
  'DECLARE', 'IF', 'WHILE', 'BEGIN', 'PRINT', 'RETURN', 'RAISERROR', 'THROW', 'CREATE', 'ALTER', 'DROP'
]);

/**
 * Words that, written straight before a statement word, make it part of the
 * statement already open: `UNION SELECT`, `MERGE … THEN UPDATE`, `ON DELETE
 * CASCADE`, `CREATE VIEW … AS SELECT`, `FOR UPDATE`, `ON CONFLICT DO UPDATE`.
 */
const CONTINUES = new Set([
  'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'THEN', 'AS', 'ON', 'OR', 'FOR', 'AFTER', 'OF', 'DO', 'GRANT', 'DENY',
  'REVOKE'
]);

/** Statement words that follow a closing parenthesis inside one statement: a CTE, or `INSERT … (cols) SELECT`. */
const CONTINUES_AFTER_GROUP = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * Where the statement the caret is in begins, as an index into `tokens`.
 *
 * A statement word opens a new statement unless something before it says it
 * belongs to the current one. A statement opened inside a parenthesis that has
 * since closed is a subquery the caret is past, and does not count.
 */
function statementBegins(tokens: Token[], from: number): number {
  const words = tokens.slice(from).filter((token) => token.kind !== 'comment');
  const opened: { token: Token; depth: number }[] = [];
  let depth = 0;
  let leader = '';
  let values = false;

  for (let k = 0; k < words.length; k++) {
    const token = words[k];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
        while (opened.length > 0 && opened[opened.length - 1].depth > depth) {
          opened.pop();
        }
      }
      continue;
    }
    if (token.kind !== 'word') {
      continue;
    }
    if (token.upper === 'VALUES') {
      values = true;
    }
    const statement = token.upper === 'WITH' ? opensCte(words, k) : STARTS_STATEMENT.has(token.upper);
    if (!statement || continuesStatement(token, words[k - 1], leader, values)) {
      continue;
    }
    opened.push({ token, depth });
    leader = token.upper;
    values = false;
  }

  const last = opened[opened.length - 1];
  return last ? tokens.indexOf(last.token) : from;
}

function continuesStatement(token: Token, previous: Token | undefined, leader: string, values: boolean): boolean {
  if (!previous) {
    return false;
  }
  // `INSERT INTO t SELECT …` and `INSERT INTO t (a, b) SELECT …`, but not the
  // query written after an `INSERT … VALUES (…)` that has finished.
  const insertSource = leader === 'INSERT' && !values;
  if (previous.kind === 'punct') {
    if (previous.text === '(' || previous.text === ',') {
      return true;
    }
    return previous.text === ')' && CONTINUES_AFTER_GROUP.has(token.upper) && (leader !== 'INSERT' || insertSource);
  }
  if (previous.kind === 'word' && CONTINUES.has(previous.upper)) {
    return true;
  }
  return insertSource && (token.upper === 'SELECT' || token.upper === 'EXEC' || token.upper === 'EXECUTE');
}

/**
 * `WITH name AS (` or `WITH name (columns)` — a common table expression, as
 * opposed to the table hint in `FROM t WITH (NOLOCK)` or `WITH ROLLUP`.
 */
function opensCte(words: Token[], k: number): boolean {
  let j = k + 1;
  if (words[j]?.upper === 'RECURSIVE') {
    j++;
  }
  if (words[j]?.kind !== 'word') {
    return false;
  }
  j++;
  if (punct(words[j], '(')) {
    return true;
  }
  if (words[j]?.upper !== 'AS') {
    return false;
  }
  j++;
  if (words[j]?.upper === 'NOT') {
    j++;
  }
  if (words[j]?.upper === 'MATERIALIZED') {
    j++;
  }
  return punct(words[j], '(');
}

/**
 * The relations the statement names after the caret.
 *
 * A select list is written before its `FROM`, so `SELECT lp.▏ FROM LeavePolicy lp`
 * has its only alias on the far side of the caret. Reading forward to the end
 * of the statement is what puts it in scope.
 *
 * Only relations at the caret's own depth count. A subquery further along
 * names tables the caret cannot see, and a `)` that closes a parenthesis opened
 * before the caret is the end of the subquery the caret is inside.
 */
function relationsAfter(all: Token[], offset: number): Relation[] {
  // A word, string or bracketed name the caret sits inside starts before the
  // caret, so it is skipped whole.
  const tokens = all.filter((token) => token.kind !== 'comment' && token.start >= offset);
  const relations: Relation[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        if (--depth < 0) {
          break;
        }
      } else if (token.text === ';' && depth === 0) {
        break;
      }
      continue;
    }
    if (token.kind !== 'word' || depth !== 0) {
      continue;
    }
    if (STARTS_STATEMENT.has(token.upper)) {
      break;
    }
    if (RELATION_ANCHORS.has(token.upper)) {
      const read = readRelation(tokens, i + 1);
      if (read) {
        if (read.relation) {
          relations.push(read.relation);
        }
        i = read.next - 1;
      }
    }
  }
  return relations;
}

/**
 * `[schema.]name [AS] [alias]`, tolerating every part being missing — or
 * `(subquery) [AS] alias`, a derived table, whose columns are read from its
 * select list.
 *
 * Nothing is read from a derived table the caret is inside: it is not closed
 * yet, and the `FROM` inside it is the one that counts.
 */
function readRelation(tokens: Token[], from: number): { relation?: Relation; next: number } | null {
  let i = from;
  if (i >= tokens.length) {
    return null;
  }
  if (punct(tokens[i], '(')) {
    const close = closeOf(tokens, i);
    if (close >= tokens.length) {
      return null;
    }
    const columns = selectedColumns(tokens, i + 1, close);
    const alias = readAlias(tokens, close + 1);
    if (!alias) {
      return { next: close + 1 };
    }
    return { relation: { name: alias.as, as: alias.as, columns, end: tokens[alias.next - 1].end }, next: alias.next };
  }
  if (tokens[i].kind !== 'word') {
    return null;
  }
  let schema: string | undefined;
  let name = strip(tokens[i].text);
  i++;

  if (tokens[i]?.kind === 'punct' && tokens[i].text === '.') {
    if (tokens[i + 1]?.kind !== 'word') {
      // `FROM saas.` — a schema and nothing after it yet. There is no relation
      // here to put in scope, and inventing one named `saas` would make the
      // schema look like an alias to everything downstream, which is what
      // turns the list at the caret into the columns of a table nobody has.
      return null;
    }
    schema = name;
    name = strip(tokens[i + 1].text);
    i += 2;
  }

  // `CROSS APPLY dbo.fn(x.Id) f`: the arguments come before the alias. Unclosed,
  // the caret is inside them, and there is no alias yet to look for.
  if (punct(tokens[i], '(')) {
    const close = closeOf(tokens, i);
    if (close >= tokens.length) {
      return { relation: { schema, name, as: name, end: tokens[i - 1].end }, next: i };
    }
    i = close + 1;
  }

  const alias = readAlias(tokens, i);
  const as = alias ? alias.as : name;
  i = alias ? alias.next : i;
  return { relation: { schema, name, as, end: tokens[i - 1].end }, next: i };
}

function readAlias(tokens: Token[], i: number): { as: string; next: number } | undefined {
  if (tokens[i]?.kind !== 'word') {
    return undefined;
  }
  if (tokens[i].upper === 'AS' && tokens[i + 1]?.kind === 'word') {
    return { as: strip(tokens[i + 1].text), next: i + 2 };
  }
  // `FROM t` and then the next statement on the line below, with no semicolon.
  if (NOT_ALIASES.has(tokens[i].upper) || STARTS_STATEMENT.has(tokens[i].upper)) {
    return undefined;
  }
  return { as: strip(tokens[i].text), next: i + 1 };
}

/* ------------------------------------------------------------ select lists */

/** The columns the first `SELECT` in `[from, to)` produces, by the names its list gives them. */
function selectedColumns(tokens: Token[], from: number, to: number): LocalColumn[] {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const token = tokens[k];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth--;
      }
    } else if (token.kind === 'word' && token.upper === 'SELECT' && depth === 0) {
      return selectListNames(tokens, k + 1, listEnd(tokens, k + 1, to));
    }
  }
  return [];
}

/** Where a select list that starts at `from` ends: its `FROM` or `INTO`, the next statement, or `to`. */
function listEnd(tokens: Token[], from: number, to: number): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const token = tokens[k];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')' && --depth < 0) {
        return k;
      }
    } else if (
      token.kind === 'word' &&
      depth === 0 &&
      (token.upper === 'FROM' || token.upper === 'INTO' || STARTS_STATEMENT.has(token.upper))
    ) {
      return k;
    }
  }
  return to;
}

/**
 * The name each entry of a select list goes out under.
 *
 * `a.b` is `b`, `a.b AS c` and `a.b c` are `c`, `c = a.b` is `c`, `COUNT(*) n`
 * is `n`. An entry with no name to read — `*`, or a bare `CAST(…)` — is left
 * out rather than guessed.
 */
function selectListNames(tokens: Token[], from: number, to: number): LocalColumn[] {
  let k = from;
  // `DISTINCT`, `ALL`, `TOP 10`, `TOP (@n) PERCENT WITH TIES`: none of it is a column.
  while (k < to && tokens[k].kind === 'word' && (tokens[k].upper === 'DISTINCT' || tokens[k].upper === 'ALL')) {
    k++;
  }
  if (k < to && tokens[k].upper === 'TOP') {
    k++;
    if (punct(tokens[k], '(')) {
      k = closeOf(tokens, k) + 1;
    } else if (tokens[k]?.kind === 'number') {
      k++;
    }
    if (tokens[k]?.upper === 'PERCENT') {
      k++;
    }
    if (tokens[k]?.upper === 'WITH' && tokens[k + 1]?.upper === 'TIES') {
      k += 2;
    }
  }

  const names: LocalColumn[] = [];
  for (const entry of splitTop(tokens, k, to)) {
    const name = entryName(entry);
    if (name) {
      names.push({ name });
    }
  }
  return names;
}

function entryName(entry: Token[]): string | undefined {
  const last = entry[entry.length - 1];
  const before = entry[entry.length - 2];
  if (!last || last.kind !== 'word' || last.upper === 'AS') {
    return undefined;
  }
  if (before?.kind === 'word' && before.upper === 'AS') {
    return strip(last.text);
  }
  if (entry.length >= 3 && punct(entry[1], '=') && entry[0].kind === 'word') {
    return strip(entry[0].text);
  }
  // `a.b` is `b`; `COUNT(*) n`, `a.b total` and `1 + x` all end in the word
  // that names the entry, whether as its alias or as the column itself.
  return strip(last.text);
}

/** The comma-separated entries of `[from, to)`, commas inside parentheses left alone. */
function splitTop(tokens: Token[], from: number, to: number): Token[][] {
  const entries: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let k = from; k < to; k++) {
    const token = tokens[k];
    if (token.kind === 'comment') {
      continue;
    }
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth--;
      } else if (token.text === ',' && depth === 0) {
        entries.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) {
    entries.push(current);
  }
  return entries;
}

/* ------------------------------------------------------- local relations */

/** Words that begin a constraint rather than a column in a `CREATE TABLE` list. */
const NOT_COLUMNS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'INDEX', 'KEY', 'PERIOD', 'WITH']);

/**
 * The relations the document declares itself, by lower-cased name.
 *
 * `CREATE TABLE #t (…)`, `DECLARE @t TABLE (…)`, `SELECT … INTO #t` and every
 * CTE in a `WITH`. None of them is in the catalog, and a script that builds a
 * temp table and then queries it is the ordinary shape of a T-SQL script.
 */
function localsOf(all: Token[]): Map<string, LocalColumn[]> {
  const locals = new Map<string, LocalColumn[]>();
  const tokens = all.filter((token) => token.kind !== 'comment');
  const declare = (name: Token, columns: LocalColumn[]) => {
    if (columns.length > 0) {
      locals.set(strip(name.text).toLowerCase(), columns);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word') {
      continue;
    }
    if (token.upper === 'TABLE') {
      const previous = tokens[i - 1];
      if (previous?.kind === 'word' && previous.text.startsWith('@') && punct(tokens[i + 1], '(')) {
        declare(previous, ddlColumns(tokens, i + 1));
      } else if (previous?.kind === 'word' && (previous.upper === 'CREATE' || previous.upper === 'TEMP' || previous.upper === 'TEMPORARY')) {
        let j = i + 1;
        if (tokens[j]?.upper === 'IF' && tokens[j + 1]?.upper === 'NOT' && tokens[j + 2]?.upper === 'EXISTS') {
          j += 3;
        }
        if (tokens[j]?.kind !== 'word') {
          continue;
        }
        while (punct(tokens[j + 1], '.') && tokens[j + 2]?.kind === 'word') {
          j += 2;
        }
        if (punct(tokens[j + 1], '(')) {
          declare(tokens[j], ddlColumns(tokens, j + 1));
        }
      }
    } else if (token.upper === 'INTO' && tokens[i - 1]?.upper !== 'INSERT' && tokens[i + 1]?.kind === 'word') {
      const select = selectBefore(tokens, i);
      if (select >= 0) {
        declare(tokens[i + 1], selectListNames(tokens, select + 1, i));
      }
    } else if (token.upper === 'WITH' && opensCte(tokens, i)) {
      readCtes(tokens, i, declare);
    }
  }
  return locals;
}

/** The columns of a `CREATE TABLE` list, each with the type written after it. */
function ddlColumns(tokens: Token[], open: number): LocalColumn[] {
  const columns: LocalColumn[] = [];
  for (const entry of splitTop(tokens, open + 1, closeOf(tokens, open))) {
    const [name, type, next] = entry;
    if (name?.kind !== 'word' || NOT_COLUMNS.has(name.upper)) {
      continue;
    }
    let rendered: string | undefined;
    if (type?.kind === 'word') {
      rendered = type.text;
      if (punct(next, '(')) {
        // `decimal(18, 2)`, as one word.
        const close = closeOf(entry, 2);
        rendered += entry.slice(2, close + 1).map((token) => token.text).join('');
      }
    }
    columns.push({ name: strip(name.text), type: rendered });
  }
  return columns;
}

/** The `SELECT` whose list ends at `into`, or -1 when `INTO` belongs to something else. */
function selectBefore(tokens: Token[], into: number): number {
  let depth = 0;
  for (let k = into - 1; k >= 0; k--) {
    const token = tokens[k];
    if (token.kind === 'punct') {
      if (token.text === ')') {
        depth++;
      } else if (token.text === '(') {
        if (depth === 0) {
          return -1;
        }
        depth--;
      } else if (token.text === ';') {
        return -1;
      }
      continue;
    }
    if (token.kind === 'word' && depth === 0) {
      if (token.upper === 'SELECT') {
        return k;
      }
      if (STARTS_STATEMENT.has(token.upper)) {
        return -1;
      }
    }
  }
  return -1;
}

/** Every `name [(columns)] AS (body)` in one `WITH`. */
function readCtes(tokens: Token[], at: number, declare: (name: Token, columns: LocalColumn[]) => void): void {
  let j = at + 1;
  if (tokens[j]?.upper === 'RECURSIVE') {
    j++;
  }
  while (tokens[j]?.kind === 'word') {
    const name = tokens[j];
    j++;
    let explicit: LocalColumn[] | undefined;
    if (punct(tokens[j], '(')) {
      const close = closeOf(tokens, j);
      explicit = splitTop(tokens, j + 1, close)
        .map((entry) => entry[0])
        .filter((token) => token?.kind === 'word')
        .map((token) => ({ name: strip(token.text) }));
      j = close + 1;
    }
    if (tokens[j]?.upper !== 'AS') {
      break;
    }
    j++;
    if (tokens[j]?.upper === 'NOT') {
      j++;
    }
    if (tokens[j]?.upper === 'MATERIALIZED') {
      j++;
    }
    if (!punct(tokens[j], '(')) {
      break;
    }
    const close = closeOf(tokens, j);
    declare(name, explicit ?? selectedColumns(tokens, j + 1, close));
    j = close + 1;
    if (!punct(tokens[j], ',')) {
      break;
    }
    j++;
  }
}

/* ----------------------------------------------------------------- insert */

/**
 * The column list and values row of the `INSERT` at `insertAt`, as far as the
 * caret has got. `typing` says the last token is the word being typed, which
 * is neither a column already listed nor something in the values row.
 */
function readInsertShape(tokens: Token[], insertAt: number, typing: boolean): InsertShape | undefined {
  let i = insertAt + 1;
  if (tokens[i]?.upper === 'INTO') {
    i++;
  }
  if (tokens[i]?.kind !== 'word') {
    return undefined;
  }
  i++;
  while (punct(tokens[i], '.') && tokens[i + 1]?.kind === 'word') {
    i += 2;
  }
  if (tokens[i]?.upper === 'WITH' && punct(tokens[i + 1], '(')) {
    i = closeOf(tokens, i + 1) + 1;
  }

  const shape: InsertShape = { columns: [], inColumns: false, atRow: false };
  const end = tokens.length - (typing ? 1 : 0);
  if (punct(tokens[i], '(')) {
    const close = closeOf(tokens, i);
    for (let k = i + 1; k < Math.min(close, end); k++) {
      if (tokens[k].kind === 'word') {
        shape.columns.push(strip(tokens[k].text));
      }
    }
    if (close >= tokens.length) {
      shape.inColumns = true;
      return shape;
    }
    i = close + 1;
  }

  const tail = tokens[end - 1];
  const before = tokens[end - 2];
  if (punct(tail, '(') && (before?.upper === 'VALUES' || punct(before, ','))) {
    shape.atRow = tokens.slice(i, end).some((token) => token.kind === 'word' && token.upper === 'VALUES');
  }
  return shape;
}

/* ------------------------------------------------------------------ calls */

const CALL_WORDS = new Set(['EXEC', 'EXECUTE', 'CALL']);

/**
 * Words that begin a statement of their own, and so end a call that has no
 * semicolon after it.
 *
 * T-SQL does not require the semicolon, and a script of `EXEC` lines followed
 * by a `SELECT` is the ordinary case. Without this, signature help for the last
 * procedure would follow the caret into every query written below it.
 */
const ENDS_CALL = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'CALL', 'USE', 'GO',
  'DECLARE', 'SET', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'PRINT', 'RETURN', 'RAISERROR', 'THROW', 'WITH',
  'CREATE', 'ALTER', 'DROP', 'FROM', 'WHERE'
]);

function punct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

/** The index of the parenthesis that closes the one at `open`, or one past the last token when it never closes. */
export function closeOf(tokens: Token[], open: number): number {
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
 * Everything after one `EXEC`, `EXECUTE` or `CALL`, up to the caret.
 *
 * `tokens[0]` is the keyword and comments have already been taken out. The
 * caret is either on the name — nothing after the keyword yet, a name being
 * typed, a schema and a dot — or past it in the arguments, or past the end of
 * the call altogether, which answers nothing.
 */
function readCall(tokens: Token[], offset: number): { wantsName: boolean; routine?: RoutineCall } {
  const none = { wantsName: false };
  const last = tokens.length - 1;
  const typing = tokens[last]?.kind === 'word' && tokens[last].end === offset;
  if (last === 0 && typing) {
    // `EXEC▏` — the keyword itself is what is being typed.
    return none;
  }

  let i = 1;
  // `EXEC @rc = dbo.usp_Save`: the return code is captured ahead of the name.
  if (tokens[i]?.kind === 'word' && tokens[i].text.startsWith('@') && punct(tokens[i + 1], '=')) {
    i += 2;
  }
  if (i > last) {
    return { wantsName: true };
  }

  // One to three dotted parts. A variable or a parenthesis in the name's place
  // is dynamic SQL, which has no parameters to offer.
  const parts: Token[] = [];
  while (tokens[i]?.kind === 'word' && !tokens[i].text.startsWith('@')) {
    parts.push(tokens[i]);
    if (!punct(tokens[i + 1], '.')) {
      i++;
      break;
    }
    i += 2;
    if (i > last) {
      return { wantsName: true };
    }
  }
  if (parts.length === 0) {
    return none;
  }
  if (i > last && typing) {
    return { wantsName: true };
  }

  const name = strip(parts[parts.length - 1].text);
  const schema = parts.length > 1 ? strip(parts[parts.length - 2].text) : undefined;
  const parenthesised = punct(tokens[i], '(');
  const base = parenthesised ? 1 : 0;
  let depth = 0;
  let argument = 0;
  let segmentStart = parenthesised ? i + 1 : i;
  const named: string[] = [];

  for (let k = i; k <= last; k++) {
    const token = tokens[k];
    if (token.kind === 'word' && depth === 0 && ENDS_CALL.has(token.upper) && !(typing && k === last)) {
      return none;
    }
    if (token.kind !== 'punct') {
      continue;
    }
    if (token.text === '(') {
      depth++;
    } else if (token.text === ')') {
      if (--depth < base) {
        return none;
      }
    } else if (token.text === ';') {
      return none;
    } else if (token.text === ',' && depth === base) {
      argument++;
      segmentStart = k + 1;
    } else if (token.text === '=' && depth === base) {
      // `@Name =` in SQL Server, `name =>` in PostgreSQL, and its older `name :=`.
      const at = punct(tokens[k - 1], ':') ? k - 2 : k - 1;
      if (at === segmentStart && tokens[at]?.kind === 'word') {
        named.push(strip(tokens[at].text).toLowerCase());
      }
    }
  }

  const segment = tokens.slice(segmentStart, typing ? last : last + 1);
  const opener = segment[0];
  const assigns = punct(segment[1], '=') || (punct(segment[1], ':') && punct(segment[2], '='));
  return {
    wantsName: false,
    routine: {
      schema,
      name,
      parenthesised,
      argument,
      named,
      current: opener?.kind === 'word' && assigns ? strip(opener.text).toLowerCase() : undefined,
      slot: segment.length === 0 ? 'argument' : 'value'
    }
  };
}

/** `[Order]`, `"user"` and `Order` all name the same thing to a completion list. */
export function strip(name: string): string {
  if (name.length >= 2) {
    if (name.startsWith('[') && name.endsWith(']')) {
      return name.slice(1, -1);
    }
    if (name.startsWith('"') && name.endsWith('"')) {
      return name.slice(1, -1).replace(/""/g, '"');
    }
  }
  return name;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (kind: Token['kind'], start: number, end: number) => {
    const value = text.slice(start, end);
    tokens.push({ text: value, upper: value.toUpperCase(), start, end, kind });
  };

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      push('comment', i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      push('comment', i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) {
        j += text[j] === "'" ? 2 : 1;
      }
      push('string', i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
      continue;
    }
    if (ch === '"' || ch === '[') {
      const closer = ch === '"' ? '"' : ']';
      const end = text.indexOf(closer, i + 1);
      push('word', i, end === -1 ? text.length : end + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(text.slice(i));
      push('number', i, i + (match?.[0].length ?? 1));
      i += match?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_@#]/.test(ch)) {
      const match = /^[A-Za-z_@#][A-Za-z0-9_@#$]*/.exec(text.slice(i));
      push('word', i, i + (match?.[0].length ?? 1));
      i += match?.[0].length ?? 1;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return tokens;
}
