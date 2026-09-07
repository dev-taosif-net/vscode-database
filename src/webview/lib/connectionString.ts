import { ConnectionProfile, SslMode } from '../../types';

export interface ParsedConnection {
  patch: Partial<ConnectionProfile>;
  /** The password the string carried, if any. Never put in the patch. */
  secret?: string;
  /** Keys with no field of their own, kept rather than dropped. */
  properties: { name: string; value: string }[];
  engine: string;
}

const SSL_MODES: SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

/** Keys only one of the two engines ever uses, which is how the engine is told. */
const MSSQL_SIGNALS = new Set([
  'server', 'data source', 'datasource', 'initial catalog', 'integrated security', 'trusted_connection',
  'trustservercertificate', 'encrypt', 'connect timeout', 'connection timeout', 'application name',
  'user id', 'uid', 'multipleactiveresultsets', 'multisubnetfailover', 'hostnameincertificate',
  'applicationintent', 'authentication', 'network address', 'packet size', 'persist security info'
]);

const PG_SIGNALS = new Set([
  'dbname', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connect_timeout', 'application_name',
  'fallback_application_name', 'hostaddr', 'target_session_attrs', 'client_encoding', 'passfile',
  'options', 'service', 'gssencmode', 'channel_binding'
]);

/**
 * Reads an ADO.NET, ODBC, libpq keyword or postgresql:// string.
 *
 * Returns the fields it understood, the password if the string carried one,
 * and every key it did not recognise so nothing is silently dropped. Returns
 * null when the text reads as neither engine.
 */
export function parseConnectionString(raw: string): ParsedConnection | null {
  const text = (raw || '').trim();
  if (!text) {
    return null;
  }
  if (/^postgres(ql)?:\/\//i.test(text)) {
    return fromPostgresUri(text);
  }

  const pairs = splitPairs(text);
  if (!pairs.length) {
    return null;
  }

  let mssqlScore = 0;
  let pgScore = 0;
  for (const [key] of pairs) {
    if (MSSQL_SIGNALS.has(key)) {
      mssqlScore++;
    }
    if (PG_SIGNALS.has(key)) {
      pgScore++;
    }
    if (key === 'host') {
      pgScore++;
    }
  }
  if (mssqlScore === 0 && pgScore === 0) {
    return null;
  }
  return mssqlScore >= pgScore ? fromMssqlPairs(pairs) : fromPostgresPairs(pairs);
}

/**
 * Splits key=value pairs. ADO.NET separates on ";" and quotes with {} or
 * quotes; libpq separates on whitespace and quotes with '. A password holding
 * a separator is common enough that the quoting has to be honoured.
 */
export function splitPairs(text: string): [string, string][] {
  const bySemicolon = text.includes(';');
  const pairs: [string, string][] = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && (text[i] === ';' || /\s/.test(text[i]))) {
      i++;
    }
    let key = '';
    while (i < text.length && text[i] !== '=' && text[i] !== ';') {
      key += text[i++];
    }
    if (i >= text.length) {
      break;
    }
    if (text[i] !== '=') {
      // A chunk with no "=" is malformed, most often an unquoted separator
      // inside a password. Skip it rather than dropping the rest of the string.
      continue;
    }
    i++;
    while (i < text.length && text[i] === ' ') {
      i++;
    }

    let value = '';
    if (text[i] === '{') {
      i++;
      while (i < text.length && text[i] !== '}') {
        value += text[i++];
      }
      i++;
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i++];
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        value += text[i++];
      }
    } else {
      while (i < text.length && text[i] !== ';' && !(!bySemicolon && /\s/.test(text[i]))) {
        value += text[i++];
      }
    }

    const name = key.trim().toLowerCase();
    if (name) {
      pairs.push([name, value.trim()]);
    }
  }
  return pairs;
}

function isTrue(value: string): boolean {
  return /^(true|yes|1|sspi)$/i.test(value.trim());
}

