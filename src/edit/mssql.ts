import { DriverSession } from '../drivers/types';
import { ColumnMeta } from '../shared/query';
import { qualified } from '../catalog/script';
import { errorMessage } from '../types';
import { Provenance, SourceColumn } from './types';

/**
 * Where a SQL Server result's columns came from.
 *
 * tedious reports a column's name and type and nothing about its origin, so
 * the server is asked to compile the statement and say — which is what
 * `sp_describe_first_result_set` does, without running anything. Browse mode
 * is what makes it name the source table and column rather than the alias.
 * Then one catalog read on that table for its key and its foreign keys.
 *
 * Two round trips, on the control session, once per result. The statement is
 * compiled but not executed, so a SELECT that took a minute to run describes
 * in milliseconds.
 */
export async function describeMssql(session: DriverSession, sql: string, columns: ColumnMeta[]): Promise<Provenance> {
  let described: DescribedRow[];
  try {
    described = await session.query<DescribedRow>(
      'EXEC sp_describe_first_result_set @tsql = @p0, @params = NULL, @browse_information_mode = 1',
      [sql]
    );
  } catch (error) {
    return refused(columns, `The statement could not be described: ${errorMessage(error)}`);
  }

  // Browse mode may append hidden key columns the statement did not select.
  // They are not in the grid, so they are not in the answer.
  const visible = described
    .filter((row) => !truthy(row.is_hidden))
    .sort((a, b) => Number(a.column_ordinal) - Number(b.column_ordinal));
  if (visible.length !== columns.length) {
    return refused(
      columns,
      `The statement describes ${visible.length} columns but the result has ${columns.length}, so they cannot be matched.`
    );
  }

  const current = session.currentDatabase().toLowerCase();
  const sources: (SourceColumn | null)[] = visible.map((row) => {
    if (!row.source_table || !row.source_column) {
      return null;
    }
    return {
      schema: String(row.source_schema ?? 'dbo'),
      table: String(row.source_table),
      column: String(row.source_column),
      identity: truthy(row.is_identity_column),
      computed: truthy(row.is_computed_column),
      rowversion: /^(timestamp|rowversion)\b/i.test(String(row.system_type_name ?? '')),
      foreignKey: false
    };
  });

  const elsewhere = visible.find(
    (row) =>
      row.source_table &&
      ((row.source_server && String(row.source_server).trim()) ||
        (row.source_database && String(row.source_database).toLowerCase() !== current))
  );
  if (elsewhere) {
    return refused(columns, 'Columns from another database or server cannot be edited from here.');
  }

  const tables = new Set(sources.filter((s): s is SourceColumn => s !== null).map((s) => `${s.schema}.${s.table}`));
  if (tables.size !== 1) {
    // Nothing to look up: the planner will say why in words.
    return { sources, keyColumns: [] };
  }
  const only = sources.find((s): s is SourceColumn => s !== null)!;
  const catalog = await readCatalog(session, only.schema, only.table);

  for (const source of sources) {
    if (source && catalog.foreignKeys.has(source.column)) {
      source.foreignKey = true;
    }
  }
  return { sources, keyColumns: catalog.keyColumns };
}

interface DescribedRow {
  is_hidden: unknown;
  column_ordinal: unknown;
  system_type_name: unknown;
  source_server: unknown;
  source_database: unknown;
  source_schema: unknown;
  source_table: unknown;
  source_column: unknown;
  is_identity_column: unknown;
  is_computed_column: unknown;
}

interface CatalogRow {
  kind: 'key' | 'fk';
  name: string;
  ord: number;
  grp: number;
  pk: unknown;
  notnull: unknown;
}

/**
 * The key to seek a row by, and the columns that are foreign keys.
 *
 * The primary key when there is one. Otherwise a unique index, preferring
 * one whose columns are all NOT NULL: a unique index over a nullable column
 * still identifies a row when the value is present, and the update refuses a
 * row whose key is NULL rather than seek with `= NULL`. Filtered indexes are
 * skipped because they identify a row only inside their filter.
 */
async function readCatalog(
  session: DriverSession,
  schema: string,
  table: string
): Promise<{ keyColumns: string[]; foreignKeys: Set<string> }> {
  const rows = await session.query<CatalogRow>(
    `DECLARE @o int = OBJECT_ID(@p0);
     SELECT 'key' AS kind, c.name AS name, ic.key_ordinal AS ord, i.index_id AS grp,
            i.is_primary_key AS pk, CAST(CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END AS bit) AS notnull
     FROM sys.indexes i
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE i.object_id = @o AND i.is_unique = 1 AND i.has_filter = 0 AND ic.is_included_column = 0
     UNION ALL
     SELECT 'fk', c.name, 0, 0, CAST(0 AS bit), CAST(0 AS bit)
     FROM sys.foreign_key_columns fkc
     JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
     WHERE fkc.parent_object_id = @o`,
    [qualified('mssql', { schema, name: table })]
  );

  const foreignKeys = new Set(rows.filter((row) => row.kind === 'fk').map((row) => String(row.name)));

  const groups = new Map<number, { pk: boolean; notnull: boolean; columns: { name: string; ord: number }[] }>();
  for (const row of rows) {
    if (row.kind !== 'key') {
      continue;
    }
    const id = Number(row.grp);
    let group = groups.get(id);
    if (!group) {
      group = { pk: truthy(row.pk), notnull: true, columns: [] };
      groups.set(id, group);
    }
    group.notnull = group.notnull && truthy(row.notnull);
    group.columns.push({ name: String(row.name), ord: Number(row.ord) });
  }
  const best = [...groups.entries()]
    .sort(([ia, a], [ib, b]) => Number(b.pk) - Number(a.pk) || Number(b.notnull) - Number(a.notnull) || ia - ib)
    .map(([, group]) => group)[0];
  const keyColumns = best ? best.columns.sort((a, b) => a.ord - b.ord).map((column) => column.name) : [];
  return { keyColumns, foreignKeys };
}

function refused(columns: ColumnMeta[], refusal: string): Provenance {
  return { sources: columns.map(() => null), keyColumns: [], refusal };
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}
