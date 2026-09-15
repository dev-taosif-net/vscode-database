/**
 * The built-in functions signature help knows, per engine.
 *
 * The catalog can say what a procedure takes, because the server declares it.
 * Nobody declares `DATEADD`; its parameters are written in the documentation
 * and in the memory of everyone who has ever got the argument order wrong.
 * This is that page, kept to the functions people write by hand in queries:
 * dates, strings, conversions, aggregates and window functions.
 *
 * Nothing here imports `vscode`, so the table can be read in a test.
 */
import { DriverKind } from '../../types';

export interface BuiltinSignature {
  /** `DATEADD(datepart, number, date)` */
  label: string;
  /** Each parameter's `[start, end)` within `label`, in order. */
  spans: Array<[number, number]>;
  /** True when the last parameter repeats: `COALESCE(a, b, …)`. */
  variadic: boolean;
  doc?: string;
}

type Table = Record<string, { params: string[]; doc?: string }>;

const COMMON: Table = {
  COALESCE: { params: ['expression', '...'], doc: 'The first argument that is not NULL.' },
  NULLIF: { params: ['expression', 'compare_to'], doc: 'NULL when the two are equal, otherwise the first.' },
  COUNT: { params: ['expression'] },
  SUM: { params: ['expression'] },
  AVG: { params: ['expression'] },
  MIN: { params: ['expression'] },
  MAX: { params: ['expression'] },
  ABS: { params: ['number'] },
  FLOOR: { params: ['number'] },
  ROUND: { params: ['number', 'decimals'] },
  POWER: { params: ['number', 'exponent'] },
  SQRT: { params: ['number'] },
  UPPER: { params: ['string'] },
  LOWER: { params: ['string'] },
  LEFT: { params: ['string', 'count'] },
  RIGHT: { params: ['string', 'count'] },
  REPLACE: { params: ['string', 'search', 'replacement'] },
  REVERSE: { params: ['string'] },
  TRIM: { params: ['string'] },
  LTRIM: { params: ['string'] },
  RTRIM: { params: ['string'] },
  CONCAT: { params: ['value', '...'], doc: 'The values joined; NULL reads as empty.' },
  CONCAT_WS: { params: ['separator', 'value', '...'] },
  STRING_AGG: { params: ['expression', 'separator'] },
  ROW_NUMBER: { params: [], doc: 'Follow with OVER (ORDER BY …).' },
  RANK: { params: [], doc: 'Follow with OVER (ORDER BY …).' },
  DENSE_RANK: { params: [], doc: 'Follow with OVER (ORDER BY …).' },
  NTILE: { params: ['buckets'] },
  LAG: { params: ['expression', 'offset', 'default'], doc: 'The value on a row before this one in the window.' },
  LEAD: { params: ['expression', 'offset', 'default'], doc: 'The value on a row after this one in the window.' },
  FIRST_VALUE: { params: ['expression'] },
  LAST_VALUE: { params: ['expression'] },
  CAST: { params: ['expression AS data_type'] },
  SUBSTRING: { params: ['string', 'start', 'length'] },
  GREATEST: { params: ['value', '...'] },
  LEAST: { params: ['value', '...'] }
};

