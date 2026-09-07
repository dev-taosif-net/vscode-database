import { CellValue, ColumnMeta, cellText } from '../../shared/query';

/** Bounds, in pixels. Narrow enough for a bit, wide enough for an email. */
const MIN = 52;
const MAX = 420;
const PADDING = 18;

let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * Text width, measured once on a canvas rather than by rendering.
 *
 * The alternative is to render a thousand cells offscreen and read their
 * widths back, which is a thousand layout reads to decide a column. This is
 * one paint-free call per string, and the font is read from the page so it
 * follows the workbench's own setting.
 */
function measure(text: string, bold = false): number {
  if (canvas === undefined) {
    const element = document.createElement('canvas');
    canvas = element.getContext('2d');
    if (canvas) {
      const style = getComputedStyle(document.body);
      canvas.font = `${style.fontSize} ${style.fontFamily}`;
    }
  }
  if (!canvas) {
    return text.length * 7;
  }
  if (bold) {
    const previous = canvas.font;
    canvas.font = `600 ${previous.replace(/^\d+\s+/, '')}`;
    const width = canvas.measureText(text).width;
    canvas.font = previous;
    return width;
  }
  return canvas.measureText(text).width;
}

/**
 * A width per column, from the header and the first rows.
 *
 * Two hundred rows is enough to be representative and few enough to measure in
 * a frame. Measuring the whole answer would mean waiting for it, and a grid
 * that cannot draw until the last row arrives is not a streaming grid.
 */
export function measureColumns(columns: ColumnMeta[], sample: CellValue[][]): number[] {
  return columns.map((column, index) => {
    let width = measure(column.name, true) + PADDING + 14;
    const rows = Math.min(sample.length, 200);
    for (let i = 0; i < rows; i++) {
      const text = cellText(sample[i]?.[index] ?? null);
      if (text.length > 60) {
        // A long value settles at the cap rather than dragging the column
        // there one character at a time.
        width = MAX;
        break;
      }
      width = Math.max(width, measure(text) + PADDING);
    }
    if (column.kind === 'bool') {
      width = Math.min(width, 90);
    }
    return Math.round(Math.max(MIN, Math.min(MAX, width)));
  });
}

export const MIN_WIDTH = MIN;
