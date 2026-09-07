import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CellValue,
  ColumnMeta,
  ExecMessage,
  ExecutionInfo,
  ExecutionStatus,
  PlanPayload,
  ResultSetInfo,
  TableCursor,
  cellText,
  isTagged
} from '../shared/query';
import { EnvironmentId } from '../types';

/**
 * Rows a result set keeps in memory before it starts spilling.
 *
 * A hundred thousand rows of a dozen columns is roughly twenty megabytes,
 * which is a fair thing for one answer to cost and small enough that eight of
 * them fit inside a budget nobody notices. Past it the rows go to a file, and
 * the grid cannot tell the difference because it never holds more than a
 * screenful either way.
 */
const MEMORY_ROWS = 100_000;

/** How often the spill file records where it had got to. */
const INDEX_EVERY = 1_000;

/** Executions kept hydrated. Older ones keep their spill file and nothing else. */
const HYDRATED = 8;

interface SetData {
  columns: ColumnMeta[];
  /** The first `MEMORY_ROWS`, in arrival order. */
  rows: CellValue[][];
  count: number;
  truncated: boolean;
  total?: number;
  sort?: ResultSetInfo['sort'];
  /**
   * The order and subset the grid is currently showing, as indexes into
   * `rows`. Null means arrival order and everything.
   *
   * A view exists only over the in-memory rows, which is the whole reason
   * sorting a query the user wrote is labelled rather than silent: past the
   * spill there is no view to build, and pretending otherwise would present a
   * sorted thousand out of a streamed forty million as though it were the
   * answer.
   */
  view: number[] | null;
  spill?: { file: string; handle: number; offsets: number[]; bytes: number };
}

export interface ExecutionRecord {
  id: string;
  tab: string;
  profileId: string;
  connectionName: string;
  database: string;
  environment: EnvironmentId;
  readOnly: boolean;
  source: 'query' | 'data' | 'runner';
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  sets: SetData[];
  messages: ExecMessage[];
  error?: ExecMessage;
  plan?: PlanPayload;
  table?: TableCursor;
  outputs?: { name: string; value: CellValue }[];
  returnValue?: number;
  /** The SQL that produced it, for Fetch more and for the history entry. */
  sql: string;
  /** Where in the document each batch started, so an error finds its line. */
  batchLines: number[];
}

/**
 * Every row anybody has run, and the only place they live.
 *
 * The webviews hold a window and the host holds the answer. That split is what
 * makes switching tabs a projection rather than a re-execution, and it is what
 * lets a webview be disposed under memory pressure and rebuilt without asking
 * the server anything.
 */
export class ResultStore implements vscode.Disposable {
  private readonly records = new Map<string, ExecutionRecord>();
  /** Execution ids in the order they were last read, oldest first. */
  private readonly recency: string[] = [];
  private seq = 0;

