/**
 * The vocabulary of the object explorer, shared by the extension host and the
 * sidebar.
 *
 * Nothing here may import `vscode`: the sidebar is a browser and has no access
 * to it. Nothing here holds a credential either, for the same reason
 * `shared/sidebar.ts` sends a projection rather than a `ConnectionProfile` — a
 * tree that draws a schema and a name has no business carrying a login.
 */
import { DriverKind } from '../types';

/**
 * The eight kinds the explorer knows about, in the order the tree lists them.
 *
 * The order is fixed and is not alphabetical: it runs from the things a
 * database is made of to the things that are wired onto them. Tables and views
 * are what people open, procedures and functions are what people run, and the
 * last four are the long tail. A list that reordered itself per connection
 * would cost the muscle memory that makes a thousand-object tree navigable.
 */
export type ObjectKind =
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'sequence'
  | 'type'
  | 'synonym';

export const OBJECT_KINDS: readonly ObjectKind[] = [
  'table',
  'view',
  'procedure',
  'function',
  'trigger',
  'sequence',
  'type',
  'synonym'
];

export interface KindMeta {
  id: ObjectKind;
  /** The folder's label. Always plural: it names a collection. */
  plural: string;
  /** The singular, for a row's type column and for an accessible name. */
  singular: string;
  /**
   * What the search box accepts as a type filter beyond the two names above.
   * `proc:customer` and `sp:customer` both have to work, because both are what
   * people actually type.
   */
  aliases: readonly string[];
}

export const KINDS: Readonly<Record<ObjectKind, KindMeta>> = {
  table: { id: 'table', plural: 'Tables', singular: 'Table', aliases: ['tbl'] },
  view: { id: 'view', plural: 'Views', singular: 'View', aliases: ['vw'] },
  procedure: {
    id: 'procedure',
    plural: 'Procedures',
    singular: 'Procedure',
    aliases: ['proc', 'procs', 'sp', 'sproc']
  },
  function: { id: 'function', plural: 'Functions', singular: 'Function', aliases: ['func', 'funcs', 'fn'] },
  trigger: { id: 'trigger', plural: 'Triggers', singular: 'Trigger', aliases: ['trg'] },
  sequence: { id: 'sequence', plural: 'Sequences', singular: 'Sequence', aliases: ['seq', 'seqs'] },
  type: { id: 'type', plural: 'Types', singular: 'Type', aliases: ['udt', 'domain', 'enum'] },
  synonym: { id: 'synonym', plural: 'Synonyms', singular: 'Synonym', aliases: ['syn', 'alias'] }
};

/**
 * PostgreSQL has no synonyms. Drawing an empty `Synonyms 0` folder under every
 * PostgreSQL connection would be a permanent row of nothing, so the folder list
 * is per engine rather than universal.
 */
export function kindsFor(driver: DriverKind): readonly ObjectKind[] {
  return driver === 'postgres' ? OBJECT_KINDS.filter((k) => k !== 'synonym') : OBJECT_KINDS;
}

/**
 * One object, as small as it can be and still draw a row.
 *
 * `detail` is computed on the host and arrives as the finished string — "34
 * columns", "4 parameters", "Scalar" — rather than as the numbers behind it.
 * That is deliberate: the sentence differs per kind and per engine, and a
 * sidebar assembling it from three optional numeric fields would be a second
 * place for those rules to live and drift.
 */
export interface DbObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  /** The dim trailing column: what this object is, in three words or fewer. */
  detail: string;
}

/** A column of a table or a view, or a parameter of a routine. */
export interface DbMember {
  name: string;
  /** The rendered type: `nvarchar(200)`, `numeric(18,2)`. */
  type: string;
  /** Part of the primary key. */
  key?: boolean;
  /** Carries a foreign key. */
  ref?: boolean;
  nullable?: boolean;
  /**
   * The server supplies this column's value: an identity, a `serial`, or a
   * computed or generated expression. Generate CRUD leaves these out of its
   * `INSERT` and its `SET` list, because the server refuses both.
   */
  auto?: boolean;
  /** For a parameter: its direction, or `returns` for a return value. */
  direction?: 'in' | 'out' | 'inout' | 'returns';
  /**
   * For a parameter: its default expression as declared, `NULL` included.
   *
   * Absent means either that there is no default or that the server would not
   * say — an encrypted SQL Server procedure has no readable header. Both read
   * as required, which is the safe way to be wrong: a call that names one
   * argument too many still runs.
   */
  default?: string;
}

