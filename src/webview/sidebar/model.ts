import {
  CatalogState,
  CatalogSummary,
  DbMember,
  DbObject,
  FAVOURITES_NODE,
  FavouriteRef,
  KINDS,
  ObjectKind,
  favouriteKey,
  kindNode,
  kindsFor,
  memberNode,
  schemaKindNode,
  schemaNode
} from '../../shared/catalog';
import { ConnectionRow, SortOrder } from '../../shared/sidebar';
import { EnvironmentId } from '../../types';
// `import type`, so this module stays free of React and can be exercised
// on its own by a plain Node harness.
import type { IconMark } from '../primitives/ObjectIcon';
import { ParsedQuery, fuzzy, isObjectQuery, parseQuery } from '../../shared/fuzzy';

/**
 * The order environments are always listed in: Development, QA, UAT,
 * Production. It is the order a change travels in, and it is fixed — the list
 * reads the same way every time it is opened, whatever is in it.
 */
const RANK: Record<EnvironmentId, number> = { dev: 0, qa: 1, uat: 2, prod: 3 };

/**
 * Every height in the list, in one place. These are constants, not
 * measurements: nothing in this file reads the DOM, and nothing reads
 * `--vscode-font-size`. They must agree exactly with the four custom
 * properties at the top of `sidebar.css`, because the virtualizer positions
 * every row from here and a stylesheet that disagrees produces a list that is
 * truthful about its offsets and visibly wrong.
 *
 * Everything is 22 — `list.rowHeight`, the value the workbench gives its own
 * trees. A connection was 34 while it carried two lines, and the second line
 * has gone: it repeated, on every row, what the footer readout already says in
 * full for the one row the cursor is on. Twelve pixels a row is the difference
 * between thirteen connections in a 560px sidebar and twenty.
 *
 * Hierarchy is no longer carried by height, and it does not need to be. A
 * connection is the only thing in the list with a state glyph, an environment
 * ribbon and a heading above it; nothing inside one has any of the three.
 */
export const H = {
  row: 22,
  group: 22,
  pinned: 22,
  nomatch: 44,
  /** Folders, schemas, objects, columns, and every note among them. */
  node: 22,
  results: 24
} as const;

/** The most object results one connection contributes to a search. */
const RESULTS_PER_CONNECTION = 150;

/** Objects a folder asks for at a time. Mirrors `CatalogService.pageSize`. */
export const PAGE = 500;

/** Which kinds open to show something underneath them. */
const HAS_MEMBERS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  'table',
  'view',
  'procedure',
  'function'
]);

/* ----------------------------------------------------------- the catalogue */

export interface CatalogNode {
  objects: DbObject[];
  total: number;
  error?: string;
}

/** One connection's tree, as the panel holds it. */
export interface ConnectionCatalog {
  state: CatalogState;
  summary?: CatalogSummary;
  error?: string;
  /** Folder node key to the rows it holds. Cumulative across pages. */
  nodes: Readonly<Record<string, CatalogNode>>;
  /** Object node key to its columns or parameters. */
  members: Readonly<Record<string, DbMember[]>>;
  /** The last server-side search answer, and the query it answers. */
  hits?: { query: string; objects: DbObject[]; capped: boolean };
}

export type CatalogMap = Readonly<Record<string, ConnectionCatalog>>;

export const EMPTY_CATALOG: ConnectionCatalog = {
  state: 'idle',
  nodes: {},
  members: {}
};

/* ------------------------------------------------------------------ items */

export type NoteTone = 'loading' | 'empty' | 'error' | 'more';

/**
 * Every kind of thing the list can draw, positioned.
 *
 * The eleven variants are one union rather than a class hierarchy because the
 * virtualizer indexes them by position and never by type: `measure` walks them
 * once for heights, `indexAt` binary-searches the offsets, and the renderer
 * switches on `kind` in one place. Nothing here holds a function, a closure or
 * a nested object, so a `FlatItem` can be compared field by field and a row
 * that receives its fields as separate primitives can `memo` on all of them.
 */
