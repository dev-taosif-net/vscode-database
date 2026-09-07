import { DriverSession } from '../drivers/types';
import { CatalogSummary, DbMember, FavouriteRef, ObjectKind } from '../shared/catalog';
import { CatalogQueries, PageArgs, PageResult, SearchResult } from './types';
import { escapeLike, foldSummary } from './fold';
import { plural, qualified, tableScript } from './script';

/**
 * PostgreSQL's catalog, read through `pg_catalog` rather than
 * `information_schema`.
 *
 * The information schema is a view over this one that hides sequences behind
 * an incomplete abstraction, has no materialized views, no triggers on
 * anything but tables and no enums at all. It is also slow on a large
 * database, because every one of its views joins half a dozen catalog tables to
 * satisfy a standard nobody is reading. `pg_class` is the real thing.
 */

/** Schemas nobody means when they say "the schemas in this database". */
const VISIBLE_SCHEMA = `
  n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%'
  AND n.nspname NOT LIKE 'pg\\_temp%'`;

/**
 * How the server describes routines, which changed in PostgreSQL 11.
 *
 * `prokind` replaced `proisagg` and `proiswindow`, and it is not a rename that
 * can be papered over: the old columns do not exist on 11 and the new one does
 * not exist on 10, so a query written for either fails to parse on the other.
 * A version probe and two statements is the only honest answer.
 */
const PROKIND_SINCE = 110000;

/** `pg_sequences` arrived one release earlier, so it gets its own floor. */
const PG_SEQUENCES_SINCE = 100000;

export class PostgresCatalog implements CatalogQueries {
  /** `server_version_num` per session, asked once and kept for its lifetime. */
  private readonly versions = new WeakMap<DriverSession, number>();

  private async version(session: DriverSession): Promise<number> {
    const known = this.versions.get(session);
    if (known !== undefined) {
      return known;
    }
    const rows = await session.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    const value = Number(rows[0]?.v ?? 0) || 0;
    this.versions.set(session, value);
    return value;
  }

  async summary(session: DriverSession): Promise<CatalogSummary> {
    const modern = (await this.version(session)) >= PROKIND_SINCE;

    /*
     * Four branches over four different catalog tables, unioned into the same
     * `(schema, kind, count)` shape SQL Server's single statement produces, so
     * both engines fold their answer through `foldSummary` and the tree never
     * learns which one it is talking to.
     *
     * A materialized view is counted as a view and a partitioned table as a
     * table. They are separate `relkind` values and they could be separate
     * folders, and they are not: a tree with ten folders where eight of them
     * are usually empty is a tree that costs a scroll to read. The distinction
     * survives on the row, in the detail column, where it does not cost a
     * folder to say.
     */
    const routines = modern
      ? `SELECT n.nspname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, count(*)::int
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${VISIBLE_SCHEMA} AND p.prokind IN ('f', 'p')
         GROUP BY 1, 2`
      : `SELECT n.nspname, 'function', count(*)::int
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${VISIBLE_SCHEMA} AND NOT p.proisagg AND NOT p.proiswindow
         GROUP BY 1`;

    const rows = await session.query<{ sch: string; kind: string; n: number }>(`
      SELECT n.nspname AS sch,
             CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view'
                            WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
             count(*)::int AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND ${VISIBLE_SCHEMA}
      GROUP BY 1, 2
      UNION ALL
      ${routines}
      UNION ALL
      SELECT n.nspname, 'trigger', count(*)::int
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${VISIBLE_SCHEMA}
      GROUP BY 1
      UNION ALL
      SELECT n.nspname, 'type', count(*)::int
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE ${VISIBLE_SCHEMA}
        AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND c.relkind = 'c'))
      GROUP BY 1
    `);
    return foldSummary(rows);
  }

