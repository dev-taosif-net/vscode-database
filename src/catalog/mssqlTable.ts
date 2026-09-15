import { DriverSession } from '../drivers/types';
import { FavouriteRef } from '../shared/catalog';
import { renderType, TypeRow } from './mssqlType';
import { qualified, quote, TableColumn, TableConstraint, TableDefinition, TableIndex } from './script';

/**
 * A SQL Server table, read in full from `sys.*`.
 *
 * Six statements rather than one: columns, key constraints, index columns,
 * indexes, check constraints and foreign keys each live in their own catalog
 * view, and one query that joined all of them would return a row per
 * (column × index column × foreign key column) and be untangled here anyway.
 * Six small answers are cheaper to read and impossible to cross-multiply.
 *
 * Everything is resolved by `object_id` from the schema and name, so a table
 * renamed between two of the statements yields nothing rather than a script
 * stitched from two tables.
 */
export async function readMssqlTable(session: DriverSession, ref: FavouriteRef): Promise<TableDefinition> {
  const target = qualified('mssql', ref);
  const q = (name: string) => quote('mssql', name);
  const params = [ref.schema, ref.name];

  const columns = await session.query<ColumnRow>(
    `
    SELECT c.name AS nm, ty.name AS ty, c.max_length AS len, c.precision AS prec, c.scale AS scl,
           ty.is_user_defined AS udt, ts.name AS tysch,
           c.is_nullable AS nullable, c.collation_name AS coll,
           CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS dbcoll,
           c.is_rowguidcol AS rowguid, c.is_sparse AS sparse,
           CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS isident,
           CONVERT(nvarchar(40), ic.seed_value) AS seed,
           CONVERT(nvarchar(40), ic.increment_value) AS incr,
           ic.is_not_for_replication AS identnfr,
           cc.definition AS computed, cc.is_persisted AS persisted,
           dc.name AS defname, dc.definition AS defexpr
    FROM sys.columns c
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    JOIN sys.schemas ts ON ts.schema_id = ty.schema_id
    LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    LEFT JOIN sys.default_constraints dc
      ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    WHERE c.object_id = ${OBJECT}
    ORDER BY c.column_id
  `,
    params
  );

  const keys = await session.query<KeyRow>(
    `
    SELECT kc.name AS nm, kc.type AS ty, i.index_id AS idxid, i.type_desc AS tydesc,
           i.fill_factor AS fill, i.is_padded AS padded, i.ignore_dup_key AS ignoredup
    FROM sys.key_constraints kc
    JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
    WHERE kc.parent_object_id = ${OBJECT}
    ORDER BY kc.type, kc.name
  `,
    params
  );

  const indexColumns = await session.query<IndexColumnRow>(
    `
    SELECT ic.index_id AS idxid, ic.key_ordinal AS ord, ic.is_descending_key AS dsc,
           ic.is_included_column AS incl, c.name AS nm
    FROM sys.index_columns ic
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = ${OBJECT}
    ORDER BY ic.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id
  `,
    params
  );

  const indexes = await session.query<IndexRow>(
    `
    SELECT i.index_id AS idxid, i.name AS nm, i.type AS ty, i.type_desc AS tydesc, i.is_unique AS uniq,
           i.has_filter AS filtered, i.filter_definition AS filter,
           i.fill_factor AS fill, i.is_padded AS padded, i.ignore_dup_key AS ignoredup,
           i.is_disabled AS disabled
    FROM sys.indexes i
    WHERE i.object_id = ${OBJECT} AND i.index_id > 0
      AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
    ORDER BY i.index_id
  `,
    params
  );

  const checks = await session.query<CheckRow>(
    `
    SELECT ck.name AS nm, ck.definition AS def, ck.is_not_trusted AS untrusted,
           ck.is_disabled AS disabled, ck.is_not_for_replication AS nfr
    FROM sys.check_constraints ck
    WHERE ck.parent_object_id = ${OBJECT}
    ORDER BY ck.name
  `,
    params
  );

  const foreignKeys = await session.query<ForeignKeyRow>(
    `
    SELECT fk.object_id AS id, fk.name AS nm, rs.name AS rsch, rt.name AS rtbl,
           fk.delete_referential_action_desc AS ondel, fk.update_referential_action_desc AS onupd,
           fk.is_not_trusted AS untrusted, fk.is_disabled AS disabled, fk.is_not_for_replication AS nfr
    FROM sys.foreign_keys fk
    JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
    WHERE fk.parent_object_id = ${OBJECT}
    ORDER BY fk.name
  `,
    params
  );

  const foreignKeyColumns = await session.query<ForeignKeyColumnRow>(
    `
    SELECT fkc.constraint_object_id AS id, pc.name AS pcol, rc.name AS rcol
    FROM sys.foreign_key_columns fkc
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE fkc.parent_object_id = ${OBJECT}
    ORDER BY fkc.constraint_object_id, fkc.constraint_column_id
  `,
    params
  );

  /* ------------------------------------------------------------ columns */

  const columnDefs: TableColumn[] = columns.map((row) => {
    if (row.computed) {
      // A computed column has no declared type: the expression is the type.
      const persisted = Boolean(row.persisted);
      const notNull = persisted && !Boolean(row.nullable) ? ' NOT NULL' : '';
      return { name: String(row.nm), definition: `AS ${row.computed}${persisted ? ' PERSISTED' : ''}${notNull}` };
    }
    const type = Boolean(row.udt)
      ? qualified('mssql', { schema: String(row.tysch), name: String(row.ty) })
      : renderType(row);
    const parts = [type];
    // The collation is written only where it differs from the database's own,
    // which is what SSMS does and what keeps the script portable to a database
    // whose default is different.
    if (row.coll && row.coll !== row.dbcoll) {
      parts.push(`COLLATE ${row.coll}`);
    }
    if (Boolean(row.isident)) {
      parts.push(`IDENTITY(${row.seed ?? '1'},${row.incr ?? '1'})`);
      if (Boolean(row.identnfr)) {
        parts.push('NOT FOR REPLICATION');
      }
    }
    if (Boolean(row.rowguid)) {
      parts.push('ROWGUIDCOL');
    }
    if (Boolean(row.sparse)) {
      parts.push('SPARSE');
    }
    parts.push(Boolean(row.nullable) ? 'NULL' : 'NOT NULL');
    if (row.defname && row.defexpr) {
      parts.push(`CONSTRAINT ${q(String(row.defname))} DEFAULT ${row.defexpr}`);
    }
    return { name: String(row.nm), definition: parts.join(' ') };
  });

  /* -------------------------------------------------------- constraints */

  const byIndex = new Map<number, IndexColumnRow[]>();
  for (const row of indexColumns) {
    const id = Number(row.idxid);
    byIndex.set(id, [...(byIndex.get(id) ?? []), row]);
  }
  const keyList = (id: number): string =>
    (byIndex.get(id) ?? [])
      .filter((c) => !Boolean(c.incl) && Number(c.ord) > 0)
      .map((c) => `${q(String(c.nm))} ${Boolean(c.dsc) ? 'DESC' : 'ASC'}`)
      .join(', ');
  const includeList = (id: number): string =>
    (byIndex.get(id) ?? [])
      .filter((c) => Boolean(c.incl))
      .map((c) => q(String(c.nm)))
      .join(', ');
  const plainList = (id: number): string =>
    (byIndex.get(id) ?? []).map((c) => q(String(c.nm))).join(', ');

  const constraints: TableConstraint[] = [];

  for (const row of keys) {
    const verb = String(row.ty).trim() === 'PK' ? 'PRIMARY KEY' : 'UNIQUE';
    constraints.push({
      name: String(row.nm),
      definition: `${verb} ${String(row.tydesc)} (${keyList(Number(row.idxid))})${withOptions(row)}`,
      inline: true
    });
  }

  for (const row of checks) {
    const disabled = Boolean(row.disabled);
    const untrusted = Boolean(row.untrusted);
    const name = String(row.nm);
    constraints.push({
      name,
      definition: `CHECK${Boolean(row.nfr) ? ' NOT FOR REPLICATION' : ''} ${row.def}`,
      inline: !disabled && !untrusted,
      noCheck: disabled || untrusted,
      after: disabled ? [`ALTER TABLE ${target} NOCHECK CONSTRAINT ${q(name)}`] : undefined
    });
  }

  const fkColumns = new Map<number, ForeignKeyColumnRow[]>();
  for (const row of foreignKeyColumns) {
    const id = Number(row.id);
    fkColumns.set(id, [...(fkColumns.get(id) ?? []), row]);
  }
  for (const row of foreignKeys) {
    const cols = fkColumns.get(Number(row.id)) ?? [];
    const disabled = Boolean(row.disabled);
    const untrusted = Boolean(row.untrusted);
    const name = String(row.nm);
    const parts = [
      `FOREIGN KEY (${cols.map((c) => q(String(c.pcol))).join(', ')})`,
      `REFERENCES ${qualified('mssql', { schema: String(row.rsch), name: String(row.rtbl) })}`,
      `(${cols.map((c) => q(String(c.rcol))).join(', ')})`
    ];
    const onDelete = action(row.ondel);
    const onUpdate = action(row.onupd);
    if (onDelete) {
      parts.push(`ON DELETE ${onDelete}`);
    }
    if (onUpdate) {
      parts.push(`ON UPDATE ${onUpdate}`);
    }
    if (Boolean(row.nfr)) {
      parts.push('NOT FOR REPLICATION');
    }
    constraints.push({
      name,
      definition: parts.join(' '),
      inline: !disabled && !untrusted,
      noCheck: disabled || untrusted,
      after: disabled ? [`ALTER TABLE ${target} NOCHECK CONSTRAINT ${q(name)}`] : undefined
    });
  }

  /* ------------------------------------------------------------ indexes */

  const indexDefs: TableIndex[] = [];
  const notes: string[] = [];

  for (const row of indexes) {
    const id = Number(row.idxid);
    const name = String(row.nm);
    const type = Number(row.ty);
    const unique = Boolean(row.uniq) ? 'UNIQUE ' : '';
    const filter = Boolean(row.filtered) && row.filter ? ` WHERE ${row.filter}` : '';
    let statement: string;

    if (type === 1 || type === 2) {
      const include = includeList(id);
      statement =
        `CREATE ${unique}${String(row.tydesc)} INDEX ${q(name)} ON ${target} (${keyList(id)})` +
        `${include ? ` INCLUDE (${include})` : ''}${filter}${withOptions(row)}`;
    } else if (type === 5) {
      statement = `CREATE CLUSTERED COLUMNSTORE INDEX ${q(name)} ON ${target}`;
    } else if (type === 6) {
      statement = `CREATE NONCLUSTERED COLUMNSTORE INDEX ${q(name)} ON ${target} (${plainList(id)})${filter}`;
    } else {
      // XML, spatial and hash indexes each have a syntax of their own that the
      // plain index columns cannot express. Saying so beats writing a
      // statement that is wrong.
      notes.push(`Index ${name} (${String(row.tydesc)}) exists on this table and is not scripted here.`);
      continue;
    }

    indexDefs.push({
      name,
      statement,
      after: Boolean(row.disabled) ? [`ALTER INDEX ${q(name)} ON ${target} DISABLE`] : undefined
    });
  }

  return { ref, columns: columnDefs, constraints, indexes: indexDefs, notes: notes.length ? notes : undefined };
}