export type FlatItem =
  | { kind: 'pinned'; count: number }
  | { kind: 'group'; environment: EnvironmentId; count: number; open: number; collapsed: boolean }
  | {
      kind: 'row';
      id: string;
      environment: EnvironmentId;
      pinned: boolean;
      showBadge: boolean;
      expandable: boolean;
      expanded: boolean;
      /** Carried so the row's context menu can offer the right mode toggle. */
      schemaMode: boolean;
    }
  | { kind: 'nomatch'; query: string }
  | {
      kind: 'folder';
      key: string;
      profileId: string;
      node: string;
      level: number;
      label: string;
      count: number;
      mark: IconMark;
      expanded: boolean;
    }
  | {
      kind: 'schema';
      key: string;
      profileId: string;
      node: string;
      level: number;
      name: string;
      total: number;
      expanded: boolean;
    }
  | {
      kind: 'object';
      key: string;
      profileId: string;
      node: string;
      level: number;
      objKind: ObjectKind;
      schema: string;
      name: string;
      detail: string;
      /** Draw `sales.Order` rather than `Order`, when the schema is not implied. */
      qualify: boolean;
      expandable: boolean;
      expanded: boolean;
      favourite: boolean;
    }
  | {
      kind: 'member';
      key: string;
      level: number;
      name: string;
      type: string;
      mark: IconMark;
      nullable: boolean;
    }
  | {
      kind: 'note';
      key: string;
      level: number;
      tone: NoteTone;
      text: string;
      profileId: string;
      node: string;
      /** For `more`: the offset the next page starts at. */
      offset: number;
    }
  | { kind: 'results'; key: string; profileId: string; label: string; count: number; capped: boolean };

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
    case 'results':
      return H.results;
    default:
      return H.node;
  }
}

/** The cursor id and React key for an item. Unique across the whole list. */
export function keyOf(item: FlatItem): string {
  switch (item.kind) {
    case 'row':
      return item.id;
    case 'group':
      return `environment:${item.environment}`;
    case 'pinned':
      return 'pinned';
    case 'nomatch':
      return 'nomatch';
    default:
      return item.key;
  }
}

/** True when the item is a section header the cursor treats as a level above. */
export function isHeader(item: FlatItem): boolean {
  return item.kind === 'group' || item.kind === 'pinned' || item.kind === 'results';
}

/**
 * Whether an item can be opened, and whether it is.
 *
 * One function rather than a field on every variant, because the keyboard
 * model asks this of whatever the cursor is on and does not care which of the
 * five expandable kinds it found.
 */
export function expansionOf(item: FlatItem): { expandable: boolean; expanded: boolean } | null {
  switch (item.kind) {
    case 'group':
      return { expandable: true, expanded: !item.collapsed };
    case 'row':
    case 'object':
      return { expandable: item.expandable, expanded: item.expanded };
    case 'folder':
    case 'schema':
      return { expandable: true, expanded: item.expanded };
    default:
      return null;
  }
}

/* --------------------------------------------------------------- geometry */

export interface Geometry {
  items: FlatItem[];
  /** `offsets[i]` is the top of `items[i]`; `offsets[length]` is the total. */
  offsets: Int32Array;
  /** Index of the section header owning `items[i]`, or -1 when it has none. */
  owner: Int32Array;
  /** Every header index, ascending. */
  headers: number[];
}

