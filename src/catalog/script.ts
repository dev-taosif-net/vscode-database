import { DbMember, FavouriteRef, KINDS } from '../shared/catalog';
import { DriverKind } from '../types';

/**
 * Every piece of SQL this extension writes rather than reads.
 *
 * Phase 2 has no execution engine, so nothing here runs: each of these
 * produces a statement into an editor, where the user reads it, changes it and
 * runs it with whatever they already use. That is a real constraint and it
 * shapes the output — a scaffold nobody can read is worse than no scaffold, so
 * these favour one clause per line and a comment where a value has to be
 * supplied, over the shortest statement that would work.
 */

/** `1 column`, `34 columns`, and never `0 column`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * A quoted identifier, in the engine's own brackets.
 *
 * The closing delimiter is doubled rather than escaped with a backslash,
 * because that is what both engines actually specify: a `]` inside a SQL
 * Server identifier is `]]`, and a `"` inside a PostgreSQL one is `""`. A
 * table genuinely called `Order]s` is rare and an identifier that silently
 * ends early is not a class of bug worth leaving open.
 */
export function quote(driver: DriverKind, name: string): string {
  return driver === 'mssql' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}

export function qualified(driver: DriverKind, ref: { schema: string; name: string }): string {
  return `${quote(driver, ref.schema)}.${quote(driver, ref.name)}`;
}

/**
 * `SELECT TOP (100) * FROM [dbo].[Customer]`.
 *
 * A star and not a column list, deliberately. This action is a look at the
 * data, and the fastest path from a right-click to rows on screen is a
 * statement that is one line long and needs no editing. The enumerated forms
 * are what Generate CRUD is for.
 */
export function selectTop(driver: DriverKind, ref: FavouriteRef, limit: number): string {
  const target = qualified(driver, ref);
  return driver === 'mssql'
    ? `SELECT TOP (${limit}) *\nFROM ${target};\n`
    : `SELECT *\nFROM ${target}\nLIMIT ${limit};\n`;
}

/**
 * The four statements, written against the columns the table actually has.
 *
 * The primary key drives all three of the statements that need a predicate,
 * and a table without one gets a comment saying so rather than a `WHERE` that
 * would match every row. That is the one failure mode of a generated `UPDATE`
 * that is worth going out of the way to prevent.
 *
 * Generated and identity columns are omitted from `INSERT` and from the `SET`
 * list, because the server refuses both — a scaffold that does not compile is
 * a scaffold that gets deleted rather than edited.
 */
export function crudScript(driver: DriverKind, ref: FavouriteRef, columns: DbMember[]): string {
  const target = qualified(driver, ref);
  const q = (name: string) => quote(driver, name);

  /**
   * A fresh placeholder numbering, per statement.
   *
   * PostgreSQL numbers its placeholders across the whole statement, so an
   * UPDATE whose SET list and WHERE clause each start counting at `$1` binds
   * the key's value into the first column being set. That is a generated
   * statement that runs, corrupts one row and reports success, which is the
   * worst failure a scaffold can have. SQL Server names its parameters after
   * the columns instead, so the same value appearing twice is correct there and
   * is what somebody would have typed.
   */
  const numbering = () => {
    let n = 0;
    return (member: DbMember): string => {
      n++;
      if (driver === 'postgres') {
        return `$${n}`;
      }
      const clean = member.name.replace(/\W/g, '');
      return `@${clean || `p${n}`}`;
    };
  };

  const keys = columns.filter((c) => c.key);
  const writable = columns.filter((c) => !c.auto);
  const settable = writable.filter((c) => !c.key);

  // A block comment, not a line comment: a trailing `--` would swallow the
  // semicolon that follows it on the same line and leave the statement open.
  const predicate = (next: (member: DbMember) => string): string =>
    keys.length > 0
      ? `WHERE ${keys.map((c) => `${q(c.name)} = ${next(c)}`).join('\n  AND ')}`
      : 'WHERE 1 = 0 /* no primary key: replace this predicate */';

  const out: string[] = [`-- ${KINDS[ref.kind].singular} ${ref.schema}.${ref.name}`, ''];

  if (keys.length === 0) {
    out.push(
      '-- This table has no primary key, so the three statements below carry no',
      '-- usable WHERE clause. Add one before running either of the last two.',
      ''
    );
  }

  const read = numbering();
  out.push(
    '-- Read',
    `SELECT ${columns.map((c) => q(c.name)).join(',\n       ')}`,
    `FROM ${target}`,
    `${predicate(read)};`,
    ''
  );

  const create = numbering();
  out.push(
    '-- Create',
    `INSERT INTO ${target} (${writable.map((c) => q(c.name)).join(', ')})`,
    `VALUES (${writable.map(create).join(', ')});`,
    ''
  );

  // One numbering across both clauses, which is the whole point.
  const update = numbering();
  out.push(
    '-- Update',
    `UPDATE ${target}`,
    `SET ${settable.map((c) => `${q(c.name)} = ${update(c)}`).join(',\n    ')}`,
    `${predicate(update)};`,
    ''
  );

  const remove = numbering();
  out.push('-- Delete', `DELETE FROM ${target}`, `${predicate(remove)};`, '');

  return out.join('\n');
}

