import { ConnectionRow, SortOrder } from '../../shared/sidebar';
import { EnvironmentId } from '../../types';

/**
 * The order environments are always listed in: Development, QA, UAT,
 * Production. It is the order a change travels in, and it is fixed — the list
 * reads the same way every time it is opened, whatever is in it.
 */
const RANK: Record<EnvironmentId, number> = { dev: 0, qa: 1, uat: 2, prod: 3 };

/**
 * Every height in the list, in one place. These are constants, not
 * measurements: nothing in this file reads the DOM, and nothing reads
 * `--vscode-font-size`. A row is `list.rowHeight`, the value the workbench
 * gives its own trees, and it does not change with the width of the panel.
 *
 * A header is 24px folded and 24px open. It carried a second line naming the
 * environment's guard while it was folded, and the sentence is gone from the
 * list: the connection editor says it at the moment it applies, and a heading
 * that changes height as you fold it is movement bought with a repetition.
 */
export const H = {
  row: 22,
  group: 24,
  pinned: 24,
  nomatch: 44
} as const;

export type FlatItem =
  | { kind: 'pinned'; count: number }
  | { kind: 'group'; environment: EnvironmentId; count: number; open: number; collapsed: boolean }
  | { kind: 'row'; id: string; environment: EnvironmentId; pinned: boolean; showBadge: boolean }
  | { kind: 'nomatch'; query: string };

export function heightOf(item: FlatItem): number {
  switch (item.kind) {
    case 'row':
      return H.row;
    case 'group':
      return H.group;
    case 'pinned':
      return H.pinned;
    case 'nomatch':
      return H.nomatch;
  }
}

export interface Geometry {
  items: FlatItem[];
  /** `offsets[i]` is the top of `items[i]`; `offsets[length]` is the total. */
  offsets: Int32Array;
  /** Index of the section header owning `items[i]`, or -1 when it has none. */
  owner: Int32Array;
  /** Every header index, ascending. At most six entries. */
  headers: number[];
}

export function measure(items: FlatItem[]): Geometry {
  const offsets = new Int32Array(items.length + 1);
  const owner = new Int32Array(items.length);
  const headers: number[] = [];
  let current = -1;
  for (let i = 0; i < items.length; i++) {
    offsets[i + 1] = offsets[i] + heightOf(items[i]);
    if (items[i].kind === 'group' || items[i].kind === 'pinned') {
      current = i;
      headers.push(i);
    }
    owner[i] = current;
  }
  return { items, offsets, owner, headers };
}

/** The index of the item containing `y`, clamped to the last item. */
export function indexAt(g: Geometry, y: number): number {
  let lo = 0;
  let hi = g.items.length - 1;
  if (hi < 0) {
    return 0;
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.offsets[mid] <= y) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export type MatchField = 'name' | 'host' | 'database';

/** Null means the row is filtered out. An empty array means there is no query. */
export function matchRow(row: ConnectionRow, needle: string): MatchField[] | null {
  if (!needle) {
    return [];
  }
  const fields: MatchField[] = [];
  if (row.name.toLowerCase().includes(needle)) {
    fields.push('name');
  }
  if (row.host.toLowerCase().includes(needle)) {
    fields.push('host');
  }
  if (row.database.toLowerCase().includes(needle)) {
    fields.push('database');
  }
  return fields.length > 0 ? fields : null;
}

export function compare(sort: SortOrder, a: ConnectionRow, b: ConnectionRow): number {
  if (sort === 'name') {
    return a.name.localeCompare(b.name);
  }
  if (sort === 'recent') {
    return b.updatedAt - a.updatedAt;
  }
  return RANK[a.environment] - RANK[b.environment] || a.name.localeCompare(b.name);
}

export interface FlattenInput {
  rows: ConnectionRow[];
  grouped: boolean;
  sort: SortOrder;
  collapsed: EnvironmentId[];
  query: string;
  /** Ids with a live session, for the "n open" a group header carries. */
  open: ReadonlySet<string>;
}

export interface Flattened {
  items: FlatItem[];
  matches: Map<string, MatchField[]>;
  matched: number;
  /** Production rows the query removed. The footer has to be able to say so. */
  productionHidden: number;
}

/**
 * The whole list, as one array of positioned things.
 *
 * A function of structure only — profiles, grouping, sort, folding and the
 * query. Never of session state, because a connection going live must
 * re-render one row rather than rebuild the index every row is keyed by.
 */
export function flatten(input: FlattenInput): Flattened {
  const needle = input.query.trim().toLowerCase();
  const matches = new Map<string, MatchField[]>();
  const kept: ConnectionRow[] = [];
  let productionHidden = 0;

  for (const row of input.rows) {
    const fields = matchRow(row, needle);
    if (fields === null) {
      if (row.environment === 'prod') {
        productionHidden++;
      }
      continue;
    }
    matches.set(row.id, fields);
    kept.push(row);
  }

  if (kept.length === 0) {
    // An empty list would read as "there are no connections". There are; they
    // are filtered out, and saying so is the difference.
    const items: FlatItem[] = needle ? [{ kind: 'nomatch', query: input.query.trim() }] : [];
    return { items, matches, matched: 0, productionHidden };
  }

  const items: FlatItem[] = [];
  const pinned = kept.filter((r) => r.favourite).sort((a, b) => compare(input.sort, a, b));
  const rest = kept.filter((r) => !r.favourite);

  if (pinned.length > 0) {
    items.push({ kind: 'pinned', count: pinned.length });
    for (const r of pinned) {
      items.push({ kind: 'row', id: r.id, environment: r.environment, pinned: true, showBadge: true });
    }
  }

  if (!input.grouped) {
    for (const r of rest.sort((a, b) => compare(input.sort, a, b))) {
      items.push({ kind: 'row', id: r.id, environment: r.environment, pinned: false, showBadge: true });
    }
    return { items, matches, matched: kept.length, productionHidden };
  }

  const folded = new Set(input.collapsed);
  const present = [...new Set(rest.map((r) => r.environment))].sort((a, b) => RANK[a] - RANK[b]);
  for (const environment of present) {
    const members = rest.filter((r) => r.environment === environment);
    // A filter that hides its matches inside a folded group would read as a
    // filter that found nothing, so searching always opens what it found.
    const collapsed = needle ? false : folded.has(environment);
    items.push({
      kind: 'group',
      environment,
      count: members.length,
      open: members.reduce((n, r) => (input.open.has(r.id) ? n + 1 : n), 0),
      collapsed
    });
    if (collapsed) {
      continue;
    }
    for (const r of members.sort((a, b) => compare(input.sort, a, b))) {
      items.push({ kind: 'row', id: r.id, environment, pinned: false, showBadge: false });
    }
  }

  return { items, matches, matched: kept.length, productionHidden };
}