  async page(session: DriverSession, args: PageArgs): Promise<PageResult> {
    const version = await this.version(session);
    const sql = pageStatement(args, {
      prokind: version >= PROKIND_SINCE,
      sequences: version >= PG_SEQUENCES_SINCE
    });
    const rows = await session.query<PageRow>(sql, [args.schema ?? null, args.limit, args.offset]);
    return {
      objects: rows.map((row) => ({
        kind: args.kind,
        schema: String(row.sch),
        name: String(row.nm),
        detail: detailOf(args.kind, row)
      })),
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
    /*
     * `attnum > 0 AND NOT attisdropped` is not optional. Negative `attnum`s
     * are the system columns — `ctid`, `xmin`, `tableoid` — which are on every
     * table and are not the user's; and a dropped column stays in
     * `pg_attribute` for ever as a tombstone named `........pg.dropped.3........`,
     * which is exactly what a column list must not contain.
     *
     * "The server supplies this value" has meant three different things across
     * three releases: a `nextval` default for ever, `attidentity` from 10, and
     * `attgenerated` from 12. Each column is added only where it exists,
     * because referring to one that does not is a statement that fails to
     * parse rather than a field that comes back null.
     */
    const version = await this.version(session);
    const auto = [
      version >= 100000 ? "a.attidentity <> ''" : null,
      version >= 120000 ? "a.attgenerated <> ''" : null,
      "pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'"
    ]
      .filter(Boolean)
      .join(' OR ');

    const rows = await session.query<PgColumnRow>(
      `
      SELECT a.attname AS nm,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS ty,
             NOT a.attnotnull AS nullable,
             (${auto}) AS isauto,
             EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) AS iskey,
             EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) AS isref
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `,
      [ref.schema, ref.name]
    );
    return rows.map((row) => ({
      name: String(row.nm),
      type: String(row.ty),
      key: Boolean(row.iskey),
      ref: Boolean(row.isref),
      nullable: Boolean(row.nullable),
      auto: Boolean(row.isauto)
    }));
  }

  private async parameters(session: DriverSession, ref: FavouriteRef): Promise<DbMember[]> {
    /*
     * PostgreSQL overloads routines, so a schema and a name can name several.
     * The tree shows one row per name — an overload set is one thing to a
     * reader — so this takes the first by argument count and says nothing
     * about the rest. Listing five identical `Parameters` folders that differ
     * three levels down is not a feature.
     */
    const rows = await session.query<{ args: string; ret: string; setof: boolean }>(
      `
      SELECT pg_get_function_arguments(p.oid) AS args,
             pg_catalog.format_type(p.prorettype, NULL) AS ret,
             p.proretset AS setof
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2
      ORDER BY p.pronargs
      LIMIT 1
    `,
      [ref.schema, ref.name]
    );
    const row = rows[0];
    if (!row) {
      return [];
    }

    const members = splitArguments(String(row.args ?? ''));
    if (ref.kind === 'function' && row.ret) {
      members.push({
        name: 'returns',
        type: row.setof ? `setof ${row.ret}` : String(row.ret),
        direction: 'returns'
      });
    }
    return members;
  }

  async search(session: DriverSession, needle: string, limit: number): Promise<SearchResult> {
    const modern = (await this.version(session)) >= PROKIND_SINCE;
    const like = `%${escapeLike(needle)}%`;
    const prefix = `${escapeLike(needle)}%`;

    const routines = modern
      ? `SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${VISIBLE_SCHEMA} AND p.prokind IN ('f', 'p') AND p.proname LIKE $1`
      : `SELECT n.nspname, p.proname, 'function'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${VISIBLE_SCHEMA} AND NOT p.proisagg AND NOT p.proiswindow AND p.proname LIKE $1`;

    const rows = await session.query<{ sch: string; nm: string; kind: string }>(
      `
      SELECT sch, nm, kind FROM (
        SELECT n.nspname AS sch, c.relname AS nm,
               CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view'
                              WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND ${VISIBLE_SCHEMA}
          AND (c.relname LIKE $1 OR n.nspname LIKE $1)
        UNION ALL
        ${routines}
        UNION ALL
        SELECT n.nspname, t.tgname, 'trigger'
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND ${VISIBLE_SCHEMA} AND t.tgname LIKE $1
        UNION ALL
        SELECT n.nspname, t.typname, 'type'
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class c ON c.oid = t.typrelid
        WHERE ${VISIBLE_SCHEMA} AND t.typname LIKE $1
          AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND c.relkind = 'c'))
      ) q
      ORDER BY (CASE WHEN nm LIKE $2 THEN 0 ELSE 1 END), length(nm), nm
      LIMIT $3
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
      return tableScript('postgres', ref, await this.columns(session, ref));
    }

    const name = qualified('postgres', ref);

    if (ref.kind === 'view') {
      const rows = await session.query<{ src: string; mat: boolean }>(
        `SELECT pg_get_viewdef(c.oid, true) AS src, (c.relkind = 'm') AS mat
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
        [ref.schema, ref.name]
      );
      const row = rows[0];
      if (!row) {
        return `-- ${name} was not found.\n`;
      }
      const verb = row.mat ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW';
      return `${verb} ${name} AS\n${row.src}\n`;
    }

    if (ref.kind === 'procedure' || ref.kind === 'function') {
      const rows = await session.query<{ src: string }>(
        `SELECT pg_get_functiondef(p.oid) AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2
         ORDER BY p.pronargs
         LIMIT 1`,
        [ref.schema, ref.name]
      );
      return rows[0]?.src ? `${rows[0].src}\n` : `-- ${name} was not found.\n`;
    }

    if (ref.kind === 'trigger') {
      const rows = await session.query<{ src: string }>(
        `SELECT pg_get_triggerdef(t.oid, true) AS src
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
        [ref.schema, ref.name]
      );
      return rows[0]?.src ? `${rows[0].src};\n` : `-- ${name} was not found.\n`;
    }

    if (ref.kind === 'sequence') {
      if ((await this.version(session)) < PG_SEQUENCES_SINCE) {
        // Before 10 the settings live in the sequence's own relation and are
        // read with a query against it by name, which cannot be parameterised.
        // Saying so beats interpolating an identifier into a statement.
        return `-- ${name}\n-- This server predates pg_sequences, so the sequence's settings\n-- cannot be read here. Try: \\d ${ref.schema}.${ref.name}\n`;
      }
      const rows = await session.query<PgSequenceRow>(
        `SELECT data_type::text AS ty, start_value AS startv, increment_by AS inc,
                min_value AS minv, max_value AS maxv, cycle AS cyc
         FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
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

    // A type: an enum, a domain or a standalone composite.
    const rows = await session.query<{ typtype: string; base: string | null; labels: string[] | null }>(
      `SELECT t.typtype::text AS typtype,
              CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS base,
              CASE WHEN t.typtype = 'e' THEN
                ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder)
              END AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = $2`,
      [ref.schema, ref.name]
    );
    const row = rows[0];
    if (!row) {
      return `-- ${name} was not found.\n`;
    }
    if (row.typtype === 'e') {
      const labels = (row.labels ?? []).map((l) => `    '${String(l).replace(/'/g, "''")}'`).join(',\n');
      return `CREATE TYPE ${name} AS ENUM (\n${labels}\n);\n`;
    }
    if (row.typtype === 'd') {
      return `CREATE DOMAIN ${name} AS ${row.base ?? 'text'};\n`;
    }
    return tableScript('postgres', ref, await this.columns(session, ref), {
      verb: 'CREATE TYPE',
      suffix: ' AS'
    });
  }
}

