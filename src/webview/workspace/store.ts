import { useCallback } from 'react';
import { createStore, useStoreSelector } from '../state/store';
import {
  CellValue,
  ColumnMeta,
  ExecutionInfo,
  PlanPayload,
  QueryHostMessage,
  RunnerForm,
  RunnerValue,
  TabContext
} from '../../shared/query';
import { forget, patch, put } from '../grid/rows';

export type ResultTab = 'results' | 'messages' | 'plan';

/**
 * Where an edited cell is between Enter and the server's answer, and for a
 * moment after. `pending` dims it; `saved` marks it briefly so the eye can
 * confirm the write landed; `error` keeps the mark and the server's words
 * until the cell is edited again.
 */
export interface CellStatus {
  state: 'pending' | 'saved' | 'error';
  text?: string;
}

export function cellKey(executionId: string, setIndex: number, row: number, column: number): string {
  return `${executionId}:${setIndex}:${row}:${column}`;
}

/** How long a saved cell keeps its mark. Long enough to see, short enough not to clutter. */
const SAVED_MS = 1500;

export interface WorkspaceState {
  execution: ExecutionInfo | null;
  /** The query tab in front of the user, so the strip stands before any run. */
  context: TabContext | null;
  plan: PlanPayload | null;
  form: RunnerForm | null;
  values: Record<string, RunnerValue>;
  /** Bumped when the host asks the runner to execute, so the form can act on it. */
  executeRequest: number;
  tab: ResultTab;
  setIndex: number;
  filter: string;
  /** Table data only: the columns the filter searches. Empty means all of them. */
  filterColumns: string[];
  /**
   * Whether the filter controls have been filled from the host's cursor yet.
   *
   * A data tab keeps no webview state while hidden, so revealing it again
   * starts this store from nothing while the host is still filtering. Reading
   * the cursor once on the first projection is what stops the box saying
   * "All columns" over rows filtered on one.
   */
  filterHydrated: boolean;
  /** Bumped on every batch of rows, so the grid repaints without re-fetching. */
  revision: number;
  notice: { text: string; level: 'info' | 'error' } | null;
  detail: { value: CellValue; column: ColumnMeta } | null;
  /** Edited cells by `cellKey`, while they have something to show. */
  cells: Record<string, CellStatus>;
}

export const store = createStore<WorkspaceState>({
  execution: null,
  context: null,
  plan: null,
  form: null,
  values: {},
  executeRequest: 0,
  tab: 'results',
  setIndex: 0,
  filter: '',
  filterColumns: [],
  filterHydrated: false,
  revision: 0,
  notice: null,
  detail: null,
  cells: {}
});

export function useWorkspace<T>(select: (state: WorkspaceState) => T): T {
  return useStoreSelector(store, useCallback(select, []));
}

export function applyHostMessage(message: QueryHostMessage): void {
  switch (message.type) {
    case 'project': {
      store.setState((state) => {
        const changed = state.execution?.id !== message.execution?.id;
        if (changed) {
          // A new execution invalidates every cached row: the ids are per
          // execution, so nothing from the old one could be drawn anyway, and
          // holding it would be a leak with no reader.
          forget(state.execution?.id);
        }
        const table = message.execution?.table;
        const hydrate = !state.filterHydrated && table !== undefined;
        return {
          ...state,
          ...(hydrate
            ? { filter: table.filter ?? '', filterColumns: table.filterColumns ?? [], filterHydrated: true }
            : {}),
          execution: message.execution,
          context: message.context,
          setIndex: changed ? 0 : Math.min(state.setIndex, Math.max(0, (message.execution?.sets.length ?? 1) - 1)),
          plan: changed ? null : state.plan,
          tab: changed && state.tab === 'plan' ? 'results' : state.tab,
          cells: changed ? {} : state.cells,
          revision: state.revision + 1
        };
      });
      return;
    }

    case 'rows':
      put(message.executionId, message.setIndex, message.offset, message.rows);
      store.setState((state) => ({ ...state, revision: state.revision + 1 }));
      return;

    case 'plan':
      store.setState((state) => ({ ...state, plan: message.plan, tab: 'plan' }));
      return;

    case 'form':
      store.setState((state) => ({ ...state, form: message.form, values: message.form.values }));
      return;

    case 'execute':
      store.setState((state) => ({ ...state, executeRequest: state.executeRequest + 1 }));
      return;

    case 'exported':
      store.setState((state) => ({
        ...state,
        notice: { level: 'info', text: `Wrote ${message.rows.toLocaleString('en-US')} rows to ${message.path}.` }
      }));
      return;

    case 'copied':
      store.setState((state) => ({
        ...state,
        notice: { level: 'info', text: `Copied ${message.cells.toLocaleString('en-US')} cells.` }
      }));
      return;

    case 'notice':
      store.setState((state) => ({ ...state, notice: { level: message.level, text: message.text } }));
      return;

    case 'cell': {
      const key = cellKey(message.executionId, message.setIndex, message.row, message.column);
      if (message.ok) {
        patch(message.executionId, message.setIndex, message.row, message.column, message.value ?? null);
        markCell(key, { state: 'saved' });
        store.setState((state) => ({ ...state, revision: state.revision + 1 }));
        setTimeout(() => {
          if (store.getState().cells[key]?.state === 'saved') {
            markCell(key, null);
          }
        }, SAVED_MS);
        return;
      }
      // No error means the edit was withdrawn — a production confirmation
      // declined — and the cell simply goes back to what it was.
      markCell(key, message.error ? { state: 'error', text: message.error } : null);
      if (message.error) {
        store.setState((state) => ({ ...state, notice: { level: 'error', text: message.error ?? '' } }));
      }
      return;
    }

    default:
      return;
  }
}

export function markCell(key: string, status: CellStatus | null): void {
  store.setState((state) => {
    const cells = { ...state.cells };
    if (status) {
      cells[key] = status;
    } else {
      delete cells[key];
    }
    return { ...state, cells };
  });
}

export function setTab(tab: ResultTab): void {
  store.setState((state) => ({ ...state, tab }));
}

export function setSetIndex(setIndex: number): void {
  store.setState((state) => ({ ...state, setIndex }));
}

export function setFilter(filter: string): void {
  store.setState((state) => ({ ...state, filter }));
}

export function setFilterColumns(filterColumns: string[]): void {
  store.setState((state) => ({ ...state, filterColumns }));
}

export function setNotice(notice: WorkspaceState['notice']): void {
  store.setState((state) => ({ ...state, notice }));
}

export function setDetail(detail: WorkspaceState['detail']): void {
  store.setState((state) => ({ ...state, detail }));
}

export function setValue(name: string, value: RunnerValue): void {
  store.setState((state) => ({ ...state, values: { ...state.values, [name]: value } }));
}
