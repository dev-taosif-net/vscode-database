import { CellValue, ColumnMeta, isTagged } from '../shared/query';
import { DriverKind } from '../types';
import { qualified, quote } from '../catalog/script';

export interface UpdateArgs {
  target: { schema: string; name: string };
  /** The table column being written, and the set column it is shown as. */
  column: { name: string; meta: ColumnMeta };
  /** The typed text, or null for NULL. */
  value: string | null;
  /** The row's key, in key order. No value here may be null. */
  keys: { name: string; value: CellValue }[];
  /**
   * What the cell held when it was fetched, when that can be compared. Adding
   * it to the WHERE is what turns "overwrite whatever is there now" into "write
   * only if nobody else has" — the cheapest possible optimistic lock, and one
   * that costs nothing on the common path because the key seek finds the row
   * either way.
   */
  expected?: { value: CellValue };
}

export interface UpdateSql {
  sql: string;
  params: unknown[];
  /**
   * The statement with its values written in, for the Messages tab and for
   * history. Never executed: the one that runs is `sql`, with every value
   * bound. This exists because "1 row affected" under a placeholder is not an
   * audit trail, and a person checking what they did needs to read the value.
   */
  display: string;
}

/**
 * One cell, written back.
 *
 * Both forms answer with the row count and the value the server now holds,
 * in one round trip. PostgreSQL has `RETURNING` for that. SQL Server's
 * `OUTPUT` would do the same but refuses on any table with a trigger, so the
 * value is read back with a second statement in the same batch instead —
 * one round trip either way, and one that works on every table.
 */
export function updateCellSql(driver: DriverKind, args: UpdateArgs): UpdateSql {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return driver === 'mssql' ? `@p${params.length - 1}` : `$${params.length}`;
  };

  const target = qualified(driver, args.target);
  const column = quote(driver, args.column.name);
  const assignment = `${column} = ${bind(args.value)}`;

  const where: string[] = args.keys.map((key) => `${quote(driver, key.name)} = ${bind(toParam(key.value))}`);
  if (args.expected) {
    where.push(args.expected.value === null ? `${column} IS NULL` : `${column} = ${bind(toParam(args.expected.value))}`);
  }
  const predicate = where.join('\n  AND ');

  const sql =
    driver === 'mssql'
      ? `UPDATE ${target}\nSET ${assignment}\nWHERE ${predicate};\n` +
        `SELECT @@ROWCOUNT AS n, (SELECT ${column} FROM ${target} WHERE ${where
          .slice(0, args.keys.length)
          .join(' AND ')}) AS v;`
      : `UPDATE ${target}\nSET ${assignment}\nWHERE ${predicate}\nRETURNING ${column} AS v;`;

  const literals = params.map((value) => literal(driver, value));
  const display =
    `UPDATE ${target}\nSET ${column} = ${literals[0]}\nWHERE ` +
    args.keys.map((key, i) => `${quote(driver, key.name)} = ${literals[i + 1]}`).join('\n  AND ') +
    ';';

  return { sql, params, display };
}

/**
 * Whether the fetched value can stand in a `WHERE` as the expected one.
 *
 * Integers, booleans and plain strings compare exactly. Everything else is
 * left out rather than risked: a `datetime2` was rounded to milliseconds on
 * the way to the grid, a `float` does not survive a text round trip, `text`
 * and `xml` on SQL Server have no equality operator, and `json` on PostgreSQL
 * has none either. A column left out is still updated — only without the
 * check that nobody wrote to it in between.
 */
export function comparable(driver: DriverKind, meta: ColumnMeta): boolean {
  const type = meta.type.toLowerCase();
  if (meta.kind === 'bool') {
    return true;
  }
  if (meta.kind === 'number') {
    return /^(tinyint|smallint|int|integer|bigint|smallserial|serial|bigserial)\b/.test(type);
  }
  if (meta.kind === 'text') {
    return driver === 'mssql' ? !/^(text|ntext|xml)\b/.test(type) : true;
  }
  return false;
}

/** A tagged value back to the engine as the text it arrived as. */
function toParam(value: CellValue): unknown {
  if (value === null) {
    return null;
  }
  return isTagged(value) ? value.v : value;
}

/** For reading, never for running. */
function literal(driver: DriverKind, value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return driver === 'mssql' ? (value ? '1' : '0') : value ? 'true' : 'false';
  }
  const text = String(value).replace(/'/g, "''");
  return driver === 'mssql' ? `N'${text}'` : `'${text}'`;
}
