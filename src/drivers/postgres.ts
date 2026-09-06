import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Client, ClientConfig } from 'pg';
import { ConnectionProfile, defaultPort } from '../types';
import { ConnectSecrets, Driver, DriverError, DriverSession, OpenResult } from './types';

type PgModule = typeof import('pg');

let pg: PgModule | undefined;

/** Loaded on the first connection, never at activation. */
function load(): PgModule {
  if (!pg) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pg = require('pg') as PgModule;
  }
  return pg;
}

/** libpq reads this when sslrootcert is unset. Node does not, so we do. */
const LIBPQ_DEFAULT_ROOT_CERT = path.join(os.homedir(), '.postgresql', 'root.crt');

export class PostgresDriver implements Driver {
  readonly kind = 'postgres' as const;

  async open(profile: ConnectionProfile, secrets: ConnectSecrets, signal?: AbortSignal): Promise<OpenResult> {
    const started = Date.now();
    let client: Client;

    try {
      client = await this.connectWithSslPolicy(profile, secrets, signal);
    } catch (error) {
      throw toDriverError(error);
    }

    try {
      let readOnlyApplied = false;
      if (profile.readOnly) {
        // PostgreSQL can genuinely hold the whole session read-only, so it does.
        await client.query('SET default_transaction_read_only = on');
        readOnlyApplied = true;
      }

      const result = await client.query<{ version: string; principal: string }>(
        'SELECT version() AS version, current_user AS principal'
      );
      const latencyMs = Date.now() - started;
      const row = result.rows[0];
      return {
        session: new PostgresSession(profile.id, client),
        serverVersion: shortVersion(row?.version ?? ''),
        principal: row?.principal ?? profile.user,
        latencyMs,
        readOnlyApplied
      };
    } catch (error) {
      await client.end().catch(() => undefined);
      throw toDriverError(error);
    }
  }

  /**
   * libpq's `allow` and `prefer` are negotiations, not settings: they try one
   * way and fall back to the other. node-postgres only takes a fixed ssl
   * option, so the fallback is done here rather than pretending it happened.
   */
  private async connectWithSslPolicy(
    profile: ConnectionProfile,
    secrets: ConnectSecrets,
    signal?: AbortSignal
  ): Promise<Client> {
    const negotiates = profile.sslMode === 'prefer' || profile.sslMode === 'allow';
    const first = profile.sslMode === 'allow' ? false : buildSsl(profile, secrets);

    try {
      return await this.connectOnce(profile, secrets, first, signal);
    } catch (error) {
      if (!negotiates || signal?.aborted) {
        throw error;
      }
      const second = profile.sslMode === 'allow' ? buildSsl(profile, secrets) : false;
      return this.connectOnce(profile, secrets, second, signal);
    }
  }

  private async connectOnce(
    profile: ConnectionProfile,
    secrets: ConnectSecrets,
    ssl: ClientConfig['ssl'],
    signal?: AbortSignal
  ): Promise<Client> {
    const { Client: PgClient } = load();
    const client = new PgClient(buildConfig(profile, secrets, ssl));

    if (signal?.aborted) {
      throw abortError();
    }

    const connecting = client.connect();
    if (!signal) {
      await connecting;
      return client;
    }

    // `client.end()` alone does not stop a connection that has not finished
    // opening, so a cancelled attempt would sit there until the OS timed the
    // socket out. Tearing the stream down is what actually stops it.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        try {
          const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream;
          stream?.destroy();
        } catch {
          // Already gone; ending the client below is enough.
        }
        client.end().catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      connecting.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
    return client;
  }
}

class PostgresSession implements DriverSession {
  private closed = false;

