import { useEffect } from 'react';
import { HostMessage } from '../shared/protocol';
import { applyHostMessage, isDirty, isValid, setMethod, useSelect, useStore, useUpdate } from './state/editor';
import { post } from './state/vscode';
import { payloadOf, ActionBar } from './components/ActionBar';
import { AdvancedGroups } from './components/AdvancedGroups';
import { AuthSection } from './components/AuthSection';
import { ConnectionStringPanel } from './components/ConnectionStringPanel';
import { ConnectionSummary } from './components/ConnectionSummary';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { IdentityPanel } from './components/IdentityPanel';
import { ProductionConfirm } from './components/ProductionConfirm';
import { ProductionWarning } from './components/ProductionWarning';
import { ServerSection } from './components/ServerSection';
import { TestResult } from './components/TestResult';
import { Panel } from './primitives/Panel';
import { Segmented } from './primitives/Segmented';
import { Codicon } from './primitives/Codicon';

export function App() {
  useHostMessages();
  useDirtyReporting();
  useShortcuts();

  const hasDraft = useSelect((state) => Boolean(state.draft));
  const environment = useSelect((state) => state.draft?.environment);

  if (!hasDraft) {
    return <EmptyState />;
  }

  return (
    <div className="editor">
      <Header />

      <div className="columns">
        <IdentityPanel />
        <main className="details" aria-label="Connection details">
          {environment === 'prod' ? <ProductionWarning /> : null}
          <MethodPanel />
          <Panel icon="settings-gear" title="Advanced" summary="Everything with a working default">
            <AdvancedGroups />
          </Panel>
        </main>
      </div>

      <ConnectionSummary />
      <TestResult />
      <ActionBar />
      <ProductionConfirm />
    </div>
  );
}

/** The switch between filling fields and pasting a string. */
function MethodPanel() {
  const method = useSelect((state) => state.method);
  const report = useSelect((state) => state.parseReport);
  const update = useUpdate();

  return (
    <Panel
      icon="plug"
      title="Connection details"
      actions={
        <Segmented
          name="Connection method"
          value={method}
          options={[
            { id: 'manual', label: 'Manual setup', hint: 'Fill in the fields' },
            { id: 'string', label: 'Connection string', hint: 'Paste one instead' }
          ]}
          onChange={(next) => update((state) => setMethod({ ...state, parseReport: null }, next))}
        />
      }
    >
      {report && report.ok ? (
        <p className="note info" role="status">
          <Codicon name="info" className="glyph" />
          <span>{report.text}</span>
        </p>
      ) : null}

      <div className={`method-panes method-${method}`}>
        {method === 'manual' ? (
          <div className="stack wide">
            <section className="subsection" aria-label="Server and database">
              <ServerSection />
            </section>
            <section className="subsection" aria-label="Authentication">
              <h3>
                <Codicon name="key" />
                Authentication
              </h3>
              <AuthSection />
            </section>
          </div>
        ) : (
          <ConnectionStringPanel />
        )}
      </div>
    </Panel>
  );
}

/** Folds every message from the host into the store. */
function useHostMessages(): void {
  const store = useStore();
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      store.setState((state) => applyHostMessage(state, event.data));
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [store]);
}

/**
 * The host has to know whether the editor holds work that would be lost, so it
 * can ask before moving to another connection.
 */
function useDirtyReporting(): void {
  const dirty = useSelect(isDirty);
  useEffect(() => {
    post({ type: 'dirty', dirty });
  }, [dirty]);
}

function useShortcuts(): void {
  const store = useStore();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = store.getState();
      const payload = payloadOf(state);
      if (!payload) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape' && state.host.busy === payload.id) {
        event.preventDefault();
        post({ type: 'cancel', id: payload.id });
        return;
      }
      if (!isValid(state)) {
        return;
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault();
        if (state.draft?.environment === 'prod') {
          store.setState((next) => ({ ...next, confirming: true }));
        } else {
          post({ type: 'connect', ...payload });
        }
      } else if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        post({ type: 'save', ...payload });
      } else if (event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        post({ type: 'test', ...payload });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
}
