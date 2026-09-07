import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellRange, CellValue, ColumnMeta, ResultSetInfo, cellText, isTagged } from '../../shared/query';
import { MIN_WIDTH, measureColumns } from './widths';
import { PAGE, claim, get, pageOf } from './rows';
import { useScroll, useSize, useVirtualColumns, useVirtualRows } from './useVirtual';

/** The row height the explorer uses. One product, one rhythm. */
const ROW = 22;
const GUTTER = 44;

export interface GridProps {
  executionId: string;
  set: ResultSetInfo;
  /** Asks the host for a page. The grid never fetches twice for one page. */
  request: (offset: number, count: number) => void;
  onSort: (column: number, direction: 'asc' | 'desc' | null) => void;
  onCopy: (range: CellRange, shape: 'tsv' | 'tsv-headers') => void;
  onOpenCell: (value: CellValue, column: ColumnMeta) => void;
  /** Bumped by the host on every `rows` message, to force a repaint. */
  revision: number;
}

export function Grid(props: GridProps): JSX.Element {
  const { executionId, set, request, onSort, onCopy, revision } = props;
  const [viewport, size] = useSize<HTMLDivElement>();
  const scroll = useScroll(viewport);
  const [widths, setWidths] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<{ row: number; column: number } | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  const dragging = useRef<{ column: number; startX: number; startWidth: number } | null>(null);

  const count = set.rowCount;

  // Widths are measured once per result set, from the header and whatever rows
  // have arrived. A user's drag wins for ever after.
  useEffect(() => {
    const sample: CellValue[][] = [];
    for (let i = 0; i < 200 && i < count; i++) {
      const row = get(executionId, set.index, i);
      if (row) {
        sample.push(row);
      }
    }
    setWidths((current) => (current.length === set.columns.length && sample.length === 0 ? current : measureColumns(set.columns, sample)));
    // `revision` is here so the first page of rows re-measures the columns
    // that were sized from their headers alone.
  }, [executionId, set.index, set.columns, count, revision]);

  const rows = useVirtualRows(count, ROW, size.height || 400, scroll.top);
  const columns = useVirtualColumns(widths.length ? widths : set.columns.map(() => 120), size.width || 600, scroll.left);

  // Ask for what is about to be drawn, one page at a time. `claim` is what
  // stops a fast scroll from sending the same request eight times.
  useEffect(() => {
    for (let offset = pageOf(rows.start); offset < rows.end; offset += PAGE) {
      if (claim(executionId, set.index, offset)) {
        request(offset, PAGE);
      }
    }
  }, [executionId, set.index, rows.start, rows.end, request]);

  const total = widths.reduce((sum, width) => sum + width, 0);

  const select = useCallback(
    (row: number, column: number, extend: boolean) => {
      if (extend && anchor) {
        setRange({
          top: Math.min(anchor.row, row),
          bottom: Math.max(anchor.row, row),
          left: Math.min(anchor.column, column),
          right: Math.max(anchor.column, column)
        });
        return;
      }
      setAnchor({ row, column });
      setRange({ top: row, bottom: row, left: column, right: column });
    },
    [anchor]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (range) {
        onCopy(range, event.shiftKey ? 'tsv-headers' : 'tsv');
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setRange({ top: 0, bottom: Math.max(0, count - 1), left: 0, right: set.columns.length - 1 });
      return;
    }
    if (!anchor) {
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-Math.floor((size.height || 400) / ROW), 0],
      PageDown: [Math.floor((size.height || 400) / ROW), 0]
    };
    const move = moves[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    const row = Math.max(0, Math.min(count - 1, anchor.row + move[0]));
    const column = Math.max(0, Math.min(set.columns.length - 1, anchor.column + move[1]));
    select(row, column, event.shiftKey);
    const element = viewport.current;
    if (element) {
      const top = row * ROW;
      if (top < element.scrollTop) {
        element.scrollTop = top;
      } else if (top + ROW > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW - element.clientHeight;
      }
    }
  };

  const startResize = (event: MouseEvent, column: number) => {
    event.preventDefault();
    event.stopPropagation();
    dragging.current = { column, startX: event.clientX, startWidth: widths[column] ?? 120 };

    const onMove = (move: globalThis.MouseEvent) => {
      const drag = dragging.current;
      if (!drag) {
        return;
      }
      setWidths((current) => {
        const next = [...current];
        next[drag.column] = Math.max(MIN_WIDTH, drag.startWidth + (move.clientX - drag.startX));
        return next;
      });
    };
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const visibleColumns = useMemo(
    () => set.columns.slice(columns.start, columns.end).map((column, i) => ({ column, index: columns.start + i })),
    [set.columns, columns.start, columns.end]
  );

  const inRange = (row: number, column: number) =>
    range !== null && row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;

  return (
    <div className="grid" onKeyDown={onKeyDown} tabIndex={0} role="grid" aria-rowcount={count}>
      <div className="grid-header" style={{ transform: `translateX(${-scroll.left}px)`, width: total + GUTTER }}>
        <div className="grid-hcell grid-gutter" style={{ width: GUTTER }} />
        <div style={{ width: columns.before }} />
        {visibleColumns.map(({ column, index }) => {
          const sorted = set.sort?.column === index ? set.sort : undefined;
          return (
            <div
              key={index}
              className={`grid-hcell${sorted ? ' is-sorted' : ''}`}
              style={{ width: widths[index] ?? 120 }}
              title={`${column.name}  ${column.type}`}
              role="columnheader"
              aria-sort={sorted ? (sorted.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() =>
                onSort(index, !sorted ? 'asc' : sorted.direction === 'asc' ? 'desc' : null)
              }
            >
              <span className="grid-hname">{column.name}</span>
              {sorted ? (
                <span className={`grid-sort${sorted.server ? '' : ' is-partial'}`} aria-hidden="true">
                  {sorted.direction === 'asc' ? '▲' : '▼'}
                </span>
              ) : null}
              <span className="grid-resize" onMouseDown={(event) => startResize(event, index)} />
            </div>
          );
        })}
        <div style={{ width: columns.after }} />
      </div>

      <div className="grid-viewport" ref={viewport}>
        <div className="grid-canvas" style={{ height: Math.max(count * ROW, 1), width: total + GUTTER }}>
          {Array.from({ length: Math.max(0, rows.end - rows.start) }, (_, i) => {
            const index = rows.start + i;
            const row = get(executionId, set.index, index);
            return (
              <div className="grid-row" key={index} style={{ top: index * ROW }} role="row">
                <div className="grid-cell grid-gutter" style={{ width: GUTTER }}>
                  {(index + 1).toLocaleString('en-US')}
                </div>
                <div style={{ width: columns.before }} />
                {visibleColumns.map(({ column, index: c }) => {
                  const value = row?.[c];
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      className={`grid-cell kind-${column.kind}${inRange(index, c) ? ' is-selected' : ''}${
                        anchor?.row === index && anchor.column === c ? ' is-anchor' : ''
                      }`}
                      style={{ width: widths[c] ?? 120 }}
                      onMouseDown={(event) => select(index, c, event.shiftKey)}
                      onDoubleClick={() => props.onOpenCell(value ?? null, column)}
                      title={row ? cellText(value ?? null) : undefined}
                    >
                      {row ? <Cell value={value ?? null} /> : <span className="grid-skeleton" />}
                    </div>
                  );
                })}
                <div style={{ width: columns.after }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * One value.
 *
 * `NULL` is italic and dim and is not an empty string; an empty string draws
 * nothing at all. The two are told apart deliberately, because a grid that
 * renders both as blank makes a column of missing data indistinguishable from
 * a column of present but empty data.
 */
function Cell({ value }: { value: CellValue }): JSX.Element {
  if (value === null) {
    return <span className="grid-null">NULL</span>;
  }
  if (typeof value === 'boolean') {
    return <span>{value ? 'true' : 'false'}</span>;
  }
  if (isTagged(value)) {
    if (value.t === 'bin') {
      return (
        <span className="grid-binary">
          {value.v}
          <span className="grid-dim"> {value.n?.toLocaleString('en-US')} bytes</span>
        </span>
      );
    }
    return <span className="grid-mono">{value.v}</span>;
  }
  return <span>{String(value)}</span>;
}

export const ROW_HEIGHT = ROW;
