import { MssqlAuth, PgAuth, needsSecret, needsUser } from '../../types';
import { passwordMissing, touch, useProblem, useSelect, useStore, useUpdate } from '../state/editor';
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
 *
 * Which fields are required follows the drivers, not a guess: see `problems`
 * in `state/editor.ts`, which is the one place that rule is written down.
 */
export function AuthSection() {
  const driver = useSelect((state) => state.draft?.driver);
  const mssqlAuth = useSelect((state) => state.draft?.mssqlAuth);
  const pgAuth = useSelect((state) => state.draft?.pgAuth);
  const userRequired = useSelect((state) => Boolean(state.draft && needsUser(state.draft)));
  const secretUsed = useSelect((state) => Boolean(state.draft && needsSecret(state.draft)));
  const userProblem = useProblem('user');
  const certProblem = useProblem('clientCertPath');
  const keyProblem = useProblem('clientKeyPath');
  if (!driver) {
    return null;
  }
  const isMssql = driver === 'mssql';

  return (
    <div className="stack">
      <Field label="Method" htmlFor={isMssql ? 'f-auth' : 'f-pgauth'} required>
        {isMssql ? (
          <SelectInput id="f-auth" field="mssqlAuth" options={MSSQL_METHODS} />
        ) : (
          <SelectInput id="f-pgauth" field="pgAuth" options={PG_METHODS} />
        )}
      </Field>

      {isMssql && mssqlAuth === 'entra-mfa' ? <EntraFields /> : null}

      {isMssql && mssqlAuth === 'ntlm' ? (
        <Field
          label="Domain"
          htmlFor="f-domain"
          hint="Optional. Blank uses the server's own DNS domain."
        >
          <TextInput id="f-domain" field="domain" placeholder="NORTHWIND" />
        </Field>
      ) : null}

      {isMssql && mssqlAuth === 'entra-mfa' ? null : (
        <Field
          label="User name"
          htmlFor="f-user"
          required={userRequired}
          error={userProblem}
          hint={userRequired ? undefined : 'Optional. Blank uses your operating system user name.'}
        >
          <TextInput id="f-user" field="user" invalid={Boolean(userProblem)} />
        </Field>
      )}

      {secretUsed ? <PasswordField /> : null}

      {!isMssql && pgAuth === 'certificate' ? (
        <>
          <Field label="Client certificate" htmlFor="f-sslcert" required error={certProblem}>
            <TextInput
              id="f-sslcert"
              field="clientCertPath"
              mono
              placeholder="~/.postgresql/postgresql.crt"
              invalid={Boolean(certProblem)}
            />
          </Field>
          <Field
            label="Client key"
            htmlFor="f-sslkey"
            required
            error={keyProblem}
            hint="The key never leaves this machine."
          >
            <TextInput
              id="f-sslkey"
              field="clientKeyPath"
              mono
              placeholder="~/.postgresql/postgresql.key"
              invalid={Boolean(keyProblem)}
            />
          </Field>
        </>
      ) : null}

      {!isMssql && pgAuth === 'none' ? (
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
        hint="Optional. Blank uses the account's home tenant."
      >
        <TextInput id="f-tenant" field="tenant" placeholder="contoso.onmicrosoft.com" />
      </Field>
      <Field label="Account" htmlFor="f-account" hint="Optional. Blank lets VS Code choose the account when you connect.">
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

/**
 * The password box, and the one reading a box cannot carry on its own: whether
 * a session needs a password from here at all. A profile that asks every time
 * will ask; a profile that keeps its password in the keychain, and has one
 * there, needs nothing typed; only the third case is required.
 */
function PasswordField() {
  const store = useStore();
  const update = useUpdate();
  const secret = useSelect((state) => state.secret);
  const reveal = useSelect((state) => state.revealSecret);
  const stored = useSelect((state) => Boolean(state.draft && state.host.hasSecret[state.draft.id]));
  const keeps = useSelect((state) => state.draft?.credentialStore === 'secret');
  const required = useSelect(passwordMissing);
  const problem = useProblem('password');

  const hint = problem
    ? undefined
    : !keeps
      ? 'Asked for each time you connect, and never stored.'
      : stored && secret === undefined
        ? 'A password is stored in the keychain. Type here to replace it.'
        : 'Kept in the VS Code secret store, which is the operating system keychain.';

  return (
    <Field label="Password" htmlFor="f-password" required={required} error={problem} hint={hint}>
      <div className="row">
        <input
          id="f-password"
          type={reveal ? 'text' : 'password'}
          value={secret ?? ''}
          autoComplete="off"
          aria-required={required || undefined}
          aria-invalid={Boolean(problem) || undefined}
          aria-describedby="f-password-hint"
          placeholder={stored && secret === undefined ? '••••••••' : undefined}
          onChange={(event) => {
            const next = event.target.value;
            // An empty box is untouched, not "forget the stored one". Undefined
            // is the value that never travels, and the box ends up empty either
            // way, so nothing on screen moves. Clearing a stored password on
            // purpose is the button underneath, which says what it does.
            update((state) => ({ ...state, secret: next === '' ? undefined : next }));
          }}
          onBlur={() => update((state) => touch(state, 'password'))}
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
