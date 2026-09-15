import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CellRange,
  CellValue,
  ColumnMeta,
  EditInfo,
  LOCK_LABELS,
  ResultSetInfo,
  cellText,
  isTagged
} from '../../shared/query';
import { Codicon } from '../primitives/Codicon';
import { MIN_WIDTH, measureColumns } from './widths';
import { PAGE, claim, get, pageOf } from './rows';
import { useScroll, useSize, useVirtualColumns, useVirtualRows } from './useVirtual';

/** The row height the explorer uses. One product, one rhythm. */
const ROW = 22;
const GUTTER = 44;

export interface CellMark {
  state: 'pending' | 'saved' | 'error';
  text?: string;
}

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
  /**
   * Whether cells may be typed into. Undefined until the host has been asked,
   * which happens on the first attempt rather than on Run.
   */
  edit?: EditInfo;
  /** Cells with an edit in flight or just settled, by `row:column`. */
  marks: Record<string, CellMark>;
  onDescribeEdit: () => void;
  /** A cell to write back: the typed text, or null for NULL. */
  onEdit: (row: number, column: number, value: string | null) => void;
  onNotice: (text: string) => void;
}

/** A cell being typed into. `isNull` wins over `text` when set. */
interface Editing {
  row: number;
  column: number;
  text: string;
  isNull: boolean;
  /** Select the whole value on open (Enter, F2) or append to it (typed). */
  selectAll: boolean;
}

/** What the user meant to do before the host had said whether they could. */
interface Intent {
  row: number;
  column: number;
  text?: string;
  toNull?: boolean;
}

