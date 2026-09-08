import * as fs from 'fs';
import * as vscode from 'vscode';
import { CellValue, ColumnMeta, CopyShape, ExportFormat, cellText, isTagged } from '../shared/query';
import { ResultStore, SetData } from '../exec/resultStore';
import { XlsxWriter } from './xlsx';
import { DriverKind } from '../types';
import { qualified, quote } from '../catalog/script';

/** Rows read from the store per turn of the loop. */
const PAGE = 5000;

export const EXTENSIONS: Record<ExportFormat, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  sql: 'sql',
  markdown: 'md',
  xlsx: 'xlsx'
};

/**
 * Writes a result set to a file, without it passing through the webview.
 *
 * The grid asks the host to export and the host streams from its own buffer
 * and spill file straight to disk. Sending four million rows through
 * `postMessage` would serialise the whole answer into one string first, which
 * is the allocation this architecture exists to avoid.
 *
 * The host is single-threaded and shares its thread with every other extension
 * in the window, so the loop yields between pages. A worker would be the other
 * answer and is not worth its build plumbing here: yielding every few thousand
 * rows keeps the window responsive, and formatting is not where the time goes
 * — the disk is.
 */
export async function exportSet(
  store: ResultStore,
  set: SetData,
  format: ExportFormat,
  target: vscode.Uri,
  table: { schema: string; name: string } | undefined,
  driver: DriverKind,
  progress?: (rows: number) => void
): Promise<number> {
  if (format === 'xlsx') {
    return exportXlsx(store, set, target, table?.name ?? 'Results', progress);
  }

  const handle = await fs.promises.open(target.fsPath, 'w');
  let written = 0;
  try {
    const head = header(set.columns, format);
    if (head) {
      await handle.write(head);
    }
    let first = true;
    for await (const rows of store.readAll(set, PAGE)) {
      let chunk = '';
      for (const row of rows) {
        chunk += body(row, set.columns, format, first, table, driver);
        first = false;
        written++;
      }
      if (chunk) {
        await handle.write(chunk);
      }
      progress?.(written);
      // One turn of the event loop between pages, so the window keeps painting
      // while a million rows are being written.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const tail = footer(format);
    if (tail) {
      await handle.write(tail);
    }
  } finally {
    await handle.close();
  }
  return written;
}

async function exportXlsx(
  store: ResultStore,
  set: SetData,
  target: vscode.Uri,
  sheetName: string,
  progress?: (rows: number) => void
): Promise<number> {
  const writer = new XlsxWriter(set.columns);
  let written = 0;
  for await (const rows of store.readAll(set, PAGE)) {
    for (const row of rows) {
      writer.add(row);
      written++;
    }
    progress?.(written);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await fs.promises.writeFile(target.fsPath, writer.finish(sheetName));
  return written;
}

function header(columns: ColumnMeta[], format: ExportFormat): string {
  if (format === 'csv') {
    // A byte order mark, because Excel opens a UTF-8 CSV as the system code
    // page without one, and every accented name in the file becomes mojibake.
    return `\uFEFF${columns.map((c) => csvField(c.name)).join(',')}\n`;
  }
  if (format === 'tsv') {
    return `${columns.map((c) => c.name).join('\t')}\n`;
  }
  if (format === 'json') {
    return '[\n';
  }
  if (format === 'markdown') {
    return `| ${columns.map((c) => c.name).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n`;
  }
  return '';
}

function footer(format: ExportFormat): string {
  return format === 'json' ? '\n]\n' : '';
}

function body(
  row: CellValue[],
  columns: ColumnMeta[],
  format: ExportFormat,
  first: boolean,
  table: { schema: string; name: string } | undefined,
  driver: DriverKind
): string {
  switch (format) {
    case 'csv':
      return `${row.map((cell) => csvField(cellText(cell))).join(',')}\n`;
    case 'tsv':
      // Tabs and newlines inside a value would break the shape of the file, so
      // they become spaces. TSV has no quoting to escape them with.
      return `${row.map((cell) => cellText(cell).replace(/[\t\r\n]+/g, ' ')).join('\t')}\n`;
    case 'json':
      return `${first ? '  ' : ',\n  '}${JSON.stringify(toObject(row, columns))}`;
    case 'markdown':
      return `| ${row.map((cell) => cellText(cell).replace(/\|/g, '\\|')).join(' | ')} |\n`;
    case 'sql':
      return `${insertStatement(row, columns, table, driver)}\n`;
    default:
      return '';
  }
}

function toObject(row: CellValue[], columns: ColumnMeta[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    const value = row[index] ?? null;
    out[column.name] = isTagged(value) ? value.v : value;
  });
  return out;
}

/**
 * RFC 4180: a field is quoted when it contains the delimiter, a quote or a
 * newline, and a quote inside a quoted field is doubled.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function insertStatement(
  row: CellValue[],
  columns: ColumnMeta[],
  table: { schema: string; name: string } | undefined,
  driver: DriverKind
): string {
  const target = table ? qualified(driver, table) : '<table>';
  const names = columns.map((column) => quote(driver, column.name)).join(', ');
  const values = row.map((cell, index) => literal(cell, columns[index])).join(', ');
  return `INSERT INTO ${target} (${names}) VALUES (${values});`;
}

/**
 * A value as SQL text.
 *
 * Everything that is not plainly numeric is quoted, including a `bigint` that
 * arrived as a tag: writing 9007199254740993 unquoted would be exact here and
 * inexact the moment anything parsed it as a double.
 */
function literal(value: CellValue, column: ColumnMeta | undefined): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (isTagged(value)) {
    return value.t === 'bin' ? value.v : `'${value.v.replace(/'/g, "''")}'`;
  }
  if (column?.kind === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A selection, as text on the clipboard.
 *
 * TSV is the default because it is what pastes into Excel as columns — the
 * single most common thing anybody does with a selection from a database grid.
 */
export function renderCopy(
  columns: ColumnMeta[],
  rows: CellValue[][],
  shape: CopyShape,
  table: { schema: string; name: string } | undefined,
  driver: DriverKind
): string {
  switch (shape) {
    case 'tsv':
      return rows.map((row) => row.map((cell) => cellText(cell).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
    case 'tsv-headers':
      return [
        columns.map((column) => column.name).join('\t'),
        ...rows.map((row) => row.map((cell) => cellText(cell).replace(/[\t\r\n]+/g, ' ')).join('\t'))
      ].join('\n');
    case 'csv':
      return [
        columns.map((column) => csvField(column.name)).join(','),
        ...rows.map((row) => row.map((cell) => csvField(cellText(cell))).join(','))
      ].join('\n');
    case 'json':
      return JSON.stringify(
        rows.map((row) => toObject(row, columns)),
        null,
        2
      );
    case 'markdown':
      return [
        `| ${columns.map((column) => column.name).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map((cell) => cellText(cell).replace(/\|/g, '\\|')).join(' | ')} |`)
      ].join('\n');
    case 'insert':
      return rows.map((row) => insertStatement(row, columns, table, driver)).join('\n');
    default:
      return '';
  }
}
