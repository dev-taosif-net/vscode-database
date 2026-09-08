/**
 * The shapes the whole extension agrees on. Nothing in here is persisted
 * verbatim: `ConnectionProfile` is stored without its secret, and the secret
 * lives in the VS Code secret store under `secretKey(profile.id)`.
 */

export type DriverKind = 'mssql' | 'postgres';

export type EnvironmentId = 'dev' | 'qa' | 'uat' | 'prod';

/** SQL Server authentication methods supported in phase 1. */
export type MssqlAuth =
  | 'sql'
  | 'entra-mfa'
  | 'ntlm';

/** PostgreSQL authentication methods supported in phase 1. */
export type PgAuth =
  | 'password'
  | 'certificate'
  | 'none';

/** SQL Server transport policy, mirroring the driver's Encrypt keyword. */
export type EncryptMode = 'strict' | 'mandatory' | 'optional';

/** PostgreSQL transport policy, mirroring libpq's sslmode. */
export type SslMode =
  | 'disable'
  | 'allow'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

/**
 * Where the credential for a profile is kept. `prompt` asks on every attempt
 * and stores nothing; there is no third value because "do not keep it" and
 * "ask every time" were two names for the same behaviour.
 */
export type CredentialStore = 'secret' | 'prompt';

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: DriverKind;
  environment: EnvironmentId;

  host: string;
  port: number | null;
  database: string;

  /** SQL Server only. */
  mssqlAuth: MssqlAuth;
  /** SQL Server only: the account id of a VS Code Microsoft session. */
  account: string;
  /** SQL Server only: Entra tenant, blank means the account's home tenant. */
  tenant: string;
  /** SQL Server only: NTLM domain. */
  domain: string;

  /** PostgreSQL only. */
  pgAuth: PgAuth;

  /** Login name for SQL logins, Entra password auth, NTLM, and PostgreSQL. */
  user: string;

  /** SQL Server transport. */
  encrypt: EncryptMode;
  trustServerCertificate: boolean;
  /** Expected certificate subject when it differs from `host`. */
  certificateHostname: string;

  /** PostgreSQL transport. */
  sslMode: SslMode;
  rootCertPath: string;
  clientCertPath: string;
  clientKeyPath: string;

  credentialStore: CredentialStore;
  /** Ask for the credential again when a stored one is rejected. */
  repromptOnReject: boolean;

  connectTimeoutSeconds: number;
  queryTimeoutSeconds: number;
  applicationName: string;
  rowsPerFetch: number;

  /** Open new sessions read-only. Defaults to true for `prod`. */
  readOnly: boolean;
  /** SQL Server only. */
  multiSubnetFailover: boolean;
  /** PostgreSQL only. */
  searchPath: string;

  /** Arbitrary driver keywords, applied last. */
  properties: Array<{ name: string; value: string }>;

  createdAt: number;
  updatedAt: number;
}

/** Everything the connection editor needs about a live session. */
export interface ConnectionInfo {
  profileId: string;
  serverVersion: string;
  principal: string;
  latencyMs: number;
  readOnly: boolean;
  connectedAt: number;
}

/**
 * A failure translated out of driver-speak. `title` says what happened,
 * `detail` says what it means here, and `actions` are the buttons the editor
 * offers. The safe action always comes first.
 */
export interface ConnectionFailure {
  kind: 'certificate' | 'login' | 'unreachable' | 'database' | 'cancelled' | 'unknown';
  title: string;
  detail: string;
  actions: FailureAction[];
  /** The driver's own message, kept for "Copy the driver error". */
  raw: string;
}

export type FailureActionId =
  | 'trustOnce'
  | 'openCertificateDocs'
  | 'clearCredential'
  | 'useDefaultDatabase'
  | 'retryLongerTimeout'
  | 'copyError';

export interface FailureAction {
  id: FailureActionId;
  label: string;
  /** Rendered in amber: it works, but it weakens the connection. */
  weakening?: boolean;
}

