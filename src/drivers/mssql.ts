import type { Connection, ConnectionConfiguration, Request as TediousRequest } from 'tedious';
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
  Signal,
  StreamOutcome,
  abortError,
  coerceProperty
} from './types';

/**
 * Rows handed to the sink at a time.
 *
 * Small enough that the first screenful appears while the server is still
 * producing, large enough that a four-million-row read is four thousand calls
 * rather than four million. The number is a judgement; anything between about
 * a hundred and a few thousand behaves the same.
 */
const CHUNK = 500;

/**
 * A column as tedious describes it.
 *
 * Declared here rather than imported: `ColumnMetadata` lives in a token parser
 * module inside the package rather than on its public surface, and reaching
 * into `tedious/lib/...` for a shape this file uses four fields of would tie
 * the build to the package's internal layout.
 */
interface TediousColumn {
  colName?: string;
  type?: { name?: string };
  dataLength?: number;
  precision?: number;
  scale?: number;
}

/**
 * `PRINT`, `RAISERROR` below the error threshold and `SET STATISTICS IO` all
 * arrive as connection-level messages rather than on the request that caused
 * them, so the session routes them to whatever is streaming at the time. A
 * session runs one statement at a time, so "at the time" is unambiguous.
 */
interface MessageRoute {
  message(level: 'info' | 'error', text: string, line?: number): void;
  noteError(text: string, line?: number): void;
}

type TediousModule = typeof import('tedious');

let tedious: TediousModule | undefined;

/** Loaded on the first connection, never at activation. */
function load(): TediousModule {
  if (!tedious) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tedious = require('tedious') as TediousModule;
  }
  return tedious;
}

export class MssqlDriver implements Driver {
  readonly kind = 'mssql' as const;

  async open(profile: ConnectionProfile, secrets: ConnectSecrets, signal?: AbortSignal): Promise<OpenResult> {
    const { Connection: TediousConnection } = load();
    const config = buildConfig(profile, secrets);
    const started = Date.now();

    const connection = new TediousConnection(config);
    await connectOnce(connection, signal);

    try {
      const rows = await query(
        connection,
        'SELECT @@VERSION AS version, SUSER_SNAME() AS principal, DB_NAME() AS db'
      );
      const latencyMs = Date.now() - started;
      const first = rows[0] ?? {};
      return {
        // The database comes from the server rather than from the profile: a
        // profile that names none lands on the login's default, and the strip
        // at the bottom of the window should say which one that turned out to
        // be rather than leaving the question open.
        session: new MssqlSession(profile.id, connection, String(first.db ?? profile.database ?? '')),
        serverVersion: shortVersion(String(first.version ?? '')),
        principal: String(first.principal ?? profile.user ?? ''),
        latencyMs,
        // SQL Server has no session-level read-only switch. The flag is carried
        // on the profile and enforced by the statement gate that lands with
        // query execution; nothing here can claim the server applied it.
        readOnlyApplied: false
      };
    } catch (error) {
      connection.close();
      throw error;
    }
  }
}

class MssqlSession implements DriverSession {
  private closed = false;
  /**
   * The request in flight, so `cancelCurrent` can name it.
   *
   * `request.cancel()` rather than `connection.cancel()` because it says which
   * request it means. The connection-level call cancels whatever happens to be
   * running, which on a session shared between a grid and anything else is a
   * race the user would lose exactly once, silently.
   */
  private current: TediousRequest | undefined;
  /** Where connection-level messages go while a statement is streaming. */
  private route: MessageRoute | undefined;
  private readonly databaseSignal = new Signal<string>();

