import { useCallback } from 'react';
import {
  CatalogSummary,
  DATABASES_NODE,
  DbMember,
  DbObject,
  ObjectKind,
  catalogKey,
  databaseNode,
  databaseOfNode,
  globalKey,
  parseFolderNode,
  summaryNode
} from '../../shared/catalog';
import { ConnectionRow, SessionUpdate, SortOrder } from '../../shared/sidebar';
import { EnvironmentId } from '../../types';
import { Store, createStore, useStoreSelector } from '../state/store';
import { post, readPersisted, writePersisted } from './api';
import { CatalogMap, ConnectionCatalog, EMPTY_CATALOG, FilterMap, PAGE, Want } from './model';

export interface ListState {
  rows: ConnectionRow[];
  byId: Readonly<Record<string, ConnectionRow>>;
  grouped: boolean;
  sort: SortOrder;
  collapsed: EnvironmentId[];
  query: string;
  /** False until the first state message lands, so nothing flashes empty. */
  ready: boolean;
}

export type SessionMap = Readonly<Record<string, SessionUpdate>>;

export interface CursorState {
  /** The roving-tabindex cursor. Null until the list is first touched. */
  cursorId: string | null;
  /** Which profile the editor is showing. Mirrors the host. */
  selectedId: string | null;
}

/** Global keys that are open. A record rather than a Set, so it persists. */
export type ExpandedMap = Readonly<Record<string, true>>;

/*
 * Five stores rather than one, and the split is the whole performance story.
 *
 * `listStore` and the two added for phase 2 — `catalogStore` and
 * `expandedStore` — are the three the geometry is derived from, so all three
 * rebuild the flattened index and all three change only when the tree's shape
 * genuinely changes. `sessionStore` holds only the rows that are not saved and
 * rows subscribe to it one id at a time. `cursorStore` changes at click and
 * keypress rate and nothing else reads it.
 *
 * A connection going live is still a `sessionStore` write and still re-renders
 * one row — except that it now also adds an id to `open`, which is why
 * `VirtualList` derives that set from a joined string rather than from the
 * session map itself.
 */

export const listStore: Store<ListState> = createStore<ListState>({
  rows: [],
  byId: {},
  grouped: true,
  sort: 'environment',
  collapsed: [],
  query: '',
  ready: false
});

export const sessionStore: Store<SessionMap> = createStore<SessionMap>({});

export const cursorStore: Store<CursorState> = createStore<CursorState>({
  cursorId: null,
  selectedId: null
});

export const catalogStore: Store<CatalogMap> = createStore<CatalogMap>({});

/**
 * What the current query matched: connections, production connections it hid,
 * and objects across every open connection.
 *
 * All three are computed by `flatten`, which is the only thing that does the
 * matching, and published here rather than recomputed by the search band and
 * the footer — each of which used to run its own pass over every row on every
 * keystroke, and a second implementation of the matching is a second one to
 * disagree. The screen reader is told the object count too: a user who types
 * `customer`, hears "0 of 84 connections match" and is not told about the
 * forty objects on screen has been told the opposite of the truth.
 */
export interface Counts {
  matched: number;
  productionHidden: number;
  objectHits: number;
}

export const countsStore: Store<Counts> = createStore<Counts>({ matched: 0, productionHidden: 0, objectHits: 0 });

export function setCounts(next: Counts): void {
  countsStore.setState((held) =>
    held.matched === next.matched &&
    held.productionHidden === next.productionHidden &&
    held.objectHits === next.objectHits
      ? held
      : next
  );
}

/**
 * What is open, restored from the panel's own memento.
 *
 * Expansion is persisted for the same reason scroll position is: it has no
 * host-side reader, and losing it every time the sidebar is collapsed is what
 * makes a deep tree exhausting. It is *not* persisted host-side, because the
 * host would then have to know the node key convention, and a second place
 * that builds keys is a second place they can disagree.
 */
export const expandedStore: Store<ExpandedMap> = createStore<ExpandedMap>(
  readPersisted().expanded ?? {}
);

/* ------------------------------------------------------------- expansion */

function persistExpanded(next: ExpandedMap): void {
  writePersisted({ expanded: next });
}

export function setExpanded(key: string, on: boolean): void {
  expandedStore.setState((s) => {
    if (Boolean(s[key]) === on) {
      return s;
    }
    const next: Record<string, true> = { ...s };
    if (on) {
      next[key] = true;
    } else {
      delete next[key];
    }
    persistExpanded(next);
    return next;
  });
}

