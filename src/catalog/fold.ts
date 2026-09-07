import { CatalogSummary, ObjectKind, SchemaInfo } from '../shared/catalog';

/**
 * The two helpers both engines need and neither owns.
 *
 * They lived in `mssql.ts` and the PostgreSQL reader imported them from there,
 * which read as though one engine were the reference implementation and the
 * other a variant of it. They are not: they are the shape of the answer, which
 * is the one thing the two genuinely share.
 */

/**
 * The `(schema, kind, count)` triples folded into both readings the tree needs.
 *
 * The general-mode counts are the per-schema counts summed, which is why one
 * statement can serve both modes: switching a connection to schema-focused
 * mode costs no round trip at all, because the answer was already here.
 */
export function foldSummary(rows: Array<{ sch: string; kind: string; n: number }>): CatalogSummary {
  const counts: Partial<Record<ObjectKind, number>> = {};
  const schemas = new Map<string, SchemaInfo>();

  for (const row of rows) {
    const kind = row.kind as ObjectKind;
    if (!kind) {
      continue;
    }
    const n = Number(row.n) || 0;
    const name = String(row.sch);
    counts[kind] = (counts[kind] ?? 0) + n;

    let schema = schemas.get(name);
    if (!schema) {
      schema = { name, counts: {}, total: 0 };
      schemas.set(name, schema);
    }
    schema.counts[kind] = (schema.counts[kind] ?? 0) + n;
    schema.total += n;
  }

  return {
    counts,
    // Empty schemas are dropped by construction: a schema with no objects
    // never produced a row, and a schema-focused tree listing forty empty
    // `db_datareader`-style schemas would bury the three that hold anything.
    schemas: [...schemas.values()].sort((a, b) => a.name.localeCompare(b.name)),
    loadedAt: Date.now()
  };
}

/**
 * `LIKE` treats four characters as syntax, and a search for `usp_Get` means
 * the underscore literally. Without this, `_` matches any character and the
 * search quietly returns more than it was asked for.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (match) => '\\' + match);
}
