import { ConnectionFailure, ConnectionProfile, FailureAction } from '../types';
import { DriverError } from './types';

const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED'
]);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ETIMEOUT',
  'ESOCKETTIMEOUT'
]);

const COPY: FailureAction = { id: 'copyError', label: 'Copy the driver error' };

/**
 * Turns a driver failure into something a person can act on: what the server
 * said, what that usually means here, and the safe fix first. Trusting a
 * certificate without checking it is always last, and always marked as
 * weakening.
 */
export function describeFailure(profile: ConnectionProfile, error: unknown): ConnectionFailure {
  const raw = messageOf(error);
  const code = codeOf(error);
  const number = numberOf(error);
  const text = raw.toLowerCase();
  const address = profile.host + (profile.port ? `:${profile.port}` : '');

  if (isAbort(error)) {
    return {
      kind: 'cancelled',
      title: 'The test was cancelled.',
      detail: 'Nothing was left open.',
      actions: [],
      raw
    };
  }

  if (isCertificateFailure(code, text)) {
    const actions: FailureAction[] = [
      { id: 'openCertificateDocs', label: 'How to add the authority to the trust store' },
      COPY,
      { id: 'trustOnce', label: 'Trust it for this connection only', weakening: true }
    ];
    const policy =
      profile.driver === 'mssql'
        ? `Encrypt is set to ${profile.encrypt === 'strict' ? 'Strict' : 'Mandatory'}`
        : `sslmode is ${profile.sslMode}`;
    return {
      kind: 'certificate',
      title: 'The server certificate could not be validated.',
      detail:
        `${profile.host} presented a certificate this machine does not trust. ${policy}, so the driver ` +
        'refused the connection rather than falling back to plain text. Adding the issuing authority to the ' +
        'machine trust store keeps the connection verified; trusting it here does not.',
      actions,
      raw
    };
  }

  // SQL Server states 38 and 40 both mean the login is fine but the database
  // is not reachable for it, which is a different fix from a bad password.
  const state = stateOf(error);
  if (number === 18456) {
    const missingDatabase = state === '38' || state === '40';
    return {
      kind: missingDatabase ? 'database' : 'login',
      title: `The server refused the login${profile.user ? ` for ${profile.user}` : ''}.`,
      detail: missingDatabase
        ? `Error 18456, state ${state}. The credential was accepted, but the login has no access to ` +
          `${profile.database || 'that database'}. Either the name is wrong or the login was never mapped to a ` +
          'user inside it.'
        : `Error 18456${state ? `, state ${state}` : ''}. The server did not accept the credential.`,
      actions: missingDatabase
        ? [{ id: 'useDefaultDatabase', label: 'Connect to the default database instead' }, COPY]
        : [{ id: 'clearCredential', label: 'Clear the stored credential and ask again' }, COPY],
      raw
    };
  }

  // PostgreSQL SQLSTATEs: 28P01 bad password, 28000 bad authorisation,
  // 3D000 no such database.
  if (code === '28P01' || code === '28000') {
    return {
      kind: 'login',
      title: `The server refused the login${profile.user ? ` for ${profile.user}` : ''}.`,
      detail: `SQLSTATE ${code}. The server did not accept the credential for this role.`,
      actions: [{ id: 'clearCredential', label: 'Clear the stored credential and ask again' }, COPY],
      raw
    };
  }

  if (code === '3D000') {
    return {
      kind: 'database',
      title: `The database ${profile.database} does not exist on this server.`,
      detail: 'The login was accepted, so the server and the credential are both fine.',
      actions: [{ id: 'useDefaultDatabase', label: 'Connect to the default database instead' }, COPY],
      raw
    };
  }

  if (isUnreachable(code, text)) {
    const dns = code === 'ENOTFOUND' || code === 'EAI_AGAIN';
    return {
      kind: 'unreachable',
      title: dns
        ? `The name ${profile.host} could not be resolved.`
        : `No answer from ${address} after ${profile.connectTimeoutSeconds} seconds.`,
      detail: dns
        ? 'Nothing was contacted, so this is a name resolution problem rather than a database one. Check the ' +
          'spelling, and whether this machine is on the network that knows the name.'
        : 'The address resolved but nothing accepted the connection. On a corporate address this usually means ' +
          'the network is not reachable from here.',
      actions: [{ id: 'retryLongerTimeout', label: 'Retry with a 60 second timeout' }, COPY],
      raw
    };
  }

  return {
    kind: 'unknown',
    title: 'The connection could not be opened.',
    detail: raw,
    actions: [COPY],
    raw
  };
}

function isCertificateFailure(code: string | undefined, text: string): boolean {
  if (code && CERT_CODES.has(code)) {
    return true;
  }
  return (
    text.includes('self signed certificate') ||
    text.includes('self-signed certificate') ||
    text.includes('unable to verify the first certificate') ||
    text.includes('certificate chain') ||
    text.includes('altname') ||
    (text.includes('certificate') && text.includes('trust'))
  );
}

function isUnreachable(code: string | undefined, text: string): boolean {
  if (code && UNREACHABLE_CODES.has(code)) {
    return true;
  }
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('could not connect') ||
    text.includes('connection refused') ||
    text.includes('getaddrinfo')
  );
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // tedious nests the interesting message one level down more often than not.
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof DriverError && error.code) {
    return error.code;
  }
  const direct = readString(error, 'code');
  if (direct) {
    return direct;
  }
  const cause = (error as { cause?: unknown })?.cause;
  return readString(cause, 'code');
}

function numberOf(error: unknown): number | undefined {
  if (error instanceof DriverError && error.number !== undefined) {
    return error.number;
  }
  const value = (error as { number?: unknown })?.number;
  return typeof value === 'number' ? value : undefined;
}

function stateOf(error: unknown): string | undefined {
  if (error instanceof DriverError && error.state !== undefined) {
    return error.state;
  }
  const value = (error as { state?: unknown })?.state;
  if (typeof value === 'number') {
    return String(value);
  }
  return typeof value === 'string' ? value : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (value && typeof value === 'object' && key in value) {
    const found = (value as Record<string, unknown>)[key];
    return typeof found === 'string' ? found : undefined;
  }
  return undefined;
}
