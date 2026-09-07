import { useCallback } from 'react';
import {
  CatalogSummary,
  DbMember,
  DbObject,
  ObjectKind,
  globalKey,
  parseFolderNode
} from '../../shared/catalog';
import { ConnectionRow, SessionUpdate, SortOrder } from '../../shared/sidebar';
import { EnvironmentId } from '../../types';
import { Store, createStore, useStoreSelector } from '../state/store';
import { post, readPersisted, writePersisted } from './api';
import { CatalogMap, ConnectionCatalog, EMPTY_CATALOG, PAGE, Want } from './model';

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
 * How many objects the current query matched, across every connection.
 *
 * It exists for one reason: the search box announces its result count to a
 * screen reader, and before phase 2 that count was connections alone. A user
 * who types `customer`, hears "0 of 84 connections match" and is not told
 * about the forty objects on screen has been told the opposite of the truth.
 *
 * The count is computed by `flatten`, which is the only thing that does the
 * matching, and published here rather than recomputed in the band, because a
 * second implementation of the ranking is a second implementation to disagree.
 */
export const hitsStore: Store<number> = createStore<number>(0);

export function setObjectHits(n: number): void {
  hitsStore.setState((held) => (held === n ? held : n));
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

function patch(profileId: string, change: Partial<ConnectionCatalog>): void {
  catalogStore.setState((s) => ({
    ...s,
    [profileId]: { ...(s[profileId] ?? EMPTY_CATALOG), ...change }
  }));
}

export function applySummary(profileId: string, summary: CatalogSummary): void {
  patch(profileId, { state: 'ready', summary, error: undefined });
}

export function applyCatalogError(profileId: string, message: string): void {
  patch(profileId, { state: 'error', error: message });
  // The request failed, so the guard that stops it being asked twice has to be
  // lifted: the user can collapse the connection and open it again to retry,
  // and without this that retry would be a no-op for the rest of the session.
  asked.delete(`catalog:${profileId}`);
}

export function applyObjects(
  profileId: string,
  node: string,
  objects: DbObject[],
  total: number
): void {
  catalogStore.setState((s) => {
    const held = s[profileId] ?? EMPTY_CATALOG;
    return {
      ...s,
      [profileId]: { ...held, nodes: { ...held.nodes, [node]: { objects, total } } }
    };
  });
  // The `asked` entry for this page is deliberately kept. The answer is now in
  // the store, so `flatten` will stop asking on its own; clearing the guard
  // would only reopen the window in which a re-render could ask again.
}

export function applyMembers(profileId: string, node: string, members: DbMember[]): void {
  catalogStore.setState((s) => {
    const held = s[profileId] ?? EMPTY_CATALOG;
    return { ...s, [profileId]: { ...held, members: { ...held.members, [node]: members } } };
  });
}

export function applyNodeError(profileId: string, node: string, message: string): void {
  catalogStore.setState((s) => {
    const held = s[profileId] ?? EMPTY_CATALOG;
    return {
      ...s,
      [profileId]: {
        ...held,
        nodes: { ...held.nodes, [node]: { objects: [], total: 0, error: message } }
      }
    };
  });
  forgetAsked(profileId);
}

export function applySearchAnswer(
  profileId: string,
  query: string,
  objects: DbObject[],
  capped: boolean
): void {
  patch(profileId, { hits: { query, objects, capped } });
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
    return;
  }
  catalogStore.setState((s) => {
    if (!s[profileId]) {
      return s;
    }
    const next = { ...s };
    delete next[profileId];
    return next;
  });
  forgetAsked(profileId);
  pruneExpanded(profileId);
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

function keyOfWant(want: Want): string {
  switch (want.what) {
    case 'catalog':
      return `catalog:${want.profileId}`;
    case 'node':
      return `node:${want.profileId}:${want.node}:${want.offset}`;
    case 'members':
      return `members:${want.profileId}:${want.node}`;
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
      case 'catalog':
        patch(want.profileId, { state: 'loading' });
        post({ type: 'loadCatalog', profileId: want.profileId });
        break;
      case 'node':
        post({
          type: 'loadNode',
          profileId: want.profileId,
          node: want.node,
          kind: want.kind,
          schema: want.schema,
          offset: want.offset,
          limit: PAGE
        });
        break;
      case 'members':
        post({ type: 'loadMembers', profileId: want.profileId, node: want.node, ref: want.ref });
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
  if (!parsed) {
    return;
  }
  request([
    {
      what: 'node',
      profileId,
      node,
      kind: parsed.kind as ObjectKind,
      schema: parsed.schema,
      offset
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