function wholeNumber(value: string, min: number, max: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function fromMssqlPairs(pairs: [string, string][]): ParsedConnection {
  const patch: Partial<ConnectionProfile> = { driver: 'mssql' };
  const properties: { name: string; value: string }[] = [];
  let secret: string | undefined;
  let authStated = false;

  for (const [key, value] of pairs) {
    switch (key) {
      case 'server':
      case 'data source':
      case 'datasource':
      case 'addr':
      case 'address':
      case 'network address': {
        // "tcp:host,1433" and "host\\INSTANCE,1433" both turn up in the wild.
        let host = value.replace(/^(tcp|np|lpc|admin):/i, '').trim();
        const comma = host.lastIndexOf(',');
        if (comma > 0) {
          const port = wholeNumber(host.slice(comma + 1), 1, 65535);
          if (port !== undefined) {
            patch.port = port;
          }
          host = host.slice(0, comma).trim();
        }
        patch.host = host;
        break;
      }
      case 'initial catalog':
      case 'database':
        patch.database = value;
        break;
      case 'user id':
      case 'uid':
      case 'user':
      case 'username':
        patch.user = value;
        break;
      case 'password':
      case 'pwd':
        secret = value;
        break;
      case 'integrated security':
      case 'trusted_connection':
        if (isTrue(value)) {
          patch.mssqlAuth = 'ntlm';
          authStated = true;
        }
        break;
      case 'authentication': {
        const mode = value.toLowerCase().replace(/\s+/g, '');
        if (mode.includes('activedirectory') || mode.includes('entra')) {
          patch.mssqlAuth = 'entra-mfa';
          authStated = true;
        } else if (mode.includes('sqlpassword')) {
          patch.mssqlAuth = 'sql';
          authStated = true;
        }
        break;
      }
      case 'domain':
        patch.domain = value;
        break;
      case 'encrypt':
        patch.encrypt = /^strict$/i.test(value) ? 'strict' : isTrue(value) ? 'mandatory' : 'optional';
        break;
      case 'trustservercertificate':
        patch.trustServerCertificate = isTrue(value);
        break;
      case 'hostnameincertificate':
        patch.certificateHostname = value;
        break;
      case 'application name':
      case 'app':
        patch.applicationName = value;
        break;
      case 'connect timeout':
      case 'connection timeout':
      case 'timeout': {
        const seconds = wholeNumber(value, 1, 600);
        if (seconds !== undefined) {
          patch.connectTimeoutSeconds = seconds;
        }
        break;
      }
      case 'multipleactiveresultsets':
        patch.multipleActiveResultSets = isTrue(value);
        break;
      case 'multisubnetfailover':
        patch.multiSubnetFailover = isTrue(value);
        break;
      case 'applicationintent':
        patch.readOnly = /readonly/i.test(value);
        break;
      default:
        properties.push({ name: key, value });
    }
  }

  // A login and a password with nothing else said is a SQL login.
  if (!authStated && patch.user && secret !== undefined) {
    patch.mssqlAuth = 'sql';
  }
  return { patch, secret, properties, engine: 'Microsoft SQL Server' };
}

interface PgAccumulator {
  patch: Partial<ConnectionProfile>;
  secret: string | undefined;
  properties: { name: string; value: string }[];
}

function fromPostgresPairs(pairs: [string, string][]): ParsedConnection {
  const out: PgAccumulator = { patch: { driver: 'postgres' }, secret: undefined, properties: [] };
  for (const [key, value] of pairs) {
    applyPostgresKey(out, key, value);
  }
  return finishPostgres(out);
}

function fromPostgresUri(text: string): ParsedConnection | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const out: PgAccumulator = { patch: { driver: 'postgres' }, secret: undefined, properties: [] };

  if (url.hostname) {
    out.patch.host = decodeURIComponent(url.hostname);
  }
  if (url.port) {
    const port = wholeNumber(url.port, 1, 65535);
    if (port !== undefined) {
      out.patch.port = port;
    }
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) {
    out.patch.database = database;
  }
  if (url.username) {
    out.patch.user = decodeURIComponent(url.username);
  }
  if (url.password) {
    out.secret = decodeURIComponent(url.password);
  }
  url.searchParams.forEach((value, key) => applyPostgresKey(out, key.toLowerCase(), value));
  return finishPostgres(out);
}

function applyPostgresKey(out: PgAccumulator, key: string, value: string): void {
  const patch = out.patch;
  switch (key) {
    case 'host':
      patch.host = value;
      break;
    case 'hostaddr':
      if (!patch.host) {
        patch.host = value;
      }
      break;
    case 'port': {
      const port = wholeNumber(value, 1, 65535);
      if (port !== undefined) {
        patch.port = port;
      }
      break;
    }
    case 'dbname':
    case 'database':
      patch.database = value;
      break;
    case 'user':
      patch.user = value;
      break;
    case 'password':
      out.secret = value;
      break;
    case 'sslmode': {
      const mode = value.toLowerCase() as SslMode;
      if (SSL_MODES.includes(mode)) {
        patch.sslMode = mode;
      }
      break;
    }
    case 'sslrootcert':
      patch.rootCertPath = value;
      break;
    case 'sslcert':
      patch.clientCertPath = value;
      break;
    case 'sslkey':
      patch.clientKeyPath = value;
      break;
    case 'connect_timeout': {
      const seconds = wholeNumber(value, 1, 600);
      if (seconds !== undefined) {
        patch.connectTimeoutSeconds = seconds;
      }
      break;
    }
    case 'application_name':
    case 'fallback_application_name':
      patch.applicationName = value;
      break;
    case 'options': {
      const searchPath = /-c\s*search_path=([^\s]+)/i.exec(value);
      if (searchPath) {
        patch.searchPath = searchPath[1];
      } else {
        out.properties.push({ name: key, value });
      }
      break;
    }
    case 'target_session_attrs':
      patch.readOnly = value.toLowerCase() === 'read-only';
      break;
    default:
      out.properties.push({ name: key, value });
  }
}

function finishPostgres(out: PgAccumulator): ParsedConnection {
  // A client certificate with no password is certificate authentication.
  if (out.patch.clientCertPath && out.secret === undefined) {
    out.patch.pgAuth = 'certificate';
  } else if (out.secret !== undefined) {
    out.patch.pgAuth = 'password';
  }
  return { patch: out.patch, secret: out.secret, properties: out.properties, engine: 'PostgreSQL' };
}

