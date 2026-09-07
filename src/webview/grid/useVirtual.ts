import { useCallback, useEffect, useRef, useState } from 'react';

export interface Window {
  start: number;
  end: number;
}

/**
 * A window over a fixed-height list.
 *
 * Fixed height is the whole trick: `scrollTop / rowHeight` is an index rather
 * than a measurement, so jumping to row nine million is a subtraction and not
 * a walk. Variable-height rows would buy wrapped text and cost the scroll
 * model; a long value gets a tooltip and a detail pane instead.
 */
export function useVirtualRows(
  count: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 12
): Window {
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  return { start, end: Math.min(count, start + visible) };
}

/**
 * Columns are windowed too.
 *
 * A `SELECT *` on a wide fact table is two hundred columns, and rendering two
 * hundred cells per row for forty rows is eight thousand elements to show the
 * twelve a person can see. Only the columns intersecting the viewport are
 * built; the rest are two spacer cells.
 */
export function useVirtualColumns(
  widths: number[],
  viewportWidth: number,
  scrollLeft: number,
  overscan = 2
): Window & { before: number; after: number } {
  let start = 0;
  let offset = 0;
  while (start < widths.length && offset + widths[start] < scrollLeft) {
    offset += widths[start];
    start++;
  }
  start = Math.max(0, start - overscan);

  let before = 0;
  for (let i = 0; i < start; i++) {
    before += widths[i];
  }

  let end = start;
  let width = 0;
  while (end < widths.length && width < viewportWidth + scrollLeft - before) {
    width += widths[end];
    end++;
  }
  end = Math.min(widths.length, end + overscan);

  let after = 0;
  for (let i = end; i < widths.length; i++) {
    after += widths[i];
  }
  return { start, end, before, after };
}

/** The element's own size, tracked without a layout read per frame. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setSize((current) =>
          current.width === box.width && current.height === box.height
            ? current
            : { width: box.width, height: box.height }
        );
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

/**
 * Scroll offsets, sampled on a frame rather than on every scroll event.
 *
 * A trackpad fires scroll far faster than the browser paints, and re-rendering
 * a windowed grid on each one is work thrown away before it is seen.
 */
export function useScroll<T extends HTMLElement>(ref: React.RefObject<T>): { top: number; left: number } {
  const [offset, setOffset] = useState({ top: 0, left: 0 });
  const frame = useRef(0);

  const sample = useCallback(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    setOffset((current) =>
      current.top === element.scrollTop && current.left === element.scrollLeft
        ? current
        : { top: element.scrollTop, left: element.scrollLeft }
    );
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const onScroll = () => {
      if (frame.current) {
        return;
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        sample();
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (frame.current) {
        cancelAnimationFrame(frame.current);
      }
    };
  }, [ref, sample]);

  return offset;
}
