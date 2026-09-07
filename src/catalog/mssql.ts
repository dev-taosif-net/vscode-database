import { DriverSession } from '../drivers/types';
import { CatalogSummary, DbMember, FavouriteRef, ObjectKind } from '../shared/catalog';
import { CatalogQueries, PageArgs, PageResult, SearchResult } from './types';
import { escapeLike, foldSummary } from './fold';
import { plural, qualified, tableScript } from './script';

/**
 * SQL Server's catalog, read through `sys.*` rather than
 * `INFORMATION_SCHEMA.*`.
 *
 * The information schema is the portable one and it is the wrong one here: it
 * has no sequences, no synonyms, no triggers and no user-defined types, which
 * is four of the eight kinds this tree draws. `sys.objects` has all of them and
 * carries `is_ms_shipped`, which is the only reliable way to keep the two
 * hundred objects Microsoft ships out of a list of the user's own.
 */

/** The `sys.objects.type` codes, mapped to the kinds the tree knows. */
const OBJECT_TYPES: Readonly<Record<string, ObjectKind>> = {
  U: 'table',
  V: 'view',
  P: 'procedure',
  PC: 'procedure',
  FN: 'function',
  IF: 'function',
  TF: 'function',
  AF: 'function',
  FS: 'function',
  FT: 'function',
  SO: 'sequence',
  SN: 'synonym'
};

const OBJECT_TYPE_LIST = Object.keys(OBJECT_TYPES)
  .map((code) => `'${code}'`)
  .join(', ');

/**
 * The `CASE` that turns a type code into a kind, written once.
 *
 * It is duplicated into three statements and the duplication is the point: a
 * catalog query that joined against a mapping table would be a round trip to
 * avoid repeating eleven lines of SQL.
 */
const KIND_CASE = `CASE o.type ${Object.entries(OBJECT_TYPES)
  .map(([code, kind]) => `WHEN '${code}' THEN '${kind}'`)
  .join(' ')} END`;

/** Schemas nobody means when they say "the schemas in this database". */
const SYSTEM_SCHEMAS = "('sys', 'INFORMATION_SCHEMA')";

export class MssqlCatalog implements CatalogQueries {
  async summary(session: DriverSession): Promise<CatalogSummary> {
    /*
     * One statement for every count in the tree.
     *
     * Triggers and types are unioned in separately rather than taken from the
     * `sys.objects` branch, and each has a reason. A trigger's `schema_id` in
     * `sys.objects` is not its parent's — it is whatever the trigger was
     * created under, which for a DML trigger is not the schema the tree files
     * it in — so it is joined through its parent instead. A user-defined type
     * is not in `sys.objects` at all; it only exists in `sys.types`.
     */
    const rows = await session.query<{ sch: string; kind: string; n: number }>(`
      SELECT s.name AS sch, ${KIND_CASE} AS kind, COUNT_BIG(*) AS n
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0 AND o.type IN (${OBJECT_TYPE_LIST})
      GROUP BY s.name, o.type
      UNION ALL
      SELECT s.name, 'trigger', COUNT_BIG(*)
      FROM sys.triggers tr
      JOIN sys.objects p ON p.object_id = tr.parent_id
      JOIN sys.schemas s ON s.schema_id = p.schema_id
      WHERE tr.is_ms_shipped = 0 AND tr.parent_class = 1
      GROUP BY s.name
      UNION ALL
      SELECT s.name, 'type', COUNT_BIG(*)
      FROM sys.types t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_user_defined = 1 AND s.name NOT IN ${SYSTEM_SCHEMAS}
      GROUP BY s.name
    `);
    return foldSummary(rows);
  }

  async page(session: DriverSession, args: PageArgs): Promise<PageResult> {
    const { sql, params } = pageStatement(args);
    const rows = await session.query<PageRow>(sql, params);
    return {
      objects: rows.map((row) => ({
        kind: args.kind,
        schema: String(row.sch),
        name: String(row.nm),
        detail: detailOf(args.kind, row)
      })),
      // `COUNT(*) OVER()` is computed before OFFSET is applied, so it is the
      // whole matching set rather than the page — one round trip for both.
      total: rows.length > 0 ? Number(rows[0].total) : args.offset
    };
  }

