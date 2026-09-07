import { CellValue, ColumnKind, TaggedValue } from '../shared/query';

/**
 * The most bytes of a binary value that reach the grid.
 *
 * A `varbinary(max)` holding a PDF is megabytes, and a grid cell shows about
 * forty characters of it. The rest is carried nowhere and dropped here rather
 * than at the far end, because the point of a cap is not to send it.
 */
const BINARY_PREVIEW = 32;

/**
 * Turns a driver's value into something that survives `postMessage` and means
 * the same thing on the other side.
 *
 * Three types get a tag rather than a value. `bigint` does not clone. A
 * `Buffer` clones into an object the grid cannot read. And a `Date` clones
 * into a `Date` whose rendering depends on the viewer's locale and time zone,
 * which is how the same `datetime2` shows one instant in the grid and another
 * in the CSV. Each is converted here, once, by the side that knows what the
 * server actually sent.
 */
export function encodeCell(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  const type = typeof value;
  if (type === 'string' || type === 'boolean') {
    return value as string | boolean;
  }
  if (type === 'number') {
    // NaN and Infinity clone, but they are not JSON and they are not values a
    // server produced: they are a driver's way of saying something went wrong.
    return Number.isFinite(value as number) ? (value as number) : String(value);
  }
  if (type === 'bigint') {
    return { t: 'n64', v: (value as bigint).toString() };
  }
  if (value instanceof Date) {
    return { t: 'ts', v: isoLocal(value) };
  }
  if (isBinary(value)) {
    const bytes = value as Uint8Array;
    const head = Buffer.from(bytes.subarray(0, BINARY_PREVIEW)).toString('hex');
    const tagged: TaggedValue = { t: 'bin', v: `0x${head.toUpperCase()}`, n: bytes.length };
    return tagged;
  }
  if (type === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function isBinary(value: unknown): boolean {
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

/**
 * ISO-8601 in the value's own wall clock, not in UTC and not localised.
 *
 * Both drivers hand back a `Date` built from what the column held. Rendering
 * it with `toISOString` shifts it by the host's offset, so a row written at
 * 09:14 in a `datetime2` column reads as 08:14 for anybody an hour east of the
 * server — a difference that is invisible until somebody reconciles a report.
 * The local parts are what the column contained, so the local parts are what
 * is written.
 */
function isoLocal(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ms = date.getMilliseconds();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  return ms ? `${stamp}.${pad(ms, 3)}` : stamp;
}

/** Alignment and comparison follow the type, never the first row's value. */
export function kindOfSqlType(type: string): ColumnKind {
  const t = type.toLowerCase();
  if (/^(bit|bool|boolean)/.test(t)) {
    return 'bool';
  }
  if (/(int|decimal|numeric|money|float|real|double|serial)/.test(t)) {
    return 'number';
  }
  if (/(date|time|interval)/.test(t)) {
    return 'date';
  }
  if (/(binary|bytea|image|blob)/.test(t)) {
    return 'binary';
  }
  if (/(json|xml)/.test(t)) {
    return 'json';
  }
  if (/(char|text|clob|uniqueidentifier|uuid|name)/.test(t)) {
    return 'text';
  }
  return 'other';
}
