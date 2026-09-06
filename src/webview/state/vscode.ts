import { WebviewMessage } from '../../shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Acquired once. Calling it twice throws, so nothing else may call it. */
const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

/**
 * Preferences that belong to the editor rather than to the connection: which
 * method is showing, which advanced groups are open. Kept in the webview's own
 * state so they survive a reload of the tab.
 */
export interface PersistedUi {
  method?: 'manual' | 'string';
  advanced?: Record<string, boolean>;
}

export function readPersisted(): PersistedUi {
  const state = api.getState();
  return state && typeof state === 'object' ? (state as PersistedUi) : {};
}

export function writePersisted(next: PersistedUi): void {
  api.setState({ ...readPersisted(), ...next });
}
