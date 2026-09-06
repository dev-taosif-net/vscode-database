import { isDirty, isNew, useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';
import { EngineMark, engineName } from '../primitives/EngineMark';

export function Header() {
  const store = useStore();
  const draft = useSelect((state) => state.draft);
  const fresh = useSelect(isNew);
  const dirty = useSelect(isDirty);
  const connected = useSelect((state) => Boolean(state.draft && state.host.connected.includes(state.draft.id)));

  if (!draft) {
    return null;
  }

  const engine = engineName(draft.driver);
  const title = draft.name.trim() || (fresh ? `New ${engine} connection` : 'Untitled connection');

  return (
    <header className="page-head">
      <EngineMark driver={draft.driver} size={20} plate={36} />
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
