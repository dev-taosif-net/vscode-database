import { DraftPayload } from '../../shared/protocol';
import {
  AppState,
  EditorStore,
  effective,
  isConnected,
  isDirty,
  isNew,
  isValid,
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

const selDirty = (state: AppState) => isDirty(effective(state));
const selValid = (state: AppState) => isValid(effective(state));
const selBusy = (state: AppState) => Boolean(state.draft && state.host.busy === state.draft.id);
const selProduction = (state: AppState) => state.draft?.environment === 'prod';

/**
 * The sticky footer. Connect is last and accented because it is the one that
 * opens a session; Save is primary because it is the one that keeps the work.
 *
 * These three are the only Test, Save and Connect in the editor. They read the
 * draft with any pasted string already laid over it, so pasting a string and
 * pressing Connect works without a second set of buttons in the paste pane.
 */
export function ActionBar() {
  const store = useStore();
  const fresh = useSelect(isNew);
  // Measured on the draft a press would act on, so a pasted string lights the
  // buttons that are about to use it.
  const dirty = useSelect(selDirty);
  const valid = useSelect(selValid);
  const busy = useSelect(selBusy);
  const connected = useSelect(isConnected);
  const production = useSelect(selProduction);

  const send = (type: 'save' | 'test' | 'connect') => {
    const state = commitPastedString(store);
    const payload = payloadOf(state);
    if (!payload) {
      return;
    }
    if (type === 'connect' && production) {
      // Production asks first, in the page, before anything reaches the host.
      store.setState((state) => ({ ...state, confirming: true }));
      return;
    }
    post({ type, ...payload });
  };

  return (
    <footer className="actions">
      <Button tone="ghost" onClick={() => post({ type: 'close' })}>
        Cancel
      </Button>

      <span className="grow" />

      <Button tone="outline" icon="beaker" disabled={busy || !valid} onClick={() => send('test')}>
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
        disabled={(!dirty && !fresh) || !valid}
        onClick={() => send('save')}
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
        disabled={!valid}
        title={fresh ? 'Saves the connection first, then opens a session' : undefined}
        onClick={() => send('connect')}
      >
        Connect
      </Button>
    </footer>
  );
}
