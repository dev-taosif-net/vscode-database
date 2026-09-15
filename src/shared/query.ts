/**
 * The contract between the extension host and the three grid-bearing webviews:
 * the results panel, a table data tab, and a procedure runner.
 *
 * Both sides compile against this file, so a message that changes shape breaks
 * the build rather than the grid. Nothing here may import `vscode`: a webview
 * is a browser and has no access to it. Nothing here holds a credential
 * either — a grid that draws rows has no business carrying a login.
 */
import { EnvironmentId } from '../types';
import { FavouriteRef } from './catalog';

/* ------------------------------------------------------------------ cells */

/**
 * How a column is drawn and how its values are compared.
 *
 * Alignment is a property of the type, not of the value: a numeric column with
 * a null in it still right-aligns, and a column that decided its alignment
 * from the first row would jump when the first row was the null.
 */
export type ColumnKind = 'number' | 'text' | 'date' | 'bool' | 'binary' | 'json' | 'other';

export interface ColumnMeta {
  name: string;
  /** The engine's own type name, rendered: `nvarchar(200)`, `numeric(18,2)`. */
  type: string;
  kind: ColumnKind;
  /**
   * Whether the column admits `NULL`, where the engine says so. SQL Server
   * reports it with the column; PostgreSQL only knows it for a column read
   * straight from a table, and fills it in once the statement has finished.
   * Absent means unknown, which is drawn as neither.
   */
  nullable?: boolean;
  /**
   * The table column this was read straight from, where the engine says so at
   * no cost. PostgreSQL names the relation and attribute in every row
   * description; SQL Server says nothing until asked, and is asked lazily by
   * the edit path. A computed value or an expression has no origin.
   */
  origin?: { relation: string; column: number };
}

/**
 * A value that has survived structured cloning intact, or a tag standing in
 * for one that would not have.
 *
 * `bigint` does not clone at all in every host, a `Buffer` arrives as an
 * unusable object, and a `Date` arrives as a `Date` whose rendering then
 * depends on the viewer's locale — which is how a `datetime2` becomes a
 * different instant between the grid and the CSV. So each of the three is
 * tagged and carries its own text, chosen by the driver that read it, and
 * nothing downstream has to guess.
 */
export interface TaggedValue {
  t: 'n64' | 'bin' | 'ts';
  v: string;
  /** Binary only: how many bytes there were before truncation. */
  n?: number;
}

export type CellValue = string | number | boolean | null | TaggedValue;

export function isTagged(value: CellValue): value is TaggedValue {
  return typeof value === 'object' && value !== null;
}

