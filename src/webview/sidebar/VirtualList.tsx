import {
  FocusEvent,
  MutableRefObject,
  UIEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useStoreSelector } from '../state/store';
import { NOMATCH_ID, NoMatch } from './EmptyState';
import { GroupHeader, PINNED_ID, PinnedHeader, headerId } from './GroupHeader';
import { Row } from './Row';
import { StickyHeader } from './StickyHeader';
import { FlatItem, flatten, heightOf, indexAt, measure } from './model';
import { CursorState, ListState, SessionMap, cursorStore, listStore, sessionStore } from './state';

/**
 * Below this many items the whole list is in the DOM.
 *
 * Everything else — absolute positioning inside the spacer, the overlay
 * header, the ribbons, the explicit set size — is identical either side of it,
 * so there is one geometry model to maintain rather than two. What the
 * threshold buys is that most users get a complete DOM and therefore an
 * unbroken screen-reader browse mode with no ARIA compensation at all.
 */
const VIRTUALIZE_ABOVE = 120;

/** Eight rows above and below: 176px of insurance against a fast flick. */
const OVERSCAN = 8;

const selRows = (s: ListState) => s.rows;
const selGrouped = (s: ListState) => s.grouped;
const selSort = (s: ListState) => s.sort;
const selCollapsed = (s: ListState) => s.collapsed;
const selQuery = (s: ListState) => s.query;
const selCursor = (s: CursorState) => s.cursorId;

/**
 * A value, not an object, so `useSyncExternalStore` compares it with `Object.is`
 * and bails.
 *
 * The flattened index has to know which rows are open, because a group header
 * says "18 · 2 open". If this returned the session map, every spinner tick and
 * every remembered failure would rebuild the geometry the whole list is keyed
 * by. Returning the connected ids as one string means the index is rebuilt when
 * a session actually opens or closes and at no other time.
 */
const selOpenKey = (s: SessionMap): string => {
  const ids: string[] = [];
  for (const id in s) {
    if (s[id].state === 'connected') {
      ids.push(id);
    }
  }
  return ids.sort().join(' ');
};

/**
 * The cursor is a flat index here and a string in `cursorStore`, so a row can
 * test it with one comparison. The three ids that are not profile ids are owned
 * by the components that answer to them rather than minted here, because a
 * second convention for the same thing is a second thing to get wrong.
 */
export function keyOf(item: FlatItem): string {
  switch (item.kind) {
    case 'row':
      return item.id;
    case 'group':
      return headerId(item.environment);
    case 'pinned':
      return PINNED_ID;
    case 'nomatch':
      return NOMATCH_ID;
  }
}

function indexOfKey(items: readonly FlatItem[], key: string | null): number {
  if (key === null) {
    return -1;
  }
  for (let i = 0; i < items.length; i++) {
    if (keyOf(items[i]) === key) {
      return i;
    }
  }
  return -1;
}

/**
 * What the keyboard model needs from the list.
 *
 * The key table lives in `Sidebar` because it is one thing to read in one
 * place; the geometry lives here because nothing else has it. This is the seam
 * between them, and every method answers against the geometry of the current
 * render.
 */
export interface ListHandle {
  items(): readonly FlatItem[];
  /** The flat index the cursor is on, or -1 when the list has not been touched. */
  cursorIndex(): number;
  /** The index of the section header owning an item, or -1. */
  ownerOf(index: number): number;
  /** How many items a viewport holds, for PageUp and PageDown. */
  page(): number;
  /** Scroll it into view, make it the cursor, and give it DOM focus. */
  focusIndex(index: number): void;
  focusFirst(rowsOnly: boolean): void;
  /** Bring a row into view and make it the cursor, without taking focus. */
  reveal(id: string): void;
  restoreFocus(): void;
}

interface Frame {
  first: number;
  last: number;
  /** The index of the header the overlay is drawing, or -1. */
  sticky: number;
}

interface Props {
  handle: MutableRefObject<ListHandle | null>;
  initialTop: number;
  onTop: (top: number) => void;
}

