/**
 * How SQL Server's `sys.types` row for a column or a parameter is written back
 * out as a type name: `nvarchar(200)`, `decimal(18,2)`, `varbinary(max)`.
 */
export interface TypeRow {
  ty: string;
  len: number;
  prec: number;
  scl: number;
}

/**
 * The rendered type, with the length rules the catalog leaves implicit.
 *
 * `max_length` is in bytes, so an `nvarchar` halves it; `-1` is `max`; a
 * `float(53)` is what `float` means and is written without the number, the
 * way somebody would have typed it. `sysname` carries a length in the
 * catalog and takes none in a declaration.
 */
export function renderType(row: TypeRow): string {
  const name = String(row.ty ?? '').toLowerCase();
  const length = Number(row.len);

  if (name === 'sysname') {
    return name;
  }
  if (name === 'nvarchar' || name === 'nchar') {
    return `${name}(${length === -1 ? 'max' : length / 2})`;
  }
  if (name === 'varchar' || name === 'char' || name === 'varbinary' || name === 'binary') {
    return `${name}(${length === -1 ? 'max' : length})`;
  }
  if (name === 'decimal' || name === 'numeric') {
    return `${name}(${row.prec},${row.scl})`;
  }
  if (name === 'datetime2' || name === 'time' || name === 'datetimeoffset') {
    return `${name}(${row.scl})`;
  }
  if (name === 'float') {
    return Number(row.prec) === 53 ? name : `${name}(${row.prec})`;
  }
  return name;
}
