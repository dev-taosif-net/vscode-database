import type { Connection, ConnectionConfiguration } from 'tedious';
import { ConnectionProfile, defaultPort } from '../types';
import { ConnectSecrets, Driver, DriverError, DriverSession, OpenResult } from './types';

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
        session: new MssqlSession(profile.id, connection),
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

  constructor(
    readonly profileId: string,
    private readonly connection: Connection
  ) {
    this.connection.on('error', () => {
      this.closed = true;
    });
    this.connection.on('end', () => {
      this.closed = true;
    });
  }

  async listDatabases(): Promise<string[]> {
    const rows = await query(
      this.connection,
      'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name'
    );
    return rows.map((r) => String(r.name));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.connection.once('end', () => resolve());
      this.connection.close();
      // The socket occasionally never reports back on a half-open connection,
      // so the caller is not left waiting on it.
      setTimeout(resolve, 2000);
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
    options.cryptoCredentialsDetails = { servername: profile.certificateHostname };
  }

  // Driver properties are the user's own escape hatch, so they are applied
  // last and can override anything decided above.
  for (const property of profile.properties) {
    options[property.name] = coerce(property.value);
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
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(toDriverError(error));
      } else {
        resolve();
      }
    };
    const onAbort = () => {
      connection.close();
      const error = new Error('The connection attempt was cancelled.');
      error.name = 'AbortError';
      finish(error);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    connection.on('connect', (error?: Error) => finish(error));
    // A socket-level failure can arrive before 'connect' ever fires.
    connection.on('error', (error: Error) => finish(error));
    connection.connect();
  });
}

function query(connection: Connection, sql: string): Promise<Array<Record<string, unknown>>> {
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

function toDriverError(error: unknown): DriverError {
  if (error instanceof DriverError) {
    return error;
  }
  const e = error as { message?: string; code?: string; number?: number; state?: number | string; name?: string };
  const wrapped = new DriverError(
    e?.message ?? String(error),
    e?.code,
    typeof e?.number === 'number' ? e.number : undefined,
    e?.state === undefined ? undefined : String(e.state),
    error
  );
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
