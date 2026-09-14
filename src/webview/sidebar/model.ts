import {
  CatalogState,
  CatalogSummary,
  DATABASES_NODE,
  DbMember,
  DbObject,
  FAVOURITES_NODE,
  FavouriteRef,
  KINDS,
  ObjectKind,
  SYSTEM_DATABASES_NODE,
  catalogKey,
  databaseNode,
  databaseOfNode,
  favouriteKey,
  inDatabase,
  isSystemDatabase,
  kindNode,
  kindsFor,
  memberNode,
  schemaKindNode,
  schemaNode,
  summaryNode
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

interface CatalogNode {
  objects: DbObject[];
  total: number;
  error?: string;
}

/**
 * One entry in the panel's catalog map.
 *
 * The entry under a bare profile id holds that connection's database list, in
 * `databases`. The entry under `catalogKey(profileId, database)` holds one
 * database's tree. One shape for both keeps a single store and a single prefix
 * sweep when the connection goes away.
 */
export interface ConnectionCatalog {
  state: CatalogState;
  summary?: CatalogSummary;
  error?: string;
  /** The database this tree was read from, as the server spells it. */
  database?: string;
  /** On the connection's own entry: the databases it draws. */
  databases?: { names: string[]; current: string; all: boolean };
  /** Folder node key to the rows it holds. Cumulative across pages. */
  nodes: Readonly<Record<string, CatalogNode>>;
  /** Object node key to its columns or parameters. */
  members: Readonly<Record<string, DbMember[]>>;
  /** The last server-side search answer, and the query it answers. */
  hits?: { query: string; objects: DbObject[]; capped: boolean };
  /**
   * A folder's filtered answer from the server, keyed like `nodes`. Only the
   * latest filter per folder is held, and only folders too large to have been
   * read whole ever ask for one.
   */
  filtered?: Readonly<Record<string, CatalogNode & { filter: string }>>;
}

/**
 * A folder's own filter, keyed by the folder's global key.
 *
 * `text` is what is in the box, and filters what is already loaded on every
 * keystroke. `committed` is the same text once typing pauses, and it is what
 * the server is asked for — one query per pause rather than one per character.
 */
export interface FolderFilter {
  text: string;
  committed: string;
}

export type FilterMap = Readonly<Record<string, FolderFilter>>;

export type CatalogMap = Readonly<Record<string, ConnectionCatalog>>;

export const EMPTY_CATALOG: ConnectionCatalog = {
  state: 'idle',
  nodes: {},
  members: {}
};

/* ------------------------------------------------------------------ items */

type NoteTone = 'loading' | 'empty' | 'error' | 'more';

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
      /** The folder holds objects, so it offers a filter box. */
      filterable: boolean;
      /** Its filter box has something typed into it. */
      filtering: boolean;
    }
  | {
      /**
       * A folder's filter box, drawn as the folder's first child.
       *
       * `summary` is what the right-hand column says — `12 of 1,240`, or that
       * the rest of the folder is still being searched.
       */
      kind: 'filter';
      key: string;
      /** The folder's own global key, which is what the filter is stored under. */
      folderKey: string;
      level: number;
      label: string;
      text: string;
      summary: string;
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
      /** The database the object is in, so its menu acts on the right one. */
      database: string;
      detail: string;
      /** Draw `sales.Order` rather than `Order`, when the schema is not implied. */
      qualify: boolean;
      expandable: boolean;
      expanded: boolean;
      favourite: boolean;
      /** The folder filter it is shown because of, to mark in the name. Empty otherwise. */
      needle: string;
    }
  | {
      kind: 'database';
      key: string;
      profileId: string;
      node: string;
      level: number;
      name: string;
      /** The database the connection opened in. */
      isDefault: boolean;
      expanded: boolean;
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
    case 'database':
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
  /**
   * Cursor id to flat index. The cursor moves on every arrow key and `reveal`
   * arrives on every selection, and a linear scan of a folder holding fifty
   * thousand objects on each of those is the difference between a keypress and
   * a pause.
   */
  index: Map<string, number>;
}