  constructor(private readonly storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.sweepOrphans();
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) {
      this.drop(id);
    }
  }

  create(seed: Omit<ExecutionRecord, 'id' | 'sets' | 'messages' | 'status' | 'startedAt'>): ExecutionRecord {
    const id = `x${++this.seq}`;
    const record: ExecutionRecord = {
      ...seed,
      id,
      sets: [],
      messages: [],
      status: 'running',
      startedAt: Date.now()
    };
    this.records.set(id, record);
    this.touch(id);
    this.evict();
    return record;
  }

  get(id: string): ExecutionRecord | undefined {
    const record = this.records.get(id);
    if (record) {
      this.touch(id);
    }
    return record;
  }

  /** Every execution belonging to one tab, newest first. */
  forTab(tab: string): ExecutionRecord[] {
    return [...this.records.values()].filter((r) => r.tab === tab).sort((a, b) => b.startedAt - a.startedAt);
  }

  latestFor(tab: string): ExecutionRecord | undefined {
    return this.forTab(tab)[0];
  }

  drop(id: string): void {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    for (const set of record.sets) {
      closeSpill(set);
    }
    this.records.delete(id);
    const at = this.recency.indexOf(id);
    if (at !== -1) {
      this.recency.splice(at, 1);
    }
  }

  dropTab(tab: string): void {
    for (const record of this.forTab(tab)) {
      this.drop(record.id);
    }
  }

  dropProfile(profileId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.profileId === profileId) {
        this.drop(record.id);
      }
    }
  }

  /* --------------------------------------------------------------- writing */

  openSet(record: ExecutionRecord, columns: ColumnMeta[]): SetData {
    const set: SetData = { columns, rows: [], count: 0, truncated: false, view: null };
    record.sets.push(set);
    return set;
  }

  append(record: ExecutionRecord, set: SetData, rows: CellValue[][]): void {
    for (const row of rows) {
      if (set.rows.length < MEMORY_ROWS) {
        set.rows.push(row);
      } else {
        this.spill(record, set, row);
      }
      set.count++;
    }
  }

  private spill(record: ExecutionRecord, set: SetData, row: CellValue[]): void {
    if (!set.spill) {
      const file = path.join(this.storageDir, `${record.id}-${record.sets.indexOf(set)}.rows`);
      const handle = fs.openSync(file, 'w+');
      set.spill = { file, handle, offsets: [], bytes: 0 };
    }
    const spill = set.spill;
    const spilled = set.count - MEMORY_ROWS;
    if (spilled % INDEX_EVERY === 0) {
      // One offset every thousand rows, so seeking to row four million is a
      // seek plus a scan of at most a thousand lines rather than a scan of
      // four million.
      spill.offsets.push(spill.bytes);
    }
    const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
    fs.writeSync(spill.handle, line, 0, line.length, spill.bytes);
    spill.bytes += line.length;
  }

  /* --------------------------------------------------------------- reading */

  /**
   * A window of rows, in whatever order the current view says.
   *
   * The grid asks for what it is about to draw and forgets what scrolls away,
   * so this is called constantly and has to be cheap. It is: in the ordinary
   * case it is a slice of an array.
   */
  async read(set: SetData, offset: number, count: number): Promise<CellValue[][]> {
    if (offset < 0 || count <= 0) {
      return [];
    }
    if (set.view) {
      const slice = set.view.slice(offset, offset + count);
      return slice.map((i) => set.rows[i] ?? []);
    }
    const out: CellValue[][] = [];
    const fromMemory = Math.min(Math.max(0, MEMORY_ROWS - offset), count);
    if (offset < set.rows.length) {
      out.push(...set.rows.slice(offset, offset + Math.min(count, fromMemory)));
    }
    const stillWanted = count - out.length;
    if (stillWanted > 0 && set.spill) {
      const from = Math.max(offset, MEMORY_ROWS) - MEMORY_ROWS;
      out.push(...(await readSpill(set.spill, from, stillWanted)));
    }
    return out;
  }

  /** Every row, for an export. Yields in pages so nothing is materialised. */
  async *readAll(set: SetData, pageSize = 5_000): AsyncGenerator<CellValue[][]> {
    const total = set.view ? set.view.length : set.count;
    for (let offset = 0; offset < total; offset += pageSize) {
      yield await this.read(set, offset, Math.min(pageSize, total - offset));
    }
  }

  /** How many rows the grid should draw, which is not always how many exist. */
  visibleCount(set: SetData): number {
    return set.view ? set.view.length : set.count;
  }

  /* --------------------------------------------------------- view controls */

  /**
   * Whether a client-side sort or filter can be honest about this set.
   *
   * It can only reorder what it holds. Past the spill it holds a prefix, and a
   * prefix sorted and presented as the answer is the bug this guards.
   */
  canReorder(set: SetData): boolean {
    return set.count <= set.rows.length;
  }

  sort(set: SetData, column: number, direction: 'asc' | 'desc' | null): void {
    if (direction === null) {
      set.sort = undefined;
      set.view = set.view ? indexesOf(set.rows, () => true) : null;
      return;
    }
    if (!this.canReorder(set)) {
      return;
    }
    const kind = set.columns[column]?.kind ?? 'text';
    const base = set.view ?? indexesOf(set.rows, () => true);
    const sign = direction === 'asc' ? 1 : -1;
    base.sort((a, b) => sign * compare(set.rows[a]?.[column] ?? null, set.rows[b]?.[column] ?? null, kind));
    set.view = base;
    set.sort = { column, direction, server: false };
  }

  filter(set: SetData, text: string): void {
    const needle = text.trim().toLowerCase();
    if (!needle) {
      set.view = null;
      if (set.sort && !set.sort.server) {
        this.sort(set, set.sort.column, set.sort.direction);
      }
      return;
    }
    if (!this.canReorder(set)) {
      return;
    }
    set.view = indexesOf(set.rows, (row) => row.some((cell) => cellText(cell).toLowerCase().includes(needle)));
    if (set.sort && !set.sort.server) {
      const sort = set.sort;
      this.sort(set, sort.column, sort.direction);
    }
  }

  /* ------------------------------------------------------------ projection */

  /** What the webview is told. Rows are not in it; the grid asks for those. */
  project(record: ExecutionRecord): ExecutionInfo {
    return {
      id: record.id,
      tab: record.tab,
      profileId: record.profileId,
      connectionName: record.connectionName,
      database: record.database,
      environment: record.environment,
      readOnly: record.readOnly,
      status: record.status,
      startedAt: record.startedAt,
      elapsedMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      rowsFetched: record.sets.reduce((sum, set) => sum + set.count, 0),
      rowsAffected: record.sets.reduce<number | undefined>(
        (sum, set) => (set.columns.length === 0 && set.total !== undefined ? (sum ?? 0) + set.total : sum),
        undefined
      ),
      sets: record.sets.map((set, index) => ({
        index,
        columns: set.columns,
        rowCount: this.visibleCount(set),
        total: set.total,
        truncated: set.truncated,
        sort: set.sort
      })),
      messages: record.messages,
      error: record.error,
      hasPlan: Boolean(record.plan),
      source: record.source,
      table: record.table,
      outputs: record.outputs,
      returnValue: record.returnValue
    };
  }

  /* ---------------------------------------------------------------- upkeep */

  private touch(id: string): void {
    const at = this.recency.indexOf(id);
    if (at !== -1) {
      this.recency.splice(at, 1);
    }
    this.recency.push(id);
  }

  /**
   * Keeps the eight most recently looked-at executions and drops the rest.
   *
   * A running execution is never evicted, however old it looks: it is still
   * being written to, and dropping it would lose the rows arriving now.
   */
  private evict(): void {
    while (this.recency.length > HYDRATED) {
      const oldest = this.recency.find((id) => this.records.get(id)?.status !== 'running');
      if (!oldest) {
        return;
      }
      this.drop(oldest);
    }
  }

  /**
   * Spill files from a window that crashed.
   *
   * Nothing else deletes them: a process that is killed does not run its
   * disposables, and the directory would otherwise grow by one file per large
   * query, for ever.
   */
  private sweepOrphans(): void {
    try {
      for (const name of fs.readdirSync(this.storageDir)) {
        if (name.endsWith('.rows')) {
          fs.unlinkSync(path.join(this.storageDir, name));
        }
      }
    } catch {
      // A storage directory that cannot be read is a storage directory that
      // will fail loudly the first time something spills into it.
    }
  }
}

