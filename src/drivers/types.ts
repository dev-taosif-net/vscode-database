import { ConnectionProfile } from '../types';
import { CellValue, ColumnMeta } from '../shared/query';

/**
 * Where a streamed statement puts what it produces.
 *
 * Rows arrive in batches rather than one at a time because a callback per row
 * across four million rows is four million callbacks; the driver fills a small
 * array and hands it over. Everything on this interface is synchronous and
 * must stay that way: it is called from a socket callback, and a sink that
 * awaited would let the next chunk arrive before the last one was recorded.
 */
export interface RowSink {
  /** One per result set, before any of its rows. */
  columns(columns: ColumnMeta[]): void;
  rows(rows: CellValue[][]): void;
  /** `PRINT`, `RAISERROR` below the error threshold, `RAISE NOTICE`. */
  message(level: 'info' | 'error', text: string, line?: number): void;
  /** The current result set ended. `affected` is absent for a `SELECT`. */
  complete(affected?: number): void;
  /**
   * How many more rows this sink still wants.
   *
   * The fetch ceiling lives here rather than in a `TOP` the extension writes,
   * because rewriting the user's statement changes what it means: a `TOP`
   * added around an `ORDER BY` in a view changes which rows come back, and one
   * added to a statement with an `OFFSET` is a syntax error. Returning zero
   * stops the read instead, and the rows already produced are kept.
   */
  wants(): number;
}

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

  /**
   * The database this session is in, as the server last reported it.
   *
   * Read from the server at open rather than copied off the profile, because a
   * profile that names no database lands on the login's default and only the
   * server knows what that was.
   */
  currentDatabase(): string;

  /**
   * Moves the session to another database.
   *
   * Rejects on an engine that cannot — see `switchesDatabase`. It exists as a
   * driver method rather than as a `USE` the caller writes, because the
   * statement is the engine's and the quoting rules are too: a database named
   * `my db` needs brackets, and a caller assembling that by hand is a caller
   * assembling an injection.
   */
  useDatabase(name: string): Promise<void>;

  /**
   * Called when the server reports the session moved to another database.
   *
   * This is a push rather than a poll for a reason worth stating: the only way
   * to know a `USE` buried in the middle of somebody's script took effect is
   * to be told, and SQL Server tells us — the change arrives as an ENVCHANGE
   * token on the same connection, before the batch finishes. Asking
   * `DB_NAME()` after every execution would be a round trip per Run to learn
   * something the server already said.
   */
  onDatabaseChange(listener: (database: string) => void): { dispose(): void };
  /** Positional parameters, in the engine's own placeholder syntax. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Runs one batch, handing rows to the sink as the server produces them.
   *
   * Phase 3's whole addition, and it costs neither driver anything new:
   * tedious already emits a `row` event per row and node-postgres already
   * emits one from a submitted `Query`. What changes is that nothing collects
   * them into an array first, which is the difference between a hundred
   * million rows and a heap the size of a hundred million rows.
   *
   * Resolves when the batch is finished, whether or not it produced anything.
   * Rejects only on a server error; a cancellation resolves, because the rows
   * already delivered are a real answer and throwing them away is the one
   * thing a person who cancels never wants.
   */
  stream(sql: string, params: unknown[] | undefined, sink: RowSink): Promise<StreamOutcome>;

  /**
   * Cancels whatever this session is running, out of band.
   *
   * A no-op when nothing is in flight. It has to be out of band because the
   * connection carrying the statement is the connection that would have to
   * carry the cancel, and it is busy: SQL Server has an attention signal for
   * exactly this, and PostgreSQL has a CancelRequest sent down a second
   * socket.
   */
  cancelCurrent(): void;

  close(): Promise<void>;
  isClosed(): boolean;
}

export interface StreamOutcome {
  cancelled: boolean;
  /** True when the sink asked for no more rows before the server ran out. */
  truncated: boolean;
}

export interface Driver {
  readonly kind: ConnectionProfile['driver'];
  open(profile: ConnectionProfile, secrets: ConnectSecrets, signal?: AbortSignal): Promise<OpenResult>;
}

/**
 * The smallest event a driver needs, so neither driver has to import `vscode`.
 *
 * Keeping the driver layer free of the workbench is what lets both of them be
 * reasoned about — and eventually tested — as plain socket code, and one
 * `EventEmitter` for one event is not worth breaking that for.
 */
export class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** The shape `describeFailure` reads as a cancellation rather than a fault. */
export function abortError(): Error {
  const error = new Error('The connection attempt was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * A driver property as typed in the editor, given the type the driver wants.
 *
 * The properties table is text, and `true`, `false` and `30000` have to reach
 * the driver as a boolean and a number rather than as three strings it would
 * refuse.
 */
export function coerceProperty(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}

/**
 * Thrown by a driver when the attempt failed for a reason worth explaining.
 * `code` is the driver's own code where there is one, so the mapper in
 * `errors.ts` can be precise rather than matching on message text alone.
 */
export class DriverError extends Error {
  /**
   * The line the server blamed, one-based and relative to the batch it was
   * sent. `ExecutionService` shifts it by the batch's own offset before it
   * reaches a document, because a batch four hundred lines down a file
   * reports its errors from line one.
   */
  line?: number;

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
