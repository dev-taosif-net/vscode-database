import { environmentMeta, transportLabel, transportStrength } from '../../types';
import { useSelect } from '../state/editor';
import { Codicon } from '../primitives/Codicon';

/**
 * The standing answer to "what am I about to connect to".
 *
 * It sits above the action bar and never scrolls away, so the environment and
 * the target are readable at the moment the decision is made rather than three
 * screens up.
 */
export function ConnectionSummary() {
  const draft = useSelect((state) => state.draft);
  if (!draft) {
    return null;
  }

  const meta = environmentMeta(draft.environment);
  const strength = transportStrength(draft);
  const port = draft.port ?? (draft.driver === 'mssql' ? 1433 : 5432);
  const authName =
    draft.driver === 'mssql'
      ? { sql: 'SQL Server login', 'entra-mfa': 'Microsoft Entra ID', ntlm: 'Windows NTLM' }[draft.mssqlAuth]
      : { password: 'SCRAM password', certificate: 'Client certificate', none: 'No credential' }[draft.pgAuth];

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
    { icon: 'symbol-enum', label: 'Environment', value: `${meta.short} · ${meta.full}`, tone: `env-${draft.environment}` },
    {
      icon: 'shield',
      label: 'Transport',
      value: transportLabel(draft),
      tone: strength === 'verified' ? 'ok' : strength === 'weakened' ? 'warn' : 'bad'
    }
  ];

  return (
    <section className="summary" aria-label="Connection summary">
      <h2 className="summary-title">
        <Codicon name="checklist" />
        Connection summary
      </h2>
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