  async members(session: DriverSession, ref: FavouriteRef): Promise<DbMember[]> {
    if (ref.kind === 'table' || ref.kind === 'view') {
      return this.columns(session, ref);
    }
    if (ref.kind === 'procedure' || ref.kind === 'function') {
      return this.parameters(session, ref);
    }
    return [];
  }

  private async columns(session: DriverSession, ref: FavouriteRef): Promise<DbMember[]> {
    const rows = await session.query<ColumnRow>(
      `
      SELECT c.name AS nm, ty.name AS ty, c.max_length AS len, c.precision AS prec,
             c.scale AS scl, c.is_nullable AS nullable,
             CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS iskey,
             CASE WHEN fk.parent_column_id IS NULL THEN 0 ELSE 1 END AS isref,
             CASE WHEN c.is_identity = 1 OR c.is_computed = 1 THEN 1 ELSE 0 END AS isauto
      FROM sys.columns c
      JOIN sys.objects o ON o.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      OUTER APPLY (
        SELECT TOP 1 ic.column_id FROM sys.index_columns ic
        JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
      ) pk
      OUTER APPLY (
        SELECT TOP 1 fkc.parent_column_id FROM sys.foreign_key_columns fkc
        WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
      ) fk
      WHERE s.name = @p0 AND o.name = @p1
      ORDER BY c.column_id
    `,
      [ref.schema, ref.name]
    );
    return rows.map((row) => ({
      name: String(row.nm),
      type: renderType(row),
      key: Boolean(row.iskey),
      ref: Boolean(row.isref),
      nullable: Boolean(row.nullable),
      auto: Boolean(row.isauto)
    }));
  }

  private async parameters(session: DriverSession, ref: FavouriteRef): Promise<DbMember[]> {
    const rows = await session.query<ParameterRow>(
      `
      SELECT p.name AS nm, ty.name AS ty, p.max_length AS len, p.precision AS prec,
             p.scale AS scl, p.is_output AS isout, p.parameter_id AS ord
      FROM sys.parameters p
      JOIN sys.objects o ON o.object_id = p.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.types ty ON ty.user_type_id = p.user_type_id
      WHERE s.name = @p0 AND o.name = @p1
      ORDER BY p.parameter_id
    `,
      [ref.schema, ref.name]
    );
    return rows.map((row) => ({
      // Parameter zero is the return value of a scalar function, and SQL
      // Server gives it an empty name. Calling it `returns` is what stops it
      // rendering as a nameless first parameter.
      name: Number(row.ord) === 0 ? 'returns' : String(row.nm),
      type: renderType(row),
      direction: Number(row.ord) === 0 ? 'returns' : row.isout ? 'inout' : 'in'
    }));
  }

  async search(session: DriverSession, needle: string, limit: number): Promise<SearchResult> {
    // `LIKE` and not `CONTAINS`: full-text search is an optional feature that
    // most databases do not have installed, and a search that worked on one
    // server and threw on the next would be worse than a scan of a catalog
    // view that is always there and always small.
    const like = `%${escapeLike(needle)}%`;
    const prefix = `${escapeLike(needle)}%`;
    const rows = await session.query<{ sch: string; nm: string; kind: string }>(
      `
      SELECT TOP (@p2) sch, nm, kind FROM (
        SELECT s.name AS sch, o.name AS nm, ${KIND_CASE} AS kind
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.is_ms_shipped = 0 AND o.type IN (${OBJECT_TYPE_LIST})
          AND (o.name LIKE @p0 ESCAPE '\\' OR s.name LIKE @p0 ESCAPE '\\')
        UNION ALL
        SELECT s.name, tr.name, 'trigger'
        FROM sys.triggers tr
        JOIN sys.objects p ON p.object_id = tr.parent_id
        JOIN sys.schemas s ON s.schema_id = p.schema_id
        WHERE tr.is_ms_shipped = 0 AND tr.parent_class = 1 AND tr.name LIKE @p0 ESCAPE '\\'
        UNION ALL
        SELECT s.name, t.name, 'type'
        FROM sys.types t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.is_user_defined = 1 AND t.name LIKE @p0 ESCAPE '\\'
      ) q
      ORDER BY CASE WHEN nm LIKE @p1 ESCAPE '\\' THEN 0 ELSE 1 END, LEN(nm), nm
    `,
      [like, prefix, limit + 1]
    );

    const capped = rows.length > limit;
    return {
      objects: rows.slice(0, limit).map((row) => ({
        kind: (row.kind as ObjectKind) ?? 'table',
        schema: String(row.sch),
        name: String(row.nm),
        detail: ''
      })),
      capped
    };
  }

