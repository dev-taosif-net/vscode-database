import * as vscode from 'vscode';
import {
  ConnectionProfile,
  DriverKind,
  EnvironmentId,
  defaultPort,
  needsSecret,
  secretKey
} from '../types';

const PROFILES_KEY = 'databaseTools.profiles.v1';

/**
 * Owns the connection list and the credentials that go with it.
 *
 * Profiles live in `globalState`, which is per-user and never written into a
 * workspace file. Credentials live in the VS Code secret store, which is the
 * operating system keychain. Nothing secret is written to settings.json or to
 * any file in the workspace, and deleting a profile deletes its secret in the
 * same step so no orphan is left behind.
 */
export class ConnectionStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private profiles: ConnectionProfile[];

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
    this.profiles = stored.map((p) => normalise(p));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  all(): ConnectionProfile[] {
    return this.profiles.slice();
  }

  get(id: string): ConnectionProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  async create(seed: Partial<ConnectionProfile> = {}): Promise<ConnectionProfile> {
    const profile = blankProfile(seed);
    this.profiles = [...this.profiles, profile];
    await this.flush();
    return profile;
  }

  /**
   * Replaces a profile. `patch` carries only what the editor changed, so a
   * field the editor does not know about survives a round trip untouched.
   */
  async update(id: string, patch: Partial<ConnectionProfile>): Promise<ConnectionProfile> {
    const index = this.profiles.findIndex((p) => p.id === id);
    if (index < 0) {
      throw new Error(`No connection with id ${id}`);
    }
    const next = normalise({ ...this.profiles[index], ...patch, id, updatedAt: Date.now() });
    this.profiles = this.profiles.map((p, i) => (i === index ? next : p));
    await this.flush();
    return next;
  }

  async duplicate(id: string): Promise<ConnectionProfile | undefined> {
    const source = this.get(id);
    if (!source) {
      return undefined;
    }
    // The copy deliberately does not inherit the secret. A duplicated profile
    // is usually pointed somewhere else, and silently carrying a credential
    // across would be a surprise.
    const copy = blankProfile({
      ...source,
      name: uniqueName(this.profiles, `${source.name} copy`)
    });
    this.profiles = [...this.profiles, copy];
    await this.flush();
    return copy;
  }

  async remove(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.context.secrets.delete(secretKey(id));
    await this.flush();
  }

  /** The stored secret, or undefined when there is none to read. */
  async readSecret(profile: ConnectionProfile): Promise<string | undefined> {
    if (!needsSecret(profile) || profile.credentialStore !== 'secret') {
      return undefined;
    }
    return this.context.secrets.get(secretKey(profile.id));
  }

  async writeSecret(profileId: string, secret: string | undefined): Promise<void> {
    if (secret === undefined || secret === '') {
      await this.context.secrets.delete(secretKey(profileId));
      return;
    }
    await this.context.secrets.store(secretKey(profileId), secret);
  }

  async hasSecret(profileId: string): Promise<boolean> {
    return (await this.context.secrets.get(secretKey(profileId))) !== undefined;
  }

  /** True when a name is free, ignoring one profile (the one being renamed). */
  isNameFree(name: string, exceptId?: string): boolean {
    const wanted = name.trim().toLowerCase();
    return !this.profiles.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === wanted);
  }

  private async flush(): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, this.profiles);
    this.onDidChangeEmitter.fire();
  }
}

function uniqueName(existing: ConnectionProfile[], base: string): string {
  const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) {
    return base;
  }
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.trim().toLowerCase())) {
      return candidate;
    }
  }
  return `${base} ${Date.now()}`;
}

