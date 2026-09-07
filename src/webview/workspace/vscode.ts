import { QueryWebviewMessage } from '../../shared/query';

interface VsCodeApi {
  postMessage(message: QueryWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Acquired once. Calling it twice throws, so nothing else may call it. */
const api = acquireVsCodeApi();

export function post(message: QueryWebviewMessage): void {
  api.postMessage(message);
}

/**
 * The three things that live in the page and only three: scroll offset, column
 * widths and the current selection.
 *
 * All three are per tab and all three survive the webview being disposed under
 * the budget and rebuilt, which is what makes disposal invisible. Everything
 * else — which set is showing, the sort, the filter, the row window — is host
 * state, because every one of those changes what the host has to fetch.
 */
export interface PersistedGrid {
  widths?: Record<string, number[]>;
  scrollTop?: Record<string, number>;
  tab?: 'results' | 'messages' | 'plan';
  /** The tab's own address, read back by the serializer after a reload. */
  uri?: string;
}

export function readPersisted(): PersistedGrid {
  const state = api.getState();
  return state && typeof state === 'object' ? (state as PersistedGrid) : {};
}

export function writePersisted(next: PersistedGrid): void {
  api.setState({ ...readPersisted(), ...next });
}

/** The surface this bundle was mounted as, from the page rather than a message. */
export function viewName(): 'results' | 'data' | 'runner' {
  const value = document.body.dataset.view;
  return value === 'data' || value === 'runner' ? value : 'results';
}

/**
 * Hands the tab's address back to the workbench.
 *
 * A serializer gets nothing after a window reload but whatever the page last
 * put in `setState`, so the address has to make that round trip or the tab
 * cannot be rebuilt. The page holds no other state worth restoring, which is
 * why restoring one is this cheap.
 */
export function announceAddress(): void {
  const address = document.body.dataset.address;
  if (address) {
    api.setState({ ...readPersisted(), uri: address });
  }
}