  async definition(session: DriverSession, ref: FavouriteRef): Promise<string> {
    if (ref.kind === 'table') {
      return tableScript('mssql', ref, await this.columns(session, ref));
    }

    const rows = await session.query<{ src: string | null }>(
      `
      SELECT m.definition AS src
      FROM sys.sql_modules m
      JOIN sys.objects o ON o.object_id = m.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p0 AND o.name = @p1
      UNION ALL
      SELECT OBJECT_DEFINITION(tr.object_id)
      FROM sys.triggers tr
      JOIN sys.objects p ON p.object_id = tr.parent_id
      JOIN sys.schemas s ON s.schema_id = p.schema_id
      WHERE s.name = @p0 AND tr.name = @p1 AND tr.parent_class = 1
    `,
      [ref.schema, ref.name]
    );

    const source = rows.find((row) => row.src)?.src;
    if (source) {
      return source;
    }
    // A sequence, a synonym or a user-defined type has no module. The catalog
    // holds every fact needed to write the statement, so it is written rather
    // than the action reporting that this kind cannot be scripted.
    return this.syntheticDefinition(session, ref);
  }

  private async syntheticDefinition(session: DriverSession, ref: FavouriteRef): Promise<string> {
    const name = qualified('mssql', ref);

    if (ref.kind === 'synonym') {
      const rows = await session.query<{ base: string }>(
        `SELECT sn.base_object_name AS base FROM sys.synonyms sn
         JOIN sys.schemas s ON s.schema_id = sn.schema_id
         WHERE s.name = @p0 AND sn.name = @p1`,
        [ref.schema, ref.name]
      );
      const base = rows[0]?.base ?? '<target>';
      return `CREATE SYNONYM ${name} FOR ${base};\n`;
    }

    if (ref.kind === 'sequence') {
      const rows = await session.query<SequenceRow>(
        `SELECT ty.name AS ty, sq.start_value AS startv, sq.increment AS inc,
                sq.minimum_value AS minv, sq.maximum_value AS maxv, sq.is_cycling AS cyc
         FROM sys.sequences sq
         JOIN sys.schemas s ON s.schema_id = sq.schema_id
         JOIN sys.types ty ON ty.user_type_id = sq.user_type_id
         WHERE s.name = @p0 AND sq.name = @p1`,
        [ref.schema, ref.name]
      );
      const row = rows[0];
      if (!row) {
        return `-- ${name} was not found.\n`;
      }
      return [
        `CREATE SEQUENCE ${name}`,
        `    AS ${row.ty}`,
        `    START WITH ${row.startv}`,
        `    INCREMENT BY ${row.inc}`,
        `    MINVALUE ${row.minv}`,
        `    MAXVALUE ${row.maxv}`,
        `    ${row.cyc ? 'CYCLE' : 'NO CYCLE'};`,
        ''
      ].join('\n');
    }

    if (ref.kind === 'type') {
      const rows = await session.query<{ base: string | null; len: number; prec: number; scl: number; tt: boolean }>(
        `SELECT bt.name AS base, t.max_length AS len, t.precision AS prec, t.scale AS scl,
                t.is_table_type AS tt
         FROM sys.types t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         LEFT JOIN sys.types bt ON bt.user_type_id = t.system_type_id AND bt.is_user_defined = 0
         WHERE s.name = @p0 AND t.name = @p1`,
        [ref.schema, ref.name]
      );
      const row = rows[0];
      if (!row) {
        return `-- ${name} was not found.\n`;
      }
      if (row.tt) {
        const columns = await this.columns(session, ref);
        return tableScript('mssql', ref, columns, { verb: 'CREATE TYPE', suffix: ' AS TABLE' });
      }
      return `CREATE TYPE ${name} FROM ${renderType({ ty: row.base ?? 'sql_variant', len: row.len, prec: row.prec, scl: row.scl })};\n`;
    }

    return `-- No definition is stored for ${name}.\n`;
  }
}

