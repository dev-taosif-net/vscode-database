import { ColumnMeta, LockReason } from '../shared/query';
import { EditPlan, Provenance, SourceColumn } from './types';

/**
 * The rules that turn "where did these columns come from" into "which cells
 * may be typed into".
 *
 * Pure, and kept apart from the engines on purpose: every refusal here is a
 * sentence the user reads, and the sentences have to agree whichever server
 * is on the other end. The engines only report facts.
 */
export function planEdit(columns: ColumnMeta[], provenance: Provenance, readOnly: boolean): EditPlan {
  const none = (reason: string): EditPlan => ({
    info: { editable: false, reason, keyColumns: [], locks: columns.map(() => null) },
    keyIndexes: [],
    sourceNames: columns.map(() => null)
  });

  if (readOnly) {
    return none('This connection is read-only.');
  }
  if (provenance.refusal) {
    return none(provenance.refusal);
  }

  const sources = provenance.sources;
  const tables = new Map<string, SourceColumn>();
  for (const source of sources) {
    if (source) {
      tables.set(`${source.schema}.${source.table}`, source);
    }
  }
  if (tables.size === 0) {
    return none('No column in this result comes straight from a table.');
  }
  if (tables.size > 1) {
    return none(
      `The result combines ${tables.size} tables (${[...tables.keys()].join(', ')}). Edits need columns from one table.`
    );
  }
  const [only] = tables.values();
  const target = { schema: only.schema, name: only.table };
  const qualified = `${target.schema}.${target.name}`;

  if (provenance.keyColumns.length === 0) {
    return none(`${qualified} has no primary key or unique index, so a row cannot be identified.`);
  }

  // Every key column has to be in the result, or the row cannot be found
  // again. The first matching set column is taken for each, so a key that
  // appears twice (`SELECT id, id AS copy`) still works.
  const keyIndexes: number[] = [];
  for (const key of provenance.keyColumns) {
    const index = sources.findIndex((source) => source !== null && source.column === key);
    if (index === -1) {
      return none(`The result does not include the key column ${key} of ${qualified}. Add it to the SELECT to edit.`);
    }
    keyIndexes.push(index);
  }
  const keySet = new Set(provenance.keyColumns);

  const locks: (LockReason | null)[] = columns.map((column, index) => {
    const source = sources[index];
    if (!source) {
      return 'expression';
    }
    if (keySet.has(source.column)) {
      return 'key';
    }
    if (source.identity) {
      return 'identity';
    }
    if (source.computed) {
      return 'computed';
    }
    if (source.rowversion) {
      return 'rowversion';
    }
    if (source.foreignKey) {
      return 'foreignKey';
    }
    if (column.kind === 'binary') {
      return 'binary';
    }
    return null;
  });

  if (locks.every((lock) => lock !== null)) {
    return {
      info: {
        editable: false,
        reason: `Every column in this result is a key, a foreign key, or maintained by the server.`,
        target,
        keyColumns: provenance.keyColumns,
        locks
      },
      keyIndexes,
      sourceNames: sources.map((source) => source?.column ?? null)
    };
  }

  return {
    info: { editable: true, target, keyColumns: provenance.keyColumns, locks },
    keyIndexes,
    sourceNames: sources.map((source) => source?.column ?? null)
  };
}
