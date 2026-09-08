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

export type CopyShape = 'tsv' | 'tsv-headers' | 'csv' | 'json' | 'insert' | 'markdown';
export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'xlsx';

/* ------------------------------------------------------------------ wire */

export type QueryHostMessage =
  /** The active tab changed, or its execution did. `null` means show nothing. */
  | { type: 'project'; execution: ExecutionInfo | null }
  /** A window of rows. Never the whole result: the grid asks for what it draws. */
  | { type: 'rows'; executionId: string; setIndex: number; offset: number; rows: CellValue[][] }
  | { type: 'plan'; executionId: string; plan: PlanPayload }
  | { type: 'form'; form: RunnerForm }
  /** Runner only: the workbench's Run keybinding fired while this tab was active. */
  | { type: 'execute' }
  | { type: 'exported'; path: string; rows: number }
  | { type: 'copied'; cells: number }
  | { type: 'notice'; text: string; level: 'info' | 'error' };

export type QueryWebviewMessage =
  | { type: 'ready' }
  | { type: 'getRows'; executionId: string; setIndex: number; offset: number; count: number }
  | { type: 'sort'; executionId: string; setIndex: number; column: number; direction: 'asc' | 'desc' | null }
  | { type: 'filter'; executionId: string; text: string; server: boolean }
  | { type: 'cancel'; executionId: string }
  | { type: 'fetchMore'; executionId: string; all: boolean }
  | { type: 'page'; executionId: string; delta: number }
  | { type: 'pageSize'; executionId: string; size: number }
  | { type: 'refresh'; executionId: string }
  | { type: 'goToError'; executionId: string }
  | { type: 'export'; executionId: string; setIndex: number; format: ExportFormat }
  | { type: 'copy'; executionId: string; setIndex: number; range: CellRange; shape: CopyShape }
  | { type: 'run'; values: Record<string, RunnerValue> }
  | { type: 'openConnection'; profileId: string };