/* ------------------------------------------------------------- statements */

interface PageRow {
  sch: string;
  nm: string;
  total: number;
  n?: number;
  kindcode?: string;
  parent?: string;
  extra?: string;
}

/**
 * The page statement for one kind.
 *
 * Every branch ends in the same three clauses — `ORDER BY`, `OFFSET`, `FETCH`
 * — and every one selects `COUNT(*) OVER() AS total`, so a folder learns how
 * many rows it has and gets its first five hundred in a single round trip.
 * `@p0` is the schema filter and is null in general mode; the predicate is
 * written so that a null means "every schema" rather than "no schema".
 */
function pageStatement(args: PageArgs): { sql: string; params: unknown[] } {
  const params = [args.schema ?? null, args.offset, args.limit];
  const schemaFilter = '(@p0 IS NULL OR s.name = @p0)';
  const tail = 'OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY';
  const total = 'COUNT(*) OVER() AS total';

  switch (args.kind) {
    case 'table':
    case 'view':
      return {
        sql: `
          SELECT s.name AS sch, o.name AS nm, cols.n AS n, ${total}
          FROM ${args.kind === 'table' ? 'sys.tables' : 'sys.views'} o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          OUTER APPLY (SELECT COUNT(*) AS n FROM sys.columns c WHERE c.object_id = o.object_id) cols
          WHERE o.is_ms_shipped = 0 AND ${schemaFilter}
          ORDER BY s.name, o.name
          ${tail}`,
        params
      };

    case 'procedure':
      return {
        sql: `
          SELECT s.name AS sch, o.name AS nm, args.n AS n, ${total}
          FROM sys.procedures o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          OUTER APPLY (SELECT COUNT(*) AS n FROM sys.parameters p WHERE p.object_id = o.object_id) args
          WHERE o.is_ms_shipped = 0 AND ${schemaFilter}
          ORDER BY s.name, o.name
          ${tail}`,
        params
      };

    case 'function':
      return {
        sql: `
          SELECT s.name AS sch, o.name AS nm, o.type AS kindcode, args.n AS n, ${total}
          FROM sys.objects o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          OUTER APPLY (SELECT COUNT(*) AS n FROM sys.parameters p WHERE p.object_id = o.object_id) args
          WHERE o.is_ms_shipped = 0 AND o.type IN ('FN', 'IF', 'TF', 'AF', 'FS', 'FT') AND ${schemaFilter}
          ORDER BY s.name, o.name
          ${tail}`,
        params
      };

    case 'trigger':
      return {
        sql: `
          SELECT s.name AS sch, tr.name AS nm, p.name AS parent,
                 CASE WHEN tr.is_disabled = 1 THEN 'disabled' ELSE '' END AS extra, ${total}
          FROM sys.triggers tr
          JOIN sys.objects p ON p.object_id = tr.parent_id
          JOIN sys.schemas s ON s.schema_id = p.schema_id
          WHERE tr.is_ms_shipped = 0 AND tr.parent_class = 1 AND ${schemaFilter}
          ORDER BY s.name, p.name, tr.name
          ${tail}`,
        params
      };

    case 'sequence':
      return {
        sql: `
          SELECT s.name AS sch, sq.name AS nm, ty.name AS extra, ${total}
          FROM sys.sequences sq
          JOIN sys.schemas s ON s.schema_id = sq.schema_id
          JOIN sys.types ty ON ty.user_type_id = sq.user_type_id
          WHERE sq.is_ms_shipped = 0 AND ${schemaFilter}
          ORDER BY s.name, sq.name
          ${tail}`,
        params
      };

    case 'type':
      return {
        sql: `
          SELECT s.name AS sch, t.name AS nm,
                 CASE WHEN t.is_table_type = 1 THEN 'Table type' ELSE bt.name END AS extra, ${total}
          FROM sys.types t
          JOIN sys.schemas s ON s.schema_id = t.schema_id
          LEFT JOIN sys.types bt ON bt.user_type_id = t.system_type_id AND bt.is_user_defined = 0
          WHERE t.is_user_defined = 1 AND s.name NOT IN ${SYSTEM_SCHEMAS} AND ${schemaFilter}
          ORDER BY s.name, t.name
          ${tail}`,
        params
      };

    case 'synonym':
      return {
        sql: `
          SELECT s.name AS sch, sn.name AS nm, sn.base_object_name AS extra, ${total}
          FROM sys.synonyms sn
          JOIN sys.schemas s ON s.schema_id = sn.schema_id
          WHERE sn.is_ms_shipped = 0 AND ${schemaFilter}
          ORDER BY s.name, sn.name
          ${tail}`,
        params
      };
  }
}

