import { isDirty, isNew, useField, useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';
import { EngineMark, engineName } from '../primitives/EngineMark';

export function Header() {
  const store = useStore();
  // The head draws the name and the engine and nothing else out of the draft.
  // Subscribing to the whole object rebuilt this on every keystroke in every
  // box on the page, and with it the engine mark's thirty-odd nodes.
  const name = useField('name');
  const driver = useField('driver');
  const fresh = useSelect(isNew);
  const dirty = useSelect(isDirty);
  const connected = useSelect((state) => Boolean(state.draft && state.host.connected.includes(state.draft.id)));

  if (name === undefined || driver === undefined) {
    return null;
  }

  const engine = engineName(driver);
  const title = name.trim() || (fresh ? `New ${engine} connection` : 'Untitled connection');

  return (
    <header className="page-head">
      <EngineMark driver={driver} size={20} plate={36} />
      <div className="page-title">
        <h1>{title}</h1>
        <p>{fresh ? `Create a connection to ${engine}` : engine}</p>
      </div>

      {connected ? (
        <span className="state-chip live">
          <span className="dot" aria-hidden="true" />
          Connected
        </span>
      ) : fresh ? (
        <span className="state-chip draft">Not saved yet</span>
      ) : dirty ? (
        <span className="state-chip draft">Unsaved changes</span>
      ) : (
        <span className="state-chip saved">Saved</span>
      )}

      <button
        type="button"
        className="icon-btn"
        title={fresh ? 'Discard this new connection' : 'More actions'}
        aria-label={fresh ? 'Discard this new connection' : 'More actions'}
        onClick={() => {
          const id = store.getState().draft?.id;
          if (id) {
            post({ type: 'menu', id });
          }
        }}
      >
        <Codicon name="ellipsis" />
      </button>
    </header>
  );
}
