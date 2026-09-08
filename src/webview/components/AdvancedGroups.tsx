import { ReactNode } from 'react';
import { EncryptMode, SslMode, transportLabel, transportStrength } from '../../types';
import { AdvancedGroupId, toggleGroup, useField, useSelect, useUpdate } from '../state/editor';
import { Codicon } from '../primitives/Codicon';
import { Disclosure } from '../primitives/Disclosure';
import { Field } from '../primitives/Field';
import { Checkbox, NumberInput, SelectInput, TextInput } from '../primitives/Inputs';
import { PropertiesTable } from './PropertiesTable';

const ENCRYPT_HINT: Record<EncryptMode, string> = {
  strict:
    'The channel is encrypted before the login packet leaves the machine and the certificate must validate. Needs SQL Server 2022 or Azure SQL.',
  mandatory:
    'The connection is refused when the server cannot encrypt. The driver default, and the right choice almost everywhere.',
  optional:
    'Falls back to an unencrypted channel when the server does not offer encryption. Reasonable only on a loopback host.'
};

const SSL_HINT: Record<SslMode, string> = {
  disable: 'No encryption at all. Reasonable only on a loopback host.',
  allow: 'Tries plain text first and only encrypts if the server insists. Offers no real protection.',
  prefer: 'Encrypts when it can and silently falls back when it cannot. The libpq default, and weaker than it looks.',
  require: 'Always encrypts, but never checks who the server is. Stops passive sniffing, not interception.',
  'verify-ca': 'Encrypts and checks that the certificate came from a trusted authority.',
  'verify-full':
    'Encrypts, checks the issuer, and checks the host name against the certificate. Use this anywhere but a development machine.'
};

/**
 * The settings that have a working default, in five named groups rather than
 * one heap. A closed group builds nothing: its body is a function the
 * disclosure only calls once it is open.
 */
export function AdvancedGroups() {
  // Only the four readings the headers themselves draw. Holding the whole
  // draft here rebuilt all five groups, and the body of every open one, on
  // every keystroke anywhere in the form — the badges are the only part of
  // this that a field can change, and three of the five have no badge at all.
  const driver = useField('driver');
  const readOnly = useField('readOnly');
  const propertyCount = useSelect((state) => state.draft?.properties.length ?? 0);
  // Two readings rather than the profile they are read from: both are plain
  // values, so an edit that leaves the transport alone stops here.
  const strength = useSelect((state) => (state.draft ? transportStrength(state.draft) : null));
  const label = useSelect((state) => (state.draft ? transportLabel(state.draft) : ''));
  const open = useSelect((state) => state.advanced);
  const update = useUpdate();
  if (driver === undefined || strength === null) {
    return null;
  }

  const isMssql = driver === 'mssql';
  const toggle = (group: AdvancedGroupId) => () => update((state) => toggleGroup(state, group));

  const groups: {
    id: AdvancedGroupId;
    icon: string;
    title: string;
    summary: string;
    badge?: ReactNode;
    body: () => ReactNode;
  }[] = [
    {
      id: 'transport',
      icon: 'shield',
      title: 'Transport',
      summary: 'Encryption and certificate checking',
      badge: (
        <span className={`chip ${strength === 'verified' ? 'ok' : strength === 'weakened' ? 'warn' : 'bad'}`}>
          {label}
        </span>
      ),
      body: () => (isMssql ? <MssqlTransport /> : <PostgresTransport />)
    },
    {
      id: 'network',
      icon: 'globe',
      title: 'Network',
      summary: 'Connect timeout and failover',
      body: () => <NetworkGroup mssql={isMssql} />
    },
    {
      id: 'security',
      icon: 'lock',
      title: 'Security',
      summary: 'Where the credential lives and what a session may do',
      badge: readOnly ? <span className="chip ok">Read-only</span> : undefined,
      body: () => <SecurityGroup />
    },
    {
      id: 'session',
      icon: 'watch',
      title: 'Session',
      summary: isMssql ? 'Query timeout, paging and the name the server sees' : 'Query timeout, paging, search path and the name the server sees',
      body: () => <SessionGroup mssql={isMssql} />
    },
    {
      id: 'driver',
      icon: 'settings-gear',
      title: 'Driver',
      summary: 'Anything the driver accepts that has no field here',
      badge: propertyCount ? <span className="chip">{propertyCount}</span> : undefined,
      body: () => <PropertiesTable />
    }
  ];

  return (
    <div className="groups">
      {groups.map((group) => (
        <Disclosure
          key={group.id}
          id={group.id}
          icon={group.icon}
          title={group.title}
          summary={group.summary}
          badge={group.badge}
          open={open[group.id]}
          onToggle={toggle(group.id)}
        >
          {group.body}
        </Disclosure>
      ))}
    </div>
  );
}

