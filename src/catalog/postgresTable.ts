import { DriverSession } from '../drivers/types';
import { FavouriteRef } from '../shared/catalog';
import { serverVersion } from './pgVersion';
import { qualified, quote, TableColumn, TableConstraint, TableDefinition, TableIndex } from './script';

/**
 * A PostgreSQL table, read in full from `pg_catalog`.
 *
 * The server does most of the writing. `pg_get_constraintdef` and
 * `pg_get_indexdef` return the constraint and the index exactly as the server
 * would declare them, deferrability, `NOT VALID` and `WHERE` clauses included,
 * so this reader composes only the column list — the one thing the server has
 * no function for — and takes the rest verbatim. A hand-written rendering of
 * an exclusion constraint would be a second implementation of what the server
 * already does correctly.
 *
 * Identity, generated and partition columns each arrived in a different
 * release, and a query naming a column the server does not have fails to
 * parse rather than returning null. So each is added only where it exists.
 */
export async function readPostgresTable(session: DriverSession, ref: FavouriteRef): Promise<TableDefinition> {
  const version = await serverVersion(session);
  const target = qualified('postgres', ref);
  const params = [ref.schema, ref.name];
  const partitioned = version >= 100000;

  const tables = await session.query<TableRow>(
    `
    SELECT c.relpersistence::text AS persist,
           ${partitioned ? 'c.relispartition' : 'false'} AS ispart,
           ${partitioned ? 'pg_get_partkeydef(c.oid)' : 'NULL::text'} AS partkey,
           ${partitioned ? 'pg_get_expr(c.relpartbound, c.oid)' : 'NULL::text'} AS partbound,
           (SELECT quote_ident(pn.nspname) || '.' || quote_ident(p.relname)
            FROM pg_inherits h
            JOIN pg_class p ON p.oid = h.inhparent
            JOIN pg_namespace pn ON pn.oid = p.relnamespace
            WHERE h.inhrelid = c.oid
            ORDER BY h.inhseqno
            LIMIT 1) AS parent
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
  `,
    params
  );
  const table = tables[0];

  const identity = version >= 100000;
  const columns = await session.query<ColumnRow>(
    `
    SELECT a.attname AS nm,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS ty,
           a.attnotnull AS notnull,
           pg_get_expr(d.adbin, d.adrelid) AS defexpr,
           ${identity ? 'a.attidentity::text' : "''"} AS ident,
           ${version >= 120000 ? 'a.attgenerated::text' : "''"} AS gen,
           CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END AS coll,
           ${
             identity
               ? `sq.increment_by::text AS incr, sq.start_value::text AS startv,
           sq.min_value::text AS minv, sq.max_value::text AS maxv, sq.cycle AS cyc`
               : 'NULL::text AS incr, NULL::text AS startv, NULL::text AS minv, NULL::text AS maxv, false AS cyc'
           }
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
    ${
      identity
        ? `LEFT JOIN LATERAL (
      SELECT s.increment_by, s.start_value, s.min_value, s.max_value, s.cycle
      FROM pg_sequences s
      WHERE a.attidentity <> ''
        AND quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename)
            = pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname)
    ) sq ON true`
        : ''
    }
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `,
    params
  );

  const constraints = await session.query<ConstraintRow>(
    `
    SELECT k.conname AS nm, k.contype::text AS ty, pg_get_constraintdef(k.oid, true) AS def,
           k.convalidated AS valid
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
      AND k.contype IN ('p', 'u', 'f', 'c', 'x') AND k.conislocal
    ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END,
             k.conname
  `,
    params
  );

  const indexes = await session.query<IndexRow>(
    `
    SELECT ic.relname AS nm, pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid,
           i.indisclustered AS clustered
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE n.nspname = $1 AND c.relname = $2
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u', 'x'))
    ORDER BY ic.relname
  `,
    params
  );

  /* ------------------------------------------------------------ columns */

  const columnDefs: TableColumn[] = columns.map((row) => {
    const parts = [String(row.ty)];
    if (row.coll) {
      parts.push(`COLLATE ${row.coll}`);
    }
    if (row.gen === 's' && row.defexpr) {
      parts.push(`GENERATED ALWAYS AS (${row.defexpr}) STORED`);
    } else if (row.ident === 'a' || row.ident === 'd') {
      parts.push(`GENERATED ${row.ident === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${sequenceOptions(row)}`);
    } else if (row.defexpr) {
      parts.push(`DEFAULT ${row.defexpr}`);
    }
    if (Boolean(row.notnull)) {
      parts.push('NOT NULL');
    }
    return { name: String(row.nm), definition: parts.join(' ') };
  });

  /* -------------------------------------------------------- constraints */

  const constraintDefs: TableConstraint[] = constraints.map((row) => ({
    name: String(row.nm),
    definition: String(row.def),
    // `NOT VALID` is a word `CREATE TABLE` does not accept, so a constraint
    // the server has not validated is added afterwards, as pg_dump does.
    inline: Boolean(row.valid)
  }));

  /* ------------------------------------------------------------ indexes */

  const notes: string[] = [];
  const indexDefs: TableIndex[] = [];
  for (const row of indexes) {
    const name = String(row.nm);
    if (!Boolean(row.valid)) {
      notes.push(`Index ${name} is marked invalid on the server; it is scripted as declared.`);
    }
    indexDefs.push({
      name,
      statement: String(row.def),
      after: Boolean(row.clustered) ? [`ALTER TABLE ${target} CLUSTER ON ${quote('postgres', name)}`] : undefined
    });
  }

  /* -------------------------------------------------------------- table */

  const modifiers: string[] = [];
  const trailing: string[] = [];
  if (table?.persist === 'u') {
    modifiers.push('UNLOGGED');
  }
  if (table?.partkey) {
    trailing.push(`PARTITION BY ${table.partkey}`);
  }
  if (table?.parent && Boolean(table.ispart)) {
    notes.push(
      `This table is a partition of ${table.parent}. The server declares it as:`,
      `  CREATE TABLE ${target} PARTITION OF ${table.parent} FOR VALUES ${table.partbound ?? ''}`,
      'The standalone form below carries the same columns and constraints.'
    );
  } else if (table?.parent) {
    trailing.push(`INHERITS (${table.parent})`);
  }

  return {
    ref,
    columns: columnDefs,
    constraints: constraintDefs,
    indexes: indexDefs,
    modifiers: modifiers.length ? modifiers : undefined,
    trailing: trailing.length ? trailing : undefined,
    notes: notes.length ? notes : undefined
  };
}