const MSSQL: Table = {
  DATEADD: { params: ['datepart', 'number', 'date'], doc: 'datepart: year, quarter, month, day, week, hour, minute, second, …' },
  DATEDIFF: { params: ['datepart', 'startdate', 'enddate'], doc: 'The number of datepart boundaries crossed between the two dates.' },
  DATEDIFF_BIG: { params: ['datepart', 'startdate', 'enddate'] },
  DATEPART: { params: ['datepart', 'date'] },
  DATENAME: { params: ['datepart', 'date'] },
  DATETRUNC: { params: ['datepart', 'date'] },
  DATEFROMPARTS: { params: ['year', 'month', 'day'] },
  DATETIMEFROMPARTS: { params: ['year', 'month', 'day', 'hour', 'minute', 'seconds', 'milliseconds'] },
  EOMONTH: { params: ['start_date', 'month_to_add'] },
  GETDATE: { params: [] },
  GETUTCDATE: { params: [] },
  SYSDATETIME: { params: [] },
  SYSUTCDATETIME: { params: [] },
  ISDATE: { params: ['expression'] },
  CONVERT: { params: ['data_type', 'expression', 'style'], doc: 'style: 101 mm/dd/yyyy, 103 dd/mm/yyyy, 112 yyyymmdd, 120 yyyy-mm-dd hh:mi:ss, 126 ISO 8601.' },
  TRY_CONVERT: { params: ['data_type', 'expression', 'style'], doc: 'NULL rather than an error when the conversion fails.' },
  TRY_CAST: { params: ['expression AS data_type'], doc: 'NULL rather than an error when the conversion fails.' },
  PARSE: { params: ['string AS data_type', 'culture'] },
  ISNULL: { params: ['check_expression', 'replacement_value'] },
  IIF: { params: ['condition', 'true_value', 'false_value'] },
  CHOOSE: { params: ['index', 'value', '...'] },
  LEN: { params: ['string'], doc: 'Characters, trailing spaces not counted.' },
  DATALENGTH: { params: ['expression'], doc: 'Bytes.' },
  CHARINDEX: { params: ['search', 'string', 'start'], doc: 'The 1-based position of search in string, 0 when absent.' },
  PATINDEX: { params: ['pattern', 'string'] },
  STUFF: { params: ['string', 'start', 'length', 'replacement'] },
  REPLICATE: { params: ['string', 'count'] },
  SPACE: { params: ['count'] },
  QUOTENAME: { params: ['string', 'quote_character'] },
  FORMAT: { params: ['value', 'format', 'culture'], doc: 'A .NET format string: N2, C, d, yyyy-MM-dd.' },
  STR: { params: ['number', 'length', 'decimals'] },
  TRANSLATE: { params: ['string', 'characters', 'translations'] },
  ASCII: { params: ['character'] },
  CHAR: { params: ['code'] },
  UNICODE: { params: ['character'] },
  NCHAR: { params: ['code'] },
  STRING_SPLIT: { params: ['string', 'separator', 'enable_ordinal'] },
  CEILING: { params: ['number'] },
  ROUND: { params: ['number', 'length', 'function'], doc: 'function other than 0 truncates instead of rounding.' },
  JSON_VALUE: { params: ['expression', 'path'], doc: 'A scalar from JSON: JSON_VALUE(doc, \'$.name\').' },
  JSON_QUERY: { params: ['expression', 'path'], doc: 'An object or array from JSON.' },
  JSON_MODIFY: { params: ['expression', 'path', 'new_value'] },
  ISJSON: { params: ['expression'] },
  OPENJSON: { params: ['expression', 'path'] },
  NEWID: { params: [] },
  NEWSEQUENTIALID: { params: [] },
  ISNUMERIC: { params: ['expression'] },
  OBJECT_ID: { params: ['object_name', 'object_type'] },
  OBJECT_NAME: { params: ['object_id'] },
  DB_NAME: { params: ['database_id'] },
  SCHEMA_NAME: { params: ['schema_id'] },
  HASHBYTES: { params: ['algorithm', 'input'], doc: 'algorithm: MD5, SHA1, SHA2_256, SHA2_512.' },
  CHECKSUM: { params: ['expression', '...'] },
  COUNT_BIG: { params: ['expression'] },
  STDEV: { params: ['expression'] },
  VAR: { params: ['expression'] },
  PERCENTILE_CONT: { params: ['numeric_literal'], doc: 'Follow with WITHIN GROUP (ORDER BY …) OVER (…).' },
  APPROX_COUNT_DISTINCT: { params: ['expression'] }
};