function MssqlTransport() {
  const encrypt = (useSelect((state) => state.draft?.encrypt) ?? 'mandatory') as EncryptMode;
  const trust = useSelect((state) => state.draft?.trustServerCertificate ?? false);

  return (
    <div className="stack">
      <Field label="Encrypt" htmlFor="f-encrypt" hint={ENCRYPT_HINT[encrypt]}>
        <SelectInput
          id="f-encrypt"
          field="encrypt"
          options={[
            ['strict', 'Strict, TDS 8.0'],
            ['mandatory', 'Mandatory, encrypt or fail'],
            ['optional', 'Optional, encrypt only if offered']
          ]}
        />
      </Field>
      <Field
        label="Name in certificate"
        htmlFor="f-certhost"
        hint="Set this when the certificate was issued for a listener or an alias."
      >
        <TextInput id="f-certhost" field="certificateHostname" placeholder="Same as the server address" />
      </Field>
      <Checkbox
        id="f-trust"
        field="trustServerCertificate"
        label="Trust the server certificate without validating it"
      />
      {trust ? (
        <p className="note warn">
          <Codicon name="warning" className="glyph" />
          <span>
            Traffic stays encrypted, but the server's identity is no longer checked, so the connection is
            open to interception on the way. Add the issuing authority to the machine trust store instead
            wherever you can.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function PostgresTransport() {
  const mode = (useSelect((state) => state.draft?.sslMode) ?? 'verify-full') as SslMode;

  return (
    <div className="stack">
      <Field label="SSL mode" htmlFor="f-sslmode" hint={SSL_HINT[mode]}>
        <SelectInput
          id="f-sslmode"
          field="sslMode"
          options={[
            ['disable', 'disable'],
            ['allow', 'allow'],
            ['prefer', 'prefer'],
            ['require', 'require'],
            ['verify-ca', 'verify-ca'],
            ['verify-full', 'verify-full']
          ]}
        />
      </Field>
      <Field
        label="Root certificate"
        htmlFor="f-rootcert"
        hint='Blank falls back to ~/.postgresql/root.crt, the libpq default. Type "system" to use the machine trust store instead.'
      >
        <TextInput id="f-rootcert" field="rootCertPath" mono placeholder="~/.postgresql/root.crt" />
      </Field>
    </div>
  );
}

function NetworkGroup({ mssql }: { mssql: boolean }) {
  return (
    <div className="stack">
      <Field label="Connect timeout" htmlFor="f-connect-timeout" hint="How long to wait for the server to answer.">
        <div className="row tight">
          <NumberInput id="f-connect-timeout" field="connectTimeoutSeconds" width={92} />
          <span className="unit">seconds</span>
        </div>
      </Field>
      {mssql ? (
        <Checkbox
          id="f-msf"
          field="multiSubnetFailover"
          label="Multi-subnet failover"
          hint="For an availability group listener spanning subnets."
        />
      ) : null}
    </div>
  );
}

function SecurityGroup() {
  return (
    <div className="stack">
      <Field
        label="Keep the credential"
        htmlFor="f-credstore"
        hint="Production connections default to asking every time, so an unattended laptop cannot open a live session on its own."
      >
        <SelectInput
          id="f-credstore"
          field="credentialStore"
          options={[
            ['secret', 'In the VS Code secret store, the OS keychain'],
            ['prompt', 'Ask me every time I connect']
          ]}
        />
      </Field>
      <Checkbox
        id="f-reprompt"
        field="repromptOnReject"
        label="Ask again when a stored credential is rejected"
        hint="The rejected password is forgotten and you are asked for a new one on the same attempt."
      />
      <Checkbox
        id="f-readonly"
        field="readOnly"
        label="Open new sessions read-only"
        hint="PostgreSQL holds this at the session; SQL Server has no equivalent, so it is applied by the query gate."
      />
    </div>
  );
}

function SessionGroup({ mssql }: { mssql: boolean }) {
  return (
    <div className="stack">
      <Field label="Query timeout" htmlFor="f-query-timeout" hint="Zero lets a query run without a limit.">
        <div className="row tight">
          <NumberInput id="f-query-timeout" field="queryTimeoutSeconds" width={92} />
          <span className="unit">seconds</span>
        </div>
      </Field>
      <Field label="Rows per fetch" htmlFor="f-rows" hint="Raising it costs memory on wide tables.">
        <div className="row tight">
          <NumberInput id="f-rows" field="rowsPerFetch" width={92} />
          <span className="unit">rows</span>
        </div>
      </Field>
      <Field
        label="Application name"
        htmlFor="f-appname"
        hint="Sent to the server so a database administrator can tell these sessions apart."
      >
        <TextInput id="f-appname" field="applicationName" />
      </Field>
      {mssql ? null : (
        <Field label="Schema search path" htmlFor="f-searchpath" hint="Sent with the first statement of every session.">
          <TextInput id="f-searchpath" field="searchPath" mono />
        </Field>
      )}
    </div>
  );
}
