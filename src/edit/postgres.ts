import { DriverSession } from '../drivers/types';
import { ColumnMeta } from '../shared/query';
import { Provenance, SourceColumn } from './types';

/**
 * Where a PostgreSQL result's columns came from.
 *
 * The driver already tagged each column with its relation and attribute
 * number, so this is one catalog read to name them and flag what the server
 * maintains itself, and one more for the relation's unique indexes. Nothing
 * is compiled and nothing is re-run.
 *
 * `to_jsonb(a)->>'attgenerated'` rather than the column: it appeared in
 * version 12 and `attidentity` in 10, and a query that named either would
 * fail outright on an older server. Read through JSON, a missing column is a
 * NULL rather than an error.
 */
export async function describePostgres(session: DriverSession, columns: ColumnMeta[]): Promise<Provenance> {
  const origins = columns.map((column) => column.origin ?? null);
  const pairs = new Map<string, { relation: string; column: number }>();
  for (const origin of origins) {
    if (origin) {
      pairs.set(`${origin.relation}:${origin.column}`, origin);
    }
  }
  if (pairs.size === 0) {
    return { sources: columns.map(() => null), keyColumns: [] };
  }

  const wanted = [...pairs.values()];
  const attributes = await session.query<AttributeRow>(
    `SELECT a.attrelid::bigint::text AS rel, a.attnum::int AS att, a.attname::text AS col,
            n.nspname::text AS schema, c.relname::text AS "table", c.relkind::text AS kind,
            COALESCE(to_jsonb(a)->>'attidentity', '') <> '' AS identity,
            COALESCE(to_jsonb(a)->>'attgenerated', '') <> '' AS generated,
            EXISTS (SELECT 1 FROM pg_catalog.pg_constraint f
                    WHERE f.conrelid = a.attrelid AND f.contype = 'f' AND a.attnum = ANY (f.conkey)) AS fk
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN unnest($1::oid[], $2::int2[]) AS k(t, c) ON a.attrelid = k.t AND a.attnum = k.c`,
    [wanted.map((origin) => origin.relation), wanted.map((origin) => origin.column)]
  );
  const byPair = new Map(attributes.map((row) => [`${row.rel}:${row.att}`, row]));

  const sources: (SourceColumn | null)[] = origins.map((origin) => {
    const row = origin ? byPair.get(`${origin.relation}:${origin.column}`) : undefined;
    if (!row) {
      return null;
    }
    return {
      schema: row.schema,
      table: row.table,
      column: row.col,
      identity: Boolean(row.identity),
      computed: Boolean(row.generated),
      rowversion: false,
      foreignKey: Boolean(row.fk)
    };
  });

  const relations = new Set(attributes.map((row) => row.rel));
  if (relations.size !== 1) {
    return { sources, keyColumns: [] };
  }
  const [relation] = relations;
  const kind = attributes[0].kind;
  if (kind !== 'r' && kind !== 'p') {
    const what = kind === 'v' ? 'a view' : kind === 'm' ? 'a materialized view' : kind === 'f' ? 'a foreign table' : 'not a table';
    return { sources, keyColumns: [], refusal: `${attributes[0].schema}.${attributes[0].table} is ${what}, which is not edited in place.` };
  }

  return { sources, keyColumns: await keyOf(session, relation) };
}

interface AttributeRow {
  rel: string;
  att: number;
  col: string;
  schema: string;
  table: string;
  kind: string;
  identity: boolean;
  generated: boolean;
  fk: boolean;
}

interface IndexRow {
  pk: boolean;
  plain: boolean;
  nkeys: number | string | null;
  cols: string[];
  notnull: boolean | null;
}

/**
 * The columns that identify a row: the primary key, or failing that a unique
 * index — plain ones only, since a partial index identifies a row only
 * inside its predicate and an expression index identifies nothing the grid
 * can see. `INCLUDE` columns are cut off by `indnkeyatts`, read through JSON
 * for the same reason as above: it appeared in version 11.
 */
async function keyOf(session: DriverSession, relation: string): Promise<string[]> {
  const indexes = await session.query<IndexRow>(
    `SELECT i.indisprimary AS pk,
            (i.indpred IS NULL AND i.indexprs IS NULL) AS plain,
            (to_jsonb(i)->>'indnkeyatts') AS nkeys,
            ARRAY(SELECT a.attname::text
                  FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
                  ORDER BY u.ord) AS cols,
            (SELECT bool_and(a.attnotnull)
             FROM unnest(i.indkey) AS u(attnum)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) AS notnull
     FROM pg_catalog.pg_index i
     WHERE i.indrelid = $1::oid AND i.indisunique AND i.indisvalid AND i.indimmediate`,
    [relation]
  );
  const candidates = indexes
    .filter((index) => index.plain && index.cols.length > 0)
    .map((index) => {
      const keys = Number(index.nkeys);
      return {
        pk: index.pk,
        notnull: Boolean(index.notnull),
        cols: Number.isFinite(keys) && keys > 0 ? index.cols.slice(0, keys) : index.cols
      };
    })
    .sort((a, b) => Number(b.pk) - Number(a.pk) || Number(b.notnull) - Number(a.notnull) || a.cols.length - b.cols.length);
  return candidates[0]?.cols ?? [];
}
