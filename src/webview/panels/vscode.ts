import { PanelWebviewMessage } from '../../shared/details';

interface VsCodeApi {
  postMessage(message: PanelWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: PanelWebviewMessage): void {
  api.postMessage(message);
}

/** Which section is open, kept so a redraw does not fold everything shut. */
export function readOpen(): Record<string, boolean> {
  const state = api.getState();
  return state && typeof state === 'object' ? ((state as { open?: Record<string, boolean> }).open ?? {}) : {};
}

export function writeOpen(open: Record<string, boolean>): void {
  api.setState({ open });
}

export function viewName(): 'details' | 'history' {
  return document.body.dataset.view === 'history' ? 'history' : 'details';
}
