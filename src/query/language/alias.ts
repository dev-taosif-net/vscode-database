/**
 * A short name for a relation, derived the way people write them by hand.
 *
 * The rule is the one most schemas are already named to: the capitals carry
 * the meaning. `empManualAttendanceSummary` is `mas`, `SalesOrderHeader` is
 * `soh`, `sales_order_line` is `sol`. The leading lower-case segment of a
 * camel-cased name is a prefix — `emp`, `tbl`, `vw` — and dropping it is
 * exactly what somebody aliasing by hand does.
 *
 * A name with no shape to read falls back to its first three letters, which
 * is what a person typing fast would have reached for anyway.
 */
import { strip } from './context';

const MAX = 4;

export function aliasFor(name: string, taken: Iterable<string> = []): string {
  const seed = seedOf(strip(name));
  const used = new Set<string>();
  for (const alias of taken) {
    used.add(alias.toLowerCase());
  }
  if (!used.has(seed)) {
    return seed;
  }
  // A second copy of the same table is a self-join, and a self-join needs two
  // names for one thing. Numbering is what people already do here.
  for (let n = 2; n < 100; n++) {
    const candidate = `${seed}${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return seed;
}

function seedOf(name: string): string {
  const bare = name.replace(/[^A-Za-z0-9_]/g, '');
  const parts = bare.split('_').filter(Boolean);

  // snake_case in either case: the first letter of every part.
  if (parts.length > 1) {
    return parts
      .map((part) => part[0])
      .join('')
      .toLowerCase()
      .slice(0, MAX);
  }

  const word = parts[0] ?? '';
  if (!word) {
    return 't';
  }

  const capitals = word.replace(/[^A-Z]/g, '');
  // `capitals.length < word.length` is what keeps an all-caps name out of
  // here: `SALESORDER` has no humps to read, it is just loud.
  if (capitals.length >= 2 && capitals.length < word.length) {
    return capitals.toLowerCase().slice(0, MAX);
  }
  return word.slice(0, 3).toLowerCase();
}
