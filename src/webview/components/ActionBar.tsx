import { DraftPayload } from '../../shared/protocol';
import {
  AppState,
  EditorStore,
  canConnect,
  canSave,
  effective,
  isConnected,
  isDirty,
  isNew,
  markAttempted,
  missingSummary,
  useSelect,
  useStore
} from '../state/editor';
import { post } from '../state/vscode';
import { Button } from '../primitives/Button';

export function payloadOf(state: AppState): DraftPayload | null {
  if (!state.draft) {
    return null;
  }
  return { id: state.draft.id, patch: state.draft, secret: state.secret };
}

/**
 * Folds a recognised pasted string into the draft before an action runs on it.
 * Nothing to fold in leaves the state untouched, and an identical state is a
 * no-op in the store, so this is free on the ordinary path through the fields.
 */
export function commitPastedString(store: EditorStore): AppState {
  store.setState(effective);
  return store.getState();
}

/**
 * Tries to send one of the three actions, and says why not when it cannot.
 *
 * The buttons are disabled while the draft is not ready, but a shortcut has no
 * disabled state to show — so a Ctrl+Enter on an unfinished draft marks every
 * problem visible instead of doing nothing, which is the one thing worse than
 * doing the wrong thing.
 */
export function send(store: EditorStore, type: 'save' | 'test' | 'connect'): void {
  const state = commitPastedString(store);
  const ready = type === 'save' ? canSave(state) : canConnect(state);
  if (!ready) {
    store.setState(markAttempted);
    return;
  }
  const payload = payloadOf(state);
  if (!payload) {
    return;
  }
  if (type === 'connect' && state.draft?.environment === 'prod') {
    // Production asks first, in the page, before anything reaches the host.
    store.setState((next) => ({ ...next, confirming: true }));
    return;
  }
  post({ type, ...payload });
}

const selDirty = (state: AppState) => isDirty(effective(state));
const selCanSave = (state: AppState) => canSave(effective(state));
const selCanConnect = (state: AppState) => canConnect(effective(state));
const selSaveWhy = (state: AppState) => missingSummary(effective(state), true);
const selConnectWhy = (state: AppState) => missingSummary(effective(state));
const selBusy = (state: AppState) => Boolean(state.draft && state.host.busy === state.draft.id);

/**
 * The sticky footer. Connect is last and accented because it is the one that
 * opens a session; Save is primary because it is the one that keeps the work.
 *
 * These three are the only Test, Save and Connect in the editor. They read the
 * draft with any pasted string already laid over it, so pasting a string and
 * pressing Connect works without a second set of buttons in the paste pane.
 * A button that cannot be pressed says why in its tooltip, and the summary
 * strip above says the same thing in the open.
 */
export function ActionBar() {
  const store = useStore();
  const fresh = useSelect(isNew);
  const dirty = useSelect(selDirty);
  const saveable = useSelect(selCanSave);
  const connectable = useSelect(selCanConnect);
  const saveWhy = useSelect(selSaveWhy);
  const connectWhy = useSelect(selConnectWhy);
  const busy = useSelect(selBusy);
  const connected = useSelect(isConnected);

  return (
    <footer className="actions">
      <Button tone="ghost" onClick={() => post({ type: 'close' })}>
        Cancel
      </Button>

      <span className="grow" />

      <Button
        tone="outline"
        icon="beaker"
        disabled={busy || !connectable}
        title={connectWhy}
        onClick={() => send(store, 'test')}
      >
        Test connection
      </Button>

      {dirty && !fresh ? (
        <Button
          tone="ghost"
          onClick={() => {
            const id = store.getState().draft?.id;
            if (id) {
              post({ type: 'revert', id });
            }
          }}
        >
          Revert
        </Button>
      ) : null}

      <Button
        tone="primary"
        icon="save"
        disabled={(!dirty && !fresh) || !saveable}
        title={saveWhy}
        onClick={() => send(store, 'save')}
      >
        {fresh ? 'Save to the list' : 'Save'}
      </Button>

      {connected ? (
        <Button
          tone="secondary"
          icon="debug-disconnect"
          onClick={() => {
            const id = store.getState().draft?.id;
            if (id) {
              post({ type: 'disconnect', id });
            }
          }}
        >
          Disconnect
        </Button>
      ) : null}

      <Button
        tone="success"
        icon="plug"
        busy={busy}
        disabled={!connectable}
        title={connectWhy ?? (fresh ? 'Saves the connection first, then opens a session' : undefined)}
        onClick={() => send(store, 'connect')}
      >
        Connect
      </Button>
    </footer>
  );
}
