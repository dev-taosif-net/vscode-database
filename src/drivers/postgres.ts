import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Client, ClientConfig, FieldDef, Query, QueryResult } from 'pg';
import { ConnectionProfile, defaultPort } from '../types';
import { CellValue, ColumnMeta } from '../shared/query';
import { encodeCell, kindOfSqlType } from '../exec/encode';
import {
  ConnectSecrets,
  Driver,
  DriverError,
  DriverSession,
  OpenResult,
  RowSink,
  StreamOutcome,
  abortError,
  coerceProperty
} from './types';

/** Rows handed to the sink at a time. See the same constant in `mssql.ts`. */
const CHUNK = 500;

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
    let opened: Opened;

    try {
      opened = await this.connectWithSslPolicy(profile, secrets, signal);
    } catch (error) {
      throw toDriverError(error);
    }
    const client = opened.client;

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
        session: new PostgresSession(profile.id, client, opened.config),
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
  ): Promise<Opened> {
    const negotiates = profile.sslMode === 'prefer' || profile.sslMode === 'allow';
    const first = profile.sslMode === 'allow' ? false : buildSsl(profile, secrets);

    try {
      return await this.connectOnce(profile, secrets, first, signal);
    } catch (error) {
      if (!negotiates || signal?.aborted) {
        throw error;
      }
      if (profile.sslMode === 'prefer' && answeredOverTls(error)) {
        // `prefer` is the one direction that falls back downwards, from an
        // encrypted socket to a plain one. libpq only ever does that when the
        // server refuses to negotiate TLS at all; once a session is up, the
        // transport is settled and the answer on it is the answer. Retrying
        // here anyway would put the password back on the wire in clear over a
        // wrong password or a missing database, which is not a fallback but a
        // leak. `allow` negotiates the other way and is left alone.
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
  ): Promise<Opened> {
    const { Client: PgClient } = load();
    const config = buildConfig(profile, secrets, ssl);
    const client = new PgClient(config);

    if (signal?.aborted) {
      throw abortError();
    }

    const connecting = client.connect();
    if (!signal) {
      await connecting;
      return { client, config };
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
    return { client, config };
  }
}

/**
 * A live client and the settings it was opened with.
 *
 * The config travels with the client because a cancel has to open a second
 * socket to the same place, with the same TLS, and rebuilding it from the
 * profile would rebuild the wrong one: `prefer` and `allow` negotiate, so the
 * transport that ended up being used is not always the one the profile asks
 * for.
 */
interface Opened {
  client: Client;
  config: ClientConfig;
}

class PostgresSession implements DriverSession {
  private closed = false;
  /**
   * The query in flight, so `cancelCurrent` can name it.
   *
   * node-postgres only cancels a query it can prove is the client's active
   * one, which is the right check: cancelling by process id alone would kill
   * whatever the backend had moved on to.
   */
  private current: Query | undefined;

  constructor(
    readonly profileId: string,
    private readonly client: Client,
    /** Kept so a cancel can open a second socket with the same settings. */
    private readonly config: ClientConfig
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

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this.closed) {
      throw new DriverError('The connection is closed.', 'ECLOSED', undefined, undefined);
    }
    try {
      // node-postgres binds `$1` server-side, so a schema or an object name
      // coming back through the webview is data and never syntax.
      const result = await this.client.query(sql, params as unknown[] | undefined);
      return result.rows as T[];
    } catch (error) {
      throw toDriverError(error);
    }
  }

  stream(sql: string, params: unknown[] | undefined, sink: RowSink): Promise<StreamOutcome> {
    if (this.closed) {
      return Promise.reject(new DriverError('The connection is closed.', 'ECLOSED', undefined, undefined));
    }
    const { Query: PgQuery } = load();

    return new Promise<StreamOutcome>((resolve, reject) => {
      let buffer: CellValue[][] = [];
      let truncated = false;
      let cancelled = false;
      /** The result object the rows arriving now belong to. */
      let openResult: unknown;
      const seen = new Set<unknown>();

      const flush = () => {
        if (buffer.length) {
          sink.rows(buffer);
          buffer = [];
        }
      };

      // `rowMode: 'array'` is the whole reason this is cheap: the driver hands
      // back a positional array rather than building an object with one key per
      // column per row, which is what the grid wants anyway.
      const query = new PgQuery({ text: sql, values: params, rowMode: 'array' } as never) as Query;

      // Attached before submitting, deliberately. node-postgres decides whether
      // to accumulate every row in memory by counting `row` listeners at the
      // moment the row description arrives; with one attached it accumulates
      // nothing, which is the difference between streaming and buffering the
      // whole answer twice.
      query.on('row', (row: unknown[], result: unknown) => {
        if (truncated) {
          return;
        }
        if (result !== openResult) {
          flush();
          if (openResult) {
            sink.complete();
          }
          openResult = result;
          seen.add(result);
          sink.columns(fieldsOf(result).map(toColumnMeta));
        }
        if (sink.wants() <= 0) {
          truncated = true;
          flush();
          this.cancelCurrent();
          return;
        }
        buffer.push((row ?? []).map(encodeCell));
        if (buffer.length >= CHUNK) {
          flush();
        }
      });

      query.on('error', (error: unknown) => {
        this.current = undefined;
        flush();
        if (openResult) {
          sink.complete();
          openResult = undefined;
        }
        if (isCancellation(error)) {
          // See the same distinction in `mssql.ts`: hitting the fetch ceiling
          // cancels the statement, and that is not the user cancelling it.
          resolve({ cancelled: !truncated, truncated });
          return;
        }
        const wrapped = toDriverError(error);
        const position = Number((error as { position?: string }).position);
        if (Number.isFinite(position) && position > 0) {
          // PostgreSQL reports a character offset rather than a line, so the
          // line is counted here — the only place that still has the text.
          wrapped.line = sql.slice(0, position - 1).split('\n').length;
        }
        reject(wrapped);
      });

      query.on('end', (results: unknown) => {
        this.current = undefined;
        flush();
        if (openResult) {
          sink.complete();
          openResult = undefined;
        }
        // A multi-statement script hands back one result per statement, and
        // the ones that produced no rows were never announced above. They are
        // still answers — an UPDATE's row count is the whole answer — so each
        // is closed out here in the order the server ran them.
        for (const result of Array.isArray(results) ? results : [results]) {
          if (seen.has(result)) {
            continue;
          }
          const fields = fieldsOf(result);
          if (fields.length) {
            sink.columns(fields.map(toColumnMeta));
            sink.complete();
          } else {
            sink.complete((result as QueryResult | undefined)?.rowCount ?? 0);
          }
        }
        resolve({ cancelled, truncated });
      });

      this.current = query;
      this.client.query(query as never);
    });
  }

  cancelCurrent(): void {
    const query = this.current;
    if (!query || this.closed) {
      return;
    }
    const { Client: PgClient } = load();
    try {
      // The protocol's own out-of-band cancel: a second socket carrying the
      // backend's process id and secret key, both captured at startup. It
      // needs no login and no permission on the target session, which
      // `pg_cancel_backend` does — and it is not in the published typings,
      // which is why the call is declared rather than imported.
      const canceller = new PgClient(this.config) as unknown as {
        cancel(client: Client, query: Query): void;
      };
      canceller.cancel(this.client, query);
      return;
    } catch {
      // Fall through to the SQL path.
    }
    void this.cancelBySql();
  }

  /**
   * The fallback, for a server that will not take a CancelRequest.
   *
   * It needs a login and it needs the caller to be allowed to signal the
   * target backend, so it can fail where the protocol cancel would not. It is
   * second for that reason rather than first.
   */
  private async cancelBySql(): Promise<void> {
    const pid = (this.client as unknown as { processID?: number }).processID;
    if (!pid) {
      return;
    }
    const { Client: PgClient } = load();
    const side = new PgClient(this.config);
    try {
      await side.connect();
      await side.query('SELECT pg_cancel_backend($1)', [pid]);
    } catch {
      // Nothing useful to say: the query either stops or it does not, and the
      // grid already shows that it is still running.
    } finally {
      await side.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.current = undefined;
    await this.client.end().catch(() => undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The rendered type of a column.
 *
 * PostgreSQL sends an oid rather than a name, so the name comes from the
 * driver's own builtin table, inverted once. `dataTypeModifier` carries the
 * length or the precision and scale, in the encoding the catalog uses: four
 * bytes of header for the character types, and precision in the high sixteen
 * bits for numeric.
 */
const OID_NAMES = new Map<number, string>();

function pgTypeName(field: FieldDef): string {
  if (OID_NAMES.size === 0) {
    const builtins = (load() as unknown as { types?: { builtins?: Record<string, number> } }).types?.builtins ?? {};
    for (const [name, oid] of Object.entries(builtins)) {
      OID_NAMES.set(oid, FRIENDLY[name] ?? name.toLowerCase());
    }
  }
  const base = OID_NAMES.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`;
  const modifier = field.dataTypeModifier;
  if (modifier === undefined || modifier < 0) {
    return base;
  }
  if (base === 'numeric') {
    const precision = (modifier - 4) >> 16;
    const scale = (modifier - 4) & 0xffff;
    return `numeric(${precision},${scale})`;
  }
  if (base === 'varchar' || base === 'char' || base === 'bpchar') {
    return `${base}(${modifier - 4})`;
  }
  if (base.startsWith('time') || base === 'interval') {
    return `${base}(${modifier})`;
  }
  return base;
}

/**
 * The handful of builtin names that would otherwise be printed in a spelling
 * nobody writes. Everything else is the catalog's own name lower-cased, which
 * is what `\d` prints too.
 */
const FRIENDLY: Record<string, string> = {
  INT2: 'smallint',
  INT4: 'integer',
  INT8: 'bigint',
  FLOAT4: 'real',
  FLOAT8: 'double precision',
  BOOL: 'boolean',
  TIMESTAMPTZ: 'timestamptz',
  TIMETZ: 'timetz'
};

function toColumnMeta(field: FieldDef): ColumnMeta {
  const type = pgTypeName(field);
  return { name: field.name, type, kind: kindOfSqlType(type) };
}

function fieldsOf(result: unknown): FieldDef[] {
  return ((result as { fields?: FieldDef[] } | undefined)?.fields ?? []) as FieldDef[];
}

/**
 * PostgreSQL answers a CancelRequest by failing the statement with 57014,
 * `query_canceled`. That is a cancellation and not a fault, so the rows
 * already delivered are kept and the execution is filed as cancelled.
 */
function isCancellation(error: unknown): boolean {
  return (error as { code?: string })?.code === '57014';
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
    // A `trust` or `peer` login still names a role when one is given; only an
    // empty box falls back to the operating system user.
    user: profile.user || undefined,
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
    config[property.name] = coerceProperty(property.value);
  }

  return config as ClientConfig;
}

/**
 * True when the backend answered on the connection rather than the connection
 * failing to come up.
 *
 * `severity` is the tell, not the code. node-postgres sets it on the errors it
 * builds from an ErrorResponse and on nothing else, so it separates a real
 * answer from a socket that died. A five-character code alone does not: Node's
 * own errno strings are the same shape, and EPIPE — which is what a handshake
 * dying on a write looks like — would have been read as an answer and stopped
 * `prefer` from falling back at all.
 *
 * 28000 is the exception in the other direction: that is how a `hostnossl`
 * rule turns down the transport itself, which is the one thing the fallback is
 * there for.
 */
function answeredOverTls(error: unknown): boolean {
  const e = error as { code?: unknown; severity?: unknown } | null | undefined;
  if (typeof e?.severity !== 'string') {
    return false;
  }
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.code !== '28000';
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

