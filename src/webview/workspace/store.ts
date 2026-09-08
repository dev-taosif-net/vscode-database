import { useCallback } from 'react';
import { createStore, useStoreSelector } from '../state/store';
import {
  CellValue,
  ColumnMeta,
  ExecutionInfo,
  PlanPayload,
  QueryHostMessage,
  RunnerForm,
  RunnerValue
} from '../../shared/query';
import { forget, put } from '../grid/rows';

export type ResultTab = 'results' | 'messages' | 'plan';

export interface WorkspaceState {
  execution: ExecutionInfo | null;
  plan: PlanPayload | null;
  form: RunnerForm | null;
  values: Record<string, RunnerValue>;
  /** Bumped when the host asks the runner to execute, so the form can act on it. */
  executeRequest: number;
  tab: ResultTab;
  setIndex: number;
  filter: string;
  /** Bumped on every batch of rows, so the grid repaints without re-fetching. */
  revision: number;
  notice: { text: string; level: 'info' | 'error' } | null;
  detail: { value: CellValue; column: ColumnMeta } | null;
}

export const store = createStore<WorkspaceState>({
  execution: null,
  plan: null,
  form: null,
  values: {},
  executeRequest: 0,
  tab: 'results',
  setIndex: 0,
  filter: '',
  revision: 0,
  notice: null,
  detail: null
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
        return {
          ...state,
          execution: message.execution,
          setIndex: changed ? 0 : Math.min(state.setIndex, Math.max(0, (message.execution?.sets.length ?? 1) - 1)),
          plan: changed ? null : state.plan,
          tab: changed && state.tab === 'plan' ? 'results' : state.tab,
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

    default:
      return;
  }
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

export function setNotice(notice: WorkspaceState['notice']): void {
  store.setState((state) => ({ ...state, notice }));
}

export function setDetail(detail: WorkspaceState['detail']): void {
  store.setState((state) => ({ ...state, detail }));
}

export function setValue(name: string, value: RunnerValue): void {
  store.setState((state) => ({ ...state, values: { ...state.values, [name]: value } }));
}
