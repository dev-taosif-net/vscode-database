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
  /** The routine being called, when the caret is inside an EXEC or CALL. */
  routine?: { schema?: string; name: string; argument: number };
}

interface Token {
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
  CALL: 'exec'
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
  const context: SqlContext = { clause: 'none', relations: [], prefix: '', wantsObject: false };

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
  const scope = tokens.slice(start);

  for (let i = 0; i < scope.length; i++) {
    const token = scope[i];
    if (token.kind !== 'word') {
      continue;
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
    if (token.upper === 'EXEC' || token.upper === 'EXECUTE' || token.upper === 'CALL') {
      const routine = readRelation(scope, i + 1);
      if (routine) {
        context.routine = {
          schema: routine.relation.schema,
          name: routine.relation.name,
          argument: countArguments(scope, routine.next)
        };
      }
    }
  }

  const last = scope[scope.length - 1];
  const penultimate = scope[scope.length - 2];

  if (last && last.kind === 'word' && last.end === offset) {
    context.prefix = last.text;
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
  return context;
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

  if (tokens[i]?.kind === 'punct' && tokens[i].text === '.' && tokens[i + 1]?.kind === 'word') {
    schema = name;
    name = strip(tokens[i + 1].text);
    i += 2;
  }

  let as = name;
  if (tokens[i]?.kind === 'word' && tokens[i].upper === 'AS' && tokens[i + 1]?.kind === 'word') {
    as = strip(tokens[i + 1].text);
    i += 2;
  } else if (tokens[i]?.kind === 'word' && !NOT_ALIASES.has(tokens[i].upper)) {
    as = strip(tokens[i].text);
    i += 1;
  }

  return { relation: { schema, name, as }, next: i };
}

/** Which argument the caret is on, by counting commas at depth zero. */
function countArguments(tokens: Token[], from: number): number {
  let depth = 0;
  let count = 0;
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'punct') {
      continue;
    }
    if (token.text === '(') {
      depth++;
    } else if (token.text === ')') {
      depth = Math.max(0, depth - 1);
    } else if (token.text === ',' && depth <= 1) {
      count++;
    }
  }
  return count;
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

function tokenize(text: string): Token[] {
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
