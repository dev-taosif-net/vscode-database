import { EditInfo } from '../shared/query';

/**
 * Where one result column was read from, as the engine reports it and before
 * any rule about editing is applied.
 *
 * The two engines answer the question differently — PostgreSQL in the row
 * description, SQL Server through `sp_describe_first_result_set` — and this is
 * the shape they both answer in, so the rules in `plan.ts` are written once.
 */
export interface SourceColumn {
  schema: string;
  table: string;
  column: string;
  identity: boolean;
  computed: boolean;
  rowversion: boolean;
  foreignKey: boolean;
}

export interface Provenance {
  /** Aligned with the set's columns; null where the column is an expression. */
  sources: (SourceColumn | null)[];
  /**
   * The columns that identify a row of the one source table, in key order.
   * Empty when the table has no primary key or unique index — or when the
   * columns come from more than one table, in which case there is no one
   * table to have a key.
   */
  keyColumns: string[];
  /** Why the engine says nothing here can be edited, when it says so. */
  refusal?: string;
}

/**
 * What the host keeps per result set once the question has been asked.
 *
 * `info` is what the grid is told. The rest is what the update needs and the
 * grid does not: which columns of the set are the key, and what each column
 * is called in the table — a `SELECT name AS n` writes to `name`.
 */
export interface EditPlan {
  info: EditInfo;
  /** Column indexes into the set, aligned with `info.keyColumns`. */
  keyIndexes: number[];
  /** The table column behind each set column, null for an expression. */
  sourceNames: (string | null)[];
}
