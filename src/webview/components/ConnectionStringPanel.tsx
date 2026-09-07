import { applyParsed, effective, isNew, isValid, useSelect, useUpdate } from '../state/editor';
import { defaultPortFor, parseConnectionString } from '../lib/connectionString';
import { ConnectionProfile } from '../../types';
import { Codicon } from '../primitives/Codicon';
import { Button } from '../primitives/Button';

/**
 * The other way of describing a connection.
 *
 * A string that parses is part of the draft, so the action bar at the foot of
 * the page works from the paste box exactly as it works from the fields: paste
 * one and press Connect. Parse stays for the other case, where the reading
 * wants checking or correcting before anything is done with it, and hands the
 * editor back to the fields to do that in.
 *
 * Acting on a string without ever seeing the fields is only safe if the string
 * has been read back, so the card below states what was understood. It states
 * it by running the same transition the buttons commit, which is why the
 * reading cannot drift from the deed.
 */
export function ConnectionStringPanel() {
  const update = useUpdate();
  const text = useSelect((state) => state.parseText);
  const report = useSelect((state) => state.parseReport);
  const fresh = useSelect(isNew);
  const resolved = useSelect((state) => effective(state).draft);
  const ready = useSelect((state) => isValid(effective(state)));

  const parsed = parseConnectionString(text);

  const parse = () => {
    if (!parsed) {
      update((state) => ({
        ...state,
        parseReport: {
          ok: false,
          text:
            'That does not read as a SQL Server or PostgreSQL connection string. Expected keys such as Server= and Initial Catalog=, or a postgresql:// address.'
        }
      }));
      return;
    }
    update((state) => applyParsed(state, parsed, 'fields'));
  };

  return (
    <div className="stack">
      <label className="label" htmlFor="f-parse">
        Paste a connection string
      </label>
      <textarea
        id="f-parse"
        className="mono"
        rows={4}
        spellCheck={false}
        value={text}
        placeholder={
          'Server=sql-dev-01.company.local,1433;Database=AdventureWorks;User Id=app;Password=…\npostgresql://app@db.example.com:5432/billing?sslmode=verify-full'
        }
        onChange={(event) => {
          const next = event.target.value;
          update((state) => ({ ...state, parseText: next }));
        }}
      />

      <div className="row">
        <Button
          tone="primary"
          icon="wand"
          disabled={!text.trim()}
          title="Lays the string over the fields and hands the editor back to them"
          onClick={parse}
        >
          Parse
        </Button>
        {text ? (
          <Button
            tone="ghost"
            onClick={() => update((state) => ({ ...state, parseText: '', parseReport: null }))}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {report && !report.ok ? (
        <p className="note warn" role="alert">
          <Codicon name="warning" className="glyph" />
          <span>{report.text}</span>
        </p>
      ) : null}

      {!parsed && text.trim() && !(report && !report.ok) ? (
        <p className="hint">
          Nothing recognised in this yet. Keys such as Server= and Database=, or a postgresql:// address.
        </p>
      ) : null}

      {parsed && resolved ? (
        <Reading
          engine={parsed.engine}
          hasSecret={parsed.secret !== undefined}
          kept={parsed.properties.map((property) => property.name)}
          resolved={resolved}
          savedAs={fresh ? resolved.name : null}
          ready={ready}
        />
      ) : null}
    </div>
  );
}

interface ReadingProps {
  engine: string;
  hasSecret: boolean;
  kept: string[];
  /** The draft as it stands once the string is laid over it. */
  resolved: ConnectionProfile;
  /** The name a new connection would take, or null when it is already stored. */
  savedAs: string | null;
  ready: boolean;
}

/**
 * What the string was understood to mean. It carries no buttons of its own:
 * the ones at the foot of the page already do these three things, and a second
 * set of them would only raise the question of how the two differ.
 */
function Reading({ engine, hasSecret, kept, resolved, savedAs, ready }: ReadingProps) {
  const port = resolved.port ?? defaultPortFor(resolved.driver);
  const authName =
    resolved.driver === 'mssql'
      ? { sql: 'SQL Server login', 'entra-mfa': 'Microsoft Entra ID', ntlm: 'Windows NTLM' }[resolved.mssqlAuth]
      : { password: 'SCRAM password', certificate: 'Client certificate', none: 'No credential' }[resolved.pgAuth];

  const facts: { icon: string; label: string; value: string; tone?: string }[] = [
    {
      icon: 'server',
      label: 'Server',
      value: resolved.host ? `${resolved.host}:${port}` : 'Not named in the string',
      tone: resolved.host ? undefined : 'bad'
    },
    { icon: 'database', label: 'Database', value: resolved.database || "The login's default" },
    {
      icon: 'account',
      label: 'Sign in',
      value: resolved.user ? `${authName} (${resolved.user})` : authName
    },
    {
      // Whether there is a password, never the password: a credential read
      // back out of a card is a credential on a screen share.
      icon: 'key',
      label: 'Password',
      value: hasSecret ? 'Carried by the string' : 'Not in the string'
    }
  ];

  return (
    <section className="parsed" aria-label="What the connection string was read as">
      <header className="parsed-head">
        <Codicon name="pass-filled" className="glyph" />
        <span>
          Read as a <strong>{engine}</strong> connection
        </span>
      </header>

      <dl className="parsed-facts">
        {facts.map((fact) => (
          <div key={fact.label} className={fact.tone ? `parsed-fact ${fact.tone}` : 'parsed-fact'}>
            <dt>
              <Codicon name={fact.icon} className="parsed-icon" />
              {fact.label}
            </dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {kept.length ? <p className="hint">Kept as driver properties: {kept.join(', ')}.</p> : null}

      {ready ? (
        <p className="hint">
          Test connection, Save and Connect below act on this reading and fill the fields with it.
          {savedAs ? ` It goes into the list as ${savedAs}.` : ''}
        </p>
      ) : (
        <p className="note warn" role="alert">
          <Codicon name="warning" className="glyph" />
          <span>
            The string names no server, so there is nothing here to connect to. Parse it and fill the
            server in on the fields.
          </span>
        </p>
      )}
    </section>
  );
}