export function toggleExpanded(key: string): void {
  setExpanded(key, !expandedStore.getState()[key]);
}

/* ---------------------------------------------------------- folder filters */

/**
 * Every folder that has a filter box open, and what is typed into it.
 *
 * Not persisted. A filter is a question asked of the folder right now, and a
 * folder that reopened tomorrow still narrowed to `cust` would look like a
 * folder that had lost its tables.
 */
export const filterStore: Store<FilterMap> = createStore<FilterMap>({});

/** How long typing has to pause before a large folder asks the server. */
const FILTER_DELAY_MS = 250;

const filterTimers = new Map<string, number>();

/** A request for the filter box of one folder to take focus once it can. */
const filterFocusStore: Store<{ key: string | null; n: number }> = createStore<{ key: string | null; n: number }>({
  key: null,
  n: 0
});

/** Opens a folder's filter box, opening the folder too, and focuses the box. */
export function openFilter(folderKey: string): void {
  filterStore.setState((s) => (s[folderKey] ? s : { ...s, [folderKey]: { text: '', committed: '' } }));
  setExpanded(folderKey, true);
  filterFocusStore.setState((s) => ({ key: folderKey, n: s.n + 1 }));
}

export function setFilterText(folderKey: string, text: string): void {
  filterStore.setState((s) => ({ ...s, [folderKey]: { text, committed: s[folderKey]?.committed ?? '' } }));
  window.clearTimeout(filterTimers.get(folderKey));
  filterTimers.set(
    folderKey,
    window.setTimeout(() => {
      filterTimers.delete(folderKey);
      filterStore.setState((s) => {
        const held = s[folderKey];
        return held && held.committed !== held.text ? { ...s, [folderKey]: { ...held, committed: held.text } } : s;
      });
    }, FILTER_DELAY_MS)
  );
}

export function closeFilter(folderKey: string): void {
  window.clearTimeout(filterTimers.get(folderKey));
  filterTimers.delete(folderKey);
  filterStore.setState((s) => {
    if (!s[folderKey]) {
      return s;
    }
    const next = { ...s };
    delete next[folderKey];
    return next;
  });
}

/**
 * A number that changes when this folder's box has been asked to take focus,
 * and zero otherwise. The box focuses itself on a change and then consumes the
 * request, so a row that is scrolled away and back does not steal focus again.
 */
export function useFilterFocus(folderKey: string): number {
  const select = useCallback((s: { key: string | null; n: number }) => (s.key === folderKey ? s.n : 0), [folderKey]);
  return useStoreSelector(filterFocusStore, select);
}

export function consumeFilterFocus(): void {
  filterFocusStore.setState((s) => (s.key === null ? s : { ...s, key: null }));
}

/** The key a connection's own subtree is opened under. */
export function connectionKey(profileId: string): string {
  return globalKey(profileId, '');
}

/**
 * Closes every object node, leaving the environment groups to `collapseAll`.
 *
 * The two are deliberately separate gestures with one button: folding the
 * environments without folding the trees inside them would leave a hundred
 * open folders waiting behind the chevrons, and the next unfold would be a
 * wall.
 */
export function collapseTree(): void {
  expandedStore.setState((s) => {
    if (Object.keys(s).length === 0) {
      return s;
    }
    persistExpanded({});
    return {};
  });
}

/**
 * Folds or unfolds one environment.
 *
 * Folding is a reading of the list, so the panel applies it locally and tells
 * the host afterwards. The host persists it in its memento, because the
 * title-bar `when` clauses need it, and deliberately does not answer with a
 * fresh state — a round trip to redraw a chevron would be visible.
 */
export function fold(environment: EnvironmentId, on: boolean): void {
  listStore.setState((s) => {
    if (s.collapsed.includes(environment) === on) {
      return s;
    }
    return {
      ...s,
      collapsed: on ? [...s.collapsed, environment] : s.collapsed.filter((e) => e !== environment)
    };
  });
  post({ type: 'collapse', environment, on });
}

export function index(rows: ConnectionRow[]): Record<string, ConnectionRow> {
  const byId: Record<string, ConnectionRow> = {};
  for (const row of rows) {
    byId[row.id] = row;
  }
  return byId;
}

/* --------------------------------------------------------------- catalogue */

/** Merges into one catalog entry: a connection's list, or one database's tree. */
function patch(key: string, change: Partial<ConnectionCatalog>): void {
  catalogStore.setState((s) => ({
    ...s,
    [key]: { ...(s[key] ?? EMPTY_CATALOG), ...change }
  }));
}