/**
 * `(INCREMENT BY 10 START WITH 100)` for an identity column, or nothing when
 * the sequence is at the defaults for its type — which is nearly always, and
 * a column that reads `GENERATED ALWAYS AS IDENTITY` is the one people wrote.
 */
function sequenceOptions(row: ColumnRow): string {
  if (row.incr === null || row.incr === undefined) {
    return '';
  }
  const max = TYPE_MAX[String(row.ty)] ?? row.maxv;
  const atDefault =
    row.incr === '1' && row.startv === '1' && row.minv === '1' && row.maxv === max && !Boolean(row.cyc);
  if (atDefault) {
    return '';
  }
  return ` (INCREMENT BY ${row.incr} START WITH ${row.startv} MINVALUE ${row.minv} MAXVALUE ${row.maxv}${
    Boolean(row.cyc) ? ' CYCLE' : ''
  })`;
}

const TYPE_MAX: Readonly<Record<string, string>> = {
  smallint: '32767',
  integer: '2147483647',
  bigint: '9223372036854775807'
};

/* --------------------------------------------------------------- rows */

interface TableRow {
  persist: string;
  ispart: boolean;
  partkey: string | null;
  partbound: string | null;
  parent: string | null;
}

interface ColumnRow {
  nm: string;
  ty: string;
  notnull: boolean;
  defexpr: string | null;
  ident: string;
  gen: string;
  coll: string | null;
  incr: string | null;
  startv: string | null;
  minv: string | null;
  maxv: string | null;
  cyc: boolean;
}

interface ConstraintRow {
  nm: string;
  ty: string;
  def: string;
  valid: boolean;
}

interface IndexRow {
  nm: string;
  def: string;
  valid: boolean;
  clustered: boolean;
}