/** The text a cell shows and the text a copy or an export writes. */
export function cellText(value: CellValue): string {
  if (value === null) {
    return '';
  }
  if (isTagged(value)) {
    return value.v;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

/* -------------------------------------------------------------- execution */

export type ExecutionStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface ExecMessage {
  level: 'info' | 'error';
  text: string;
  /** Which batch produced it, and where in the document that batch started. */
  batch?: number;
  /** One-based, in the whole document rather than in the batch. */
  line?: number;
}

export interface ResultSetInfo {
  index: number;
  columns: ColumnMeta[];
  /** Rows the host holds. Grows while a query streams. */
  rowCount: number;
  /** How many there are in total, where that is knowable. */
  total?: number;
  /** The fetch ceiling stopped this short of the end. */
  truncated: boolean;
  /**
   * `server` is the whole honesty of sorting. A table data view re-issues its
   * query with `ORDER BY` and is exact; a query the user wrote can only sort
   * the rows already fetched, and the header has to say so.
   */
  sort?: { column: number; direction: 'asc' | 'desc'; server: boolean };
  /**
   * Whether cells of this set can be written back, and which. Absent until
   * somebody first tries to edit: working it out costs a catalog read, and a
   * result nobody edits should cost nothing beyond its rows.
   */
  edit?: EditInfo;
}

/* ----------------------------------------------------------------- editing */

/** Why one column of an editable set is not itself editable. */
export type LockReason = 'key' | 'foreignKey' | 'identity' | 'computed' | 'rowversion' | 'expression' | 'binary';

export const LOCK_LABELS: Record<LockReason, string> = {
  key: 'Primary key columns are not edited in place',
  foreignKey: 'Foreign key columns are not edited in place',
  identity: 'Identity columns are assigned by the server',
  computed: 'Computed columns are derived by the server',
  rowversion: 'Row version columns are maintained by the server',
  expression: 'This column is an expression, not a table column',
  binary: 'Binary columns cannot be edited as text'
};

/**
 * How a result set may be written back.
 *
 * `editable` false comes with the reason in words, because "you cannot edit
 * this" is a sentence that needs a second half: the result joins two tables,
 * or its table has no primary key, or the connection is read-only. `locks`
 * is aligned with the set's columns and is null where a cell may be typed
 * into.
 */
export interface EditInfo {
  editable: boolean;
  reason?: string;
  /** The table the edits go to. */
  target?: { schema: string; name: string };
  /** The columns that identify a row, by name. Every one is in the set. */
  keyColumns: string[];
  locks: (LockReason | null)[];
}

/** Table data only: what paging is possible and where it has got to. */
export interface TableCursor {
  ref: FavouriteRef;
  /** The approximate row count, from statistics rather than from COUNT(*). */
  estimate?: number;
  /** True when a key was found and paging is keyset rather than OFFSET. */
  keyset: boolean;
  pageSize: number;
  /** Zero-based. */
  page: number;
  /** False once a page comes back short. */
  hasMore: boolean;
  filter?: string;
  /**
   * The columns the filter is matched against, by name. Absent or empty means
   * every searchable column, which is what the filter did before it could be
   * narrowed and is still what a person means when they have not said.
   */
  filterColumns?: string[];
  /**
   * The key values the last page ended on, so the next one can seek rather
   * than skip. Absent on the first page, and on any page reached by a jump
   * rather than by walking forward.
   */
  after?: CellValue[];
  /** The column the user sorted by, which is what turns keyset off. */
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface ExecutionInfo {
  id: string;
  /** The tab that owns it, as a URI string. */
  tab: string;
  profileId: string;
  connectionName: string;
  database: string;
  environment: EnvironmentId;
  readOnly: boolean;
  status: ExecutionStatus;
  startedAt: number;
  elapsedMs: number;
  rowsFetched: number;
  rowsAffected?: number;
  sets: ResultSetInfo[];
  messages: ExecMessage[];
  error?: ExecMessage;
  hasPlan: boolean;
  source: 'query' | 'data' | 'runner';
  table?: TableCursor;
  /** Runner only: what came back that is not a result set. */
  outputs?: { name: string; value: CellValue }[];
  returnValue?: number;
}

/* ------------------------------------------------------------------- plan */

export interface PlanNode {
  id: string;
  /** `Index Seek`, `Hash Join`, `Seq Scan`. */
  operation: string;
  /** `Inner Join`, `Lookup` — absent where the engine has no second name. */
  detail?: string;
  /** The index or relation this operator touches. */
  object?: string;
  /** Share of the whole plan, 0 to 1. */
  cost: number;
  estimatedRows?: number;
  actualRows?: number;
  executions?: number;
  warnings: string[];
  children: PlanNode[];
}

export interface PlanPayload {
  root: PlanNode | null;
  raw: string;
  /** `SET STATISTICS IO` output, or the EXPLAIN summary lines. */
  stats: { label: string; value: string }[];
  warnings: string[];
  actual: boolean;
}

/* ----------------------------------------------------------------- runner */

export type RunnerControl = 'text' | 'number' | 'bool' | 'date' | 'choice' | 'multiline';

export interface RunnerParameter {
  name: string;
  /** The label, with the `@` dropped and the casing opened out. */
  label: string;
  type: string;
  control: RunnerControl;
  nullable: boolean;
  required: boolean;
  /** Rendered default, where the routine declares one. */
  defaultText?: string;
  choices?: string[];
  direction: 'in' | 'out' | 'inout';
}

export interface RunnerForm {
  ref: FavouriteRef;
  parameters: RunnerParameter[];
  /** The last values used against this connection, if any. */
  values: Record<string, RunnerValue>;
}

/** `null` is a value, not an absence: the two are different arguments. */
export type RunnerValue = { null: true } | { null: false; text: string };

/* ------------------------------------------------------------- selections */

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type CopyShape = 'headers' | 'tsv' | 'tsv-headers' | 'csv' | 'json' | 'insert' | 'markdown';
export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'xlsx';

/* ------------------------------------------------------------------ wire */

/**
 * The connection a query tab is bound to, as the status strip prints it.
 *
 * Sent beside the execution rather than read off it, so the strip has a
 * connection to name before the first Run and keeps the right one when the
 * tab is rebound or a `USE` moves it after the last record was written.
 */
export interface TabConnection {
  profileId: string;
  name: string;
  /** The first label of the host, as the strip has room for. */
  server: string;
  /** Login, role or signed-in account; blank when the method has none. */
  login: string;
  database: string;
  environment: EnvironmentId;
  readOnly: boolean;
}

/**
 * The query tab the results panel is showing for, whether or not it has run
 * anything. `connection` is null for a `.sql` file nobody has bound yet.
 */
export interface TabContext {
  tab: string;
  connection: TabConnection | null;
  /**
   * True for a tab that draws its own rows — a table data view, a procedure
   * runner. The results panel then shows nothing for it rather than the same
   * grid a second time.
   */
  inline?: boolean;
}

export type QueryHostMessage =
  /**
   * The active tab changed, or its execution did. A null execution means no
   * grid; a null context means the tab is not a query tab, so no strip either.
   */
  | { type: 'project'; execution: ExecutionInfo | null; context: TabContext | null }
  /** A window of rows. Never the whole result: the grid asks for what it draws. */
  | { type: 'rows'; executionId: string; setIndex: number; offset: number; rows: CellValue[][] }
  | { type: 'plan'; executionId: string; plan: PlanPayload }
  | { type: 'form'; form: RunnerForm }
  /** Runner only: the workbench's Run keybinding fired while this tab was active. */
  | { type: 'execute' }
  | { type: 'exported'; path: string; rows: number }
  | { type: 'copied'; cells: number }
  | { type: 'notice'; text: string; level: 'info' | 'error' }
  /**
   * One edit settled. On success `value` is what the server now holds for the
   * cell, which is not always what was typed: a trigger, a default, a
   * collation or a rounding may have had the last word. On failure the cell
   * keeps what it had and `error` says what the server said.
   */
  | {
      type: 'cell';
      executionId: string;
      setIndex: number;
      row: number;
      column: number;
      ok: boolean;
      value?: CellValue;
      error?: string;
    };

export type QueryWebviewMessage =
  | { type: 'ready' }
  | { type: 'getRows'; executionId: string; setIndex: number; offset: number; count: number }
  | { type: 'sort'; executionId: string; setIndex: number; column: number; direction: 'asc' | 'desc' | null }
  | { type: 'filter'; executionId: string; text: string; server: boolean; columns?: string[] }
  | { type: 'cancel'; executionId: string }
  | { type: 'fetchMore'; executionId: string; all: boolean }
  | { type: 'page'; executionId: string; delta: number }
  | { type: 'pageSize'; executionId: string; size: number }
  | { type: 'refresh'; executionId: string }
  | { type: 'goToError'; executionId: string }
  | { type: 'export'; executionId: string; setIndex: number; format: ExportFormat }
  | { type: 'copy'; executionId: string; setIndex: number; range: CellRange; shape: CopyShape }
  | { type: 'run'; values: Record<string, RunnerValue> }
  | { type: 'openConnection'; profileId: string }
  /** The first attempt to edit a set: work out whether it can be, and re-project. */
  | { type: 'describeEdit'; executionId: string; setIndex: number }
  /**
   * Write one cell back. `row` is the grid's row, which the host maps through
   * its sort or filter view; `value` is the typed text, or null for NULL.
   */
  | { type: 'updateCell'; executionId: string; setIndex: number; row: number; column: number; value: string | null };