  constructor(
    readonly profileId: string,
    private readonly connection: Connection,
    /** Where the session starts, from `DB_NAME()` at open. */
    private database: string
  ) {
    this.connection.on('error', () => {
      this.closed = true;
    });
    this.connection.on('end', () => {
      this.closed = true;
    });
    /*
     * The server saying which database this session is now in.
     *
     * tedious surfaces the ENVCHANGE token as this event, and it fires for
     * every route into a database change there is: a `USE` the user typed, a
     * `USE` twenty statements down a script, one inside a procedure, and the
     * implicit one at login. That is the whole reason nothing here parses SQL
     * looking for the word — a scanner would miss the last three and would be
     * wrong about the first one whenever the statement failed.
     */
    this.connection.on('databaseChange', (database: string) => {
      const name = String(database ?? '').trim();
      if (!name || name === this.database) {
        return;
      }
      this.database = name;
      this.databaseSignal.fire(name);
    });
    this.connection.on('infoMessage', (info: { message?: string; lineNumber?: number }) => {
      if (info.message) {
        this.route?.message('info', info.message, info.lineNumber);
      }
    });
    this.connection.on('errorMessage', (error: { message?: string; lineNumber?: number }) => {
      if (error.message) {
        this.route?.message('error', error.message, error.lineNumber);
        this.route?.noteError(error.message, error.lineNumber);
      }
    });
  }

  async listDatabases(): Promise<string[]> {
    const rows = await query(
      this.connection,
      'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name'
    );
    return rows.map((r) => String(r.name));
  }

  currentDatabase(): string {
    return this.database;
  }

  /**
   * `USE`, which is the one statement the extension writes on the user's
   * behalf that changes what every later statement means.
   *
   * The name is bracketed here rather than bound, because a database name is
   * an identifier and `USE @p0` is not a statement SQL Server has. Brackets
   * plus a doubled `]` is the engine's own escape and the only correct
   * quoting for the position — and the name itself only ever comes from
   * `sys.databases` or from the user's own picker.
   */
  async useDatabase(name: string): Promise<void> {
    if (this.closed) {
      throw new DriverError('The connection is closed.', 'ECLOSED', undefined, undefined);
    }
    await query(this.connection, `USE [${name.replace(/]/g, ']]')}]`);
    // Belt and braces: the ENVCHANGE token normally lands first, but a server
    // that did not send one must not leave the session claiming the old name.
    if (this.database !== name) {
      this.database = name;
      this.databaseSignal.fire(name);
    }
  }

