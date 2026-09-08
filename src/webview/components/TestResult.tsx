import { defaultPort } from '../../types';
import { useField, useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';

/**
 * The outcome strip. Testing is a first-class step here: it says how long the
 * round trip took, what answered, and how it was encrypted, because those
 * three are what tell you the connection is the one you meant.
 */
export function TestResult() {
  const store = useStore();
  // The strip reads an id, a host and a port, and only while an attempt is
  // running. Holding the whole draft redrew it on every keystroke.
  const id = useField('id');
  const host = useField('host');
  const port = useField('port');
  const driver = useField('driver');
  const busy = useSelect((state) => Boolean(state.draft && state.host.busy === state.draft.id));
  const result = useSelect((state) => (state.draft ? state.host.results[state.draft.id] : undefined));

  if (id === undefined) {
    return null;
  }

  if (busy) {
    const shown = port ?? defaultPort(driver ?? 'mssql');
    return (
      <div className="result busy" role="status" aria-live="polite">
        <Codicon name="loading" spin />
        <span>
          Connecting to {host || 'the server'} on {shown}
        </span>
        <button type="button" className="link-btn" onClick={() => post({ type: 'cancel', id })}>
          Cancel
        </button>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="result idle" role="status" aria-live="polite">
        <Codicon name="circle-large-outline" />
        <span>Not tested yet. Connecting tests it first.</span>
      </div>
    );
  }

  if (result.ok) {
    const info = result.info;
    return (
      <div className="result ok" role="status" aria-live="polite">
        <Codicon name="pass-filled" />
        <div className="result-body">
          <strong>Connected in {info.latencyMs} ms</strong>
          <dl className="result-facts">
            <div>
              <dt>Server</dt>
              <dd>{info.serverVersion}</dd>
            </div>
            <div>
              <dt>Signed in as</dt>
              <dd>{info.principal}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{info.readOnly ? 'Read-only' : 'Read-write'}</dd>
            </div>
          </dl>
        </div>
      </div>
    );
  }

  const failure = result.failure;
  return (
    <div className="result bad" role="alert">
      <Codicon name="error" />
      <div className="result-body">
        <strong>{failure.title}</strong>
        <p className="what">
          <span className="tag">What happened</span>
          {failure.detail}
        </p>
        {failure.actions.length ? (
          <div className="result-actions">
            {failure.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={action.weakening ? 'btn ghost weakening' : 'btn outline'}
                onClick={() => {
                  const id = store.getState().draft?.id;
                  if (id) {
                    post({ type: 'action', id, actionId: action.id, raw: failure.raw });
                  }
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