  constructor(
    readonly profileId: string,
    private readonly client: Client
  ) {
    this.client.on('end', () => {
      this.closed = true;
    });
    // Without a listener, a dropped backend takes the extension host with it.
    this.client.on('error', () => {
      this.closed = true;
    });
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
    );
    return result.rows.map((r) => r.datname);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.client.end().catch(() => undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function buildConfig(
  profile: ConnectionProfile,
  secrets: ConnectSecrets,
  ssl: ClientConfig['ssl']
): ClientConfig {
  const config: Record<string, unknown> = {
    host: profile.host,
    port: profile.port ?? defaultPort('postgres'),
    database: profile.database || undefined,
    user: profile.pgAuth === 'none' ? undefined : profile.user || undefined,
    password: profile.pgAuth === 'password' ? secrets.password : undefined,
    ssl,
    connectionTimeoutMillis: profile.connectTimeoutSeconds * 1000,
    application_name: profile.applicationName || 'VS Code Database Tools'
  };

  if (profile.queryTimeoutSeconds > 0) {
    config.statement_timeout = profile.queryTimeoutSeconds * 1000;
  }
  if (profile.searchPath && profile.searchPath !== 'public') {
    // Passed as a startup packet option so the very first statement sees it.
    config.options = `-c search_path=${profile.searchPath}`;
  }

  for (const property of profile.properties) {
    config[property.name] = coerce(property.value);
  }

  return config as ClientConfig;
}

function buildSsl(profile: ConnectionProfile, secrets: ConnectSecrets): ClientConfig['ssl'] {
  if (profile.sslMode === 'disable') {
    return false;
  }

  const options: Record<string, unknown> = {};

  // `require` encrypts but never checks who the server is, which is exactly
  // what libpq does. Only the verify modes turn verification on.
  const verifies = profile.sslMode === 'verify-ca' || profile.sslMode === 'verify-full';
  options.rejectUnauthorized = verifies;

  if (verifies) {
    const ca = readRootCert(profile.rootCertPath);
    if (ca) {
      options.ca = ca;
    }
    if (profile.sslMode === 'verify-ca') {
      // verify-ca trusts the issuer but deliberately ignores the host name.
      options.checkServerIdentity = () => undefined;
    }
  }

  if (profile.pgAuth === 'certificate') {
    if (profile.clientCertPath) {
      options.cert = readFile(profile.clientCertPath, 'client certificate');
    }
    if (profile.clientKeyPath) {
      options.key = readFile(profile.clientKeyPath, 'client key');
    }
    if (secrets.password) {
      options.passphrase = secrets.password;
    }
  }

  return options as ClientConfig['ssl'];
}

function readRootCert(configured: string): string | undefined {
  const trimmed = configured.trim();
  if (trimmed === 'system') {
    // Fall through to Node's bundled roots.
    return undefined;
  }
  const target = trimmed ? expandHome(trimmed) : LIBPQ_DEFAULT_ROOT_CERT;
  if (!fs.existsSync(target)) {
    if (trimmed) {
      throw new DriverError(
        `The root certificate ${target} was not found.`,
        'ENOENT',
        undefined,
        undefined
      );
    }
    return undefined;
  }
  return fs.readFileSync(target, 'utf8');
}

function readFile(configured: string, what: string): string {
  const target = expandHome(configured.trim());
  if (!fs.existsSync(target)) {
    throw new DriverError(`The ${what} ${target} was not found.`, 'ENOENT', undefined, undefined);
  }
  return fs.readFileSync(target, 'utf8');
}

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function toDriverError(error: unknown): DriverError {
  if (error instanceof DriverError) {
    return error;
  }
  const e = error as { message?: string; code?: string; name?: string };
  const wrapped = new DriverError(e?.message ?? String(error), e?.code, undefined, undefined, error);
  if (e?.name === 'AbortError') {
    wrapped.name = 'AbortError';
  }
  return wrapped;
}

/** `version()` returns a paragraph; the product and release are the point. */
function shortVersion(banner: string): string {
  const match = banner.match(/^PostgreSQL\s+([\d.]+\w*)/i);
  return match ? `PostgreSQL ${match[1]}` : banner.split(' ').slice(0, 2).join(' ') || 'PostgreSQL';
}

function coerce(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}

function abortError(): Error {
  const error = new Error('The connection attempt was cancelled.');
  error.name = 'AbortError';
  return error;
}
