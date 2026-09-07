import { DriverSession } from '../drivers/types';
import { FavouriteRef } from '../shared/catalog';
import { DependencyRef, Fact, IndexInfo, KeyColumns, Tag } from '../shared/details';
import { DetailsQueries, ForeignKeyColumn } from './types';

/**
 * SQL Server's answers, out of `sys.*`.
 *
 * `INFORMATION_SCHEMA` is not used here for the same reason the catalog does
 * not use it: it is a portable view over a server that is not portable, and it
 * cannot see an identity column, a clustered index, a partition scheme or a
 * temporal table — which is four of the badges this file exists to produce.
 */
export class MssqlDetails implements DetailsQueries {
  async facts(session: DriverSession, ref: FavouriteRef): Promise<{ facts: Fact[]; tags: Tag[] }> {
    const rows = await session.query<{
      type_desc: string;
      create_date: Date | null;
      modify_date: Date | null;
      column_count: number;
      row_count: number | string;
      total_bytes: number | string;
      index_bytes: number | string;
      index_count: number;
      fk_count: number;
      trigger_count: number;
      has_pk: number;
      has_identity: number;
      has_clustered: number;
      is_heap: number;
      temporal: number;
      partitioned: number;
      unique_count: number;
    }>(
      `SELECT
         o.type_desc,
         o.create_date,
         o.modify_date,
         (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = o.object_id) AS column_count,
         ISNULL((SELECT SUM(ps.row_count) FROM sys.dm_db_partition_stats ps
                  WHERE ps.object_id = o.object_id AND ps.index_id IN (0, 1)), 0) AS row_count,
         ISNULL((SELECT SUM(ps.reserved_page_count) * 8192 FROM sys.dm_db_partition_stats ps
                  WHERE ps.object_id = o.object_id), 0) AS total_bytes,
         ISNULL((SELECT SUM(ps.used_page_count) * 8192 FROM sys.dm_db_partition_stats ps
                  WHERE ps.object_id = o.object_id AND ps.index_id > 1), 0) AS index_bytes,
         (SELECT COUNT(*) FROM sys.indexes i WHERE i.object_id = o.object_id AND i.index_id > 0) AS index_count,
         (SELECT COUNT(*) FROM sys.foreign_keys f WHERE f.parent_object_id = o.object_id) AS fk_count,
         (SELECT COUNT(*) FROM sys.triggers t WHERE t.parent_id = o.object_id) AS trigger_count,
         CASE WHEN EXISTS (SELECT 1 FROM sys.key_constraints k
                            WHERE k.parent_object_id = o.object_id AND k.type = 'PK') THEN 1 ELSE 0 END AS has_pk,
         CASE WHEN EXISTS (SELECT 1 FROM sys.identity_columns ic
                            WHERE ic.object_id = o.object_id) THEN 1 ELSE 0 END AS has_identity,
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                            WHERE i.object_id = o.object_id AND i.type = 1) THEN 1 ELSE 0 END AS has_clustered,
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                            WHERE i.object_id = o.object_id AND i.type = 0) THEN 1 ELSE 0 END AS is_heap,
         ISNULL(t.temporal_type, 0) AS temporal,
         CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                            JOIN sys.partition_schemes psch ON psch.data_space_id = i.data_space_id
                            WHERE i.object_id = o.object_id) THEN 1 ELSE 0 END AS partitioned,
         (SELECT COUNT(*) FROM sys.indexes i
           WHERE i.object_id = o.object_id AND i.is_unique = 1 AND i.is_primary_key = 0) AS unique_count
       FROM sys.objects o
       LEFT JOIN sys.tables t ON t.object_id = o.object_id
       WHERE o.object_id = OBJECT_ID(@p0)`,
      [qualified(ref)]
    );

    const row = rows[0];
    if (!row) {
      return { facts: [], tags: [] };
    }

    const facts: Fact[] = [];
    if (ref.kind === 'table' || ref.kind === 'view') {
      facts.push({
        label: 'Rows',
        value: count(row.row_count),
        // From `sys.dm_db_partition_stats`, which is maintained by the engine
        // and is not `COUNT(*)`. A tool that runs `COUNT(*)` to fill a label
        // takes forty seconds to show an empty grid on the one table that most
        // needed looking at.
        approximate: true
      });
      facts.push({ label: 'Columns', value: String(row.column_count) });
      facts.push({ label: 'Data', value: bytes(row.total_bytes) });
      facts.push({
        label: 'Indexes',
        value: `${row.index_count} · ${bytes(row.index_bytes)}`
      });
    } else {
      facts.push({ label: 'Type', value: friendly(row.type_desc) });
    }
    facts.push({ label: 'Created', value: date(row.create_date) });
    facts.push({ label: 'Modified', value: date(row.modify_date) });

    const tags: Tag[] = [];
    if (row.has_pk) {
      tags.push({ id: 'pk', label: 'PK', detail: 'Has a primary key constraint.' });
    }
    if (row.fk_count) {
      tags.push({ id: 'fk', label: `FK×${row.fk_count}`, detail: 'Foreign keys declared on this table.' });
    }
    if (row.has_identity) {
      tags.push({ id: 'identity', label: 'Identity', detail: 'A column whose value the server supplies.' });
    }
    if (row.has_clustered) {
      tags.push({ id: 'clustered', label: 'Clustered', detail: 'Stored in the order of its clustered index.' });
    }
    if (row.is_heap) {
      tags.push({ id: 'heap', label: 'Heap', detail: 'No clustered index. Paging past a few thousand rows is slow.' });
    }
    if (row.unique_count) {
      tags.push({ id: 'unique', label: `Unique×${row.unique_count}`, detail: 'Unique indexes beyond the primary key.' });
    }
    if (row.trigger_count) {
      tags.push({
        id: 'trigger',
        label: row.trigger_count === 1 ? '1 trigger' : `${row.trigger_count} triggers`,
        detail: 'Writes here run other code.'
      });
    }
    if (row.temporal === 2) {
      tags.push({ id: 'temporal', label: 'Temporal', detail: 'System-versioned. History is kept automatically.' });
    }
    if (row.partitioned) {
      tags.push({ id: 'partitioned', label: 'Partitioned', detail: 'Stored across a partition scheme.' });
    }

    return { facts, tags };
  }