/** The dim trailing column, one short phrase per kind. */
function detailOf(kind: ObjectKind, row: PageRow): string {
  switch (kind) {
    case 'table':
    case 'view':
      return plural(Number(row.n ?? 0), 'column');
    case 'procedure':
      return plural(Number(row.n ?? 0), 'parameter');
    case 'function':
      return functionShape(String(row.kindcode ?? ''), Number(row.n ?? 0));
    case 'trigger':
      return row.extra ? `on ${row.parent} · disabled` : `on ${row.parent}`;
    case 'sequence':
    case 'type':
      return String(row.extra ?? '');
    case 'synonym':
      return `→ ${row.extra ?? ''}`;
  }
}

/**
 * What kind of function this is, which is the fact a name never carries.
 *
 * A scalar function and an inline table-valued function are used in completely
 * different places in a statement, and `fn_CustomerScore` does not say which
 * it is. The parameter count is appended only for scalars, because for the
 * table-valued kinds the shape is the more useful of the two and the row has
 * room for one.
 */
function functionShape(code: string, parameters: number): string {
  switch (code.trim()) {
    case 'IF':
      return 'Inline table-valued';
    case 'TF':
      return 'Table-valued';
    case 'AF':
      return 'Aggregate';
    case 'FS':
    case 'FT':
      return 'CLR';
    default:
      // Parameter zero is the return value, so it is not a parameter.
      return parameters > 1 ? `Scalar · ${plural(parameters - 1, 'parameter')}` : 'Scalar';
  }
}

/* ------------------------------------------------------------------ types */

interface TypeRow {
  ty: string;
  len: number;
  prec: number;
  scl: number;
}

interface ColumnRow extends TypeRow {
  nm: string;
  nullable: boolean | number;
  iskey: number;
  isref: number;
  isauto: number;
}

interface ParameterRow extends TypeRow {
  nm: string;
  isout: boolean | number;
  ord: number;
}

interface SequenceRow {
  ty: string;
  startv: unknown;
  inc: unknown;
  minv: unknown;
  maxv: unknown;
  cyc: boolean | number;
}

/**
 * `nvarchar(200)` rather than `nvarchar` and a `max_length` of 400.
 *
 * The halving is not a rounding: `max_length` is bytes, and every `n` type
 * stores two bytes per character, so a column declared `nvarchar(200)` reports
 * 400 and rendering it verbatim would double every string length in the tree.
 * A length of -1 is `(max)`, which is the one value that is not a number.
 */
function renderType(row: TypeRow): string {
  const name = String(row.ty ?? '').toLowerCase();
  const length = Number(row.len);

  if (name === 'nvarchar' || name === 'nchar') {
    return `${name}(${length === -1 ? 'max' : length / 2})`;
  }
  if (name === 'varchar' || name === 'char' || name === 'varbinary' || name === 'binary') {
    return `${name}(${length === -1 ? 'max' : length})`;
  }
  if (name === 'decimal' || name === 'numeric') {
    return `${name}(${row.prec},${row.scl})`;
  }
  if (name === 'datetime2' || name === 'time' || name === 'datetimeoffset') {
    return `${name}(${row.scl})`;
  }
  if (name === 'float') {
    return Number(row.prec) === 53 ? name : `${name}(${row.prec})`;
  }
  return name;
}