/**
 * Connections whose one database has already been opened for them, so a
 * connection the user collapsed by hand is not reopened on every refresh of
 * the list. Forgotten with the catalog.
 */
const opened = new Set<string>();

export function applyDatabases(profileId: string, names: string[], current: string, all: boolean): void {
  patch(profileId, { state: 'ready', databases: { names, current, all }, error: undefined });
  // A connection that draws exactly one database opens straight into it, so
  // a named-database profile is still one click from its tables.
  if (!all && names.length === 1 && !opened.has(profileId)) {
    opened.add(profileId);
    setExpanded(globalKey(profileId, databaseNode(names[0])), true);
  }
}

export function applyDatabasesError(profileId: string, message: string): void {
  patch(profileId, { state: 'error', error: message });
  asked.delete(`databases:${profileId}`);
}

/**
 * Forgets a connection's database list, so it is read again.
 *
 * Called when a profile starts or stops showing every database. The trees
 * already read under each database are kept: they are still true.
 */
export function resetDatabases(profileId: string): void {
  catalogStore.setState((s) => {
    if (!s[profileId]) {
      return s;
    }
    const next = { ...s };
    delete next[profileId];
    return next;
  });
  asked.delete(`databases:${profileId}`);
  opened.delete(profileId);
}

export function applySummary(profileId: string, database: string, summary: CatalogSummary): void {
  patch(catalogKey(profileId, database), { state: 'ready', summary, error: undefined, database });
}

export function applyCatalogError(profileId: string, database: string, message: string): void {
  const key = catalogKey(profileId, database);
  patch(key, { state: 'error', error: message, database });
  // The request failed, so the guard that stops it being asked twice has to be
  // lifted: the user can collapse the database and open it again to retry,
  // and without this that retry would be a no-op for the rest of the session.
  asked.delete(`catalog:${key}`);
}

export function applyObjects(
  profileId: string,
  database: string,
  node: string,
  objects: DbObject[],
  total: number,
  filter?: string
): void {
  const key = catalogKey(profileId, database);
  if (filter) {
    // Answers can land out of order, and an answer for a filter the box no
    // longer holds must not replace the one it does. Its guard is lifted so
    // typing that filter again asks again rather than waiting for ever.
    if (filterStore.getState()[globalKey(profileId, node)]?.committed.trim() !== filter) {
      forgetFilterAsked(profileId, node, '');
      return;
    }
    catalogStore.setState((s) => {
      const held = s[key] ?? EMPTY_CATALOG;
      return {
        ...s,
        [key]: { ...held, database, filtered: { ...held.filtered, [node]: { objects, total, filter } } }
      };
    });
    forgetFilterAsked(profileId, node, filter);
    return;
  }
  catalogStore.setState((s) => {
    const held = s[key] ?? EMPTY_CATALOG;
    return {
      ...s,
      [key]: { ...held, database, nodes: { ...held.nodes, [node]: { objects, total } } }
    };
  });
  // The `asked` entry for this page is deliberately kept. The answer is now in
  // the store, so `flatten` will stop asking on its own; clearing the guard
  // would only reopen the window in which a re-render could ask again.
}

export function applyMembers(profileId: string, database: string, node: string, members: DbMember[]): void {
  const key = catalogKey(profileId, database);
  catalogStore.setState((s) => {
    const held = s[key] ?? EMPTY_CATALOG;
    return { ...s, [key]: { ...held, database, members: { ...held.members, [node]: members } } };
  });
}

export function applyNodeError(
  profileId: string,
  database: string,
  node: string,
  message: string,
  filter?: string
): void {
  const key = catalogKey(profileId, database);
  if (filter) {
    // Beside the folder, not in it: a filter that failed has not made the
    // tables already on screen any less true.
    catalogStore.setState((s) => {
      const held = s[key] ?? EMPTY_CATALOG;
      return {
        ...s,
        [key]: {
          ...held,
          database,
          filtered: { ...held.filtered, [node]: { objects: [], total: 0, error: message, filter } }
        }
      };
    });
    forgetAsked(profileId);
    return;
  }
  catalogStore.setState((s) => {
    const held = s[key] ?? EMPTY_CATALOG;
    return {
      ...s,
      [key]: {
        ...held,
        database,
        nodes: { ...held.nodes, [node]: { objects: [], total: 0, error: message } }
      }
    };
  });
  forgetAsked(profileId);
}

