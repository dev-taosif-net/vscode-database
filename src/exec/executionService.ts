import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { BindingStore } from '../query/bindingStore';
import { CellValue, ColumnMeta, TableCursor, cellText } from '../shared/query';
import { effectiveDatabase, errorMessage } from '../types';
import { DriverSession, RowSink } from '../drivers/types';
import { PlanMode, isPlanColumn, parsePlan, wrapForPlan } from '../plan/planService';
import { ExecutionRecord, ResultStore, SetData } from './resultStore';
import { SessionPool } from './sessionPool';
import { Batch, splitBatches } from './splitter';
import { classify, confirmProductionWrite, readOnlyRefusal } from './guards';

/** How often a running execution tells the grid it has more rows. */
const PROGRESS_MS = 120;

/**
 * How long a superseded execution is given to settle after it is cancelled.
 *
 * A session runs one statement at a time, so a second Run on a tab cannot be
 * sent until the first has stopped. Both drivers settle a cancel within a
 * round trip; a server that takes longer than this is a server that is not
 * answering, and the lease is closed under it rather than waited on.
 */
const SETTLE_MS = 3000;

export interface RunOptions {
  /** The tab that owns this, as a URI string. It is also the pool's lease key. */
  tab: string;
  profileId: string;
  sql: string;
  source: 'query' | 'data' | 'runner';
  params?: unknown[];
  /** Rows per result set. Falls back to the connection's own setting. */
  limit?: number;
  plan?: PlanMode;
  table?: TableCursor;
  /** Paging does not belong in history; the query that opened the tab does. */
  quiet?: boolean;
}

export interface ExecutionChange {
  tab: string;
  executionId: string;
}

/**
 * Everything between pressing Run and there being rows.
 *
 * It owns the pipeline and deliberately not the storage: `ResultStore` holds
 * the rows, `SessionPool` holds the connections, and this holds the order
 * things happen in. Splitting it that way is what lets a tab be closed
 * mid-query — the pool releases the lease, the store drops the rows, and this
 * has nothing left to clean up.
 */
