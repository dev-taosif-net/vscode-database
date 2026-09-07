import { SidebarWebviewMessage } from '../../shared/sidebar';

interface VsCodeApi {
  postMessage(message: SidebarWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * Acquired once. `state/vscode.ts` does the same for the connection editor and
 * calling it twice throws, so nothing under `sidebar/` may import that module.
 */
const api = acquireVsCodeApi();

export function post(message: SidebarWebviewMessage): void {
  api.postMessage(message);
}

/**
 * The only thing the panel persists for itself.
 *
 * Grouping, sort and which environments are folded live in the host's memento,
 * because the title-bar toggles need them for their `when` clauses and a single
 * source of truth belongs on the side that owns the commands. Scroll position
 * has no host-side reader, and losing it every time the view is collapsed is
 * the whole reason this exists.
 */
export interface PersistedSidebar {
  scrollTop?: number;
}

export function readPersisted(): PersistedSidebar {
  const state = api.getState();
  return state && typeof state === 'object' ? (state as PersistedSidebar) : {};
}

export function writePersisted(next: PersistedSidebar): void {
  api.setState({ ...readPersisted(), ...next });
}