/* ------------------------------------------------------------------ helpers */

function indexesOf(rows: CellValue[][], keep: (row: CellValue[]) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (keep(rows[i])) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Comparison follows the column's declared type, not the value's.
 *
 * A numeric column sorted as text puts 10 before 9, and a column that decided
 * from its first row would sort correctly until the first row was null.
 */
function compare(a: CellValue, b: CellValue, kind: ColumnMeta['kind']): number {
  if (a === null && b === null) {
    return 0;
  }
  // Nulls sort first ascending, which is what both engines do by default on
  // SQL Server and what `NULLS FIRST` means on PostgreSQL.
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  if (kind === 'number') {
    return Number(numeric(a)) - Number(numeric(b));
  }
  if (kind === 'bool') {
    return Number(a) - Number(b);
  }
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' });
}

function numeric(value: CellValue): number {
  if (typeof value === 'number') {
    return value;
  }
  if (isTagged(value)) {
    return Number(value.v);
  }
  return Number(value);
}

function closeSpill(set: SetData): void {
  if (!set.spill) {
    return;
  }
  try {
    fs.closeSync(set.spill.handle);
  } catch {
    // Already closed.
  }
  try {
    fs.unlinkSync(set.spill.file);
  } catch {
    // Already gone.
  }
  set.spill = undefined;
}

/**
 * Rows out of the spill file, starting at a row number relative to the file.
 *
 * It seeks to the nearest index entry at or before the row, then scans
 * forward. The scan is bounded by `INDEX_EVERY`, so the cost of reading row
 * nine million is the cost of reading row nine thousand.
 */
async function readSpill(
  spill: NonNullable<SetData['spill']>,
  from: number,
  count: number
): Promise<CellValue[][]> {
  const bucket = Math.floor(from / INDEX_EVERY);
  const start = spill.offsets[bucket];
  if (start === undefined) {
    return [];
  }
  let skip = from - bucket * INDEX_EVERY;
  const out: CellValue[][] = [];
  let position = start;
  let carry = '';

  while (out.length < count && position < spill.bytes) {
    const size = Math.min(1 << 16, spill.bytes - position);
    const buffer = Buffer.allocUnsafe(size);
    const read = fs.readSync(spill.handle, buffer, 0, size, position);
    if (read <= 0) {
      break;
    }
    position += read;
    carry += buffer.toString('utf8', 0, read);

    let newline = carry.indexOf('\n');
    while (newline !== -1 && out.length < count) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      if (skip > 0) {
        skip--;
      } else if (line) {
        try {
          out.push(JSON.parse(line) as CellValue[]);
        } catch {
          // A truncated last line, which can only happen if the process died
          // mid-write. Everything before it is still good.
        }
      }
      newline = carry.indexOf('\n');
    }
  }
  return out;
}

export type { SetData };
