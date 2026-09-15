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

export interface Relation {
  schema?: string;
  name: string;
  /** The alias, or the name when there is none. */
  as: string;
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

export function analyse(text: string, offset: number): SqlContext {
  const tokens = tokenize(text.slice(0, offset));
  const context: SqlContext = {
    clause: 'none',
    relations: [],
    prefix: '',
    wantsObject: false,
    wantsDatabase: false,
    wantsRoutine: false,
    inCase: false
  };

  // Everything before the caret in this statement. Statement boundaries are
  // unquoted semicolons; anything before the last one belongs to a statement
  // the caret is not in and would only add relations that are out of scope.
  let start = 0;
  let statementStart = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].kind === 'punct' && tokens[i].text === ';') {
      start = i + 1;
      statementStart = tokens[i].end;
      break;
    }
  }
  // T-SQL does not need the semicolon, so a script of queries one after another
  // is ordinarily a script with none. The statement also ends where the next
  // one begins.
  const begins = statementBegins(tokens, start);
  if (begins > start) {
    start = begins;
    statementStart = tokens[begins].start;
  }
  const scope = tokens.slice(start);
  // `CASE` and `BEGIN` both close with `END`, so both go on the stack; only a
  // `CASE` on top means the caret is inside one.
  const blocks: string[] = [];

  for (let i = 0; i < scope.length; i++) {
    const token = scope[i];
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
    if (RELATION_ANCHORS.has(token.upper)) {
      const relation = readRelation(scope, i + 1);
      if (relation) {
        context.relations.push(relation.relation);
        i = relation.next - 1;
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
  context.relations.push(...relationsAfter(text, statementStart, offset));

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
function relationsAfter(text: string, statementStart: number, offset: number): Relation[] {
  // From the start of the statement rather than the caret, so a word, string
  // or bracketed name the caret sits inside is tokenised whole and skipped.
  const tokens = tokenize(text.slice(statementStart)).filter(
    (token) => token.kind !== 'comment' && token.start + statementStart >= offset
  );
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
      const relation = readRelation(tokens, i + 1);
      if (relation) {
        relations.push(relation.relation);
        i = relation.next - 1;
      }
    }
  }
  return relations;
}

/** `[schema.]name [AS] [alias]`, tolerating every part being missing. */
function readRelation(tokens: Token[], from: number): { relation: Relation; next: number } | null {
  let i = from;
  if (i >= tokens.length || tokens[i].kind !== 'word') {
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

  let as = name;
  if (tokens[i]?.kind === 'word' && tokens[i].upper === 'AS' && tokens[i + 1]?.kind === 'word') {
    as = strip(tokens[i + 1].text);
    i += 2;
  } else if (
    tokens[i]?.kind === 'word' &&
    !NOT_ALIASES.has(tokens[i].upper) &&
    // `FROM t` and then the next statement on the line below, with no semicolon.
    !STARTS_STATEMENT.has(tokens[i].upper)
  ) {
    as = strip(tokens[i].text);
    i += 1;
  }

  return { relation: { schema, name, as }, next: i };
}

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
