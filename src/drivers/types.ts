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

/** A live session. Phase 1 only needs identity, the database list and close. */
export interface DriverSession {
  readonly profileId: string;
  listDatabases(): Promise<string[]>;
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
