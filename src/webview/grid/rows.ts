import { CellValue } from '../../shared/query';

/**
 * The rows a grid is holding right now, and nothing else.
 *
 * The host owns the answer; this holds the window being drawn plus whatever
 * has not been evicted yet. A grid showing forty rows of a forty-million-row
 * result holds forty rows, which is the property the whole architecture is
 * built to have.
 */
const CAPACITY = 4000;

type Key = string;

interface Cache {
  rows: Map<number, CellValue[]>;
  /** Ranges asked for and not yet answered, so a scroll does not ask twice. */
  pending: Set<number>;
  order: number[];
}

const caches = new Map<Key, Cache>();

function keyOf(executionId: string, setIndex: number): Key {
  return `${executionId}:${setIndex}`;
}

function cacheFor(key: Key): Cache {
  let cache = caches.get(key);
  if (!cache) {
    cache = { rows: new Map(), pending: new Set(), order: [] };
    caches.set(key, cache);
  }
  return cache;
}

/** The page size the grid asks in. Bigger than a screen, smaller than a fetch. */
export const PAGE = 200;

export function pageOf(index: number): number {
  return Math.floor(index / PAGE) * PAGE;
}

export function get(executionId: string, setIndex: number, index: number): CellValue[] | undefined {
  return caches.get(keyOf(executionId, setIndex))?.rows.get(index);
}

/**
 * Notes that a page has been asked for.
 *
 * Returns false when it already has been, which is what stops a fast scroll
 * from sending the same request eight times before the first answer lands.
 */
export function claim(executionId: string, setIndex: number, offset: number): boolean {
  const cache = cacheFor(keyOf(executionId, setIndex));
  if (cache.pending.has(offset) || cache.rows.has(offset)) {
    return false;
  }
  cache.pending.add(offset);
  return true;
}

export function put(executionId: string, setIndex: number, offset: number, rows: CellValue[][]): void {
  const cache = cacheFor(keyOf(executionId, setIndex));
  cache.pending.delete(offset);
  rows.forEach((row, i) => {
    const index = offset + i;
    if (!cache.rows.has(index)) {
      cache.order.push(index);
    }
    cache.rows.set(index, row);
  });

  // Oldest-first eviction. Scrolling forward through four million rows would
  // otherwise end with four million rows in the page, which is the one thing
  // this cache exists to prevent.
  while (cache.order.length > CAPACITY) {
    const oldest = cache.order.shift();
    if (oldest !== undefined) {
      cache.rows.delete(oldest);
    }
  }
}

/** Everything for one execution, dropped when it is replaced. */
export function forget(executionId?: string): void {
  if (!executionId) {
    caches.clear();
    return;
  }
  for (const key of [...caches.keys()]) {
    if (key.startsWith(`${executionId}:`)) {
      caches.delete(key);
    }
  }
}
