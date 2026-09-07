import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { DriverSession } from '../drivers/types';

/**
 * How long an idle execution session is kept before it is closed.
 *
 * Long enough that running two queries a few minutes apart reuses the session,
 * and with it the temp tables and `SET` options the second one may depend on.
 * Short enough that a window left open overnight is not still holding four
 * connections per server in the morning.
 */
const IDLE_MS = 15 * 60 * 1000;

const SWEEP_MS = 60 * 1000;

interface Lease {
  session: DriverSession;
  profileId: string;
  /** The tab holding it, as a URI string. */
  owner: string;
  lastUsed: number;
  /** True while a statement is actually running on it. */
  busy: boolean;
}

/**
 * The sessions phase 3 runs statements on, and the reason it needs any.
 *
 * Phase 2 gave a profile exactly one session, and one session is strictly
 * serial: one statement in flight at a time. That is right for a catalog,
 * where every statement is a bounded read that returns in milliseconds. It is
 * wrong the moment a person can run their own SQL. A `SELECT` scanning a
 * hundred million rows would hold the only session for four minutes, and for
 * those four minutes expanding a folder would hang, the details panel would
 * hang, and IntelliSense would stop answering — and cancelling it would have
 * to cancel through the connection it was blocking.
 *
 * So the connection manager's session becomes the *control* session: catalog,
 * metadata, completion, object details. It is never leased out. Execution gets
 * its own sessions, opened on the first Run for a tab and kept for as long as
 * that tab wants them.
 *
 * Leases are per tab rather than per statement, and that is not an
 * optimisation. A temp table, a `SET` option, an open transaction and
 * `@@IDENTITY` all belong to a session; somebody who creates `#staging` in one
 * batch expects it in the next, and a pool that handed out a different
 * connection each time would break that in a way that looks like the server
 * losing data.
 */
export class SessionPool implements vscode.Disposable {
  private readonly leases = new Map<string, Lease>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: ConnectionManager,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    // A connection that closes takes its execution sessions with it. They are
    // sockets to a server the user has disconnected from; keeping them open
    // would mean Disconnect left four connections behind on the server.
    this.disposables.push(this.manager.onDidChange(() => void this.dropClosed()));
  }

  dispose(): void {
    clearInterval(this.sweeper);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    void this.closeAll();
  }

  /** How many execution sessions one connection may hold at once. */
  private get ceiling(): number {
    const value = vscode.workspace.getConfiguration('databaseTools').get<number>('executionSessions', 4);
    return Math.max(1, Math.min(16, Math.floor(value)));
  }

  /**
   * The session a tab runs on, opening one if this is its first statement.
   *
   * A tab that already holds a lease gets the same session back, every time,
   * for the reason in the class comment. A tab that does not gets a new one
   * unless the connection is already at its ceiling, in which case the least
   * recently used idle lease is taken over — and if every lease is busy, the
   * caller is told rather than queued, because a Run that silently waits on
   * another tab's four-minute query looks exactly like a Run that did nothing.
   */
  async acquire(profileId: string, owner: string): Promise<DriverSession> {
    const existing = this.leases.get(owner);
    if (existing && existing.profileId === profileId && !existing.session.isClosed()) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    if (existing) {
      // The tab was rebound to another connection, or its session died.
      await this.release(owner);
    }

    const mine = [...this.leases.values()].filter((lease) => lease.profileId === profileId);
    if (mine.length >= this.ceiling) {
      const spare = mine
        .filter((lease) => !lease.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!spare) {
        throw new Error(
          `All ${this.ceiling} execution sessions for this connection are busy. Cancel one, or raise databaseTools.executionSessions.`
        );
      }
      await this.release(spare.owner);
    }

    const session = await this.manager.openAuxiliary(profileId);
    this.leases.set(owner, { session, profileId, owner, lastUsed: Date.now(), busy: false });
    this.output.info(`Execution session opened for ${owner}`);
    return session;
  }

  /** Marks a lease as running, so the pool will not take it from under a query. */
  setBusy(owner: string, busy: boolean): void {
    const lease = this.leases.get(owner);
    if (lease) {
      lease.busy = busy;
      lease.lastUsed = Date.now();
    }
  }

  /** Cancels whatever the tab is running. Safe when it is running nothing. */
  cancel(owner: string): void {
    this.leases.get(owner)?.session.cancelCurrent();
  }

  isBusy(owner: string): boolean {
    return this.leases.get(owner)?.busy ?? false;
  }

  /** Closes a tab's session. Called when the tab closes, and by the sweeper. */
  async release(owner: string): Promise<void> {
    const lease = this.leases.get(owner);
    if (!lease) {
      return;
    }
    this.leases.delete(owner);
    if (lease.busy) {
      lease.session.cancelCurrent();
    }
    await lease.session.close().catch(() => undefined);
    this.output.info(`Execution session closed for ${owner}`);
  }

  /** Every session belonging to one connection. Used by Disconnect. */
  async releaseProfile(profileId: string): Promise<void> {
    const owners = [...this.leases.values()]
      .filter((lease) => lease.profileId === profileId)
      .map((lease) => lease.owner);
    await Promise.all(owners.map((owner) => this.release(owner)));
  }

  private async closeAll(): Promise<void> {
    await Promise.all([...this.leases.keys()].map((owner) => this.release(owner)));
  }

  private async dropClosed(): Promise<void> {
    const gone = [...this.leases.values()]
      .filter((lease) => !this.manager.isConnected(lease.profileId) || lease.session.isClosed())
      .map((lease) => lease.owner);
    await Promise.all(gone.map((owner) => this.release(owner)));
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_MS;
    const stale = [...this.leases.values()]
      .filter((lease) => !lease.busy && lease.lastUsed < cutoff)
      .map((lease) => lease.owner);
    await Promise.all(stale.map((owner) => this.release(owner)));
  }
}