/**
 * A call to a routine, with one line per parameter.
 *
 * SQL Server takes named arguments and PostgreSQL takes positional ones, so
 * the two are genuinely different statements rather than one with different
 * punctuation. Output parameters get a declaration of their own, because a SQL
 * Server `OUTPUT` argument has to be a variable and cannot be a literal.
 */
export function executeScript(driver: DriverKind, ref: FavouriteRef, parameters: DbMember[]): string {
  const target = qualified(driver, ref);
  const args = parameters.filter((p) => p.direction !== 'returns');

  if (driver === 'postgres') {
    const call = `${ref.kind === 'procedure' ? 'CALL' : 'SELECT * FROM'} ${target}(${args
      .map((_, i) => `$${i + 1}`)
      .join(', ')});`;
    const legend = args.map((p, i) => `--   $${i + 1}  ${p.name} ${p.type}`);
    return [`-- ${ref.schema}.${ref.name}`, ...(legend.length ? ['-- Parameters', ...legend, ''] : []), call, ''].join(
      '\n'
    );
  }

  const outs = args.filter((p) => p.direction === 'out' || p.direction === 'inout');
  const lines: string[] = [`-- ${ref.schema}.${ref.name}`, ''];

  for (const out of outs) {
    lines.push(`DECLARE ${out.name} ${out.type};`);
  }
  if (outs.length > 0) {
    lines.push('');
  }

  if (args.length === 0) {
    lines.push(`EXEC ${target};`, '');
    return lines.join('\n');
  }

  lines.push(`EXEC ${target}`);
  lines.push(
    args
      .map((p) => {
        const value = p.direction === 'out' || p.direction === 'inout' ? `${p.name} OUTPUT` : `NULL /* ${p.type} */`;
        return `    ${p.name} = ${value}`;
      })
      .join(',\n') + ';'
  );
  lines.push('');
  for (const out of outs) {
    lines.push(`SELECT ${out.name} AS ${quote(driver, out.name.replace(/^@/, ''))};`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * `CREATE TABLE` composed from the column list.
 *
 * Neither engine stores a table's source, so Open Definition on a table has
 * one of two answers: compose the statement, or report that this kind cannot
 * be scripted. Composing it is the useful one, and it is honest as long as it
 * says what it leaves out — indexes, constraints, defaults and computed
 * expressions are not here, and the header says so rather than the reader
 * discovering it by running the script.
 */
export function tableScript(
  driver: DriverKind,
  ref: FavouriteRef,
  columns: DbMember[],
  options: { verb?: string; suffix?: string } = {}
): string {
  const verb = options.verb ?? 'CREATE TABLE';
  const suffix = options.suffix ?? '';
  const target = qualified(driver, ref);
  const width = columns.reduce((n, c) => Math.max(n, quote(driver, c.name).length), 0);

  const body = columns.map((c) => {
    const name = quote(driver, c.name).padEnd(width);
    const nullable = c.nullable === false ? ' NOT NULL' : ' NULL';
    return `    ${name}  ${c.type}${nullable}`;
  });

  const keys = columns.filter((c) => c.key);
  if (keys.length > 0) {
    body.push(`    PRIMARY KEY (${keys.map((c) => quote(driver, c.name)).join(', ')})`);
  }

  return [
    `-- Columns and the primary key only. Indexes, foreign keys, defaults,`,
    `-- constraints and computed expressions are not included.`,
    `${verb} ${target}${suffix} (`,
    body.join(',\n'),
    ');',
    ''
  ].join('\n');
}