export function applySearchAnswer(
  profileId: string,
  database: string,
  query: string,
  objects: DbObject[],
  capped: boolean
): void {
  patch(catalogKey(profileId, database), { database, hits: { query, objects, capped } });
}

/**
 * Tries a read that failed once more, from the row that reported it.
 *
 * A catalog that failed used to stay failed for the rest of the session: the
 * error row was drawn, nothing asked again, and the only way out was Refresh
 * or a reconnect. Forgetting the failed answer is enough — `flatten` sees the
 * gap on its next pass and asks for it — and it is done from a click rather
 * than automatically, because a server that refuses once will refuse a
 * thousand times a second if nothing waits for a person in between.
 */
export function retry(profileId: string, node: string): void {
  if (node === DATABASES_NODE) {
    asked.delete(`databases:${profileId}`);
    patch(profileId, { state: 'idle', error: undefined });
    return;
  }
  const database = databaseOfNode(node);
  if (database === undefined) {
    return;
  }
  const key = catalogKey(profileId, database);
  if (node === summaryNode(database)) {
    asked.delete(`catalog:${key}`);
    patch(key, { state: 'idle', error: undefined });
    return;
  }
  catalogStore.setState((s) => {
    const held = s[key];
    // A filter that failed is retried on its own; the folder under it is fine.
    if (held?.filtered?.[node]?.error) {
      const filtered = { ...held.filtered };
      delete filtered[node];
      return { ...s, [key]: { ...held, filtered } };
    }
    if (!held || !held.nodes[node]) {
      return s;
    }
    const nodes = { ...held.nodes };
    delete nodes[node];
    return { ...s, [key]: { ...held, nodes } };
  });
  for (const key of [...asked]) {
    if (key.startsWith(`node:${profileId}:${node}:`)) {
      asked.delete(key);
    }
  }
}

/**
 * Throws away everything read through one connection, or through all of them.
 *
 * Called when a session ends and when Refresh is used. It also drops the
 * expansion state below that connection — not because the keys would collide,
 * but because leaving forty folders open across a reconnect means forty
 * queries the moment the tree redraws, which is the opposite of what a lazy
 * tree is for. The connection's own node stays open, so reconnecting lands you
 * where you were.
 */
export function clearCatalog(profileId: string): void {
  if (profileId === '') {
    catalogStore.setState(() => ({}));
    asked.clear();
    opened.clear();
    return;
  }
  // The connection's database list and every database tree under it.
  const prefix = globalKey(profileId, '');
  catalogStore.setState((s) => {
    const doomed = Object.keys(s).filter((key) => key === profileId || key.startsWith(prefix));
    if (doomed.length === 0) {
      return s;
    }
    const next = { ...s };
    for (const key of doomed) {
      delete next[key];
    }
    return next;
  });
  forgetAsked(profileId);
  pruneExpanded(profileId);
  opened.delete(profileId);
}

/**
 * Closes everything below one connection, and leaves the connection itself
 * open.
 *
 * Forty folders left open across a disconnect are forty queries the moment the
 * tree redraws, which is the opposite of what a lazy tree is for. The
 * connection's own node survives — its key is exactly the prefix, with nothing
 * after it — so reconnecting lands you where you were rather than collapsed.
 */
function pruneExpanded(profileId: string): void {
  const prefix = connectionKey(profileId);
  expandedStore.setState((s) => {
    const next: Record<string, true> = {};
    let changed = false;
    for (const key of Object.keys(s)) {
      if (key.startsWith(prefix) && key.length > prefix.length) {
        changed = true;
        continue;
      }
      next[key] = true;
    }
    if (!changed) {
      return s;
    }
    persistExpanded(next);
    return next;
  });
}

/* ---------------------------------------------------------------- loading */

/**
 * Requests already sent, so a re-render never sends one twice.
 *
 * `flatten` reports what the tree is missing on every single pass, which is
 * the right design — it is pure and it cannot forget — but it means the same
 * `Want` is reported on every keystroke and every scroll-driven commit until
 * the answer lands. Without this set, opening a folder over a slow link would
 * fire one query per frame.
 */
const asked = new Set<string>();

function forgetAsked(profileId: string): void {
  for (const key of [...asked]) {
    if (key.includes(profileId)) {
      asked.delete(key);
    }
  }
}

/** Separates a filter from the rest of a `node` key, because a filter may contain `:`. */
const FILTER_MARK = String.fromCharCode(30);