export function VirtualList({ handle, initialTop, onTop }: Props): JSX.Element {
  const rows = useStoreSelector(listStore, selRows);
  const grouped = useStoreSelector(listStore, selGrouped);
  const sort = useStoreSelector(listStore, selSort);
  const collapsed = useStoreSelector(listStore, selCollapsed);
  const query = useStoreSelector(listStore, selQuery);
  const cursorKey = useStoreSelector(cursorStore, selCursor);
  const openKey = useStoreSelector(sessionStore, selOpenKey);

  const open = useMemo(() => new Set(openKey ? openKey.split(' ') : []), [openKey]);

  /**
   * A hundred connections plus five headers is 105 entries and two typed arrays
   * of about 850 bytes. It runs when a profile changes, when a group folds,
   * when the query changes and when a session opens. Not per frame, not per
   * scroll, and never for a spinner.
   */
  const geom = useMemo(() => {
    const flat = flatten({ rows, grouped, sort, collapsed, query, open });
    return { ...measure(flat.items), matches: flat.matches };
  }, [rows, grouped, sort, collapsed, query, open]);

  const n = geom.items.length;
  const total = geom.offsets[n];
  const virtual = n > VIRTUALIZE_ABOVE;
  const needle = query.trim().toLowerCase();

  const scroller = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const rawTop = useRef(0);
  const frame = useRef(0);
  const restored = useRef(false);
  /** An index waiting for its element to exist before it can be focused. */
  const pending = useRef(-1);

  const [viewportH, setViewportH] = useState(0);
  const [win, setWin] = useState<Frame>({ first: 0, last: 0, sticky: -1 });

  const cursorIndex = useMemo(() => indexOfKey(geom.items, cursorKey), [geom, cursorKey]);

  /**
   * The overlay's push-off, derived from the current geometry every time it is
   * written and never cached.
   *
   * A `state` message can shrink the list while the viewport is scrolled deep,
   * and a cached overlay would then name the wrong environment — which is worse
   * than no sticky header at all in a list where the environment is the primary
   * reading. There is no stale copy because there is no copy.
   */
  const paintOverlay = (top: number): void => {
    const node = overlay.current;
    if (!node || n === 0) {
      return;
    }
    const h = geom.owner[indexAt(geom, top)];
    if (h < 0) {
      return;
    }
    const hi = geom.headers.indexOf(h);
    const next = geom.headers[hi + 1];
    const nextTop = next === undefined ? Infinity : geom.offsets[next];
    // The push-off, and the only thing written per frame: the overlay is a
    // sibling of the scroller rather than a descendant of it, so it does not
    // move with the content and has no scroll offset to carry.
    node.style.transform = `translateY(${Math.min(0, nextTop - top - heightOf(geom.items[h]))}px)`;
  };

  const apply = (top: number, height: number): void => {
    // The overscan start is not the first *visible* item, and the overlay must
    // name the header of what the eye can see, not of a row eight above the
    // fold.
    const visible = indexAt(geom, top);
    const nextFirst = virtual ? Math.max(0, visible - OVERSCAN) : 0;
    const nextLast = virtual ? Math.min(n - 1, indexAt(geom, top + height) + OVERSCAN) : n - 1;
    const nextSticky = n === 0 ? -1 : geom.owner[visible];

    paintOverlay(top);

    // The only setState in the scroll loop. Returning the same object makes
    // React bail, so scrolling a 22px row by three pixels does no React work.
    setWin((w) =>
      w.first === nextFirst && w.last === nextLast && w.sticky === nextSticky
        ? w
        : { first: nextFirst, last: nextLast, sticky: nextSticky }
    );
  };

  const applyRef = useRef(apply);
  useLayoutEffect(() => {
    applyRef.current = apply;
  });

  const scrollTo = (i: number): void => {
    const el = scroller.current;
    if (!el) {
      return;
    }
    const height = el.clientHeight;
    const top = el.scrollTop;
    // An item flush with the top of the viewport lands underneath the sticky
    // overlay, so the upward edge is the overlay's height rather than zero.
    const ownerIndex = geom.owner[i];
    const cover = ownerIndex >= 0 && ownerIndex !== i ? heightOf(geom.items[ownerIndex]) : 0;
    let next = top;
    if (geom.offsets[i] - cover < top) {
      next = Math.max(0, geom.offsets[i] - cover);
    } else if (geom.offsets[i + 1] > top + height) {
      next = geom.offsets[i + 1] - height;
    }
    if (next !== top) {
      el.scrollTop = next;
      rawTop.current = next;
      apply(next, height);
    }
  };

  /**
   * Position in the flattened set is the only address every rendered item
   * carries, and it is already there for assistive technology. The child
   * combinator keeps it that way: the sticky overlay holds a copy of a header
   * with a position of its own, and a copy that is `aria-hidden` is the last
   * thing focus may land on.
   */
  const elementAt = (i: number): HTMLElement | null =>
    scroller.current?.querySelector<HTMLElement>(`.spacer > [aria-posinset="${i + 1}"]`) ?? null;

  const focusIndex = (i: number): void => {
    if (i < 0 || i >= n) {
      return;
    }
    scrollTo(i);
    const key = keyOf(geom.items[i]);
    cursorStore.setState((s) => (s.cursorId === key ? s : { ...s, cursorId: key }));
    const el = elementAt(i);
    if (el) {
      el.focus({ preventScroll: true });
      pending.current = -1;
      return;
    }
    // Not mounted yet. It will be after this commit, because the cursor is
    // always rendered.
    pending.current = i;
  };

  useLayoutEffect(() => {
    const i = pending.current;
    if (i < 0) {
      return;
    }
    const el = elementAt(i);
    if (el) {
      pending.current = -1;
      el.focus({ preventScroll: true });
    }
  });

  useLayoutEffect(() => {
    handle.current = {
      items: () => geom.items,
      cursorIndex: () => cursorIndex,
      ownerOf: (i) => (i >= 0 && i < n ? geom.owner[i] : -1),
      page: () => {
        const el = scroller.current;
        const height = el ? el.clientHeight : viewportH;
        return Math.max(1, indexAt(geom, rawTop.current + height) - indexAt(geom, rawTop.current));
      },
      focusIndex,
      focusFirst: (rowsOnly) => {
        const i = rowsOnly ? geom.items.findIndex((item) => item.kind === 'row') : 0;
        focusIndex(i);
      },
      reveal: (id) => {
        const i = indexOfKey(geom.items, id);
        if (i < 0) {
          return;
        }
        scrollTo(i);
        cursorStore.setState((s) => (s.cursorId === id ? s : { ...s, cursorId: id }));
      },
      restoreFocus: () => focusIndex(cursorIndex >= 0 ? cursorIndex : 0)
    };
    return () => {
      handle.current = null;
    };
  });

  /**
   * Height only. Knowing how tall the viewport is costs one number that cannot
   * disagree with anything; knowing how wide it is would put a second copy of
   * the breakpoints in JavaScript, where they would drift from the container
   * queries that actually draw the row.
   */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setViewportH(entries[0]?.contentRect.height ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (restored.current || n === 0) {
      return;
    }
    restored.current = true;
    const el = scroller.current;
    if (el && initialTop > 0) {
      el.scrollTop = initialTop;
      rawTop.current = el.scrollTop;
    }
  }, [n, initialTop]);

  /**
   * Rebuild, clamp, then recompute — in that order, in the same commit.
   *
   * A connection deleted from the command palette, a group folded from the
   * title bar or a search cleared can shrink the list under a viewport that is
   * scrolled deep. Left alone, `scrollTop` is past the end, `indexAt` clamps to
   * the last item and the overlay draws the wrong header. Clamping before
   * anything reads the offsets is what stops that, and setting `scrollTop`
   * does not fire a scroll event synchronously, so `rawTop` is written here too.
   */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) {
      return;
    }
    const max = Math.max(0, total - el.clientHeight);
    if (el.scrollTop > max) {
      el.scrollTop = max;
    }
    rawTop.current = el.scrollTop;
    apply(el.scrollTop, el.clientHeight);
  }, [geom, viewportH]);

  // The overlay that mounts on a header crossing has never had a transform
  // written to it, so it would draw one frame at the top of the content.
  useLayoutEffect(() => {
    paintOverlay(rawTop.current);
  });

  useEffect(
    () => () => {
      if (frame.current) {
        cancelAnimationFrame(frame.current);
      }
    },
    []
  );

  const tick = (): void => {
    frame.current = 0;
    const el = scroller.current;
    if (!el) {
      return;
    }
    applyRef.current(rawTop.current, el.clientHeight);
    onTop(rawTop.current);
  };

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    rawTop.current = event.currentTarget.scrollTop;
    if (frame.current) {
      return;
    }
    frame.current = requestAnimationFrame(tick);
  };

  /**
   * Until the list has been touched there is no cursor and therefore no item
   * carrying `tabindex="0"`, and Tab from the search box would skip the tree
   * entirely and land in the footer. The tree takes the tab stop for exactly
   * that interval and hands focus straight on.
   */
  const hasCursor = cursorIndex >= 0;

  const onListFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    focusIndex(cursorIndex >= 0 ? cursorIndex : 0);
  };

  const first = virtual ? Math.min(win.first, Math.max(0, n - 1)) : 0;
  const last = virtual ? Math.min(win.last, n - 1) : n - 1;

  const node = (i: number): JSX.Element => {
    const item = geom.items[i];
    const top = geom.offsets[i];
    switch (item.kind) {
      case 'pinned':
        return <PinnedHeader key="pinned" count={item.count} top={top} posinset={i + 1} setsize={n} />;
      case 'group':
        return (
          <GroupHeader
            key={`group:${item.environment}`}
            environment={item.environment}
            count={item.count}
            open={item.open}
            collapsed={item.collapsed}
            top={top}
            posinset={i + 1}
            setsize={n}
          />
        );
      case 'row':
        return (
          <Row
            key={item.id}
            id={item.id}
            top={top}
            pinned={item.pinned}
            showBadge={item.showBadge}
            level={geom.owner[i] >= 0 ? 2 : 1}
            posinset={i + 1}
            setsize={n}
            needle={needle}
            hit={geom.matches.get(item.id)?.join(' ') ?? ''}
          />
        );
      case 'nomatch':
        return <NoMatch key="nomatch" query={item.query} top={top} />;
    }
  };

  const nodes: JSX.Element[] = [];
  for (let i = first; i <= last; i++) {
    nodes.push(node(i));
  }
  // Non-negotiable, and the rule hand-rolled virtualizers get wrong: focus must
  // never be silently destroyed by a scroll. Off-viewport is fine; unmounted is
  // not.
  if (cursorIndex >= 0 && (cursorIndex < first || cursorIndex > last)) {
    nodes.push(node(cursorIndex));
  }

  return (
    <>
      <div
        className="list"
        role="tree"
        aria-label="Connections"
        ref={scroller}
        tabIndex={hasCursor ? -1 : 0}
        onFocus={onListFocus}
        onScroll={onScroll}
      >
        <div className="spacer" style={{ height: total }}>
          {geom.headers.map((h, i) => {
            const item = geom.items[h];
            if (item.kind !== 'group') {
              // The pinned section has no ribbon of its own: its rows keep
              // theirs, so the ribbon column beside it is multicoloured where
              // every real group's is a single hue. That texture is how the
              // section is told apart at a glance, with no icon and no reading.
              return null;
            }
            const end = geom.headers[i + 1] ?? n;
            return (
              <div
                key={`ribbon:${item.environment}`}
                className={`ribbon env-${item.environment}`}
                aria-hidden="true"
                style={{ top: geom.offsets[h], height: geom.offsets[end] - geom.offsets[h] }}
              />
            );
          })}
          {nodes}
        </div>
      </div>
      {/*
        A sibling of the scroller, not a child: an absolutely positioned
        descendant of a scroll container scrolls with the content, which is the
        one thing an overlay must not do. Its containing block is `.sidebar`,
        so the stylesheet offsets it by the search band's height.
      */}
      <StickyHeader
        item={win.sticky >= 0 && win.sticky < n ? geom.items[win.sticky] : null}
        overlayRef={overlay}
      />
    </>
  );
}