/** The table, by its `object_id`, so every statement reads the same one. */
const OBJECT = `OBJECT_ID(QUOTENAME(@p0) + N'.' + QUOTENAME(@p1), N'U')`;

/** `WITH (FILLFACTOR = 80, PAD_INDEX = ON)`, or nothing when every option is at its default. */
function withOptions(row: { fill: number; padded: boolean | number; ignoredup: boolean | number }): string {
  const options: string[] = [];
  if (Boolean(row.padded)) {
    options.push('PAD_INDEX = ON');
  }
  if (Number(row.fill) > 0) {
    options.push(`FILLFACTOR = ${Number(row.fill)}`);
  }
  if (Boolean(row.ignoredup)) {
    options.push('IGNORE_DUP_KEY = ON');
  }
  return options.length > 0 ? ` WITH (${options.join(', ')})` : '';
}

/** `SET_NULL` → `SET NULL`; `NO_ACTION`, the default, → nothing. */
function action(desc: string | null | undefined): string | undefined {
  const value = String(desc ?? 'NO_ACTION').toUpperCase();
  return value === 'NO_ACTION' ? undefined : value.replace(/_/g, ' ');
}

/* --------------------------------------------------------------- rows */

interface ColumnRow extends TypeRow {
  nm: string;
  udt: boolean | number;
  tysch: string;
  nullable: boolean | number;
  coll: string | null;
  dbcoll: string | null;
  rowguid: boolean | number;
  sparse: boolean | number;
  isident: number;
  seed: string | null;
  incr: string | null;
  identnfr: boolean | number | null;
  computed: string | null;
  persisted: boolean | number | null;
  defname: string | null;
  defexpr: string | null;
}

interface KeyRow {
  nm: string;
  ty: string;
  idxid: number;
  tydesc: string;
  fill: number;
  padded: boolean | number;
  ignoredup: boolean | number;
}

interface IndexColumnRow {
  idxid: number;
  ord: number;
  dsc: boolean | number;
  incl: boolean | number;
  nm: string;
}

interface IndexRow {
  idxid: number;
  nm: string;
  ty: number;
  tydesc: string;
  uniq: boolean | number;
  filtered: boolean | number;
  filter: string | null;
  fill: number;
  padded: boolean | number;
  ignoredup: boolean | number;
  disabled: boolean | number;
}

interface CheckRow {
  nm: string;
  def: string;
  untrusted: boolean | number;
  disabled: boolean | number;
  nfr: boolean | number;
}

interface ForeignKeyRow {
  id: number;
  nm: string;
  rsch: string;
  rtbl: string;
  ondel: string;
  onupd: string;
  untrusted: boolean | number;
  disabled: boolean | number;
  nfr: boolean | number;
}

interface ForeignKeyColumnRow {
  id: number;
  pcol: string;
  rcol: string;
}