export function blankProfile(seed: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const driver: DriverKind = seed.driver ?? 'mssql';
  const environment: EnvironmentId = seed.environment ?? 'dev';
  const config = vscode.workspace.getConfiguration('databaseTools');
  const now = Date.now();

  return normalise({
    id: randomId(),
    name: seed.name ?? '',
    driver,
    environment,
    host: seed.host ?? '',
    port: seed.port === undefined ? defaultPort(driver) : seed.port,
    database: seed.database ?? '',
    mssqlAuth: seed.mssqlAuth ?? 'entra-mfa',
    account: seed.account ?? '',
    tenant: seed.tenant ?? '',
    domain: seed.domain ?? '',
    pgAuth: seed.pgAuth ?? 'password',
    user: seed.user ?? '',
    encrypt: seed.encrypt ?? 'mandatory',
    trustServerCertificate: seed.trustServerCertificate ?? false,
    certificateHostname: seed.certificateHostname ?? '',
    sslMode: seed.sslMode ?? 'verify-full',
    rootCertPath: seed.rootCertPath ?? '',
    clientCertPath: seed.clientCertPath ?? '',
    clientKeyPath: seed.clientKeyPath ?? '',
    // Production keeps nothing on disk by default, so an unattended laptop
    // cannot open a live session on its own.
    credentialStore: seed.credentialStore ?? (environment === 'prod' ? 'prompt' : 'secret'),
    repromptOnReject: seed.repromptOnReject ?? true,
    sshEnabled: seed.sshEnabled ?? false,
    sshHost: seed.sshHost ?? '',
    sshPort: seed.sshPort ?? 22,
    sshUser: seed.sshUser ?? '',
    sshKeyPath: seed.sshKeyPath ?? '',
    connectTimeoutSeconds: seed.connectTimeoutSeconds ?? config.get<number>('connectTimeout', 15),
    queryTimeoutSeconds: seed.queryTimeoutSeconds ?? 30,
    applicationName: seed.applicationName ?? 'VS Code Database Tools',
    rowsPerFetch: seed.rowsPerFetch ?? config.get<number>('rowsPerFetch', 1000),
    readOnly: seed.readOnly ?? environment === 'prod',
    multipleActiveResultSets: seed.multipleActiveResultSets ?? false,
    multiSubnetFailover: seed.multiSubnetFailover ?? false,
    searchPath: seed.searchPath ?? 'public',
    properties: seed.properties ?? [],
    createdAt: seed.createdAt ?? now,
    updatedAt: now
  });
}

/**
 * Brings a profile up to the current shape. Older stored profiles, and patches
 * arriving from the webview, both pass through here, so every consumer can
 * assume the fields exist and the numbers are numbers.
 */
function normalise(input: ConnectionProfile): ConnectionProfile {
  const driver: DriverKind = input.driver === 'postgres' ? 'postgres' : 'mssql';
  const port = coercePort(input.port);
  return {
    ...input,
    driver,
    environment: coerceEnvironment(input.environment),
    name: (input.name ?? '').toString(),
    host: (input.host ?? '').toString().trim(),
    port,
    database: (input.database ?? '').toString().trim(),
    user: (input.user ?? '').toString().trim(),
    properties: Array.isArray(input.properties)
      ? input.properties
          .filter((p) => p && typeof p.name === 'string' && p.name.trim() !== '')
          .map((p) => ({ name: p.name.trim(), value: (p.value ?? '').toString() }))
      : [],
    connectTimeoutSeconds: clamp(input.connectTimeoutSeconds, 1, 600, 15),
    queryTimeoutSeconds: clamp(input.queryTimeoutSeconds, 0, 86400, 30),
    rowsPerFetch: clamp(input.rowsPerFetch, 50, 100000, 1000),
    sshPort: input.sshEnabled ? coercePort(input.sshPort) ?? 22 : input.sshPort ?? 22
  };
}

function coercePort(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

function coerceEnvironment(value: unknown): EnvironmentId {
  return value === 'qa' || value === 'uat' || value === 'prod' ? value : 'dev';
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function randomId(): string {
  // Enough entropy to key a secret store entry, without pulling in a uuid dep.
  const bytes = new Uint8Array(12);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
