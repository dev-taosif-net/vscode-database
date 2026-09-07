import { useCallback } from 'react';
import { ConnectionRow, SessionUpdate, SortOrder } from '../../shared/sidebar';
import { EnvironmentId } from '../../types';
import { Store, createStore, useStoreSelector } from '../state/store';
import { post } from './api';

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

/*
 * Three stores rather than one, and the split is the whole performance story.
 *
 * `listStore` is the only thing the geometry is derived from, so a connection
 * going live must never touch it. `sessionStore` holds only the rows that are
 * not saved, and rows subscribe to it one id at a time. `cursorStore` changes
 * at click and keypress rate and nothing else reads it.
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

/**
 * Folds or unfolds one environment.
 *
 * Folding is a reading of the list, so the panel applies it locally and tells
 * the host afterwards. The host persists it in its memento, because the
 * title-bar `when` clauses need it, and deliberately does not answer with a
 * fresh state — a round trip to redraw a chevron would be visible.
 *
 * This lives here rather than in the shell because the twistie and the
 * keyboard both fold, and while they had one implementation each the mouse
 * path posted without writing the store: the chevron changed its own glyph and
 * nothing else on screen moved.
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