  async indexes(session: DriverSession, ref: FavouriteRef): Promise<IndexInfo[]> {
    const rows = await session.query<{
      name: string;
      type_desc: string;
      is_unique: boolean | number;
      is_primary_key: boolean | number;
      column_name: string;
      key_ordinal: number;
      is_included: boolean | number;
    }>(
      `SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key,
              c.name AS column_name, ic.key_ordinal, ic.is_included_column AS is_included
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@p0) AND i.index_id > 0
       ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal`,
      [qualified(ref)]
    );

    const byName = new Map<string, IndexInfo>();
    for (const row of rows) {
      const name = row.name ?? '(unnamed)';
      let index = byName.get(name);
      if (!index) {
        index = {
          name,
          columns: [],
          unique: Boolean(row.is_unique),
          primary: Boolean(row.is_primary_key),
          kind: friendly(row.type_desc)
        };
        byName.set(name, index);
      }
      index.columns.push(row.is_included ? `${row.column_name} (included)` : row.column_name);
    }
    return [...byName.values()];
  }

  async dependencies(
    session: DriverSession,
    ref: FavouriteRef
  ): Promise<{ dependsOn: DependencyRef[]; usedBy: DependencyRef[] }> {
    const name = qualified(ref);

    // `sys.sql_expression_dependencies` is real dependency tracking rather
    // than a text search, and it resolves both directions. A cross-database or
    // cross-server reference comes back unresolved by design, and is shown as
    // such rather than dropped.
    const dependsOn = await session.query<{ sch: string; nm: string; kind: string; why: string }>(
      `SELECT DISTINCT
              ISNULL(d.referenced_schema_name, s.name) AS sch,
              d.referenced_entity_name AS nm,
              ISNULL(o.type_desc, 'UNRESOLVED') AS kind,
              'referenced' AS why
       FROM sys.sql_expression_dependencies d
       LEFT JOIN sys.objects o ON o.object_id = d.referenced_id
       LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE d.referencing_id = OBJECT_ID(@p0)
       UNION
       SELECT s.name, rt.name, rt.type_desc, 'foreign key'
       FROM sys.foreign_keys fk
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas s ON s.schema_id = rt.schema_id
       WHERE fk.parent_object_id = OBJECT_ID(@p0)`,
      [name]
    );

    const usedBy = await session.query<{ sch: string; nm: string; kind: string; why: string }>(
      `SELECT DISTINCT s.name AS sch, o.name AS nm, o.type_desc AS kind, 'references' AS why
       FROM sys.sql_expression_dependencies d
       JOIN sys.objects o ON o.object_id = d.referencing_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE d.referenced_id = OBJECT_ID(@p0)
       UNION
       SELECT s.name, pt.name, pt.type_desc, 'foreign key'
       FROM sys.foreign_keys fk
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.schemas s ON s.schema_id = pt.schema_id
       WHERE fk.referenced_object_id = OBJECT_ID(@p0)
       UNION
       SELECT s.name, tr.name, 'SQL_TRIGGER', 'trigger'
       FROM sys.triggers tr
       JOIN sys.objects po ON po.object_id = tr.parent_id
       JOIN sys.schemas s ON s.schema_id = po.schema_id
       WHERE tr.parent_id = OBJECT_ID(@p0)`,
      [name]
    );

    return {
      dependsOn: dependsOn.map(toDependency).filter((d) => !sameAs(d, ref)),
      usedBy: usedBy.map(toDependency).filter((d) => !sameAs(d, ref))
    };
  }