function keyOfWant(want: Want): string {
  switch (want.what) {
    case 'databases':
      return `databases:${want.profileId}`;
    case 'catalog':
      return `catalog:${catalogKey(want.profileId, want.database)}`;
    case 'node':
      return `node:${want.profileId}:${want.node}:${want.offset}${want.filter ? `${FILTER_MARK}${want.filter}` : ''}`;
    case 'members':
      return `members:${want.profileId}:${want.node}`;
  }
}

/**
 * Lifts the guard on a folder's filtered reads, all but the one for `keep`.
 *
 * Only the latest filter per folder is held, so a filter that has been
 * replaced by another is no longer answered anywhere, and typing it again has
 * to be able to ask again.
 */
function forgetFilterAsked(profileId: string, node: string, keep: string): void {
  const prefix = `node:${profileId}:${node}:`;
  for (const key of [...asked]) {
    const mark = key.indexOf(FILTER_MARK);
    if (mark >= 0 && key.startsWith(prefix) && key.slice(mark + 1) !== keep) {
      asked.delete(key);
    }
  }
}

/** Sends whatever the tree is waiting for, once each. */
export function request(wants: readonly Want[]): void {
  for (const want of wants) {
    const key = keyOfWant(want);
    if (asked.has(key)) {
      continue;
    }
    asked.add(key);

    switch (want.what) {
      case 'databases':
        patch(want.profileId, { state: 'loading' });
        post({ type: 'loadDatabases', profileId: want.profileId });
        break;
      case 'catalog':
        patch(catalogKey(want.profileId, want.database), { state: 'loading', database: want.database });
        post({ type: 'loadCatalog', profileId: want.profileId, database: want.database });
        break;
      case 'node':
        post({
          type: 'loadNode',
          profileId: want.profileId,
          database: want.database,
          node: want.node,
          kind: want.kind,
          schema: want.schema,
          offset: want.offset,
          limit: PAGE,
          ...(want.filter ? { filter: want.filter } : {})
        });
        break;
      case 'members':
        post({
          type: 'loadMembers',
          profileId: want.profileId,
          database: want.database,
          node: want.node,
          ref: want.ref
        });
        break;
    }
  }
}

/**
 * The next page of a folder, from its `Load more` row.
 *
 * The kind and the schema are read back out of the node key rather than
 * carried on the row, which is why `parseFolderNode` exists. A key that does
 * not parse is a key no folder built, so nothing is sent.
 */
export function loadMore(profileId: string, node: string, offset: number): void {
  const parsed = parseFolderNode(node);
  if (!parsed || parsed.database === undefined) {
    return;
  }
  // A folder showing a filtered answer pages through that answer rather than
  // through the folder, because that is the list its `Load more` row counted.
  const typed = filterStore.getState()[globalKey(profileId, node)];
  const filter = typed && typed.text.trim() === typed.committed.trim() ? typed.committed.trim() : '';
  const answer = catalogStore.getState()[catalogKey(profileId, parsed.database)]?.filtered?.[node];
  request([
    {
      what: 'node',
      profileId,
      database: parsed.database,
      node,
      kind: parsed.kind as ObjectKind,
      schema: parsed.schema,
      offset,
      ...(filter && answer?.filter === filter ? { filter } : {})
    }
  ]);
}

/** Asks every open connection for server-side matches. */
export function searchObjects(query: string): void {
  post({ type: 'searchObjects', query });
}


/*
 * `useStoreSelector` memoises its snapshot on [store, select], so an inline
 * arrow produces a new selector on every render, which unsubscribes and
 * resubscribes — thirty subscribe and unsubscribe pairs per frame across a
 * windowed list. It will not throw and it will not warn, and it will not show
 * up at ten connections. These four hooks are the only sanctioned way to read a
 * per-row value, because each of them holds its selector stable.
 */

export function useRow(id: string): ConnectionRow | undefined {
  const select = useCallback((s: ListState) => s.byId[id], [id]);
  return useStoreSelector(listStore, select);
}

export function useSession(id: string): SessionUpdate | undefined {
  const select = useCallback((s: SessionMap) => s[id], [id]);
  return useStoreSelector(sessionStore, select);
}

export function useIsCursor(id: string): boolean {
  const select = useCallback((s: CursorState) => s.cursorId === id, [id]);
  return useStoreSelector(cursorStore, select);
}

export function useIsSelected(id: string): boolean {
  const select = useCallback((s: CursorState) => s.selectedId === id, [id]);
  return useStoreSelector(cursorStore, select);
}