export function measure(items: FlatItem[]): Geometry {
  const offsets = new Int32Array(items.length + 1);
  const owner = new Int32Array(items.length);
  const headers: number[] = [];
  const index = new Map<string, number>();
  let current = -1;
  for (let i = 0; i < items.length; i++) {
    offsets[i + 1] = offsets[i] + heightOf(items[i]);
    if (isHeader(items[i])) {
      current = i;
      headers.push(i);
    }
    owner[i] = current;
    index.set(keyOf(items[i]), i);
  }
  return { items, offsets, owner, headers, index };
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

type MatchField = 'name' | 'host' | 'database';

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
  | { what: 'databases'; profileId: string }
  | { what: 'catalog'; profileId: string; database: string }
  | {
      what: 'node';
      profileId: string;
      database: string;
      node: string;
      kind: ObjectKind;
      schema?: string;
      offset: number;
      /** A folder's committed filter, when the folder is too large to filter locally. */
      filter?: string;
    }
  | { what: 'members'; profileId: string; database: string; node: string; ref: FavouriteRef };

interface FlattenInput {
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
  /** Folder global key to the filter box open on it. */
  filters: FilterMap;
}

interface Flattened {
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
 * The connection a cursor key belongs to, or null when the cursor is on a
 * section header rather than inside a connection.
 *
 * Every key in the panel is built here, and every one of them below a
 * connection starts with that connection's profile id, so this reads the
 * answer off the key rather than looking the item up in the flattened array.
 * That matters because the caller is a subscription that fires on every arrow
 * key: a lookup would need the geometry, and the geometry is the one thing in
 * the panel that is expensive to hold on to.
 *
 * The three headers are the exceptions, and `results` is the one inversion —
 * its key names the connection second because the band belongs to the search
 * and not to the row.
 */
export function profileOfKey(key: string | null): string | null {
  if (!key) {
    return null;
  }
  const cut = key.indexOf(SEP);
  if (cut < 0) {
    return key === 'pinned' || key === 'nomatch' || key.startsWith('environment:') ? null : key;
  }
  const head = key.slice(0, cut);
  if (head !== 'results') {
    return head;
  }
  // `results`, the profile id, then the database the section is for.
  const rest = key.slice(cut + 1);
  const next = rest.indexOf(SEP);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The database a cursor key sits inside, or undefined when it is in none. */
export function databaseOfKey(key: string | null): string | undefined {
  if (!key) {
    return undefined;
  }
  const cut = key.indexOf(SEP);
  if (cut < 0) {
    return undefined;
  }
  if (key.slice(0, cut) === 'results') {
    // `results`, the profile id, the database.
    const parts = key.split(SEP);
    return parts[2];
  }
  return databaseOfNode(key.slice(cut + 1));
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
  const list = input.catalog[row.id] ?? EMPTY_CATALOG;
  const level = 2;

  if (list.state === 'idle') {
    wanted.push({ what: 'databases', profileId: row.id });
    items.push(note(row.id, DATABASES_NODE, level, 'loading', 'Reading the databases'));
    return;
  }
  if (list.state === 'loading') {
    items.push(note(row.id, DATABASES_NODE, level, 'loading', 'Reading the databases'));
    return;
  }
  if (list.state === 'error' || !list.databases) {
    items.push(note(row.id, DATABASES_NODE, level, 'error', list.error ?? 'The databases could not be listed.'));
    return;
  }

  const { names, current, all } = list.databases;
  /*
   * SQL Server's four system databases go in a folder of their own, the way
   * SSMS files them. Only when every database is listed: a profile pointed at
   * `msdb` on purpose shows `msdb`, not a folder with `msdb` in it.
   */
  const system = all ? names.filter((name) => isSystemDatabase(row.driver, name)) : [];
  const user = system.length > 0 ? names.filter((name) => !isSystemDatabase(row.driver, name)) : names;

  // The folder comes first, the way SSMS places it: a fixed row at the top,
  // with the user's databases below it in name order.
  if (system.length > 0) {
    const open = input.expanded.has(gkey(row.id, SYSTEM_DATABASES_NODE));
    items.push({
      kind: 'folder',
      key: gkey(row.id, SYSTEM_DATABASES_NODE),
      profileId: row.id,
      node: SYSTEM_DATABASES_NODE,
      level,
      label: 'System Databases',
      count: system.length,
      mark: 'folder',
      expanded: open,
      // It holds databases, not objects, and there are only ever four.
      filterable: false,
      filtering: false
    });
    if (open) {
      for (const name of system) {
        emitDatabase(row, input, items, wanted, name, current, level + 1);
      }
    }
  }
  for (const name of user) {
    emitDatabase(row, input, items, wanted, name, current, level);
  }
}

/** One database row, and its tree when it is open. */
function emitDatabase(
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  name: string,
  current: string,
  level: number
): void {
  const node = databaseNode(name);
  const expanded = input.expanded.has(gkey(row.id, node));
  items.push({
    kind: 'database',
    key: gkey(row.id, node),
    profileId: row.id,
    node,
    level,
    name,
    isDefault: name.toLowerCase() === current.toLowerCase(),
    expanded
  });
  if (expanded) {
    databaseChildren(row, input, items, wanted, name, current, level + 1);
  }
}

/**
 * Everything under one expanded database.
 *
 * This is what used to sit directly under the connection, one level deeper
 * and with every node key placed inside the database, so the same folder in
 * two databases is two folders.
 */
function databaseChildren(
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  database: string,
  current: string,
  level: number
): void {
  const catalog = input.catalog[catalogKey(row.id, database)] ?? EMPTY_CATALOG;
  const at = (node: string) => inDatabase(database, node);
  /*
   * The pins as a set, built once per connection rather than scanned per
   * object.
   *
   * `pins` is an array on the row, and asking "is this object pinned?" with
   * `Array.prototype.some` costs one `favouriteKey` allocation per pin per
   * object. A folder of five hundred tables against twenty pins is ten
   * thousand string builds, on a function that runs on every keystroke.
   */
  const pinned = pinsIn(row, database, current);
  const pins = pinSet(pinned);

  if (catalog.state === 'idle') {
    wanted.push({ what: 'catalog', profileId: row.id, database });
    items.push(note(row.id, summaryNode(database), level, 'loading', 'Reading the catalogue'));
    return;
  }
  if (catalog.state === 'loading') {
    items.push(note(row.id, summaryNode(database), level, 'loading', 'Reading the catalogue'));
    return;
  }
  if (catalog.state === 'error' || !catalog.summary) {
    items.push(
      note(row.id, summaryNode(database), level, 'error', catalog.error ?? 'The catalogue could not be read.')
    );
    return;
  }

  const summary = catalog.summary;
  const isOpen = (node: string) => input.expanded.has(gkey(row.id, node));

  /* Favourites. Always drawn, empty or not: it is where pinning puts things,
     and a folder that appears only once you have used the feature is a folder
     nobody discovers. */
  const favourites = at(FAVOURITES_NODE);
  const favouritesKey = gkey(row.id, favourites);
  const favouritesFilter = input.filters[favouritesKey];
  items.push({
    kind: 'folder',
    key: favouritesKey,
    profileId: row.id,
    node: favourites,
    level,
    label: 'Favourites',
    count: pinned.length,
    mark: 'favourite',
    expanded: isOpen(favourites),
    filterable: true,
    filtering: needleOf(favouritesFilter) !== ''
  });
  if (isOpen(favourites)) {
    // Pins are all in memory, so this folder is only ever filtered locally.
    const needle = needleOf(favouritesFilter);
    const shown = needle ? pinned.filter((pin) => pin.name.toLowerCase().includes(needle)) : pinned;
    if (favouritesFilter) {
      items.push(
        filterItem(favouritesKey, level + 1, 'Favourites', favouritesFilter, needle ? `${shown.length} of ${pinned.length}` : '')
      );
    }
    if (pinned.length === 0) {
      items.push(note(row.id, favourites, level + 1, 'empty', 'Right-click an object to pin it here'));
    } else if (shown.length === 0) {
      items.push(note(row.id, favourites, level + 1, 'empty', 'No favourites match'));
    } else {
      for (const pin of shown) {
        emitObject(
          { kind: pin.kind, schema: pin.schema, name: pin.name, detail: KINDS[pin.kind].singular },
          row,
          input,
          items,
          wanted,
          database,
          level + 1,
          true,
          pins,
          needle
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
      const node = at(kindNode(kind));
      const filter = input.filters[gkey(row.id, node)];
      items.push({
        kind: 'folder',
        key: gkey(row.id, node),
        profileId: row.id,
        node,
        level,
        label: KINDS[kind].plural,
        count,
        mark: 'folder',
        expanded: isOpen(node),
        filterable: true,
        filtering: needleOf(filter) !== ''
      });
      if (isOpen(node)) {
        objects(row, input, items, wanted, database, node, kind, undefined, level + 1, pins, filter);
      }
    }
    return;
  }

  for (const schema of summary.schemas) {
    const node = at(schemaNode(schema.name));
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
      const child = at(schemaKindNode(schema.name, kind));
      const filter = input.filters[gkey(row.id, child)];
      items.push({
        kind: 'folder',
        key: gkey(row.id, child),
        profileId: row.id,
        node: child,
        level: level + 1,
        label: KINDS[kind].plural,
        count,
        mark: 'folder',
        expanded: isOpen(child),
        filterable: true,
        filtering: needleOf(filter) !== ''
      });
      if (isOpen(child)) {
        objects(row, input, items, wanted, database, child, kind, schema.name, level + 2, pins, filter);
      }
    }
  }
}

type FilterItem = Extract<FlatItem, { kind: 'filter' }>;

/** A filter's name part, trimmed and lower-cased the way `segments` wants it. */
function needleOf(filter: FolderFilter | undefined): string {
  return filter ? filter.text.trim().toLowerCase() : '';
}

function filterItem(folderKey: string, level: number, label: string, filter: FolderFilter, summary: string): FilterItem {
  return { kind: 'filter', key: `${folderKey}${SEP}filter`, folderKey, level, label, text: filter.text, summary };
}

function moreNote(profileId: string, node: string, level: number, loaded: number, total: number): FlatItem {
  return {
    kind: 'note',
    key: `${gkey(profileId, node)}${SEP}more`,
    profileId,
    node,
    level,
    tone: 'more',
    text: `Load ${Math.min(total - loaded, PAGE)} more of ${total.toLocaleString()}`,
    offset: loaded
  };
}

/**
 * One folder's rows, plus whatever it is still waiting for.
 *
 * With a filter typed, the folder is narrowed to the objects whose name
 * contains it. A folder read whole is narrowed right here, on every keystroke.
 * A folder that has only its first pages narrows what it holds at once and,
 * once typing pauses, asks the server for the rest — so a filter never quietly
 * answers "nothing" about the eight hundred tables that were never loaded.
 */
function objects(
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  database: string,
  node: string,
  kind: ObjectKind,
  schema: string | undefined,
  level: number,
  pins: ReadonlySet<string>,
  filter: FolderFilter | undefined
): void {
  const catalog = input.catalog[catalogKey(row.id, database)] ?? EMPTY_CATALOG;
  const held = catalog.nodes[node];
  const plural = KINDS[kind].plural.toLowerCase();
  const qualify = schema === undefined;
  const needle = needleOf(filter);

  // The box is the folder's first child in every state, so it does not jump
  // when the first page lands underneath it.
  const box = filter ? filterItem(gkey(row.id, node), level, KINDS[kind].plural, filter, '') : null;
  const say = (summary: string): void => {
    if (box) {
      box.summary = summary;
    }
  };
  if (box) {
    items.push(box);
  }

  if (!held) {
    wanted.push({ what: 'node', profileId: row.id, database, node, kind, schema, offset: 0 });
    items.push(note(row.id, node, level, 'loading', `Reading ${plural}`));
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

  if (!needle) {
    for (const object of held.objects) {
      emitObject(object, row, input, items, wanted, database, level, qualify, pins);
    }
    if (held.total > held.objects.length) {
      items.push(moreNote(row.id, node, level, held.objects.length, held.total));
    }
    return;
  }

  const total = held.total.toLocaleString();
  const local = held.objects.filter((object) => object.name.toLowerCase().includes(needle));

  if (held.objects.length >= held.total) {
    say(`${local.length.toLocaleString()} of ${total}`);
    if (local.length === 0) {
      items.push(note(row.id, node, level, 'empty', `No ${plural} match`));
    }
    for (const object of local) {
      emitObject(object, row, input, items, wanted, database, level, qualify, pins, needle);
    }
    return;
  }

  // The server is asked only for the text typing has paused on.
  const committed = filter ? filter.committed.trim() : '';
  const settled = committed !== '' && committed.toLowerCase() === needle;
  const answer = catalog.filtered?.[node];

  if (settled && answer && answer.filter === committed) {
    if (answer.error) {
      items.push(note(row.id, node, level, 'error', answer.error));
      return;
    }
    say(`${answer.total.toLocaleString()} of ${total}`);
    if (answer.objects.length === 0) {
      items.push(note(row.id, node, level, 'empty', `No ${plural} match`));
      return;
    }
    for (const object of answer.objects) {
      emitObject(object, row, input, items, wanted, database, level, qualify, pins, needle);
    }
    if (answer.total > answer.objects.length) {
      items.push(moreNote(row.id, node, level, answer.objects.length, answer.total));
    }
    return;
  }

  // Still typing, or the answer is on its way: what is loaded matches now.
  if (settled) {
    wanted.push({ what: 'node', profileId: row.id, database, node, kind, schema, offset: 0, filter: committed });
  }
  say(`${local.length.toLocaleString()}+ of ${total}`);
  for (const object of local) {
    emitObject(object, row, input, items, wanted, database, level, qualify, pins, needle);
  }
  items.push(note(row.id, node, level, 'loading', `Searching all ${total} ${plural}`));
}

/** One object, and its columns or parameters when it is open. */
function emitObject(
  object: DbObject,
  row: ConnectionRow,
  input: FlattenInput,
  items: FlatItem[],
  wanted: Want[],
  database: string,
  level: number,
  qualify: boolean,
  pins: ReadonlySet<string>,
  /** A folder filter to mark in the name, when the object is shown because of one. */
  needle = ''
): void {
  const ref: FavouriteRef = { kind: object.kind, schema: object.schema, name: object.name, database };
  const node = inDatabase(database, memberNode(ref));
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
    database,
    detail: object.detail,
    qualify,
    expandable,
    expanded,
    favourite: pins.has(favouriteKey(ref)),
    needle
  });

  if (!expanded) {
    return;
  }

  const catalog = input.catalog[catalogKey(row.id, database)] ?? EMPTY_CATALOG;
  const members = catalog.members[node];
  if (!members) {
    wanted.push({ what: 'members', profileId: row.id, database, node, ref });
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
function pinSet(pins: readonly FavouriteRef[]): ReadonlySet<string> {
  if (pins.length === 0) {
    return EMPTY_PINS;
  }
  return new Set(pins.map(favouriteKey));
}

/**
 * The pins that belong to one database. A pin with no database was made
 * before the tree drew databases, and it belongs to the one the connection
 * opened in.
 */
function pinsIn(row: ConnectionRow, database: string, current: string): FavouriteRef[] {
  const here = database.toLowerCase();
  return row.pins.filter((pin) => (pin.database ?? current).toLowerCase() === here);
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
    // One section per database that matched. The database is named on the
    // heading only when more than one did, because `dbo.Customer` in two
    // databases is exactly the case where the heading has to say which.
    const prefix = catalogKey(row.id, '');
    const sections: Array<{ database: string; found: { objects: DbObject[]; capped: boolean } }> = [];
    for (const key of Object.keys(input.catalog).sort()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const catalog = input.catalog[key];
      const found = matchObjects(catalog, parsed, needle);
      if (found.objects.length > 0) {
        sections.push({ database: catalog.database ?? key.slice(prefix.length), found });
      }
    }
    const current = input.catalog[row.id]?.databases?.current ?? '';
    for (const { database, found } of sections) {
      objectHits += found.objects.length;
      const connection = row.name || row.host;
      items.push({
        kind: 'results',
        key: `results${SEP}${row.id}${SEP}${database}`,
        profileId: row.id,
        label: sections.length > 1 ? `${connection} · ${database}` : connection,
        count: found.objects.length,
        capped: found.capped
      });
      const pins = pinSet(pinsIn(row, database, current));
      for (const object of found.objects) {
        emitObject(object, row, input, items, wanted, database, 2, true, pins);
      }
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
