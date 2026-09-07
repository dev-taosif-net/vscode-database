import * as zlib from 'zlib';
import { CellValue, ColumnMeta, isTagged } from '../shared/query';

/**
 * An `.xlsx` writer, with no dependency.
 *
 * A spreadsheet library was the obvious alternative. It is also a couple of
 * megabytes and a release cadence in exchange for a zip file containing five
 * small XML documents, and this extension already declines a third dependency
 * for the plan reader on the same grounds.
 *
 * What is not cut is the part people notice: dates are written as real dates
 * with a number format, numbers as numbers, booleans as booleans. An export
 * that turns `2025-01-04 09:14` into left-aligned text is an export somebody
 * has to repair by hand, which is the whole reason they asked for Excel rather
 * than for CSV.
 */

/** Excel counts days from this date, which is two days before 1900-01-01. */
const EPOCH = Date.UTC(1899, 11, 30);

interface Entry {
  name: string;
  data: Buffer;
}

export class XlsxWriter {
  private readonly rows: string[] = [];
  private rowNumber = 0;

  constructor(private readonly columns: ColumnMeta[]) {
    this.rowNumber++;
    const cells = this.columns.map((column, index) => inlineString(ref(index, this.rowNumber), column.name, 1));
    this.rows.push(`<row r="${this.rowNumber}">${cells.join('')}</row>`);
  }

  add(row: CellValue[]): void {
    this.rowNumber++;
    const cells: string[] = [];
    for (let index = 0; index < this.columns.length; index++) {
      const cell = this.cell(ref(index, this.rowNumber), row[index], this.columns[index]);
      if (cell) {
        cells.push(cell);
      }
    }
    this.rows.push(`<row r="${this.rowNumber}">${cells.join('')}</row>`);
  }

  private cell(reference: string, value: CellValue, column: ColumnMeta): string | null {
    if (value === null || value === undefined) {
      // An omitted cell is a blank cell, and blank is not an empty string in a
      // spreadsheet: COUNTA and ISBLANK tell the two apart.
      return null;
    }
    if (typeof value === 'boolean') {
      return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    }
    if (typeof value === 'number') {
      return `<c r="${reference}"><v>${value}</v></c>`;
    }
    if (isTagged(value)) {
      if (value.t === 'ts') {
        const serial = toSerial(value.v);
        // A timestamp that will not parse is written as its own text rather
        // than as a wrong date, which is the failure that would matter.
        return serial === null
          ? inlineString(reference, value.v, 0)
          : `<c r="${reference}" s="2"><v>${serial}</v></c>`;
      }
      // A 64-bit integer past 2^53 cannot be a spreadsheet number without
      // losing digits, so it stays text and stays exact.
      return inlineString(reference, value.v, 0);
    }
    if (column.kind === 'number' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return `<c r="${reference}"><v>${parsed}</v></c>`;
      }
    }
    return inlineString(reference, value, 0);
  }

  finish(sheetName = 'Results'): Buffer {
    const width = Math.max(1, this.columns.length);
    const dimension = `A1:${columnName(width - 1)}${Math.max(1, this.rowNumber)}`;
    const sheet =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<dimension ref="${dimension}"/>` +
      // A frozen header row and an autofilter: a fifty-thousand-row export that
      // scrolls its own headings away is one somebody has to fix by hand.
      `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
      `</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      `<sheetData>${this.rows.join('')}</sheetData>` +
      `<autoFilter ref="${dimension}"/>` +
      `</worksheet>`;

    return zip([
      { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
      { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
      { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
      { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') }
    ]);
  }
}

function inlineString(reference: string, text: string, style: number): string {
  const attributes = style ? ` s="${style}"` : '';
  return `<c r="${reference}"${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function ref(column: number, row: number): string {
  return `${columnName(column)}${row}`;
}

function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * A serial day number from the text the driver produced.
 *
 * It is parsed rather than passed through `Date`, and deliberately: the stored
 * text is already the value's own wall clock, and putting it back through a
 * `Date` would apply the host's time zone to a value that never had one.
 */
function toSerial(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(text);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
    Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
  );
  return (ms - EPOCH) / 86_400_000;
}

/**
 * The control characters XML does not admit at all.
 *
 * A binary preview, or a column holding a form feed, would otherwise produce a
 * file Excel refuses to open with an error naming neither the row nor the
 * column. Built from escapes rather than written literally, so this file stays
 * printable ASCII — the same reason `shared/catalog.ts` builds its separator.
 */
const ILLEGAL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(ILLEGAL, '');
}

/* --------------------------------------------------------------- the parts */

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `</styleSheet>`;

function workbookXml(sheetName: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`
  );
}

/* -------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/**
 * A zip container, deflated with `node:zlib`.
 *
 * Every entry carries the same DOS timestamp rather than the clock, so two
 * exports of the same rows are the same bytes. That makes an export diffable
 * and gives away nothing about when somebody ran it.
 */
function zip(entries: Entry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = 33;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}