export function Grid(props: GridProps): JSX.Element {
  const { executionId, set, request, onSort, onCopy, revision, edit, marks, onDescribeEdit, onEdit, onNotice } = props;
  const [viewport, size] = useSize<HTMLDivElement>();
  const scroll = useScroll(viewport);
  const [widths, setWidths] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<{ row: number; column: number } | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const intent = useRef<Intent | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ column: number; startX: number; startWidth: number } | null>(null);
  /**
   * What the widths were last measured from: which set, and whether rows had
   * arrived yet. A set is measured twice at most — once from its headers, and
   * once more when the first rows land — and never again after that, and never
   * at all once the user has dragged a column. The previous rule re-measured
   * on every batch of rows, which threw a drag away the moment the next page
   * scrolled in.
   */
  const measured = useRef<{ key: string; withRows: boolean; dragged: boolean }>({
    key: '',
    withRows: false,
    dragged: false
  });

  const count = set.rowCount;

  useEffect(() => {
    const key = `${executionId}:${set.index}`;
    const sample: CellValue[][] = [];
    for (let i = 0; i < 200 && i < count; i++) {
      const row = get(executionId, set.index, i);
      if (row) {
        sample.push(row);
      }
    }
    const state = measured.current;
    if (state.key !== key) {
      // A new set: measure from whatever is here, headers alone if need be.
      measured.current = { key, withRows: sample.length > 0, dragged: false };
      setWidths(measureColumns(set.columns, sample));
      setEditing(null);
      intent.current = null;
      return;
    }
    if (state.dragged || state.withRows || sample.length === 0) {
      return;
    }
    // The first rows have landed for a set sized from its headers alone.
    state.withRows = true;
    setWidths(measureColumns(set.columns, sample));
    // `revision` is here so the first page of rows re-measures the columns
    // that were sized from their headers alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const scrollRowIntoView = (row: number) => {
    const element = viewport.current;
    if (!element) {
      return;
    }
    const top = row * ROW;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + ROW > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW - element.clientHeight;
    }
  };

  /** Moves the anchor, clamped to the grid, and keeps it in view. */
  const moveBy = (dr: number, dc: number, extend: boolean) => {
    if (count === 0) {
      return;
    }
    // A grid that has been focused but never clicked has no anchor, and an
    // arrow key on it used to do nothing at all. It lands on the first cell.
    const from = anchor ?? { row: 0, column: 0 };
    const row = anchor ? Math.max(0, Math.min(count - 1, from.row + dr)) : 0;
    const column = anchor ? Math.max(0, Math.min(set.columns.length - 1, from.column + dc)) : 0;
    select(row, column, extend && Boolean(anchor));
    scrollRowIntoView(row);
  };

  /* --------------------------------------------------------------- editing */

  /**
   * Opens the editor on a cell, or says why it cannot.
   *
   * The first time on a set nothing is known yet, so the wish is remembered
   * and the host is asked; when the answer arrives the effect below picks the
   * wish up again. Zero cost on Run, one catalog read on the first Enter.
   */
  const beginEdit = (row: number, column: number, text?: string, toNull?: boolean) => {
    if (!edit) {
      intent.current = { row, column, text, toNull };
      onDescribeEdit();
      return;
    }
    if (!edit.editable) {
      onNotice(edit.reason ?? 'This result cannot be edited.');
      return;
    }
    const lock = edit.locks[column];
    if (lock) {
      onNotice(LOCK_LABELS[lock]);
      return;
    }
    const values = get(executionId, set.index, row);
    if (!values) {
      return;
    }
    const value = values[column] ?? null;
    if (toNull) {
      // Delete opens the cell already set to NULL rather than writing it:
      // Enter is still the moment the server hears anything, so one stray
      // keypress on a focused grid changes nothing.
      if (set.columns[column]?.nullable === false) {
        onNotice(`${set.columns[column].name} does not allow NULL.`);
        return;
      }
      setEditing({ row, column, text: '', isNull: true, selectAll: false });
      return;
    }
    if (text !== undefined) {
      setEditing({ row, column, text, isNull: false, selectAll: false });
      return;
    }
    setEditing({ row, column, text: value === null ? '' : cellText(value), isNull: value === null, selectAll: true });
  };

  useEffect(() => {
    const wish = intent.current;
    if (edit && wish) {
      intent.current = null;
      beginEdit(wish.row, wish.column, wish.text, wish.toNull);
    }
    // `beginEdit` closes over the current props and is rebuilt each render;
    // the effect only needs to fire when the answer lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit]);

  const focusGrid = () => root.current?.focus();

  /**
   * Enter, Tab or a click elsewhere. Nothing is sent when nothing changed:
   * opening a cell and closing it again is not an UPDATE.
   */
  const commit = (move?: 'right' | 'left' | 'down') => {
    const current = editing;
    if (!current) {
      return;
    }
    setEditing(null);
    const before = get(executionId, set.index, current.row)?.[current.column] ?? null;
    const next = current.isNull ? null : current.text;
    const same = next === null ? before === null : before !== null && cellText(before) === next;
    if (!same) {
      onEdit(current.row, current.column, next);
    }
    focusGrid();
    if (move === 'right') {
      moveBy(0, 1, false);
    } else if (move === 'left') {
      moveBy(0, -1, false);
    } else if (move === 'down') {
      moveBy(1, 0, false);
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    focusGrid();
  };

  /* ------------------------------------------------------------------ keys */

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) {
      // The editor handles its own keys and stops them; anything that still
      // reaches here while editing is not for the grid.
      return;
    }
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
    if (anchor && (event.key === 'Enter' || event.key === 'F2')) {
      event.preventDefault();
      beginEdit(anchor.row, anchor.column);
      return;
    }
    if (anchor && event.key === 'Delete') {
      event.preventDefault();
      beginEdit(anchor.row, anchor.column, undefined, true);
      return;
    }
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (anchor && printable) {
      event.preventDefault();
      beginEdit(anchor.row, anchor.column, event.key);
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
    if (!move || count === 0) {
      return;
    }
    event.preventDefault();
    moveBy(move[0], move[1], event.shiftKey);
  };

  const startResize = (event: MouseEvent, column: number) => {
    event.preventDefault();
    event.stopPropagation();
    dragging.current = { column, startX: event.clientX, startWidth: widths[column] ?? 120 };
    measured.current.dragged = true;

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

  // Locks are drawn only once the host has answered and named a table; a set
  // refused outright has nothing per column to say.
  const locks = edit?.target ? edit.locks : undefined;

  return (
    <div className="grid" ref={root} onKeyDown={onKeyDown} tabIndex={0} role="grid" aria-rowcount={count}>
      <div className="grid-header" style={{ transform: `translateX(${-scroll.left}px)`, width: total + GUTTER }}>
        {/* The corner's right-click menu is the workbench's, so its items are
            commands; `gridCorner` is what their `when` clauses read. */}
        <div
          className="grid-hcell grid-gutter grid-corner"
          style={{ width: GUTTER }}
          title="Right-click to copy headers"
          data-vscode-context={JSON.stringify({
            webviewSection: 'gridCorner',
            executionId,
            setIndex: set.index,
            preventDefaultContextMenuItems: true
          })}
        />
        <div style={{ width: columns.before }} />
        {visibleColumns.map(({ column, index }) => {
          const sorted = set.sort?.column === index ? set.sort : undefined;
          const lock = locks?.[index] ?? null;
          return (
            <div
              key={index}
              className={`grid-hcell${sorted ? ' is-sorted' : ''}${column.nullable ? ' is-nullable' : ''}${
                lock ? ' is-locked' : ''
              }`}
              style={{ width: widths[index] ?? 120 }}
              title={`${column.name}  ${column.type}${
                column.nullable === true ? '  NULL' : column.nullable === false ? '  NOT NULL' : ''
              }${lock ? `\n${LOCK_LABELS[lock]}` : ''}`}
              role="columnheader"
              aria-sort={sorted ? (sorted.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() =>
                onSort(index, !sorted ? 'asc' : sorted.direction === 'asc' ? 'desc' : null)
              }
            >
              {lock ? <Codicon name="lock" className="grid-lock" /> : null}
              <span className="grid-hname">{column.name}</span>
              {column.nullable ? (
                <span className="grid-nullable" aria-label="nullable">
                  NULL
                </span>
              ) : null}
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
                  const isEditing = editing !== null && editing.row === index && editing.column === c;
                  const mark = marks[`${index}:${c}`];
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      className={`grid-cell kind-${column.kind}${inRange(index, c) ? ' is-selected' : ''}${
                        anchor?.row === index && anchor.column === c ? ' is-anchor' : ''
                      }${isEditing ? ' is-editing' : ''}${mark ? ` is-${mark.state}` : ''}`}
                      style={{ width: widths[c] ?? 120 }}
                      onMouseDown={(event) => {
                        if (!isEditing) {
                          select(index, c, event.shiftKey);
                        }
                      }}
                      onDoubleClick={() => {
                        if (!isEditing) {
                          props.onOpenCell(value ?? null, column);
                        }
                      }}
                      title={mark?.text ?? (row ? cellText(value ?? null) : undefined)}
                    >
                      {isEditing && editing ? (
                        <CellEditor
                          editing={editing}
                          nullable={column.nullable !== false}
                          onChange={(text) => setEditing({ ...editing, text, isNull: false, selectAll: false })}
                          onNull={() => setEditing({ ...editing, text: '', isNull: true, selectAll: false })}
                          onCommit={commit}
                          onCancel={cancelEdit}
                        />
                      ) : row ? (
                        <Cell value={value ?? null} />
                      ) : (
                        <span className="grid-skeleton" />
                      )}
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
 * The box a cell becomes while it is being typed into.
 *
 * Enter writes, Escape puts the old value back, Tab writes and moves along.
 * A click anywhere else writes too, the way a spreadsheet does, because a
 * value left half-typed in a box nobody is looking at is worse than a value
 * written. NULL is a button rather than a spelling: a column that can hold
 * the four letters N-U-L-L must be able to tell them from the absence.
 */
function CellEditor({
  editing,
  nullable,
  onChange,
  onNull,
  onCommit,
  onCancel
}: {
  editing: Editing;
  nullable: boolean;
  onChange: (text: string) => void;
  onNull: () => void;
  onCommit: (move?: 'right' | 'left' | 'down') => void;
  onCancel: () => void;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const element = input.current;
    if (!element) {
      return;
    }
    element.focus();
    if (editing.selectAll) {
      element.select();
    } else {
      element.setSelectionRange(element.value.length, element.value.length);
    }
    // Once, on mount: later renders must not reset the caret under a typist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (action: () => void) => {
    if (!settled.current) {
      settled.current = true;
      action();
    }
  };

  return (
    <>
      <input
        ref={input}
        className="grid-editor"
        value={editing.isNull ? '' : editing.text}
        placeholder={editing.isNull ? 'NULL' : ''}
        aria-label="Cell value"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => finish(() => onCommit())}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(() => onCommit(event.shiftKey ? undefined : 'down'));
          } else if (event.key === 'Tab') {
            event.preventDefault();
            finish(() => onCommit(event.shiftKey ? 'left' : 'right'));
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(onCancel);
          }
        }}
      />
      {nullable ? (
        <button
          type="button"
          className={`grid-null-btn${editing.isNull ? ' is-on' : ''}`}
          title="Set to NULL"
          tabIndex={-1}
          // Pressing the button must not blur the box first, or the blur
          // would write the old text before the button could ask for NULL.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onNull}
        >
          NULL
        </button>
      ) : null}
    </>
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