  onDatabaseChange(listener: (database: string) => void): { dispose(): void } {
    return this.databaseSignal.add(listener);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this.closed) {
      throw new DriverError('The connection is closed.', 'ECLOSED', undefined, undefined);
    }
    return (await query(this.connection, sql, params)) as T[];
  }

  stream(sql: string, params: unknown[] | undefined, sink: RowSink): Promise<StreamOutcome> {
    if (this.closed) {
      return Promise.reject(new DriverError('The connection is closed.', 'ECLOSED', undefined, undefined));
    }
    const { Request } = load();

    return new Promise<StreamOutcome>((resolve, reject) => {
      let buffer: CellValue[][] = [];
      let setOpen = false;
      let truncated = false;
      let cancelled = false;
      /** The last error the server reported, for its line number. */
      let lastError: { message: string; line?: number } | undefined;

      const flush = () => {
        if (buffer.length) {
          sink.rows(buffer);
          buffer = [];
        }
      };

      const request = new Request(sql, (error) => {
        this.current = undefined;
        this.route = undefined;
        flush();
        if (setOpen) {
          sink.complete();
          setOpen = false;
        }
        if (error) {
          if (isCancellation(error)) {
            // Reaching the ceiling cancels the request too, so the two are
            // told apart by which one asked: a truncated read is not a
            // cancelled one, and the grid says something different about each.
            resolve({ cancelled: !truncated, truncated });
            return;
          }
          const wrapped = toDriverError(error);
          if (lastError?.line !== undefined) {
            wrapped.line = lastError.line;
          }
          reject(wrapped);
          return;
        }
        resolve({ cancelled, truncated });
      });

      (params ?? []).forEach((value, i) => addParameter(request, `p${i}`, value));

      this.route = {
        message: (level, text, line) => sink.message(level, text, line),
        noteError: (text, line) => {
          lastError = { message: text, line };
        }
      };

      request.on('columnMetadata', (columns) => {
        // A second metadata message means a second result set. The first one
        // has to be closed before the second one opens, or every set after the
        // first pours its rows into the set before it.
        flush();
        if (setOpen) {
          sink.complete();
        }
        sink.columns(normalizeColumns(columns).map(toColumnMeta));
        setOpen = true;
      });

      request.on('row', (columns: Array<{ value: unknown }>) => {
        if (truncated) {
          return;
        }
        if (sink.wants() <= 0) {
          // The ceiling is reached by stopping the read rather than by having
          // rewritten the statement, so what did come back is what the user
          // actually asked for.
          truncated = true;
          flush();
          this.cancelCurrent();
          return;
        }
        buffer.push(columns.map((column) => encodeCell(column.value)));
        if (buffer.length >= CHUNK) {
          flush();
        }
      });

      const done = (rowCount: number | undefined) => {
        flush();
        if (setOpen) {
          sink.complete();
          setOpen = false;
        } else if (rowCount !== undefined) {
          // No columns, so this was an INSERT, UPDATE, DELETE or a DDL
          // statement and the count is rows affected rather than rows read.
          sink.complete(rowCount);
        }
      };

      request.on('done', (rowCount?: number) => done(rowCount));
      request.on('doneInProc', (rowCount?: number) => done(rowCount));
      request.on('doneProc', (rowCount?: number) => done(rowCount));

      this.current = request;
      this.connection.execSql(request);
    });
  }

  cancelCurrent(): void {
    const request = this.current;
    if (!request) {
      return;
    }
    try {
      request.cancel();
    } catch {
      // A request that has already settled throws rather than no-opping, and a
      // cancel arriving a moment late is not a failure worth reporting.
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.current = undefined;
    this.databaseSignal.clear();
    await new Promise<void>((resolve) => {
      const onEnd = () => {
        clearTimeout(timer);
        resolve();
      };
      // The socket occasionally never reports back on a half-open connection,
      // so the caller is not left waiting on it.
      const timer = setTimeout(() => {
        this.connection.removeListener('end', onEnd);
        resolve();
      }, 2000);
      this.connection.once('end', onEnd);
      this.connection.close();
    });
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function buildConfig(profile: ConnectionProfile, secrets: ConnectSecrets): ConnectionConfiguration {
  const timeoutMs = profile.connectTimeoutSeconds * 1000;
  const requestTimeoutMs = profile.queryTimeoutSeconds > 0 ? profile.queryTimeoutSeconds * 1000 : 0;

  const options: Record<string, unknown> = {
    port: profile.port ?? defaultPort('mssql'),
    database: profile.database || undefined,
    // tedious takes `true`, `false`, or the string 'strict' for TDS 8.0.
    encrypt: profile.encrypt === 'strict' ? 'strict' : profile.encrypt === 'mandatory',
    trustServerCertificate: profile.trustServerCertificate,
    connectTimeout: timeoutMs,
    requestTimeout: requestTimeoutMs,
    cancelTimeout: 5000,
    appName: profile.applicationName || 'VS Code Database Tools',
    multiSubnetFailover: profile.multiSubnetFailover,
    rowCollectionOnRequestCompletion: false,
    useColumnNames: false,
    validateBulkLoadParameters: true
  };

  if (profile.certificateHostname) {
    // Lets a listener or an alias validate against the name on the certificate.
    //
    // This is `serverName` and not `cryptoCredentialsDetails.servername`. The
    // latter is the secure-context bag, and tedious hands it to
    // `tls.createSecureContext`, which has no `servername` option and drops the
    // key without a word — so the field read as applied and validated against
    // the host every time. `serverName` is the one tedious passes to
    // `tls.connect` on both the TDS 8.0 and the STARTTLS path.
    options.serverName = profile.certificateHostname;
  }

  // Driver properties are the user's own escape hatch, so they are applied
  // last and can override anything decided above.
  for (const property of profile.properties) {
    options[property.name] = coerceProperty(property.value);
  }

  return {
    server: profile.host,
    options,
    authentication: buildAuthentication(profile, secrets)
  } as ConnectionConfiguration;
}

function buildAuthentication(profile: ConnectionProfile, secrets: ConnectSecrets) {
  switch (profile.mssqlAuth) {
    case 'entra-mfa':
      if (!secrets.accessToken) {
        throw new DriverError(
          'No Microsoft Entra access token was available for this connection.',
          'ENOTOKEN',
          undefined,
          undefined
        );
      }
      return {
        type: 'azure-active-directory-access-token' as const,
        options: { token: secrets.accessToken }
      };
    case 'ntlm':
      return {
        type: 'ntlm' as const,
        options: {
          userName: profile.user,
          password: secrets.password ?? '',
          domain: profile.domain || profile.host.split('.').slice(1).join('.') || 'WORKGROUP'
        }
      };
    case 'sql':
    default:
      return {
        type: 'default' as const,
        options: { userName: profile.user, password: secrets.password ?? '' }
      };
  }
}

function connectOnce(connection: Connection, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    /**
     * The number and state the server actually sent.
     *
     * A login failure reaches us as a bare `ConnectionError` carrying nothing
     * but a message and the code 'ELOGIN': tedious builds it from the error
     * token and keeps neither the number nor the state. Error 18456 is the most
     * common failure SQL Server has, and without the number it cannot be told
     * apart from anything else, so the remedy the editor offers for a rejected
     * credential was unreachable. The token itself is emitted a moment earlier,
     * which is where these two come from.
     */
    let serverError: { number?: number; state?: number } | undefined;
    const onErrorMessage = (token: { number?: number; state?: number }) => {
      serverError = token;
    };
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      connection.removeListener('errorMessage', onErrorMessage);
      if (error) {
        reject(toDriverError(error, serverError));
      } else {
        resolve();
      }
    };
    const onAbort = () => {
      connection.close();
      finish(abortError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    // Carries the number and state that the 'connect' error is about to drop.
    connection.on('errorMessage', onErrorMessage);
    connection.on('connect', (error?: Error) => finish(error));
    // A socket-level failure can arrive before 'connect' ever fires.
    connection.on('error', (error: Error) => finish(error));
    connection.connect();
  });
}

function query(
  connection: Connection,
  sql: string,
  params?: unknown[]
): Promise<Array<Record<string, unknown>>> {
  const { Request } = load();
  return new Promise((resolve, reject) => {
    const rows: Array<Record<string, unknown>> = [];
    const request = new Request(sql, (error) => {
      if (error) {
        reject(toDriverError(error));
      } else {
        resolve(rows);
      }
    });
    // Bound, never interpolated. Every catalog statement takes a schema or an
    // object name straight from the tree, and a tree row is a string the server
    // gave us — but it is a string that came back through a webview, and the
    // one place a quoted identifier must never be reassembled by hand is a
    // predicate. `addParameter` is what keeps `'; DROP` a table name.
    (params ?? []).forEach((value, i) => addParameter(request, `p${i}`, value));
    request.on('row', (columns: Array<{ value: unknown; metadata: { colName: string } }>) => {
      const row: Record<string, unknown> = {};
      for (const column of columns) {
        row[column.metadata.colName] = column.value;
      }
      rows.push(row);
    });
    connection.execSql(request);
  });
}

/**
 * The TDS type for a JavaScript value.
 *
 * `Int` rather than `BigInt` for numbers, because every number the catalog
 * binds is an offset or a row limit and neither approaches 2^31; and `NVarChar`
 * rather than `VarChar` for strings, because a schema or an object name in SQL
 * Server is `sysname`, which is `nvarchar(128)`, and binding it as ASCII would
 * quietly fail to match anything outside it.
 */
function addParameter(request: import('tedious').Request, name: string, value: unknown): void {
  const { TYPES } = load();
  if (typeof value === 'number') {
    request.addParameter(name, Number.isInteger(value) ? TYPES.Int : TYPES.Float, value);
    return;
  }
  if (typeof value === 'boolean') {
    request.addParameter(name, TYPES.Bit, value);
    return;
  }
  request.addParameter(name, TYPES.NVarChar, value === null || value === undefined ? null : String(value));
}

/**
 * `token` is only ever a fallback: an error that carries its own number and
 * state keeps them, so a request failure is untouched by it.
 */
function toDriverError(error: unknown, token?: { number?: number; state?: number }): DriverError {
  if (error instanceof DriverError) {
    return error;
  }
  const e = error as { message?: string; code?: string; number?: number; state?: number | string; name?: string };
  const number = typeof e?.number === 'number' ? e.number : token?.number;
  const state = e?.state !== undefined ? String(e.state) : token?.state !== undefined ? String(token.state) : undefined;
  const wrapped = new DriverError(e?.message ?? String(error), e?.code, number, state, error);
  if (e?.name === 'AbortError') {
    wrapped.name = 'AbortError';
  }
  return wrapped;
}

/** `@@VERSION` is four lines of banner; the first line is the useful one. */
function shortVersion(banner: string): string {
  const firstLine = banner.split('\n')[0]?.trim() ?? '';
  const match = firstLine.match(/^(Microsoft SQL Server \d{4}(?:\s\(\w+\))?)\s*-\s*([\d.]+)/i);
  if (match) {
    return `${match[1]} · ${match[2]}`;
  }
  return firstLine || 'SQL Server';
}

/**
 * The rendered type of a column, as somebody would write it in a `CREATE`.
 *
 * `dataLength` is bytes rather than characters, so the wide types are halved:
 * an `nvarchar(200)` reports 400 and printing that would be wrong in the one
 * place a person is most likely to copy it from. `-1` and `65535` are both how
 * the protocol says `max`.
 */
function mssqlTypeName(meta: TediousColumn): string {
  const raw = String(meta.type?.name ?? 'unknown');
  const name = raw.toLowerCase();
  const length = meta.dataLength;
  const precision = meta.precision;
  const scale = meta.scale;

  if (name === 'decimal' || name === 'numeric' || name === 'money' || name === 'smallmoney') {
    return precision === undefined ? name : `${name}(${precision},${scale ?? 0})`;
  }
  if (name === 'datetime2' || name === 'datetimeoffset' || name === 'time') {
    return scale === undefined ? name : `${name}(${scale})`;
  }
  if (length === undefined) {
    return name;
  }
  if (length === -1 || length === 65535) {
    return `${name}(max)`;
  }
  const wide = name.startsWith('n') && name !== 'numeric';
  const chars = wide ? Math.floor(length / 2) : length;
  return /char|binary/.test(name) ? `${name}(${chars})` : name;
}

function toColumnMeta(meta: TediousColumn): ColumnMeta {
  const type = mssqlTypeName(meta);
  return { name: String(meta.colName ?? ''), type, kind: kindOfSqlType(type) };
}

/**
 * tedious hands the column list either way round depending on
 * `useColumnNames`, which is off here — but the typing admits both, and a
 * driver that trusted the array form would break the day somebody set it.
 */
function normalizeColumns(columns: unknown): TediousColumn[] {
  if (Array.isArray(columns)) {
    return columns as TediousColumn[];
  }
  return Object.values((columns ?? {}) as Record<string, TediousColumn>);
}

/**
 * Whether a request failed because it was cancelled rather than because it was
 * wrong. tedious reports the attention signal as an ordinary request error, so
 * a cancelled query would otherwise be filed as a failure and the rows already
 * on screen thrown away.
 */
function isCancellation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code) {
    return code === 'ECANCEL';
  }
  return /cancell?ed/i.test((error as { message?: string })?.message ?? '');
}
