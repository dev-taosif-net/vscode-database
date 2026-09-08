import { defaultPort, environmentMeta, transportLabel, transportStrength } from '../../types';
import { AppState, Problem, effective, problems, useSelect } from '../state/editor';
import { Codicon } from '../primitives/Codicon';

const AUTH_NAMES = {
  sql: 'SQL Server login',
  'entra-mfa': 'Microsoft Entra ID',
  ntlm: 'Windows NTLM',
  password: 'SCRAM password',
  certificate: 'Client certificate',
  none: 'No credential'
} as const;

interface Item {
  icon: string;
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
  /** True when the value is a gap rather than a fact, so it is read as one. */
  missing?: boolean;
}

/**
 * The standing answer to "what am I about to connect to", and to "what is
 * still missing".
 *
 * It sits above the action bar and never scrolls away, so the environment,
 * the target and every gap in it are readable at the moment the decision is
 * made rather than three screens up. A missing server does not say "Not set
 * yet" in the same grey as a fact: it says "Missing" with a warning mark, in
 * the warning colour, so the reason Connect is unavailable is on screen
 * beside the button that is.
 *
 * The environment leads it, in the loud treatment the banner used to carry at
 * the top of the page. Colour alone would fail a monochrome screen and a good
 * share of readers, so the reading is still repeated three ways: the badge
 * text, the spelled-out name, and the guard in force.
 */
export function ConnectionSummary() {
  // The draft the action bar directly below would act on, which is the fields
  // with any pasted string laid over them. A strip that answers "what am I
  // about to connect to" has to answer it about the press that follows it.
  const state = useSelect(effective);
  const draft = state.draft;
  if (!draft) {
    return null;
  }

  const gaps = problems(state);
  const meta = environmentMeta(draft.environment);
  const production = draft.environment === 'prod';
  const strength = transportStrength(draft);
  const port = draft.port ?? defaultPort(draft.driver);
  const authName = draft.driver === 'mssql' ? AUTH_NAMES[draft.mssqlAuth] : AUTH_NAMES[draft.pgAuth];

  const items: Item[] = [
    serverItem(draft.host, port, gaps),
    { icon: 'database', label: 'Database', value: draft.database || "The login's default" },
    authItem(authName, draft.user, gaps),
    {
      icon: 'shield',
      label: 'Transport',
      value: transportLabel(draft),
      tone: strength === 'verified' ? 'ok' : strength === 'weakened' ? 'warn' : 'bad'
    }
  ];

  return (
    <section className={`summary env-${draft.environment}`} aria-label="Connection summary">
      <div className="summary-env" role="status" aria-live="polite">
        <span className="env-mark" aria-hidden="true">
          <Codicon name={production ? 'shield' : 'circle-filled'} />
        </span>
        <h2 className="env-names">
          <span className="env-short">{meta.short}</span>
          <span className="env-full">{meta.full}</span>
        </h2>
        <span className="env-rule" aria-hidden="true" />
        <p className="env-guard">{meta.guard}</p>
      </div>

      <dl>
        {items.map((item) => (
          <div key={item.label} className={item.tone ? `summary-item ${item.tone}` : 'summary-item'}>
            <Codicon name={item.missing ? 'warning' : item.icon} className="summary-icon" />
            <div>
              <dt>{item.label}</dt>
              <dd title={item.value}>{item.value}</dd>
            </div>
          </div>
        ))}
      </dl>
      <MissingNote state={state} />
    </section>
  );
}

function serverItem(host: string, port: number, gaps: Problem[]): Item {
  if (gaps.some((gap) => gap.field === 'host')) {
    return { icon: 'server', label: 'Server', value: 'Missing', tone: 'warn', missing: true };
  }
  if (gaps.some((gap) => gap.field === 'port')) {
    return { icon: 'server', label: 'Server', value: `${host} · invalid port`, tone: 'warn', missing: true };
  }
  return { icon: 'server', label: 'Server', value: `${host}:${port}` };
}

function authItem(authName: string, user: string, gaps: Problem[]): Item {
  const missing = gaps.filter((gap) => ['user', 'password', 'clientCertPath', 'clientKeyPath'].includes(gap.field));
  if (missing.length === 0) {
    return { icon: 'account', label: 'Authentication', value: user ? `${authName} (${user})` : authName };
  }
  const what = missing
    .map((gap) =>
      gap.field === 'user'
        ? 'user name'
        : gap.field === 'password'
          ? 'password'
          : gap.field === 'clientCertPath'
            ? 'certificate'
            : 'key'
    )
    .join(', ');
  return { icon: 'account', label: 'Authentication', value: `${authName} · ${what} missing`, tone: 'warn', missing: true };
}

/**
 * The gaps as one sentence, for a screen reader and for a pane too narrow to
 * show four facts at once. Polite, because it changes as the user types and
 * an assertive region would talk over every keystroke.
 */
function MissingNote({ state }: { state: AppState }) {
  const gaps = problems(state);
  if (gaps.length === 0) {
    return null;
  }
  const text = gaps.map((gap) => gap.message).join('. ');
  return (
    <p className="summary-missing" aria-live="polite">
      {text}.
    </p>
  );
}