export class ExecutionService implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ExecutionChange>();
  /** Fires whenever an execution's shape changes: rows, a message, an end. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidFinishEmitter = new vscode.EventEmitter<ExecutionRecord>();
  /** Fires once, when an execution settles. Query history listens to this. */
  readonly onDidFinish = this.onDidFinishEmitter.event;

  /**
   * Tab to the execution running on it, and the promise that settles when it
   * has stopped.
   *
   * The promise is what makes a second Run safe. Two statements on one session
   * are a driver error at best, and a record that the old execution's `finally`
   * could delete from under the new one used to hide the Cancel button on a
   * query that was very much still running.
   */
  private readonly running = new Map<string, { id: string; settled: Promise<void> }>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly pool: SessionPool,
    private readonly results: ResultStore,
    private readonly bindings: BindingStore,
    private readonly output: vscode.LogOutputChannel
  ) {}

  /**
   * The database a tab runs in: where it has moved itself, or the profile's.
   *
   * The tab's own answer wins over the pool's, because the pool only has one
   * once a session exists and this is asked before the first Run — and it is
   * asked by the guard that decides whether to warn about production, which
   * must name the database the statement is about to reach rather than the one
   * a socket happens to be sitting in.
   */
  databaseFor(tab: string, profileId: string): string {
    const profile = this.store.get(profileId);
    const chosen = this.bindings.database(vscode.Uri.parse(tab)) ?? this.pool.databaseFor(tab);
    return profile ? effectiveDatabase(profile, chosen) : (chosen ?? '');
  }

  /**
   * Moves a tab to another database, the way running `USE` would.
   *
   * Two things happen and the order matters. The tab remembers where it is,
   * so the next session it opens starts there; and the session it already
   * holds is moved now, so the change is real before the user presses Run
   * rather than at the moment they do. A tab holding no session gets only the
   * first — opening a connection to answer a menu click would be a connection
   * the user did not ask for.
   */
  async moveTo(tab: string, profileId: string, database: string): Promise<void> {
    await this.bindings.setDatabase(vscode.Uri.parse(tab), database);
    if (this.pool.databaseFor(tab) !== undefined) {
      await this.pool.acquire(profileId, tab, database);
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.onDidFinishEmitter.dispose();
  }

  /** The rows a fetch stops at, from settings unless the caller overrode it. */
  defaultLimit(profileId: string): number {
    const profile = this.store.get(profileId);
    const configured = vscode.workspace.getConfiguration('databaseTools').get<number>('rowsPerFetch', 1000);
    return Math.max(1, profile?.rowsPerFetch || configured);
  }

  /**
   * Runs a statement and streams what it produces into the store.
   *
   * Batches run in order and stop at the first error. Everything the server
   * produced before that error is kept, because a script whose fourth
   * statement failed still ran three, and hiding their output would be hiding
   * what the database now contains.
   */
  async run(options: RunOptions): Promise<ExecutionRecord | undefined> {
    const profile = this.store.get(options.profileId);
    if (!profile) {
      void vscode.window.showErrorMessage('That connection no longer exists.');
      return undefined;
    }
    if (!this.manager.isConnected(profile.id)) {
      void vscode.window.showErrorMessage(`${profile.name || profile.host} is not connected.`);
      return undefined;
    }

    const refusal = readOnlyRefusal(profile, options.sql);
    if (refusal) {
      void vscode.window.showWarningMessage(refusal, 'Open the connection').then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('databaseTools.editConnection', profile.id);
        }
      });
      return undefined;
    }
    const database = this.databaseFor(options.tab, profile.id);
    if (!(await confirmProductionWrite(profile, options.sql, database))) {
      return undefined;
    }

    // A second Run on a tab replaces the first. Anything else would leave two
    // executions writing into one grid — or two statements on one session.
    await this.supersede(options.tab);

    const writes = classify(options.sql).writes.length > 0;
    const planMode = options.plan ?? 'none';
    const sent = wrapForPlan(profile.driver, options.sql, planMode, writes);

    const record = this.results.create({
      tab: options.tab,
      profileId: profile.id,
      connectionName: profile.name || profile.host,
      database,
      environment: profile.environment,
      readOnly: profile.readOnly,
      source: options.source,
      sql: options.sql,
      batchLines: [],
      table: options.table
    });
    let settle: () => void = () => undefined;
    const entry = { id: record.id, settled: new Promise<void>((resolve) => (settle = resolve)) };
    this.running.set(options.tab, entry);
    this.fire(record);

    const limit = options.limit ?? this.defaultLimit(profile.id);
    const batches = splitBatches(sent, profile.driver);
    record.batchLines = batches.map((batch) => batch.line);

    try {
      const session = await this.pool.acquire(profile.id, options.tab, database);
      this.pool.setBusy(options.tab, true);
      // Where the session actually landed, which is not always where it was
      // asked to go: a remembered database that has since been dropped leaves
      // the session in the one it opened in, and the record must say so.
      record.database = effectiveDatabase(profile, this.pool.databaseFor(options.tab));

      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const stop = await this.runBatch(record, session, batch, index, limit, options.params, planMode);
        if (stop) {
          break;
        }
      }

      if (record.status === 'running') {
        record.status = 'done';
      }
    } catch (error) {
      record.status = 'error';
      record.error = { level: 'error', text: errorMessage(error) };
      record.messages.push(record.error);
      this.output.error(`${profile.name}: ${errorMessage(error)}`);
    } finally {
      // Only if this execution is still the one the tab is running. A
      // superseded execution settles after its replacement has registered.
      if (this.running.get(options.tab) === entry) {
        this.pool.setBusy(options.tab, false);
        this.running.delete(options.tab);
      }
      // A `USE` anywhere in the script moves the session, and the record
      // belongs to where the statements ended up rather than where they began.
      record.database = effectiveDatabase(profile, this.pool.databaseFor(options.tab) ?? record.database);
      record.finishedAt = Date.now();
      settle();
      this.fire(record);
      if (!options.quiet) {
        this.onDidFinishEmitter.fire(record);
      }
    }

    return record;
  }

  /**
   * Stops whatever the tab is running and waits for it to have stopped.
   *
   * The wait is bounded. A cancel that the server never acknowledges would
   * otherwise block Run for ever, so after `SETTLE_MS` the lease is released —
   * which closes the socket and settles the old stream — and the new run opens
   * a fresh session.
   */
  private async supersede(tab: string): Promise<void> {
    const current = this.running.get(tab);
    if (!current) {
      return;
    }
    this.pool.cancel(tab);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SETTLE_MS);
    });
    const outcome = await Promise.race([current.settled.then(() => 'settled' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.output.warn(`${tab}: the running statement did not stop; its session is being closed.`);
      await this.pool.release(tab);
      this.running.delete(tab);
    }
  }

  /**
   * Re-announces a record whose shape was changed after it settled.
   *
   * The table view patches paging facts onto a finished record — whether there
   * is a next page, the key the next seek starts from, a server-side sort —
   * and a webview that heard the record finish a moment earlier would draw the
   * old facts until something else happened to redraw it.
   */
  notify(record: ExecutionRecord): void {
    this.fire(record);
  }

  /**
   * One batch, from `execSql` to the last row.
   *
   * Returns true when the caller should stop: an error, or a cancellation.
   */
  private async runBatch(
    record: ExecutionRecord,
    session: DriverSession,
    batch: Batch,
    index: number,
    limit: number,
    params: unknown[] | undefined,
    planMode: PlanMode
  ): Promise<boolean> {
    let current: SetData | undefined;
    /** True while the open set is the server's plan rather than an answer. */
    let planSet = false;
    let planRaw = '';
    let lastProgress = 0;

    const sink: RowSink = {
      columns: (columns: ColumnMeta[]) => {
        planSet = columns.length === 1 && isPlanColumn(columns[0].name);
        current = planSet ? undefined : this.results.openSet(record, columns);
        this.fire(record);
      },
      rows: (rows: CellValue[][]) => {
        if (planSet) {
          // The plan arrives as one cell of one row. It is not an answer to
          // the user's question, so it never becomes a result set they have to
          // click past to reach their rows.
          planRaw += cellText(rows[0]?.[0] ?? null);
          return;
        }
        if (!current) {
          return;
        }
        this.results.append(record, current, rows);
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_MS) {
          lastProgress = now;
          this.fire(record);
        }
      },
      message: (level, text, line) => {
        record.messages.push({ level, text, batch: index, line: documentLine(batch, line) });
      },
      complete: (affected?: number) => {
        if (current) {
          current.total = current.count;
          current = undefined;
        } else if (affected !== undefined && !planSet) {
          // A statement with no columns still produced an answer: how many
          // rows it changed. It gets an empty set so the count has somewhere
          // to live and the Messages tab can name it.
          const set = this.results.openSet(record, []);
          set.total = affected;
          record.messages.push({
            level: 'info',
            text: `(${affected.toLocaleString('en-US')} row${affected === 1 ? '' : 's'} affected)`,
            batch: index
          });
        }
        planSet = false;
      },
      wants: () => (planSet || !current ? Number.MAX_SAFE_INTEGER : limit - current.count)
    };

    try {
      const outcome = await session.stream(batch.text, params, sink);
      // The set that hit the ceiling has already been closed by `complete`, so
      // truncation is recorded by looking for the one that reached the limit
      // rather than by holding on to a reference that is now undefined.
      for (const set of record.sets) {
        if (outcome.truncated && set.count >= limit) {
          set.truncated = true;
        }
      }
      if (planRaw) {
        record.plan = parsePlan(this.driverOf(record), planRaw, planMode === 'actual');
      }
      if (outcome.cancelled) {
        record.status = 'cancelled';
        record.messages.push({
          level: 'info',
          text: `Cancelled after ${record.sets.reduce((n, s) => n + s.count, 0).toLocaleString('en-US')} rows. What was already fetched is kept.`
        });
        return true;
      }
      return false;
    } catch (error) {
      record.status = 'error';
      const line = (error as { line?: number }).line;
      record.error = {
        level: 'error',
        text: errorMessage(error),
        batch: index,
        line: documentLine(batch, line)
      };
      record.messages.push(record.error);
      return true;
    }
  }

  /** Stops whatever the tab is running. Rows already fetched stay. */
  async cancelTab(tab: string): Promise<void> {
    if (!this.running.has(tab)) {
      return;
    }
    this.pool.cancel(tab);
    // The driver resolves its own promise once the attention lands, so nothing
    // is awaited here: waiting would block the command on a server that may be
    // exactly why the user pressed Cancel.
  }

  cancel(executionId: string): void {
    const record = this.results.get(executionId);
    if (record) {
      void this.cancelTab(record.tab);
    }
  }

  /**
   * Runs the same statement again with a higher ceiling.
   *
   * It genuinely re-runs, and the button says so rather than implying more
   * rows are being read off a cursor that is still open. Holding a cursor
   * would mean holding a transaction on the server for as long as somebody
   * leaves a tab open, which is a far worse thing to do to a shared database
   * than running a query twice.
   */
  async fetchMore(executionId: string, all: boolean): Promise<void> {
    const record = this.results.get(executionId);
    if (!record) {
      return;
    }
    const fetched = record.sets.reduce((n, set) => n + set.count, 0);
    const step = this.defaultLimit(record.profileId);
    await this.run({
      tab: record.tab,
      profileId: record.profileId,
      sql: record.sql,
      source: record.source,
      table: record.table,
      limit: all ? Number.MAX_SAFE_INTEGER : fetched + step,
      quiet: true
    });
  }

  /** Releases everything a tab held. Called when the tab closes. */
  async closeTab(tab: string): Promise<void> {
    await this.cancelTab(tab);
    await this.pool.release(tab);
    this.results.dropTab(tab);
  }

  private driverOf(record: ExecutionRecord) {
    return this.store.get(record.profileId)?.driver ?? 'mssql';
  }

  private fire(record: ExecutionRecord): void {
    this.onDidChangeEmitter.fire({ tab: record.tab, executionId: record.id });
  }
}

/**
 * The line in the document, from the line the server blamed.
 *
 * A server counts from one inside the batch it was handed. A batch four
 * hundred lines down a file therefore reports every error as line 1, and the
 * squiggle lands on the wrong statement unless the batch's own offset is added
 * back — which is the whole reason `Batch` carries one.
 */
function documentLine(batch: Batch, line: number | undefined): number | undefined {
  if (line === undefined || line <= 0) {
    return undefined;
  }
  return batch.line + line;
}
