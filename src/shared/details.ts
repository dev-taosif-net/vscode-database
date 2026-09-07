/**
 * The contract between the extension host and the two side bar webviews: the
 * object details panel and query history.
 *
 * Nothing here may import `vscode`, and nothing here holds a credential — the
 * same two rules `shared/sidebar.ts` states at the top of itself, for the same
 * reasons.
 */
import { DbMember, FavouriteRef, ObjectKind } from './catalog';
import { DriverKind, EnvironmentId } from '../types';

/**
 * A badge on the details panel.
 *
 * Every one is a fact with a statement behind it, and an engine without the
 * concept gets no badge rather than a greyed one — a greyed `Temporal` on a
 * PostgreSQL table says the table is not temporal, which is not what it means.
 */
export type TagId =
  | 'pk'
  | 'fk'
  | 'identity'
  | 'clustered'
  | 'heap'
  | 'trigger'
  | 'temporal'
  | 'partitioned'
  | 'unlogged'
  | 'materialized'
  | 'unique';

export interface Tag {
  id: TagId;
  label: string;
  /** Why it is here, shown on hover. */
  detail?: string;
}

/**
 * A fact with a value, or a fact the engine does not record.
 *
 * `value` being null is not "unknown" but "this server does not keep it" —
 * PostgreSQL genuinely does not record when a table was created, and a dash
 * with a reason is the truthful rendering. Guessing from a file timestamp
 * would be worse than blank.
 */
export interface Fact {
  label: string;
  value: string | null;
  /** Present when `value` is null, saying why. */
  absent?: string;
  /** True when the number is an estimate rather than a count. */
  approximate?: boolean;
}

export interface DependencyRef {
  kind: ObjectKind | 'constraint';
  schema: string;
  name: string;
  /** `foreign key`, `view`, `computed column`. */
  why: string;
  /**
   * True when this was found by searching source text rather than by asking
   * the catalog.
   *
   * PostgreSQL does not track what a routine body reads: a PL/pgSQL body is an
   * opaque string to the server, so a procedure that reads `customer`
   * registers no dependency at all. Rather than show an empty Used By and let
   * somebody conclude nothing uses their table before they drop it, the reader
   * falls back to a text search — and every row it finds that way is marked,
   * because a grep can match a name inside a comment.
   */
  inferred?: boolean;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** `CLUSTERED`, `NONCLUSTERED`, `btree`, `gin`. */
  kind: string;
}

export interface ObjectDetails {
  profileId: string;
  connectionName: string;
  environment: EnvironmentId;
  driver: DriverKind;
  ref: FavouriteRef;
  /** Absent while the facts are still being read. */
  facts?: Fact[];
  tags?: Tag[];
  columns?: DbMember[];
  indexes?: IndexInfo[];
  dependsOn?: DependencyRef[];
  usedBy?: DependencyRef[];
  /** Set when something could not be read, naming what. */
  error?: string;
}

/** One column that can page a table without OFFSET. */
export interface KeyColumns {
  columns: string[];
  /** False when the table has no key the sort can be extended with. */
  usable: boolean;
}

/* ------------------------------------------------------------------- wire */

export interface HistoryRow {
  id: string;
  profileId: string;
  connectionName: string;
  sql: string;
  at: number;
  durationMs: number;
  rows: number;
  status: 'done' | 'error' | 'cancelled';
  error?: string;
  redacted?: boolean;
}

export interface SavedRow {
  uri: string;
  name: string;
  connectionName?: string;
  description?: string;
}

export type PanelHostMessage =
  | { type: 'details'; details: ObjectDetails | null }
  | { type: 'history'; entries: HistoryRow[]; connections: { id: string; name: string; environment: EnvironmentId }[] }
  | { type: 'saved'; entries: SavedRow[] };

export type PanelWebviewMessage =
  | { type: 'ready' }
  | { type: 'expand'; section: 'columns' | 'indexes' | 'dependsOn' | 'usedBy' }
  | { type: 'action'; action: DetailsAction }
  | { type: 'openHistory'; id: string }
  | { type: 'copyHistory'; id: string }
  | { type: 'saveHistory'; id: string }
  | { type: 'clearHistory'; profileId?: string }
  | { type: 'filterHistory'; profileId?: string }
  | { type: 'openSaved'; uri: string };

export type DetailsAction =
  | 'viewData'
  | 'generateCrud'
  | 'scriptCreate'
  | 'scriptAlter'
  | 'scriptDrop'
  | 'dependencies'
  | 'compare'
  | 'run';
