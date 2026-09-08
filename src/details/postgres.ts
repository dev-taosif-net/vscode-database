import { DriverSession } from '../drivers/types';
import { FavouriteRef } from '../shared/catalog';
import { DependencyRef, Fact, IndexInfo, KeyColumns, Tag } from '../shared/details';
import { DetailsQueries, ForeignKeyColumn } from './types';
import { bytes } from './mssql';
import { serverVersion } from '../catalog/pgVersion';
import { qualified } from '../catalog/script';

/**
 * PostgreSQL's answers, out of `pg_catalog`.
 *
 * Two version floors matter here and are handled the way the catalog reader
 * handles its own: `attidentity` and `relispartition` both arrived in 10, and
 * referring to a column that does not exist is a statement that fails to
 * parse rather than a field that comes back null.
 */
export class PostgresDetails implements DetailsQueries {
  async facts(session: DriverSession, ref: FavouriteRef): Promise<{ facts: Fact[]; tags: Tag[] }> {
    const version = await serverVersion(session);
    const partitioned = version >= 100000 ? 'c.relispartition' : 'false';
    const identity =
      version >= 100000
        ? `EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attidentity <> '')`
        : 'false';

    const rows = await session.query<{
      relkind: string;
      relpersistence: string;
      row_count: string;
      total_bytes: string;
      index_bytes: string;
      column_count: string;
      index_count: string;
      fk_count: string;
      trigger_count: string;
      unique_count: string;
      has_pk: boolean;
      has_identity: boolean;
      has_serial: boolean;
      clustered: boolean;
      partitioned: boolean;
    }>(
      `SELECT c.relkind,
              c.relpersistence,
              c.reltuples::bigint::text AS row_count,
              pg_total_relation_size(c.oid)::text AS total_bytes,
              pg_indexes_size(c.oid)::text AS index_bytes,
              (SELECT count(*) FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::text AS column_count,
              (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)::text AS index_count,
              (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::text AS fk_count,
              (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)::text AS trigger_count,
              (SELECT count(*) FROM pg_index i
                WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary)::text AS unique_count,
              EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p') AS has_pk,
              ${identity} AS has_identity,
              EXISTS (SELECT 1 FROM pg_attrdef d
                       WHERE d.adrelid = c.oid AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%') AS has_serial,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisclustered) AS clustered,
              ${partitioned} AS partitioned
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ref.schema, ref.name]
    );

    const row = rows[0];
    if (!row) {
      return { facts: [], tags: [] };
    }

    const facts: Fact[] = [];
    if (ref.kind === 'table' || ref.kind === 'view') {
      facts.push({
        label: 'Rows',
        value: Number(row.row_count) < 0 ? '—' : Number(row.row_count).toLocaleString('en-US'),
        // `reltuples` is whatever the last ANALYZE saw, and it is -1 on a table
        // that has never been analysed. Saying so beats printing -1 rows.
        approximate: true,
        absent: Number(row.row_count) < 0 ? 'Never analysed. Run ANALYZE for an estimate.' : undefined
      });
      facts.push({ label: 'Columns', value: row.column_count });
      facts.push({ label: 'Data', value: bytes(row.total_bytes) });
      facts.push({ label: 'Indexes', value: `${row.index_count} · ${bytes(row.index_bytes)}` });
    }
    facts.push({
      label: 'Created',
      value: null,
      // Not a gap in this reader. PostgreSQL does not record it anywhere, and
      // the nearest thing — a file's mtime — answers a different question.
      absent: 'PostgreSQL does not record when an object was created.'
    });

    const tags: Tag[] = [];
    if (row.has_pk) {
      tags.push({ id: 'pk', label: 'PK', detail: 'Has a primary key constraint.' });
    }
    if (Number(row.fk_count)) {
      tags.push({ id: 'fk', label: `FK×${row.fk_count}`, detail: 'Foreign keys declared on this table.' });
    }
    if (row.has_identity || row.has_serial) {
      tags.push({
        id: 'identity',
        label: 'Identity',
        detail: row.has_identity ? 'GENERATED AS IDENTITY.' : 'A serial column, defaulting from a sequence.'
      });
    }
    if (row.clustered) {
      tags.push({ id: 'clustered', label: 'Clustered', detail: 'CLUSTER has been run on an index of this table.' });
    }
    if (Number(row.unique_count)) {
      tags.push({ id: 'unique', label: `Unique×${row.unique_count}`, detail: 'Unique indexes beyond the primary key.' });
    }
    if (Number(row.trigger_count)) {
      tags.push({
        id: 'trigger',
        label: Number(row.trigger_count) === 1 ? '1 trigger' : `${row.trigger_count} triggers`,
        detail: 'Writes here run other code.'
      });
    }
    if (row.partitioned || row.relkind === 'p') {
      tags.push({ id: 'partitioned', label: 'Partitioned', detail: 'Part of, or the root of, a partitioned table.' });
    }
    if (row.relpersistence === 'u') {
      tags.push({ id: 'unlogged', label: 'Unlogged', detail: 'Not written to the WAL. Emptied after a crash.' });
    }
    if (row.relkind === 'm') {
      tags.push({ id: 'materialized', label: 'Materialized', detail: 'Stored, and only as fresh as its last REFRESH.' });
    }

    return { facts, tags };
  }

  async indexes(session: DriverSession, ref: FavouriteRef): Promise<IndexInfo[]> {
    const rows = await session.query<{
      name: string;
      method: string;
      is_unique: boolean;
      is_primary: boolean;
      cols: string[];
    }>(
      `SELECT ic.relname AS name,
              am.amname AS method,
              i.indisunique AS is_unique,
              i.indisprimary AS is_primary,
              ARRAY(SELECT pg_get_indexdef(i.indexrelid, k + 1, true)
                    FROM generate_subscripts(i.indkey, 1) AS k
                    ORDER BY k) AS cols
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       ORDER BY i.indisprimary DESC, ic.relname`,
      [ref.schema, ref.name]
    );
    return rows.map((row) => ({
      name: row.name,
      columns: row.cols ?? [],
      unique: row.is_unique,
      primary: row.is_primary,
      kind: row.method
    }));
  }

  async dependencies(
    session: DriverSession,
    ref: FavouriteRef
  ): Promise<{ dependsOn: DependencyRef[]; usedBy: DependencyRef[] }> {
    const target = qualified('postgres', ref);

    // Views and materialized views, exactly, through the rewrite rules that
    // define them. This half is a fact.
    const usedByViews = await session.query<{ sch: string; nm: string; kind: string }>(
      `SELECT DISTINCT n.nspname AS sch, c.relname AS nm, c.relkind AS kind
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE d.refobjid = $1::regclass
         AND d.classid = 'pg_rewrite'::regclass
         AND c.oid <> $1::regclass`,
      [target]
    );

    const usedByKeys = await session.query<{ sch: string; nm: string; con: string }>(
      `SELECT n.nspname AS sch, c.relname AS nm, k.conname AS con
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE k.confrelid = $1::regclass AND k.contype = 'f'`,
      [target]
    );

    const triggers = await session.query<{ nm: string }>(
      `SELECT t.tgname AS nm
       FROM pg_trigger t
       WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal`,
      [target]
    );

    /*
     * The honest half.
     *
     * PostgreSQL does not track what a routine body reads. To the server a
     * PL/pgSQL body is an opaque string, so a procedure that selects from this
     * table creates no dependency row at all — the only exceptions are
     * SQL-standard bodies (`BEGIN ATOMIC`, 14+), which are parsed and do
     * register above.
     *
     * Showing an empty Used By would let somebody conclude nothing uses their
     * table and then drop it. So the name is searched for in source text
     * instead, and every row found that way is marked `inferred`, because a
     * grep can match a name inside a comment. A DBA about to drop a table
     * needs to know both what the catalog knows and what it cannot know.
     */
    const inferred = await session.query<{ sch: string; nm: string }>(
      `SELECT n.nspname AS sch, p.proname AS nm
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND p.prosrc ILIKE '%' || $1 || '%'
       ORDER BY n.nspname, p.proname
       LIMIT 50`,
      [ref.name]
    );

    const dependsOnKeys = await session.query<{ sch: string; nm: string; con: string }>(
      `SELECT n.nspname AS sch, c.relname AS nm, k.conname AS con
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE k.conrelid = $1::regclass AND k.contype = 'f'`,
      [target]
    );

    const dependsOnViews = await session.query<{ sch: string; nm: string; kind: string }>(
      `SELECT DISTINCT n.nspname AS sch, c.relname AS nm, c.relkind AS kind
       FROM pg_rewrite r
       JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
       JOIN pg_class c ON c.oid = d.refobjid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE r.ev_class = $1::regclass AND c.oid <> $1::regclass`,
      [target]
    );

    return {
      dependsOn: [
        ...dependsOnViews.map((row) => ({ kind: relkind(row.kind), schema: row.sch, name: row.nm, why: 'read by this view' })),
        ...dependsOnKeys.map((row) => ({
          kind: 'table' as const,
          schema: row.sch,
          name: row.nm,
          why: `foreign key ${row.con}`
        }))
      ],
      usedBy: [
        ...usedByViews.map((row) => ({ kind: relkind(row.kind), schema: row.sch, name: row.nm, why: 'view' })),
        ...usedByKeys.map((row) => ({
          kind: 'table' as const,
          schema: row.sch,
          name: row.nm,
          why: `foreign key ${row.con}`
        })),
        ...triggers.map((row) => ({
          kind: 'trigger' as const,
          schema: ref.schema,
          name: row.nm,
          why: 'trigger'
        })),
        ...inferred.map((row) => ({
          kind: 'function' as const,
          schema: row.sch,
          name: row.nm,
          why: 'matched in source',
          inferred: true
        }))
      ]
    };
  }

  async keyColumns(session: DriverSession, ref: FavouriteRef): Promise<KeyColumns> {
    const rows = await session.query<{ cols: string[] }>(
      `SELECT ARRAY(SELECT a.attname
                    FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
                    ORDER BY u.ord) AS cols
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND i.indisunique AND i.indnatts = i.indnkeyatts
       ORDER BY i.indisprimary DESC
       LIMIT 1`,
      [ref.schema, ref.name]
    );
    const columns = rows[0]?.cols ?? [];
    return { columns, usable: columns.length > 0 };
  }

  async estimate(session: DriverSession, ref: FavouriteRef): Promise<number | undefined> {
    const rows = await session.query<{ n: string }>(
      `SELECT c.reltuples::bigint::text AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ref.schema, ref.name]
    );
    const value = Number(rows[0]?.n);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
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
      `SELECT k.conname AS fk,
              pn.nspname AS pschema, pc.relname AS ptable, pa.attname AS pcolumn,
              rn.nspname AS rschema, rc.relname AS rtable, ra.attname AS rcolumn
       FROM pg_constraint k
       JOIN pg_class pc ON pc.oid = k.conrelid
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(pnum, rnum, ord) ON true
       JOIN pg_attribute pa ON pa.attrelid = k.conrelid AND pa.attnum = u.pnum
       JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = u.rnum
       WHERE k.contype = 'f' AND pn.nspname NOT IN ('pg_catalog', 'information_schema')`
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

function relkind(kind: string): DependencyRef['kind'] {
  if (kind === 'v' || kind === 'm') {
    return 'view';
  }
  if (kind === 'r' || kind === 'p' || kind === 'f') {
    return 'table';
  }
  if (kind === 'S') {
    return 'sequence';
  }
  return 'table';
}
