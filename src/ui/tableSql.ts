import { CellValue, ColumnMeta, isTagged } from '../shared/query';
import { FavouriteRef } from '../shared/catalog';
import { DriverKind } from '../types';

export interface PageArgs {
  ref: FavouriteRef;
  /** The columns of the previous page, for the filter and the key lookup. */
  columns: ColumnMeta[];
  keyColumns: string[];
  sort?: { column: string; direction: 'asc' | 'desc' };
  filter?: string;
  page: number;
  pageSize: number;
  /** The last row's key values from the page before this one. */
  after?: CellValue[];
}

export interface PageSql {
  sql: string;
  params: unknown[];
  /** True when this page is a key seek rather than a positional skip. */
  keyset: boolean;
}

/**
 * One page of a table.
 *
 * The interesting part is which of two strategies it picks, and why the
 * difference matters at the sizes this extension is built for.
 *
 * `OFFSET 9000000 ROWS FETCH NEXT 200` makes the server walk nine million rows
 * in order to throw them away. Every page is slower than the last, and page
 * five thousand takes a minute. Keyset paging carries the previous page's key
 * forward and asks for the rows after it, which is an index seek at any depth
 * — page five thousand costs exactly what page one costs.
 *
 * Keyset needs three things to be true: the table has a unique key, the sort
 * is that key's own order, and we know where the last page ended. When any of
 * them is not — a heap, a user sort on a non-key column, a jump to a page we
 * did not walk to — this falls back to `OFFSET` and says so, so the footer can
 * warn rather than the user discovering it at page fifty.
 */
export function selectPage(driver: DriverKind, args: PageArgs): PageSql {
  const params: unknown[] = [];
  const placeholder = () => (driver === 'mssql' ? `@p${params.length - 1}` : `$${params.length}`);

  const target = `${quote(driver, args.ref.schema)}.${quote(driver, args.ref.name)}`;
  const where: string[] = [];

  if (args.filter?.trim()) {
    const needle = `%${args.filter.trim()}%`;
    const searchable = args.columns.filter((column) => column.kind === 'text' || column.kind === 'other');
    const clauses = (searchable.length ? searchable : args.columns).map((column) => {
      params.push(needle);
      // Cast rather than assume: a filter that only ever matched `varchar`
      // would silently skip the numeric and date columns a person can see.
      const expression =
        driver === 'mssql'
          ? `CAST(${quote(driver, column.name)} AS nvarchar(4000))`
          : `${quote(driver, column.name)}::text`;
      return `${expression} ${driver === 'mssql' ? 'LIKE' : 'ILIKE'} ${placeholder()}`;
    });
    if (clauses.length) {
      where.push(`(${clauses.join(' OR ')})`);
    }
  }

  const canKeyset =
    args.keyColumns.length > 0 && !args.sort && args.page > 0 && Array.isArray(args.after) && args.after.length > 0;

  if (canKeyset) {
    const values = args.after ?? [];
    if (driver === 'postgres') {
      // A row constructor comparison, which PostgreSQL evaluates as one
      // lexicographic test and can drive straight off the index.
      const names = args.keyColumns.map((name) => quote(driver, name)).join(', ');
      const marks = values.map((value) => {
        params.push(toParam(value));
        return placeholder();
      });
      where.push(`(${names}) > (${marks.join(', ')})`);
    } else {
      // SQL Server has no row constructor in a comparison, so the same test is
      // written out: equal on every earlier key, greater on this one.
      const alternatives: string[] = [];
      for (let i = 0; i < args.keyColumns.length; i++) {
        const conditions: string[] = [];
        for (let j = 0; j < i; j++) {
          params.push(toParam(values[j]));
          conditions.push(`${quote(driver, args.keyColumns[j])} = ${placeholder()}`);
        }
        params.push(toParam(values[i]));
        conditions.push(`${quote(driver, args.keyColumns[i])} > ${placeholder()}`);
        alternatives.push(`(${conditions.join(' AND ')})`);
      }
      where.push(`(${alternatives.join(' OR ')})`);
    }
  }

  const order = args.sort
    ? `${quote(driver, args.sort.column)} ${args.sort.direction === 'desc' ? 'DESC' : 'ASC'}`
    : args.keyColumns.map((name) => quote(driver, name)).join(', ');

  const clause = where.length ? `\nWHERE ${where.join('\n  AND ')}` : '';
  const orderBy = order ? `\nORDER BY ${order}` : '';

  if (canKeyset) {
    const sql =
      driver === 'mssql'
        ? `SELECT TOP (${args.pageSize}) *\nFROM ${target}${clause}${orderBy};`
        : `SELECT *\nFROM ${target}${clause}${orderBy}\nLIMIT ${args.pageSize};`;
    return { sql, params, keyset: true };
  }

  const offset = args.page * args.pageSize;
  if (driver === 'mssql') {
    // OFFSET/FETCH needs an ORDER BY, and a heap has no key to order by, so
    // one is invented from a column that exists. It is arbitrary and stable,
    // which is the most a heap can offer.
    const fallback = order || quote(driver, args.columns[0]?.name ?? '1');
    const sql = offset
      ? `SELECT *\nFROM ${target}${clause}\nORDER BY ${fallback}\nOFFSET ${offset} ROWS FETCH NEXT ${args.pageSize} ROWS ONLY;`
      : `SELECT TOP (${args.pageSize}) *\nFROM ${target}${clause}${order ? `\nORDER BY ${order}` : ''};`;
    return { sql, params, keyset: false };
  }

  const sql = `SELECT *\nFROM ${target}${clause}${orderBy}\nLIMIT ${args.pageSize}${offset ? ` OFFSET ${offset}` : ''};`;
  return { sql, params, keyset: false };
}

/** The key values of the last row of a page, for the next page to seek from. */
export function keyValuesOf(
  columns: ColumnMeta[],
  row: CellValue[] | undefined,
  keyColumns: string[]
): CellValue[] | undefined {
  if (!row || keyColumns.length === 0) {
    return undefined;
  }
  const values: CellValue[] = [];
  for (const key of keyColumns) {
    const index = columns.findIndex((column) => column.name === key);
    if (index === -1) {
      return undefined;
    }
    values.push(row[index] ?? null);
  }
  return values;
}

/**
 * A tagged value on its way back to the server as a parameter.
 *
 * A `bigint` key goes back as the exact text the server sent; passing it
 * through a JavaScript number would round it and seek to the wrong row. A
 * timestamp goes back as its own text for the same reason it was tagged.
 */
function toParam(value: CellValue | undefined): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  return isTagged(value) ? value.v : value;
}

function quote(driver: DriverKind, name: string): string {
  return driver === 'mssql' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}