export interface EnvironmentMeta {
  id: EnvironmentId;
  /** The name used in a sentence. */
  label: string;
  /** The badge, and the only form short enough for a list row. */
  short: string;
  /** The name spelled out, for the banner. */
  full: string;
  /** One line naming the guard, so the banner never relies on its colour. */
  guard: string;
}

export const ENVIRONMENTS: ReadonlyArray<EnvironmentMeta> = [
  {
    id: 'dev',
    label: 'Development',
    short: 'DEV',
    full: 'Development',
    guard: 'Safe to experiment. No extra guards.'
  },
  {
    id: 'qa',
    label: 'QA',
    short: 'QA',
    full: 'Quality Assurance',
    guard: 'Confirmation required for destructive statements.'
  },
  {
    id: 'uat',
    label: 'UAT',
    short: 'UAT',
    full: 'User Acceptance Testing',
    guard: 'The same guard as QA, and query history is tracked.'
  },
  {
    id: 'prod',
    label: 'Production',
    short: 'PROD',
    full: 'Production',
    guard: 'Connecting asks for confirmation first.'
  }
];

export function environmentMeta(id: EnvironmentId): EnvironmentMeta {
  return ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0];
}

export function environmentLabel(id: EnvironmentId): string {
  return environmentMeta(id).label;
}

export function engineName(driver: DriverKind): string {
  return driver === 'mssql' ? 'Microsoft SQL Server' : 'PostgreSQL';
}

/** The message a thrown value carries, whatever it was. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line of a message, for a row or a strip with room for one. */
export function firstLine(text: string, fallback = 'The server did not answer.'): string {
  return text.split(/\r?\n/)[0].trim() || fallback;
}

export function defaultPort(driver: DriverKind): number {
  return driver === 'mssql' ? 1433 : 5432;
}

export function secretKey(profileId: string): string {
  return `databaseTools.secret.${profileId}`;
}

/** True when this profile's method needs a stored or prompted secret at all. */
export function needsSecret(profile: ConnectionProfile): boolean {
  if (profile.driver === 'mssql') {
    return profile.mssqlAuth === 'sql' || profile.mssqlAuth === 'ntlm';
  }
  return profile.pgAuth === 'password';
}

/**
 * True when the driver cannot log in without a user name.
 *
 * Entra signs in through the account provider, and a PostgreSQL `trust` or
 * `peer` login falls back to the operating system user, so neither requires
 * one. A PostgreSQL profile without a credential may still *carry* a role
 * name, which is why the editor shows the box as optional there rather than
 * hiding it.
 */
export function needsUser(profile: ConnectionProfile): boolean {
  if (profile.driver === 'mssql') {
    return profile.mssqlAuth !== 'entra-mfa';
  }
  return profile.pgAuth !== 'none';
}

export type TransportStrength = 'verified' | 'weakened' | 'off';

/**
 * How safe the transport actually is with the current settings. The editor
 * paints this teal, amber or red, and it is the reading behind the dot on the
 * Transport section.
 */
export function transportStrength(profile: ConnectionProfile): TransportStrength {
  if (profile.driver === 'mssql') {
    if (profile.encrypt === 'optional') {
      return 'weakened';
    }
    return profile.trustServerCertificate ? 'weakened' : 'verified';
  }
  switch (profile.sslMode) {
    case 'disable':
    case 'allow':
      return 'off';
    case 'prefer':
    case 'require':
      return 'weakened';
    default:
      return 'verified';
  }
}

export function transportLabel(profile: ConnectionProfile): string {
  if (profile.driver === 'mssql') {
    if (profile.trustServerCertificate) {
      return 'TLS unverified';
    }
    if (profile.encrypt === 'strict') {
      return 'TLS strict';
    }
    return profile.encrypt === 'mandatory' ? 'TLS required' : 'TLS optional';
  }
  return `SSL ${profile.sslMode}`;
}