  async keyColumns(session: DriverSession, ref: FavouriteRef): Promise<KeyColumns> {
    const rows = await session.query<{ column_name: string }>(
      `SELECT TOP (8) c.name AS column_name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@p0)
         AND i.is_unique = 1
         AND ic.is_included_column = 0
       ORDER BY i.is_primary_key DESC, i.index_id, ic.key_ordinal`,
      [qualified(ref)]
    );
    const columns = rows.map((row) => row.column_name);
    return { columns, usable: columns.length > 0 };
  }

  async estimate(session: DriverSession, ref: FavouriteRef): Promise<number | undefined> {
    const rows = await session.query<{ n: number | string }>(
      `SELECT ISNULL(SUM(ps.row_count), 0) AS n
       FROM sys.dm_db_partition_stats ps
       WHERE ps.object_id = OBJECT_ID(@p0) AND ps.index_id IN (0, 1)`,
      [qualified(ref)]
    );
    const value = Number(rows[0]?.n);
    return Number.isFinite(value) ? value : undefined;
  }

  async foreignKeys(session: DriverSession): Promise<ForeignKeyColumn[]> {
    const rows = await session.query<{
      fk: string;
      pschema: string;
      ptable: string;
      pcolumn: string;
      rschema: string;
      rtable: string;
      rcolumn: string;
    }>(
      `SELECT fk.name AS fk,
              ps.name AS pschema, pt.name AS ptable, pc.name AS pcolumn,
              rs.name AS rschema, rt.name AS rtable, rc.name AS rcolumn
       FROM sys.foreign_key_columns fkc
       JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
       JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
       JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id`
    );
    return rows.map((row) => ({
      name: row.fk,
      fromSchema: row.pschema,
      fromTable: row.ptable,
      fromColumn: row.pcolumn,
      toSchema: row.rschema,
      toTable: row.rtable,
      toColumn: row.rcolumn
    }));
  }
}

/* ------------------------------------------------------------------ helpers */

function qualified(ref: FavouriteRef): string {
  return `[${ref.schema.replace(/]/g, ']]')}].[${ref.name.replace(/]/g, ']]')}]`;
}

function toDependency(row: { sch: string; nm: string; kind: string; why: string }): DependencyRef {
  return {
    kind: kindOf(row.kind),
    schema: row.sch ?? '',
    name: row.nm ?? '',
    why: row.kind === 'UNRESOLVED' ? 'unresolved reference' : row.why
  };
}

function sameAs(dependency: DependencyRef, ref: FavouriteRef): boolean {
  return dependency.schema === ref.schema && dependency.name === ref.name;
}

function kindOf(typeDesc: string): DependencyRef['kind'] {
  if (typeDesc.includes('TABLE')) {
    return 'table';
  }
  if (typeDesc.includes('VIEW')) {
    return 'view';
  }
  if (typeDesc.includes('PROCEDURE')) {
    return 'procedure';
  }
  if (typeDesc.includes('FUNCTION')) {
    return 'function';
  }
  if (typeDesc.includes('TRIGGER')) {
    return 'trigger';
  }
  if (typeDesc.includes('SEQUENCE')) {
    return 'sequence';
  }
  if (typeDesc.includes('SYNONYM')) {
    return 'synonym';
  }
  return 'constraint';
}

function friendly(typeDesc: string): string {
  return (typeDesc ?? '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function count(value: number | string): string {
  return Number(value).toLocaleString('en-US');
}

function date(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const iso = new Date(value).toISOString();
  return iso.slice(0, 10);
}

/** Binary units, because a page is 8 KiB and a report saying 8.2 kB is noise. */
export function bytes(value: number | string): string {
  let size = Number(value);
  if (!Number.isFinite(size)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}
