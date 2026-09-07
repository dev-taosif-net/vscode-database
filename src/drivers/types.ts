import { ConnectionProfile } from '../types';

/** What a driver needs beyond the profile to actually open a socket. */
export interface ConnectSecrets {
  /** Password, or the passphrase for a client key. */
  password?: string;
  /** An Entra access token for the SQL Server audience. */
  accessToken?: string;
}

export interface OpenResult {
  session: DriverSession;
  serverVersion: string;
  principal: string;
  latencyMs: number;
  /** True when the driver confirmed the session is read-only. */
  readOnlyApplied: boolean;
}

/**
 * A live session.
 *
 * `query` is the whole of phase 2's addition, and it is deliberately the
 * smallest one that works: a statement and its parameters in, rows out. There
 * is no cursor, no streaming and no result metadata, because the only caller is
 * the catalog and every catalog statement is a bounded read that the server
 * answers in one go. A result grid needs all three and will bring them.
 *
 * Placeholders are the engine's own — `@p0` for SQL Server, `$1` for
 * PostgreSQL — because the catalog SQL is written per engine anyway and a
 * portable placeholder dialect would be a translation layer serving nobody.
 */
export interface DriverSession {
  readonly profileId: string;
  listDatabases(): Promise<string[]>;
  /** Positional parameters, in the engine's own placeholder syntax. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface Driver {
  readonly kind: ConnectionProfile['driver'];
  open(profile: ConnectionProfile, secrets: ConnectSecrets, signal?: AbortSignal): Promise<OpenResult>;
}

/**
 * Thrown by a driver when the attempt failed for a reason worth explaining.
 * `code` is the driver's own code where there is one, so the mapper in
 * `errors.ts` can be precise rather than matching on message text alone.
 */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly number: number | undefined,
    readonly state: string | undefined,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
