import { KINDS, OBJECT_KINDS, ObjectKind } from './catalog';

/**
 * The matcher behind the search box.
 *
 * It is a subsequence matcher with a bonus table, not a Levenshtein distance
 * and not a trigram index. The reason is what people type into a database
 * explorer: they type an abbreviation of a name they already know —
 * `uspgc` for `usp_GetCustomer`, `custaddr` for `CustomerAddress` — and a
 * subsequence match is exactly right for that, while an edit distance treats
 * six missing characters as six errors and ranks the thing you meant below the
 * thing you did not.
 *
 * Every function here runs on every candidate on every keystroke, so there is
 * no allocation in the hot path beyond the position array, and the array is
 * only built once a match is certain.
 *
 * It lives in `shared/` rather than beside the sidebar because phase 3's
 * completion provider ranks with it too. Two rankings for one estate is two
 * rankings that disagree: `uspgc` has to find `usp_GetCustomer` in the editor
 * exactly as it does in the tree, or the tool has two different ideas of what
 * the user meant.
 */

interface Match {
  /** Higher is better. Only comparable between candidates for one needle. */
  score: number;
  /** Indices in the candidate that the needle matched, for the highlight. */
  positions: number[];
}

/* The bonus table. These are ordinal, not measured: what matters is the order
   they rank in, not the distance between them. */
const START = 22;
const BOUNDARY = 14;
const CONSECUTIVE = 10;
const CAMEL = 8;
/** Charged once per run of skipped characters, not per character. */
const GAP = 4;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  const previous = text.charCodeAt(i - 1);
  // `_`, `.`, `-`, ` ` — the four separators a database name actually uses.
  return previous === 95 || previous === 46 || previous === 45 || previous === 32;
}

function isCamel(text: string, i: number): boolean {
  if (i === 0) {
    return false;
  }
  const here = text.charCodeAt(i);
  const previous = text.charCodeAt(i - 1);
  const upperHere = here >= 65 && here <= 90;
  const lowerBefore = previous >= 97 && previous <= 122;
  return upperHere && lowerBefore;
}

/**
 * Scores `needle` against `text`, or returns null when it is not a
 * subsequence of it.
 *
 * `needle` must already be lower case; `text` is lowered here once per call
 * rather than by every caller, because the candidate changes and the needle
 * does not.
 */
export function fuzzy(text: string, needle: string): Match | null {
  if (needle === '') {
    return { score: 0, positions: [] };
  }
  if (needle.length > text.length) {
    return null;
  }

  const lower = text.toLowerCase();

  /*
   * An exact substring is not merely a good fuzzy match, it is a different
   * kind of answer, and it is checked first so that `customer` ranks
   * `dbo.Customer` above `CustomerAddress` above `usp_CreateCustomerMap` —
   * which is the order anybody typing `customer` means.
   */
  const at = lower.indexOf(needle);
  if (at >= 0) {
    const positions: number[] = [];
    for (let i = 0; i < needle.length; i++) {
      positions.push(at + i);
    }
    const anchor = at === 0 ? START : isBoundary(text, at) ? BOUNDARY : isCamel(text, at) ? CAMEL : 0;
    // Shorter names win among equally-anchored hits: `Customer` beats
    // `CustomerAddressArchive` for `customer`, which is what a person means.
    return {
      score: 1000 + anchor + needle.length * CONSECUTIVE - Math.min(text.length, 60),
      positions
    };
  }

  const positions: number[] = [];
  let score = 0;
  let n = 0;
  let previousIndex = -2;

  for (let i = 0; i < lower.length && n < needle.length; i++) {
    if (lower[i] !== needle[n]) {
      continue;
    }
    if (i === previousIndex + 1) {
      score += CONSECUTIVE;
    } else {
      if (previousIndex >= 0) {
        score -= GAP;
      }
      if (i === 0) {
        score += START;
      } else if (isBoundary(text, i)) {
        score += BOUNDARY;
      } else if (isCamel(text, i)) {
        score += CAMEL;
      }
    }
    positions.push(i);
    previousIndex = i;
    n++;
  }

  if (n < needle.length) {
    return null;
  }
  return { score: score - Math.min(text.length, 60) / 4, positions };
}

/* ------------------------------------------------------------------ query */

/**
 * What was typed, taken apart.
 *
 * The box accepts three things at once — a type, a schema and a name — because
 * that is how the three appear in the answer, and forcing somebody to pick a
 * filter from a menu to say "procedure" when they can type `proc:` is a menu
 * that exists to protect a parser.
 */
export interface ParsedQuery {
  /** What was typed, trimmed. Empty means the tree browses normally. */
  raw: string;
  /** The name part, lower case. May be empty when only a type was given. */
  needle: string;
  /** Restrict to these kinds, or null for every kind. */
  kinds: ObjectKind[] | null;
  /** Restrict to this schema, lower case, from a `sales.` prefix. */
  schema: string | null;
}

const EMPTY: ParsedQuery = { raw: '', needle: '', kinds: null, schema: null };

/** Every word that names a kind: `table`, `tables`, `tbl`, `proc`, `sp`… */
const KIND_WORDS = new Map<string, ObjectKind>(
  OBJECT_KINDS.flatMap((kind) => {
    const meta = KINDS[kind];
    return [
      [meta.singular.toLowerCase(), kind] as [string, ObjectKind],
      [meta.plural.toLowerCase(), kind] as [string, ObjectKind],
      ...meta.aliases.map((alias) => [alias, kind] as [string, ObjectKind])
    ];
  })
);

/**
 * `customer`, `sales.customer`, `proc:customer`, `sequences`.
 *
 * The type prefix is taken before the schema split, so `type:` is read as a
 * filter and `dbo.` as a schema even though both end in a punctuation mark. A
 * word that is only a kind name and nothing else — `sequences` — filters to
 * that kind with no name, which is how you list one folder's worth of a
 * database without finding the folder.
 */
export function parseQuery(text: string): ParsedQuery {
  const raw = text.trim();
  if (raw === '') {
    return EMPTY;
  }

  let rest = raw;
  let kinds: ObjectKind[] | null = null;

  const colon = rest.indexOf(':');
  if (colon > 0) {
    const kind = KIND_WORDS.get(rest.slice(0, colon).toLowerCase());
    if (kind) {
      kinds = [kind];
      rest = rest.slice(colon + 1);
    }
  }

  if (kinds === null) {
    const whole = KIND_WORDS.get(rest.toLowerCase());
    if (whole) {
      return { raw, needle: '', kinds: [whole], schema: null };
    }
  }

  let schema: string | null = null;
  const dot = rest.indexOf('.');
  if (dot > 0 && dot < rest.length - 1) {
    schema = rest.slice(0, dot).toLowerCase();
    rest = rest.slice(dot + 1);
  } else if (dot > 0) {
    // `sales.` on its own: everything in that schema.
    schema = rest.slice(0, dot).toLowerCase();
    rest = '';
  }

  return { raw, needle: rest.trim().toLowerCase(), kinds, schema };
}

/**
 * True when a query can only be answered by objects.
 *
 * A query carrying a type or a schema is unambiguously about objects, and the
 * connection list is left out of the answer rather than showing every
 * connection whose name happens to contain `dbo`.
 */
export function isObjectQuery(query: ParsedQuery): boolean {
  return query.kinds !== null || query.schema !== null;
}