export function measure(items: FlatItem[]): Geometry {
  const offsets = new Int32Array(items.length + 1);
  const owner = new Int32Array(items.length);
  const headers: number[] = [];
  let current = -1;
  for (let i = 0; i < items.length; i++) {
    offsets[i + 1] = offsets[i] + heightOf(items[i]);
    if (isHeader(items[i])) {
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

/**
 * The index of the row one level up from `i`.
 *
 * A section header is found through `owner`, which the geometry already
 * carries; anything nested is found by walking back to the first item with a
 * smaller depth. Left-arrow uses this, and it is what makes ← from a column
 * land on its table rather than on the group header eleven hundred rows above.
 */
export function parentOf(g: Geometry, i: number): number {
  const depth = depthOf(g.items[i]);
  if (depth <= 1) {
    return g.owner[i];
  }
  for (let k = i - 1; k >= 0; k--) {
    if (depthOf(g.items[k]) < depth) {
      return k;
    }
  }
  return g.owner[i];
}

/** How deep an item sits. A connection is 1; everything under it is its level. */
export function depthOf(item: FlatItem): number {
  switch (item.kind) {
    case 'pinned':
    case 'group':
    case 'results':
      return 0;
    case 'row':
    case 'nomatch':
      return 1;
    default:
      return item.level;
  }
}

/* --------------------------------------------------------------- matching */

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

/* ---------------------------------------------------------------- flatten */

/**
 * A read the tree needs and does not have.
 *
 * `flatten` is pure and posts nothing; it reports what is missing and the
 * panel's effect asks for it. That is what keeps the loading rules in one
 * readable place instead of in an effect on every folder component, where
 * thirty windowed rows would each be deciding for themselves whether to fire a
 * query.
 */
export type Want =
  | { what: 'catalog'; profileId: string }
  | { what: 'node'; profileId: string; node: string; kind: ObjectKind; schema?: string; offset: number }
  | { what: 'members'; profileId: string; node: string; ref: FavouriteRef };

export interface FlattenInput {
  rows: ConnectionRow[];
  grouped: boolean;
  sort: SortOrder;
  collapsed: EnvironmentId[];
  query: string;
  /** Ids with a live session, for the "n open" a group header carries. */
  open: ReadonlySet<string>;
  catalog: CatalogMap;
  /** Global keys — `profileId + separator + node` — that are open. */
  expanded: ReadonlySet<string>;
}

export interface Flattened {
  items: FlatItem[];
  matches: Map<string, MatchField[]>;
  matched: number;
  /** Production rows the query removed. The footer has to be able to say so. */
  productionHidden: number;
  wanted: Want[];
  /** Objects the query found, across every connection. */
  objectHits: number;
}

const SEP = String.fromCharCode(31);

function gkey(profileId: string, node: string): string {
  return `${profileId}${SEP}${node}`;
}

/**
 * The whole list, as one array of positioned things.
 *
 * A function of structure only — profiles, grouping, sort, folding, the query,
 * what is expanded and what the catalog holds. Never of session state beyond
 * the set of open ids, because a connection going live must re-render one row
 * rather than rebuild the index every row is keyed by.
 *
 * It runs when a profile changes, when a folder opens, when a page of objects
 * lands and when the query changes. Not per frame, not per scroll, and never
 * for a spinner.
 */
export function flatten(input: FlattenInput): Flattened {
  const parsed = parseQuery(input.query);
  return parsed.raw === '' ? browse(input) : search(input, parsed);
}

/* ------------------------------------------------------------------ browse */

function browse(input: FlattenInput): Flattened {
  const items: FlatItem[] = [];
  const wanted: Want[] = [];
  const matches = new Map<string, MatchField[]>();

  const rows = input.rows;
  for (const row of rows) {
    matches.set(row.id, []);
  }

  if (rows.length === 0) {
    return { items, matches, matched: 0, productionHidden: 0, wanted, objectHits: 0 };
  }

  const pinned = rows.filter((r) => r.favourite).sort((a, b) => compare(input.sort, a, b));
  const rest = rows.filter((r) => !r.favourite);

  const emit = (row: ConnectionRow, isPinned: boolean, showBadge: boolean): void => {
    const expandable = input.open.has(row.id);
    const expanded = expandable && input.expanded.has(gkey(row.id, ''));
    items.push({
      kind: 'row',
      id: row.id,
      environment: row.environment,
      pinned: isPinned,
      showBadge,
      expandable,
      expanded,
      schemaMode: row.mode === 'schema'
    });
    if (expanded) {
      children(row, input, items, wanted);
    }
  };

  if (pinned.length > 0) {
    items.push({ kind: 'pinned', count: pinned.length });
    for (const row of pinned) {
      emit(row, true, true);
    }
  }

  if (!input.grouped) {
    for (const row of rest.slice().sort((a, b) => compare(input.sort, a, b))) {
      emit(row, false, true);
    }
    return { items, matches, matched: rows.length, productionHidden: 0, wanted, objectHits: 0 };
  }

  const folded = new Set(input.collapsed);
  const present = [...new Set(rest.map((r) => r.environment))].sort((a, b) => RANK[a] - RANK[b]);
  for (const environment of present) {
    const members = rest.filter((r) => r.environment === environment);
    const collapsed = folded.has(environment);
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
    for (const row of members.slice().sort((a, b) => compare(input.sort, a, b))) {
      emit(row, false, false);
    }
  }

  return { items, matches, matched: rows.length, productionHidden: 0, wanted, objectHits: 0 };
}

/**
 * Everything under one expanded connection.
 *
 * The two modes differ by one level and nothing else: general mode puts the
 * kind folders directly under the connection, schema-focused mode puts a
 * schema between them. Favourites is above both in either mode, because a pin
 * is a shortcut and a shortcut below forty schemas is not one.
 */
function children(row: ConnectionRow, input: FlattenInput, items: FlatItem[], wanted: Want[]): void {
  const catalog = input.catalog[row.id] ?? EMPTY_CATALOG;
  const level = 2;
  /*
   * The pins as a set, built once per connection rather than scanned per
   * object.
   *
   * `pins` is an array on the row, and asking "is this object pinned?" with
   * `Array.prototype.some` costs one `favouriteKey` allocation per pin per
   * object. A folder of five hundred tables against twenty pins is ten
   * thousand string builds, on a function that runs on every keystroke.
   */
  const pins = pinSet(row);

  if (catalog.state === 'idle') {
    wanted.push({ what: 'catalog', profileId: row.id });
    items.push(note(row.id, 'sum', level, 'loading', 'Reading the catalogue'));
    return;
  }
  if (catalog.state === 'loading') {
    items.push(note(row.id, 'sum', level, 'loading', 'Reading the catalogue'));
    return;
  }
  if (catalog.state === 'error' || !catalog.summary) {
    items.push(note(row.id, 'sum', level, 'error', catalog.error ?? 'The catalogue could not be read.'));
    return;
  }

  const summary = catalog.summary;
  const isOpen = (node: string) => input.expanded.has(gkey(row.id, node));

  /* Favourites. Always drawn, empty or not: it is where pinning puts things,
     and a folder that appears only once you have used the feature is a folder
     nobody discovers. */
  items.push({
    kind: 'folder',
    key: gkey(row.id, FAVOURITES_NODE),
    profileId: row.id,
    node: FAVOURITES_NODE,
    level,
    label: 'Favourites',
    count: row.pins.length,
    mark: 'favourite',
    expanded: isOpen(FAVOURITES_NODE)
  });
  if (isOpen(FAVOURITES_NODE)) {
    if (row.pins.length === 0) {
      items.push(
        note(row.id, FAVOURITES_NODE, level + 1, 'empty', 'Right-click an object to pin it here')
      );
    } else {
      for (const pin of row.pins) {
        emitObject(
          { kind: pin.kind, schema: pin.schema, name: pin.name, detail: KINDS[pin.kind].singular },
          row,
          input,
          items,
          wanted,
          level + 1,
          true,
          pins
        );
      }
    }
  }

  const kinds = kindsFor(row.driver);

  if (row.mode === 'general') {
    for (const kind of kinds) {
      const count = summary.counts[kind] ?? 0;
      if (count === 0) {
        // A folder that says zero is a row that can never be useful. The count
        // is already known, so the folder is simply not drawn.
        continue;
      }
      const node = kindNode(kind);
      items.push({
        kind: 'folder',
        key: gkey(row.id, node),
        profileId: row.id,
        node,
        level,
        label: KINDS[kind].plural,
        count,
        mark: 'folder',
        expanded: isOpen(node)
      });
      if (isOpen(node)) {
        objects(row, input, items, wanted, node, kind, undefined, level + 1, pins);
      }
    }
    return;
  }

  for (const schema of summary.schemas) {
    const node = schemaNode(schema.name);
    items.push({
      kind: 'schema',
      key: gkey(row.id, node),
      profileId: row.id,
      node,
      level,
      name: schema.name,
      total: schema.total,
      expanded: isOpen(node)
    });
    if (!isOpen(node)) {
      continue;
    }
    for (const kind of kinds) {
      const count = schema.counts[kind] ?? 0;
      if (count === 0) {
        continue;
      }
      const child = schemaKindNode(schema.name, kind);
      items.push({
        kind: 'folder',
        key: gkey(row.id, child),
        profileId: row.id,
        node: child,
        level: level + 1,
        label: KINDS[kind].plural,
        count,
        mark: 'folder',
        expanded: isOpen(child)
      });
      if (isOpen(child)) {
        objects(row, input, items, wanted, child, kind, schema.name, level + 2, pins);
      }
    }
  }
}

/** One folder's rows, plus whatever it is still waiting for. */
function objects(
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  node: string,
  kind: ObjectKind,
  schema: string | undefined,
  level: number,
  pins: ReadonlySet<string>
): void {
  const catalog = input.catalog[row.id] ?? EMPTY_CATALOG;
  const held = catalog.nodes[node];

  if (!held) {
    wanted.push({ what: 'node', profileId: row.id, node, kind, schema, offset: 0 });
    items.push(note(row.id, node, level, 'loading', `Reading ${KINDS[kind].plural.toLowerCase()}`));
    return;
  }
  if (held.error) {
    items.push(note(row.id, node, level, 'error', held.error));
    return;
  }
  if (held.objects.length === 0) {
    items.push(note(row.id, node, level, 'empty', 'Nothing here'));
    return;
  }

  for (const object of held.objects) {
    emitObject(object, row, input, items, wanted, level, schema === undefined, pins);
  }

  const remaining = held.total - held.objects.length;
  if (remaining > 0) {
    items.push({
      kind: 'note',
      key: `${gkey(row.id, node)}${SEP}more`,
      profileId: row.id,
      node,
      level,
      tone: 'more',
      text: `Load ${Math.min(remaining, PAGE)} more of ${held.total.toLocaleString()}`,
      offset: held.objects.length
    });
  }
}

/** One object, and its columns or parameters when it is open. */
function emitObject(
  object: DbObject,
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  level: number,
  qualify: boolean,
  pins: ReadonlySet<string>
): void {
  const ref: FavouriteRef = { kind: object.kind, schema: object.schema, name: object.name };
  const node = memberNode(ref);
  const expandable = HAS_MEMBERS.has(object.kind);
  const expanded = expandable && input.expanded.has(gkey(row.id, node));

  items.push({
    kind: 'object',
    key: gkey(row.id, node),
    profileId: row.id,
    node,
    level,
    objKind: object.kind,
    schema: object.schema,
    name: object.name,
    detail: object.detail,
    qualify,
    expandable,
    expanded,
    favourite: pins.has(favouriteKey(ref))
  });

  if (!expanded) {
    return;
  }

  const catalog = input.catalog[row.id] ?? EMPTY_CATALOG;
  const members = catalog.members[node];
  if (!members) {
    wanted.push({ what: 'members', profileId: row.id, node, ref });
    items.push(note(row.id, node, level + 1, 'loading', 'Reading'));
    return;
  }
  if (members.length === 0) {
    items.push(note(row.id, node, level + 1, 'empty', 'Nothing here'));
    return;
  }
  for (const member of members) {
    items.push({
      kind: 'member',
      key: `${gkey(row.id, node)}${SEP}${member.name}`,
      level: level + 1,
      name: member.name || '(unnamed)',
      type: member.type,
      mark: member.key ? 'key' : member.ref ? 'ref' : member.direction ? 'parameter' : 'column',
      nullable: member.nullable !== false
    });
  }
}

/** One connection's pins, as keys, for a constant-time "is this pinned?". */
function pinSet(row: ConnectionRow): ReadonlySet<string> {
  if (row.pins.length === 0) {
    return EMPTY_PINS;
  }
  return new Set(row.pins.map(favouriteKey));
}

const EMPTY_PINS: ReadonlySet<string> = new Set<string>();

function note(
  profileId: string,
  node: string,
  level: number,
  tone: NoteTone,
  text: string
): FlatItem {
  return {
    kind: 'note',
    key: `${gkey(profileId, node)}${SEP}${tone}`,
    profileId,
    node,
    level,
    tone,
    text,
    offset: 0
  };
}

/* ------------------------------------------------------------------ search */

/**
 * The search reading of the list.
 *
 * Browsing and searching are two different lists, not one list with rows
 * hidden, and this is where they part. A search shows what matched and nothing
 * else: no folders, no schemas, nothing expanded, no hierarchy to walk. That
 * is the whole point of a search box in a tree of fifty thousand objects — the
 * hierarchy is exactly what you are trying not to walk.
 *
 * Connections still match by name, host and database, the way they did before
 * there were any objects to find, and they keep their grouping. Object matches
 * follow, one section per connection.
 */
function search(input: FlattenInput, parsed: ParsedQuery): Flattened {
  const items: FlatItem[] = [];
  const matches = new Map<string, MatchField[]>();
  const wanted: Want[] = [];
  let productionHidden = 0;
  let matched = 0;

  const needle = parsed.needle;

  if (!isObjectQuery(parsed)) {
    const kept: ConnectionRow[] = [];
    for (const row of input.rows) {
      const fields = matchRow(row, parsed.raw.toLowerCase());
      if (fields === null) {
        if (row.environment === 'prod') {
          productionHidden++;
        }
        continue;
      }
      matches.set(row.id, fields);
      kept.push(row);
    }
    matched = kept.length;

    const pinned = kept.filter((r) => r.favourite).sort((a, b) => compare(input.sort, a, b));
    const rest = kept.filter((r) => !r.favourite);

    if (pinned.length > 0) {
      items.push({ kind: 'pinned', count: pinned.length });
      for (const row of pinned) {
        items.push(searchRow(row, true, true));
      }
    }

    if (!input.grouped) {
      for (const row of rest.slice().sort((a, b) => compare(input.sort, a, b))) {
        items.push(searchRow(row, false, true));
      }
    } else {
      const present = [...new Set(rest.map((r) => r.environment))].sort((a, b) => RANK[a] - RANK[b]);
      for (const environment of present) {
        const members = rest.filter((r) => r.environment === environment);
        items.push({
          kind: 'group',
          environment,
          count: members.length,
          open: members.reduce((n, r) => (input.open.has(r.id) ? n + 1 : n), 0),
          collapsed: false
        });
        for (const row of members.slice().sort((a, b) => compare(input.sort, a, b))) {
          items.push(searchRow(row, false, false));
        }
      }
    }
  }

  /* Objects, one section per connection, in the list's own connection order so
     the sections appear where the eye already expects that connection to be. */
  let objectHits = 0;
  for (const row of input.rows) {
    if (!input.open.has(row.id)) {
      continue;
    }
    const found = matchObjects(input.catalog[row.id] ?? EMPTY_CATALOG, parsed, needle);
    if (found.objects.length === 0) {
      continue;
    }
    objectHits += found.objects.length;
    items.push({
      kind: 'results',
      key: `results${SEP}${row.id}`,
      profileId: row.id,
      label: row.name || row.host,
      count: found.objects.length,
      capped: found.capped
    });
    const pins = pinSet(row);
    for (const object of found.objects) {
      emitObject(object, row, input, items, wanted, 2, true, pins);
    }
  }

  if (items.length === 0) {
    items.push({ kind: 'nomatch', query: parsed.raw });
  }

  return { items, matches, matched, productionHidden, wanted, objectHits };
}

function searchRow(row: ConnectionRow, pinned: boolean, showBadge: boolean): FlatItem {
  // Nothing expands during a search: the answer is the list, and a twistie on
  // it would invite the user back into the hierarchy they just escaped.
  return {
    kind: 'row',
    id: row.id,
    environment: row.environment,
    pinned,
    showBadge,
    expandable: false,
    expanded: false,
    schemaMode: row.mode === 'schema'
  };
}

/**
 * Every object this connection has that matches, ranked.
 *
 * The candidates are everything the panel holds — every folder that has been
 * opened — plus the server's own answer for this query. The two overlap and
 * are deduplicated by kind, schema and name, which is the same identity a pin
 * uses. Local candidates are why a result appears on the first keystroke; the
 * server's are why the answer is not limited to the folders you happened to
 * have opened.
 */
function matchObjects(
  catalog: ConnectionCatalog,
  parsed: ParsedQuery,
  needle: string
): { objects: DbObject[]; capped: boolean } {
  const kinds = parsed.kinds ? new Set(parsed.kinds) : null;
  const seen = new Set<string>();
  const scored: Array<{ object: DbObject; score: number }> = [];

  const consider = (object: DbObject): void => {
    if (kinds && !kinds.has(object.kind)) {
      return;
    }
    if (parsed.schema && object.schema.toLowerCase() !== parsed.schema) {
      return;
    }
    const id = favouriteKey(object);
    if (seen.has(id)) {
      return;
    }
    seen.add(id);

    if (needle === '') {
      // A type or schema filter with no name: everything that passed the
      // filter, in catalogue order, which is already alphabetical.
      scored.push({ object, score: 0 });
      return;
    }
    const hit = fuzzy(object.name, needle);
    if (hit) {
      scored.push({ object, score: hit.score });
      return;
    }
    // A schema-only hit is a real hit and ranks below every name hit, so
    // `sales` finds everything in `sales` without burying `SalesOrder`.
    const inSchema = fuzzy(object.schema, needle);
    if (inSchema) {
      scored.push({ object, score: inSchema.score - 600 });
    }
  };

  for (const node of Object.values(catalog.nodes)) {
    for (const object of node.objects) {
      consider(object);
    }
  }
  const hits = catalog.hits;
  if (hits && hits.query === parsed.raw) {
    for (const object of hits.objects) {
      consider(object);
    }
  }

  scored.sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name));
  const capped = scored.length > RESULTS_PER_CONNECTION || Boolean(hits?.capped);
  return { objects: scored.slice(0, RESULTS_PER_CONNECTION).map((entry) => entry.object), capped };
}
