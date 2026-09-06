import { useEffect, useRef } from 'react';
import { defaultPort } from '../../types';
import { portInvalid, useField, useSelect, useStore } from '../state/editor';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';
import { Field } from '../primitives/Field';
import { NumberInput, SelectInput, TextInput } from '../primitives/Inputs';

const PROBE_DELAY_MS = 650;

/**
 * Where to connect, and whether that address is worth trying.
 *
 * The probe behind the reading resolves the name and opens a socket without
 * saying a word on it, so a typo is caught while it is being typed instead of
 * thirty seconds into a driver timeout. It waits for a pause in the typing so
 * a half-written host name is never looked up.
 */
export function ServerSection() {
  const driver = useField('driver') ?? 'mssql';
  const host = useField('host') ?? '';
  const port = useField('port') ?? null;
  const isMssql = driver === 'mssql';

  return (
    <div className="stack">
      <div className="row split">
        <Field label={isMssql ? 'Server' : 'Host'} htmlFor="f-host" required>
          <TextInput id="f-host" field="host" invalid={!host.trim()} />
        </Field>
        <Field
          label="Port"
          htmlFor="f-port"
          error={portInvalid(port) ? 'Between 1 and 65535.' : undefined}
        >
          <NumberInput
            id="f-port"
            field="port"
            width={92}
            placeholder={String(defaultPort(driver))}
            invalid={portInvalid(port)}
          />
        </Field>
      </div>

      <ProbeStrip />
      <DatabaseField />
    </div>
  );
}

/** The live reading under the server row. */
function ProbeStrip() {
  const store = useStore();
  const id = useSelect((state) => state.draft?.id);
  const host = useField('host') ?? '';
  const port = useField('port') ?? null;
  const driver = useField('driver') ?? 'mssql';
  const probe = useSelect((state) => state.probe);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!id || host.trim().length < 2 || portInvalid(port)) {
      return;
    }
    const target = `${host.trim()}|${port ?? ''}`;
    if (probe && probe.target === target) {
      return;
    }
    timer.current = window.setTimeout(() => {
      store.setState((state) => ({ ...state, probe: { target, state: 'checking' } }));
      post({ type: 'probe', id, host, port });
    }, PROBE_DELAY_MS);
    return () => window.clearTimeout(timer.current);
    // The probe itself is deliberately not a dependency: reacting to our own
    // answer would start the next lookup the moment the last one landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, host, port, driver, store]);

  if (!probe || probe.state === 'idle') {
    return null;
  }

  if (probe.state === 'checking') {
    return (
      <p className="probe checking" role="status" aria-live="polite">
        <Codicon name="loading" spin />
        Looking up {host.trim()}
      </p>
    );
  }

  if (probe.state === 'reachable' || probe.state === 'resolved') {
    return (
      <p className="probe ok" role="status" aria-live="polite">
        <Codicon name="pass-filled" />
        Resolved to {probe.address}
        {probe.state === 'reachable' ? `, answering on ${port ?? defaultPort(driver)}` : ''}
        {probe.latencyMs !== undefined ? ` in ${probe.latencyMs} ms` : ''}
      </p>
    );
  }

  return (
    <p className={`probe ${probe.state === 'unresolved' ? 'bad' : 'warn'}`} role="status" aria-live="polite">
      <Codicon name={probe.state === 'unresolved' ? 'error' : 'warning'} />
      {probe.message}
    </p>
  );
}

function DatabaseField() {
  const store = useStore();
  const databases = useSelect((state) => state.databases);
  const busy = useSelect((state) => Boolean(state.draft && state.host.busy === state.draft.id));
  const database = useField('database') ?? '';

  return (
    <Field
      label="Database"
      htmlFor="f-database"
      hint={databases ? `${databases.length} read from the server just now.` : undefined}
    >
      <div className="row">
        {databases && databases.length ? (
          <SelectInput
            id="f-database"
            field="database"
            options={databases.map((name) => [name, name] as [string, string])}
          />
        ) : (
          <TextInput id="f-database" field="database" />
        )}
        <button
          type="button"
          className="icon-btn"
          title="Read the database list from the server"
          aria-label="Read the database list from the server"
          disabled={busy}
          onClick={() => {
            const state = store.getState();
            if (!state.draft) {
              return;
            }
            post({
              type: 'reloadDatabases',
              id: state.draft.id,
              patch: state.draft,
              secret: state.secret
            });
          }}
        >
          <Codicon name={busy ? 'loading' : 'refresh'} spin={busy} />
        </button>
      </div>
      {database && databases && !databases.includes(database) ? (
        <p className="hint warn">{database} was not in the list the server returned.</p>
      ) : null}
    </Field>
  );
}