/* ------------------------------------------------------------- statements */

interface PageRow {
  sch: string;
  nm: string;
  total: number;
  n?: number;
  parent?: string;
  extra?: string;
  rk?: string;
}

interface PgColumnRow {
  nm: string;
  ty: string;
  nullable: boolean;
  isauto: boolean;
  iskey: boolean;
  isref: boolean;
}

interface PgSequenceRow {
  ty: string;
  startv: unknown;
  inc: unknown;
  minv: unknown;
  maxv: unknown;
  cyc: boolean;
}

/**
 * The page statement for one kind.
 *
 * `$1` is the schema filter and is null in general mode; `$2` is the limit and
 * `$3` the offset. `count(*) OVER ()` rides along on every branch, so a folder
 * gets its rows and its total in one round trip rather than two.
 *
 * The cast on `$1` is load-bearing: without it the server cannot infer a type
 * for a parameter that only ever appears beside `IS NULL`, and the statement
 * fails to prepare rather than returning nothing.
 */
interface Features {
  /** `pg_proc.prokind` exists, so procedures can be told from functions. */
  prokind: boolean;
  /** The `pg_sequences` view exists, so a sequence can report its type. */
  sequences: boolean;
}

function pageStatement(args: PageArgs, features: Features): string {
  const filter = '($1::text IS NULL OR n.nspname = $1)';
  const tail = 'LIMIT $2 OFFSET $3';
  const total = 'count(*) OVER () AS total';

  switch (args.kind) {
    case 'table':
    case 'view': {
      const kinds = args.kind === 'table' ? "'r', 'p', 'f'" : "'v', 'm'";
      return `
        SELECT n.nspname AS sch, c.relname AS nm, c.relkind::text AS rk, ${total},
               (SELECT count(*) FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS n
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN (${kinds}) AND ${VISIBLE_SCHEMA} AND ${filter}
        ORDER BY n.nspname, c.relname
        ${tail}`;
    }

    case 'procedure':
    case 'function': {
      const predicate = features.prokind
        ? `p.prokind = '${args.kind === 'procedure' ? 'p' : 'f'}'`
        : args.kind === 'procedure'
          ? 'false'
          : 'NOT p.proisagg AND NOT p.proiswindow';
      return `
        SELECT n.nspname AS sch, p.proname AS nm, p.pronargs AS n, ${total},
               CASE WHEN p.proretset THEN 'set' ELSE '' END AS extra
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE ${predicate} AND ${VISIBLE_SCHEMA} AND ${filter}
        ORDER BY n.nspname, p.proname
        ${tail}`;
    }

    case 'trigger':
      return `
        SELECT n.nspname AS sch, t.tgname AS nm, c.relname AS parent, ${total},
               CASE WHEN t.tgenabled = 'D' THEN 'disabled' ELSE '' END AS extra
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND ${VISIBLE_SCHEMA} AND ${filter}
        ORDER BY n.nspname, c.relname, t.tgname
        ${tail}`;

    case 'sequence':
      // The detail column is the sequence's own type, which only `pg_sequences`
      // reports. On 9.6 the view does not exist and the join would fail to
      // parse, so the column is dropped rather than the folder.
      return `
        SELECT n.nspname AS sch, c.relname AS nm, ${total},
               ${features.sequences ? "COALESCE(q.data_type::text, 'sequence')" : "'sequence'"} AS extra
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        ${features.sequences ? 'LEFT JOIN pg_sequences q ON q.schemaname = n.nspname AND q.sequencename = c.relname' : ''}
        WHERE c.relkind = 'S' AND ${VISIBLE_SCHEMA} AND ${filter}
        ORDER BY n.nspname, c.relname
        ${tail}`;

    case 'type':
      return `
        SELECT n.nspname AS sch, t.typname AS nm, ${total},
               CASE t.typtype WHEN 'e' THEN 'Enum' WHEN 'd' THEN 'Domain'
                              ELSE 'Composite' END AS extra
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class c ON c.oid = t.typrelid
        WHERE ${VISIBLE_SCHEMA} AND ${filter}
          AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND c.relkind = 'c'))
        ORDER BY n.nspname, t.typname
        ${tail}`;

    case 'synonym':
      // PostgreSQL has none, and `kindsFor` never draws the folder. This
      // branch exists so the switch stays exhaustive rather than falling
      // through to a statement that would run against the wrong table.
      return `SELECT NULL::text AS sch, NULL::text AS nm, 0 AS total WHERE false`;
  }
}

