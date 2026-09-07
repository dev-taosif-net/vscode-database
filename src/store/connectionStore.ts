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
const FAVOURITES_KEY = 'databaseTools.favourites.v1';

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

  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Whether each profile has a stored credential, once it has been asked.
   *
   * `hasSecret` is a boolean, but reading it is not cheap: every call is a
   * round trip to the keychain that fetches and decrypts the whole password
   * only to compare it against undefined. The editor asks for the whole list
   * on every redraw, so an uncached answer put one keychain read per
   * connection in front of the first paint and repeated the set on every state
   * post after it.
   *
   * The cache is exact rather than best-effort: every write in the extension
   * goes through `writeSecret` or `remove`, both of which set the entry
   * themselves, and `onDidChange` drops entries for anything written by
   * another window. So a hit is as true as the read it replaces.
   */
  private readonly secretPresence = new Map<string, boolean>();
  /** Reads already in the air, so a burst of callers shares one round trip. */
  private readonly presenceReads = new Map<string, Promise<boolean>>();

  private profiles: ConnectionProfile[];
  /**
   * Pinned ids, kept beside the profiles rather than inside them. A pin is a
   * reading of the list, not a property of the connection, and keeping it out
   * of the profile means pinning never rewrites `updatedAt` and never shows up
   * as a change the editor would offer to save.
   */
  private pinned: Set<string>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
    this.profiles = stored.map((p) => normalise(p));
    const favourites = context.globalState.get<string[]>(FAVOURITES_KEY, []);
    // A pin can outlive the profile it points at if a delete failed halfway,
    // so the set is filtered on the way in rather than trusted.
    const known = new Set(this.profiles.map((p) => p.id));
    this.pinned = new Set(favourites.filter((id) => known.has(id)));

    // A credential written in another window is written to the same keychain,
    // so the cached answer for it has to be dropped rather than trusted.
    this.disposables.push(
      context.secrets.onDidChange((event) => {
        for (const profile of this.profiles) {
          if (secretKey(profile.id) === event.key) {
            this.secretPresence.delete(profile.id);
            this.onDidChangeEmitter.fire();
            return;
          }
        }
      })
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
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
    // A fresh id has never been a keychain key, so this is known without asking.
    this.secretPresence.set(profile.id, false);
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
    this.secretPresence.set(copy.id, false);
    await this.flush();
    return copy;
  }

  async remove(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.pinned.delete(id);
    this.secretPresence.delete(id);
    this.presenceReads.delete(id);

    // The list is written first. A keychain that refuses the delete used to
    // take the removal down with it: the profile was already gone from memory,
    // the throw skipped both flushes, and the next window read the old list
    // back out of `globalState` and the connection returned from the dead. The
    // orphaned credential is the smaller failure of the two, and it is
    // recoverable — deleting the profile again clears it.
    await this.flushFavourites();
    await this.flush();
    await this.context.secrets.delete(secretKey(id));
  }

  /* ---------------------------------------------------------- favourites */

  isFavourite(id: string): boolean {
    return this.pinned.has(id);
  }

  favourites(): string[] {
    return [...this.pinned];
  }

  async setFavourite(id: string, on: boolean): Promise<void> {
    if (!this.get(id) || this.pinned.has(id) === on) {
      return;
    }
    if (on) {
      this.pinned.add(id);
    } else {
      this.pinned.delete(id);
    }
    await this.flushFavourites();
    this.onDidChangeEmitter.fire();
  }

  private async flushFavourites(): Promise<void> {
    await this.context.globalState.update(FAVOURITES_KEY, [...this.pinned]);
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
      this.secretPresence.set(profileId, false);
      return;
    }
    await this.context.secrets.store(secretKey(profileId), secret);
    this.secretPresence.set(profileId, true);
  }

  async hasSecret(profileId: string): Promise<boolean> {
    const known = this.secretPresence.get(profileId);
    if (known !== undefined) {
      return known;
    }
    const inFlight = this.presenceReads.get(profileId);
    if (inFlight) {
      return inFlight;
    }
    const read = Promise.resolve(this.context.secrets.get(secretKey(profileId))).then(
      (value) => {
        const present = value !== undefined;
        this.secretPresence.set(profileId, present);
        this.presenceReads.delete(profileId);
        return present;
      },
      (error) => {
        // A keychain that will not answer is not proof of anything, so nothing
        // is cached and the next caller asks again.
        this.presenceReads.delete(profileId);
        throw error;
      }
    );
    this.presenceReads.set(profileId, read);
    return read;
  }

  /**
   * Asks the keychain about every profile at once, so the answers are already
   * held by the time something needs the whole set. Failures are the caller's
   * to ignore: this is a warm-up, and every id it misses is simply read later.
   */
  primeSecretPresence(): void {
    for (const profile of this.profiles) {
      void this.hasSecret(profile.id).catch(() => undefined);
    }
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
    mssqlAuth: seed.mssqlAuth ?? 'sql',
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
export function normalise(input: ConnectionProfile): ConnectionProfile {
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
  // An empty box arrives as null, and `Number(null)` is 0, which is finite and
  // would have been clamped to the minimum. A cleared connect timeout became
  // one second rather than the fifteen the field is documented to default to.
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
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