const POSTGRES: Table = {
  DATE_TRUNC: { params: ['field', 'source'], doc: "field: 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'." },
  DATE_PART: { params: ['field', 'source'] },
  EXTRACT: { params: ['field FROM source'] },
  AGE: { params: ['timestamp', 'timestamp'], doc: 'The interval between the two, or from now with one argument.' },
  NOW: { params: [] },
  CLOCK_TIMESTAMP: { params: [] },
  MAKE_DATE: { params: ['year', 'month', 'day'] },
  MAKE_INTERVAL: { params: ['years', 'months', 'weeks', 'days', 'hours', 'mins', 'secs'] },
  TO_CHAR: { params: ['value', 'format'], doc: "format: 'YYYY-MM-DD', 'HH24:MI:SS', 'FM999,990.00'." },
  TO_DATE: { params: ['text', 'format'] },
  TO_TIMESTAMP: { params: ['text', 'format'] },
  TO_NUMBER: { params: ['text', 'format'] },
  LENGTH: { params: ['string'] },
  CHAR_LENGTH: { params: ['string'] },
  SUBSTR: { params: ['string', 'start', 'count'] },
  STRPOS: { params: ['string', 'substring'] },
  POSITION: { params: ['substring IN string'] },
  LPAD: { params: ['string', 'length', 'fill'] },
  RPAD: { params: ['string', 'length', 'fill'] },
  SPLIT_PART: { params: ['string', 'delimiter', 'field'], doc: 'field counts from 1.' },
  INITCAP: { params: ['string'] },
  REPEAT: { params: ['string', 'count'] },
  REGEXP_REPLACE: { params: ['source', 'pattern', 'replacement', 'flags'], doc: "flags: 'g' for every match, 'i' to ignore case." },
  REGEXP_MATCHES: { params: ['string', 'pattern', 'flags'] },
  REGEXP_SPLIT_TO_TABLE: { params: ['string', 'pattern', 'flags'] },
  FORMAT: { params: ['formatstr', 'value', '...'], doc: '%s for a string, %I for an identifier, %L for a literal.' },
  ARRAY_AGG: { params: ['expression'] },
  ARRAY_LENGTH: { params: ['array', 'dimension'] },
  ARRAY_TO_STRING: { params: ['array', 'delimiter', 'null_string'] },
  STRING_TO_ARRAY: { params: ['string', 'delimiter', 'null_string'] },
  UNNEST: { params: ['array', '...'] },
  GENERATE_SERIES: { params: ['start', 'stop', 'step'] },
  JSON_AGG: { params: ['expression'] },
  JSONB_AGG: { params: ['expression'] },
  JSON_BUILD_OBJECT: { params: ['key', 'value', '...'] },
  JSONB_BUILD_OBJECT: { params: ['key', 'value', '...'] },
  JSONB_EXTRACT_PATH: { params: ['from_json', 'path_element', '...'] },
  JSONB_EXTRACT_PATH_TEXT: { params: ['from_json', 'path_element', '...'] },
  JSONB_SET: { params: ['target', 'path', 'new_value', 'create_missing'] },
  JSONB_PRETTY: { params: ['from_json'] },
  TO_JSONB: { params: ['value'] },
  ROW_TO_JSON: { params: ['record', 'pretty'] },
  CEIL: { params: ['number'] },
  TRUNC: { params: ['number', 'decimals'] },
  MOD: { params: ['dividend', 'divisor'] },
  RANDOM: { params: [] },
  GEN_RANDOM_UUID: { params: [] },
  MD5: { params: ['string'] },
  ENCODE: { params: ['bytes', 'format'] },
  DECODE: { params: ['text', 'format'] },
  PERCENTILE_CONT: { params: ['fraction'], doc: 'Follow with WITHIN GROUP (ORDER BY …).' },
  BOOL_AND: { params: ['expression'] },
  BOOL_OR: { params: ['expression'] },
  STDDEV: { params: ['expression'] },
  VARIANCE: { params: ['expression'] },
  PG_TYPEOF: { params: ['value'] },
  PG_SLEEP: { params: ['seconds'] },
  CURRENT_SETTING: { params: ['setting_name', 'missing_ok'] },
  NEXTVAL: { params: ['sequence'] },
  CURRVAL: { params: ['sequence'] },
  SETVAL: { params: ['sequence', 'value', 'is_called'] }
};

/** The signature of a built-in, by the upper-cased word before its parenthesis. */
export function builtinSignature(driver: DriverKind, name: string): BuiltinSignature | undefined {
  const table = driver === 'mssql' ? MSSQL : POSTGRES;
  const entry = table[name] ?? COMMON[name];
  if (!entry) {
    return undefined;
  }
  const spans: Array<[number, number]> = [];
  let label = `${name}(`;
  let variadic = false;
  entry.params.forEach((param, i) => {
    if (param === '...') {
      variadic = true;
      label += ', …';
      return;
    }
    if (i > 0) {
      label += ', ';
    }
    const start = label.length;
    label += param;
    spans.push([start, label.length]);
  });
  label += ')';
  return { label, spans, variadic, doc: entry.doc };
}
