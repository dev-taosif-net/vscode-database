import { MssqlAuth, PgAuth, needsSecret, needsUser } from '../../types';
import { useSelect, useStore, useUpdate } from '../state/editor';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';
import { Field } from '../primitives/Field';
import { SelectInput, TextInput } from '../primitives/Inputs';

const MSSQL_METHODS: [MssqlAuth, string][] = [
  ['sql', 'SQL Server login'],
  ['entra-mfa', 'Microsoft Entra ID, MFA'],
  ['ntlm', 'Windows authentication, NTLM']
];

const PG_METHODS: [PgAuth, string][] = [
  ['password', 'Password, SCRAM-SHA-256'],
  ['certificate', 'Client certificate'],
  ['none', 'No credential, trust or peer']
];

/**
 * Who to connect as. Only the fields the chosen method actually uses are
 * built, so a SQL login never shows a tenant and Entra never shows a password
 * box that would do nothing.
 */
export function AuthSection() {
  const draft = useSelect((state) => state.draft);
  if (!draft) {
    return null;
  }
  const isMssql = draft.driver === 'mssql';

  return (
    <div className="stack">
      <Field label="Method" htmlFor={isMssql ? 'f-auth' : 'f-pgauth'} required>
        {isMssql ? (
          <SelectInput id="f-auth" field="mssqlAuth" options={MSSQL_METHODS} />
        ) : (
          <SelectInput id="f-pgauth" field="pgAuth" options={PG_METHODS} />
        )}
      </Field>

      {isMssql && draft.mssqlAuth === 'ntlm' ? (
        <Field label="Domain" htmlFor="f-domain" required>
          <TextInput id="f-domain" field="domain" placeholder="NORTHWIND" />
        </Field>
      ) : null}

      {isMssql && draft.mssqlAuth === 'entra-mfa' ? <EntraFields /> : null}

      {needsUser(draft) ? (
        <Field label="User name" htmlFor="f-user" required>
          <TextInput id="f-user" field="user" />
        </Field>
      ) : null}

      {needsSecret(draft) ? <PasswordField /> : null}

      {!isMssql && draft.pgAuth === 'certificate' ? (
        <>
          <Field label="Client certificate" htmlFor="f-sslcert" required>
            <TextInput id="f-sslcert" field="clientCertPath" mono placeholder="~/.postgresql/postgresql.crt" />
          </Field>
          <Field label="Client key" htmlFor="f-sslkey" required hint="The key never leaves this machine.">
            <TextInput id="f-sslkey" field="clientKeyPath" mono placeholder="~/.postgresql/postgresql.key" />
          </Field>
        </>
      ) : null}

      {!isMssql && draft.pgAuth === 'none' ? (
        <p className="note info">
          <Codicon name="info" className="glyph" />
          <span>
            The server is expected to accept this login through <code>trust</code> or <code>peer</code>. No
            credential is sent.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function EntraFields() {
  const store = useStore();
  const account = useSelect((state) => state.draft?.account ?? '');

  return (
    <>
      <Field
        label="Tenant"
        htmlFor="f-tenant"
        hint="Leave blank to use the account's home tenant."
      >
        <TextInput id="f-tenant" field="tenant" placeholder="contoso.onmicrosoft.com" />
      </Field>
      <Field label="Account" htmlFor="f-account">
        <div className="row">
          <TextInput id="f-account" field="account" placeholder="Not signed in yet" />
          <button
            type="button"
            className="btn outline"
            onClick={() => {
              const id = store.getState().draft?.id;
              if (id) {
                post({ type: 'signIn', id });
              }
            }}
          >
            <Codicon name="account" />
            <span>{account ? 'Switch account' : 'Sign in'}</span>
          </button>
        </div>
      </Field>
      <p className="note info">
        <Codicon name="info" className="glyph" />
        <span>
          Signed in through the VS Code Microsoft account provider. The token is requested when you connect
          and is never stored by this extension.
        </span>
      </p>
    </>
  );
}

function PasswordField() {
  const store = useStore();
  const update = useUpdate();
  const secret = useSelect((state) => state.secret);
  const reveal = useSelect((state) => state.revealSecret);
  const stored = useSelect((state) => Boolean(state.draft && state.host.hasSecret[state.draft.id]));

  return (
    <Field label="Password" htmlFor="f-password" required>
      <div className="row">
        <input
          id="f-password"
          type={reveal ? 'text' : 'password'}
          value={secret ?? ''}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value;
            update((state) => ({ ...state, secret: next }));
          }}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={reveal ? 'Hide the password' : 'Show the password'}
          title={reveal ? 'Hide the password' : 'Show the password'}
          onClick={() => update((state) => ({ ...state, revealSecret: !state.revealSecret }))}
        >
          <Codicon name={reveal ? 'eye-closed' : 'eye'} />
        </button>
      </div>
      {stored ? (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            const id = store.getState().draft?.id;
            if (id) {
              post({ type: 'clearSecret', id });
            }
          }}
        >
          Forget the stored password
        </button>
      ) : null}
    </Field>
  );
}
