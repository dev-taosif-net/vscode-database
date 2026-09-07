import { environmentMeta, transportLabel, transportStrength } from '../../types';
import { useSelect } from '../state/editor';
import { Codicon } from '../primitives/Codicon';

/**
 * The standing answer to "what am I about to connect to".
 *
 * It sits above the action bar and never scrolls away, so the environment and
 * the target are readable at the moment the decision is made rather than three
 * screens up.
 *
 * The environment leads it, in the loud treatment the banner used to carry at
 * the top of the page. Saying it twice, once under the header and once here,
 * only taught the eye to skip both; said once, in the strip the decision is
 * actually made in, it is read. Colour alone would fail a monochrome screen
 * and a good share of readers, so the reading is still repeated three ways:
 * the badge text, the spelled-out name, and the guard in force.
 *
 * The environment and the facts share one row. Two stacked rows cost height
 * the details column needs more, and the eye reads a single line left to
 * right without having to find where the second one starts.
 */
export function ConnectionSummary() {
  const draft = useSelect((state) => state.draft);
  if (!draft) {
    return null;
  }

  const meta = environmentMeta(draft.environment);
  const production = draft.environment === 'prod';
  const strength = transportStrength(draft);
  const port = draft.port ?? (draft.driver === 'mssql' ? 1433 : 5432);
  const authName =
    draft.driver === 'mssql'
      ? { sql: 'SQL Server login', 'entra-mfa': 'Microsoft Entra ID', ntlm: 'Windows NTLM' }[draft.mssqlAuth]
      : { password: 'SCRAM password', certificate: 'Client certificate', none: 'No credential' }[draft.pgAuth];

  // The environment is stated by the head above and is deliberately not
  // repeated as a fact here.
  const items: { icon: string; label: string; value: string; tone?: string }[] = [
    {
      icon: 'server',
      label: 'Server',
      value: draft.host ? `${draft.host}:${port}` : 'Not set yet'
    },
    { icon: 'database', label: 'Database', value: draft.database || "The login's default" },
    {
      icon: 'account',
      label: 'Authentication',
      value: draft.user ? `${authName} (${draft.user})` : authName
    },
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
            <Codicon name={item.icon} className="summary-icon" />
            <div>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