/** Per-schema counts, so schema-focused mode can label its folders. */
export interface SchemaInfo {
  name: string;
  counts: Partial<Record<ObjectKind, number>>;
  /** The sum, which is what the schema row itself displays. */
  total: number;
}

/** Everything the tree needs before a single folder has been opened. */
export interface CatalogSummary {
  counts: Partial<Record<ObjectKind, number>>;
  schemas: SchemaInfo[];
  /** When the server answered, so the tree can show its own staleness. */
  loadedAt: number;
}

/**
 * A pinned object, by value rather than by an id.
 *
 * A database has no stable identifier for an object that survives a rename:
 * `object_id` is reused, `oid` is per database, and neither means anything to
 * the other engine. Kind, schema and name is what a person means when they say
 * "pin this", and a pin that stops resolving because the table was renamed is a
 * pin that has correctly stopped meaning anything.
 */
export interface FavouriteRef {
  kind: ObjectKind;
  schema: string;
  name: string;
  /**
   * The database the object lives in, when the caller knows it.
   *
   * Absent means the connection's own database. That is what every pin
   * written before the explorer drew databases means, and what every caller
   * that never leaves that database — a data tab, IntelliSense — still means.
   */
  database?: string;
}

export function favouriteKey(ref: FavouriteRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}`;
}

/** How a connection's children are arranged. Saved per connection profile. */
export type ExplorerMode = 'general' | 'schema';

/* -------------------------------------------------------------- node keys */

/**
 * The address of a node inside one connection.
 *
 * Keys are opaque strings compared only for equality, and they are built here
 * so there is one convention rather than one per call site. The separator is
 * the ASCII unit separator: a schema or an object name may legally contain a
 * slash, a colon, a pipe and a dot, and a key that a table called `a|b` could
 * collide with is a key that silently pours one folder's rows into another.
 * It is built with `fromCharCode` rather than written as an escape so the
 * source of this file stays printable ASCII.
 */
const SEP = String.fromCharCode(31);

export const FAVOURITES_NODE = 'fav';

/** The note a connection draws while its database list is being read. */
export const DATABASES_NODE = 'dbs';

/** SQL Server's system databases, folded away the way SSMS folds them. */
export const SYSTEM_DATABASES_NODE = 'sysdbs';

/**
 * One database under a connection.
 *
 * Every node below it is prefixed with this, so a folder, a schema or a table
 * in `Sales` never shares a key with the same folder in `Reporting`, and one
 * database's subtree can be swept by prefix.
 */
export function databaseNode(database: string): string {
  return `d${SEP}${database}`;
}

/** A node key, placed inside one database. */
export function inDatabase(database: string, node: string): string {
  return `${databaseNode(database)}${SEP}${node}`;
}

/** The note a database draws while its counts are being read. */
export function summaryNode(database: string): string {
  return inDatabase(database, 'sum');
}

/** The database a node key sits in, or undefined for a key outside any. */
export function databaseOfNode(node: string): string | undefined {
  const parts = node.split(SEP);
  return parts[0] === 'd' && parts.length >= 2 ? parts[1] : undefined;
}

/**
 * Where the sidebar holds one database's catalog.
 *
 * The bare profile id holds the connection's database list; this holds one
 * database's counts, folders and members. Both start with the profile id, so
 * forgetting a connection is still one prefix sweep.
 */
export function catalogKey(profileId: string, database: string): string {
  return globalKey(profileId, databaseNode(database));
}

/**
 * The databases SQL Server ships with. They are real and occasionally wanted,
 * and they are never what somebody opens a server to look at, so the tree
 * files them in a folder of their own. PostgreSQL's `postgres` is an ordinary
 * database that people do use, and its templates are already filtered out.
 */
const MSSQL_SYSTEM_DATABASES: ReadonlySet<string> = new Set(['master', 'model', 'msdb', 'tempdb']);

export function isSystemDatabase(driver: DriverKind, name: string): boolean {
  return driver === 'mssql' && MSSQL_SYSTEM_DATABASES.has(name.toLowerCase());
}

export function kindNode(kind: ObjectKind): string {
  return `k${SEP}${kind}`;
}

export function schemaNode(schema: string): string {
  return `s${SEP}${schema}`;
}

export function schemaKindNode(schema: string, kind: ObjectKind): string {
  return `s${SEP}${schema}${SEP}k${SEP}${kind}`;
}

/** The member list — columns, or parameters — belonging to one object. */
export function memberNode(ref: FavouriteRef): string {
  return `m${SEP}${ref.kind}${SEP}${ref.schema}${SEP}${ref.name}`;
}

/** The global address: a node key is only unique inside its own connection. */
export function globalKey(profileId: string, node: string): string {
  return `${profileId}${SEP}${node}`;
}

/**
 * Reads a folder node key back into the request that would refill it.
 *
 * `Load more` has a node key and needs a kind and a schema, and the key
 * already carries both. Parsing it back beats widening every folder row with
 * two fields that only one row in five hundred ever reads, and it cannot drift
 * from the builders above because it is checked against them by construction:
 * a key this does not recognise returns null rather than a guess.
 */
export function parseFolderNode(node: string): { kind: ObjectKind; schema?: string; database?: string } | null {
  let parts = node.split(SEP);
  let database: string | undefined;
  if (parts[0] === 'd' && parts.length > 2) {
    database = parts[1];
    parts = parts.slice(2);
  }
  if (parts[0] === 'k' && parts.length === 2) {
    return isKind(parts[1]) ? { kind: parts[1], database } : null;
  }
  if (parts[0] === 's' && parts[2] === 'k' && parts.length === 4) {
    return isKind(parts[3]) ? { kind: parts[3], schema: parts[1], database } : null;
  }
  return null;
}

function isKind(value: string): value is ObjectKind {
  return (OBJECT_KINDS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------- requests */

/** What a folder asks the host for when it is opened. */
export interface ObjectPageRequest {
  profileId: string;
  /** Echoed back untouched, so a late answer lands on the folder that asked. */
  node: string;
  kind: ObjectKind;
  /** Absent in general mode; the schema to restrict to in schema-focused mode. */
  schema?: string;
  /**
   * The database to read. Absent means the connection's own.
   *
   * The object explorer always sets it, because the tree draws a node per
   * database. IntelliSense sets it for a query tab that has run `USE`.
   */
  database?: string;
  offset: number;
  limit: number;
}

export interface ObjectPage {
  profileId: string;
  node: string;
  /** Echoed from the request, so the panel knows whose catalog to fill. */
  database?: string;
  offset: number;
  objects: DbObject[];
  /** How many there are in total, so "Load more" can say how many are left. */
  total: number;
}

export interface MemberList {
  profileId: string;
  node: string;
  database?: string;
  members: DbMember[];
}

/** The databases a connection's explorer draws, and which one it opened in. */
export interface DatabaseList {
  profileId: string;
  names: string[];
  /** Where the control session is, as the server reported it. */
  current: string;
  /** False when the profile draws only its own database. */
  all: boolean;
}

/**
 * A server-side search result set.
 *
 * The sidebar fuzzy-matches what it already holds the instant a key is pressed,
 * and this arrives a moment later carrying what the sidebar has never seen. A
 * fifty-thousand-object database cannot be held in a webview, and a search that
 * only found the folders you happened to have opened would be a search worth
 * less than none.
 */
export interface SearchAnswer {
  profileId: string;
  /** The database that was searched. */
  database?: string;
  /** The query this answers. A stale answer is dropped rather than merged. */
  query: string;
  objects: DbObject[];
  /** True when the server had more matches than the cap allowed. */
  capped: boolean;
}

/** How far a connection's catalog has got. Drawn as a row until it is `ready`. */
export type CatalogState = 'idle' | 'loading' | 'ready' | 'error';