function detailOf(kind: ObjectKind, row: PageRow): string {
  switch (kind) {
    case 'table':
      return row.rk === 'p'
        ? `partitioned · ${plural(Number(row.n ?? 0), 'column')}`
        : row.rk === 'f'
          ? `foreign · ${plural(Number(row.n ?? 0), 'column')}`
          : plural(Number(row.n ?? 0), 'column');
    case 'view':
      return row.rk === 'm'
        ? `materialized · ${plural(Number(row.n ?? 0), 'column')}`
        : plural(Number(row.n ?? 0), 'column');
    case 'procedure':
      return plural(Number(row.n ?? 0), 'parameter');
    case 'function':
      return row.extra === 'set' ? 'Table-valued' : 'Scalar';
    case 'trigger':
      return row.extra ? `on ${row.parent} · disabled` : `on ${row.parent}`;
    case 'sequence':
    case 'type':
      return String(row.extra ?? '');
    case 'synonym':
      return '';
  }
}

/**
 * `pg_get_function_arguments` returns one string — `a integer, b text DEFAULT
 * 5, c numeric(10,2)` — and the tree needs it as rows.
 *
 * Splitting on a comma is wrong, because `numeric(10,2)` contains one. So the
 * split tracks parenthesis depth and quoting, which is the whole of the
 * grammar that matters here: the server generated this string and it is
 * well-formed, so there is nothing else to defend against.
 */
export function splitArguments(text: string): DbMember[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && (ch === '(' || ch === '[')) {
      depth++;
    } else if (!quoted && (ch === ')' || ch === ']')) {
      depth--;
    } else if (ch === ',' && depth === 0 && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) {
    parts.push(text.slice(start));
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let rest = part;
      let direction: DbMember['direction'] = 'in';
      const mode = /^(INOUT|VARIADIC|OUT|IN)\s+/i.exec(rest);
      if (mode) {
        const word = mode[1].toUpperCase();
        direction = word === 'OUT' ? 'out' : word === 'INOUT' ? 'inout' : 'in';
        rest = rest.slice(mode[0].length);
      }
      // A default is a value, not a type, and it does not belong on the row.
      rest = rest.replace(/\s+DEFAULT\s+.*$/i, '');

      // An unnamed argument is legal, and then the whole remainder is the type.
      const space = rest.indexOf(' ');
      if (space < 0) {
        return { name: '', type: rest, direction };
      }
      return { name: rest.slice(0, space), type: rest.slice(space + 1).trim(), direction };
    });
}
