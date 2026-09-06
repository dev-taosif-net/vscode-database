import { useEffect, useRef } from 'react';
import { useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { payloadOf } from './ActionBar';
import { Codicon } from '../primitives/Codicon';

/**
 * The last word before a production session opens.
 *
 * It names the server and the database rather than asking "are you sure",
 * because the question worth answering is whether this is the right box, and
 * that cannot be answered by a yes/no with no facts in it.
 */
export function ProductionConfirm() {
  const store = useStore();
  const open = useSelect((state) => state.confirming);
  const draft = useSelect((state) => state.draft);
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      cancel.current?.focus();
    }
  }, [open]);

  if (!open || !draft) {
    return null;
  }

  const close = () => store.setState((state) => ({ ...state, confirming: false }));
  const go = () => {
    const payload = payloadOf(store.getState());
    close();
    if (payload) {
      post({ type: 'connect', ...payload });
    }
  };

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        ref={dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== 'Tab') {
            return;
          }
          // The dialog keeps focus: nothing behind it is reachable while it stands.
          const focusable = dialog.current?.querySelectorAll<HTMLElement>('button');
          if (!focusable || focusable.length === 0) {
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="dialog-head env-prod">
          <Codicon name="shield" />
          <h2 id="confirm-title">Connect to production?</h2>
        </div>
        <div className="dialog-body" id="confirm-body">
          <p>This opens a live session against a production server.</p>
          <dl>
            <div>
              <dt>Connection</dt>
              <dd>{draft.name}</dd>
            </div>
            <div>
              <dt>Server</dt>
              <dd>
                {draft.host}
                {draft.port ? `:${draft.port}` : ''}
              </dd>
            </div>
            <div>
              <dt>Database</dt>
              <dd>{draft.database || "The login's default"}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{draft.readOnly ? 'Read-only' : 'Read-write'}</dd>
            </div>
          </dl>
          {!draft.readOnly ? (
            <p className="note warn">
              <Codicon name="warning" className="glyph" />
              <span>This session can write. Statements you run reach live data.</span>
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" ref={cancel} onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={go}>
            <Codicon name="plug" />
            Connect to production
          </button>
        </div>
      </div>
    </div>
  );
}
