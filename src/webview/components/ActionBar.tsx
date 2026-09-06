import { DraftPayload } from '../../shared/protocol';
import { AppState, isConnected, isDirty, isNew, isValid, useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { Button } from '../primitives/Button';

export function payloadOf(state: AppState): DraftPayload | null {
  if (!state.draft) {
    return null;
  }
  return { id: state.draft.id, patch: state.draft, secret: state.secret };
}

/**
 * The sticky footer. Connect is last and accented because it is the one that
 * opens a session; Save is primary because it is the one that keeps the work.
 */
export function ActionBar() {
  const store = useStore();
  const fresh = useSelect(isNew);
  const dirty = useSelect(isDirty);
  const valid = useSelect(isValid);
  const busy = useSelect((state) => Boolean(state.draft && state.host.busy === state.draft.id));
  const connected = useSelect(isConnected);
  const production = useSelect((state) => state.draft?.environment === 'prod');

  const send = (type: 'save' | 'test' | 'connect') => {
    const payload = payloadOf(store.getState());
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

      <Button tone="outline" icon="beaker" hint="Alt+T" disabled={busy || !valid} onClick={() => send('test')}>
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
        hint="Ctrl+S"
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
        hint="Ctrl+Enter"
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
