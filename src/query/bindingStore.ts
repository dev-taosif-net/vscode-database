import * as vscode from 'vscode';
import { FavouriteRef, OBJECT_KINDS, ObjectKind } from '../shared/catalog';

const KEY = 'databaseTools.bindings.v1';
const DATABASE_KEY = 'databaseTools.tabDatabases.v1';

/**
 * Which connection a document runs against.
 *
 * For the extension's own `dbquery:` documents the answer is already in the
 * URI authority and this is never consulted. It exists for the case that
 * matters more: an ordinary `.sql` file in the repository, which is where most
 * SQL people care about actually lives. A file has no authority to carry a
 * profile id, so the pairing is remembered here.
 *
 * It lives in `workspaceState` rather than `globalState` because the pairing is
 * a property of this checkout: the same `migrations/003.sql` opened in a
 * different clone is a different piece of work, and inheriting the first
 * clone's production binding is exactly the accident worth preventing.
 */
export class BindingStore implements vscode.Disposable {
  private readonly map: Map<string, string>;
  /**
   * Which database a document is in, when it is not the profile's own.
   *
   * A second map rather than a field on the first, because it is keyed for
   * every scheme and the connection map is not: a `dbquery:` tab carries its
   * profile in its authority and can never be rebound, but it can absolutely
   * run `USE` — the database is the one thing about such a tab that moves.
   *
   * It is remembered rather than read off the session for the same reason the
   * connection is: an execution session is swept after fifteen idle minutes,
   * and a tab whose database evaporated with it would silently run the next
   * statement somewhere else. `SessionPool` re-applies this on every acquire.
   */
  private readonly databases: Map<string, string>;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<Record<string, string>>(KEY, {});
    this.map = new Map(Object.entries(stored));
    this.databases = new Map(Object.entries(context.workspaceState.get<Record<string, string>>(DATABASE_KEY, {})));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  /**
   * The connection a document belongs to.
   *
   * The authority wins over the map, always. A `dbquery:` document cannot be
   * rebound to a different connection by anything writing here, which is what
   * makes its binding survive a window reload with nothing persisted at all.
   */
  get(uri: vscode.Uri): string | undefined {
    if (isOwnScheme(uri.scheme)) {
      return uri.authority || undefined;
    }
    return this.map.get(uri.toString());
  }

  async set(uri: vscode.Uri, profileId: string | undefined): Promise<void> {
    if (isOwnScheme(uri.scheme)) {
      return;
    }
    const key = uri.toString();
    if (this.map.get(key) !== profileId) {
      // A tab pointed at another connection is a tab whose database means
      // nothing: `Reporting` on the UAT server and `Reporting` on production
      // are two databases, and carrying the name across is how a statement
      // ends up in the second when the user meant the first.
      this.databases.delete(key);
    }
    if (profileId) {
      this.map.set(key, profileId);
    } else {
      this.map.delete(key);
    }
    await this.persist();
    this.onDidChangeEmitter.fire(uri);
  }

  /**
   * The database a document runs in, or undefined when it runs in the
   * profile's own.
   *
   * Undefined is not the same as the profile's database spelled out, and the
   * difference is what the strip draws: a tab that has never moved says
   * nothing extra, and a tab that has says where it went.
   */
  database(uri: vscode.Uri): string | undefined {
    return this.databases.get(uri.toString());
  }

  async setDatabase(uri: vscode.Uri, database: string | undefined): Promise<void> {
    const key = uri.toString();
    const next = (database ?? '').trim();
    if ((this.databases.get(key) ?? '') === next) {
      return;
    }
    if (next) {
      this.databases.set(key, next);
    } else {
      this.databases.delete(key);
    }
    await this.persist();
    this.onDidChangeEmitter.fire(uri);
  }

  /** Every document bound to a connection, for when it is deleted. */
  async forget(profileId: string): Promise<void> {
    let changed = false;
    for (const [key, value] of [...this.map]) {
      if (value === profileId) {
        this.map.delete(key);
        this.databases.delete(key);
        changed = true;
      }
    }
    // A `dbquery:` tab is never in the map above — its profile is its
    // authority — but it can still hold a database, and a deleted connection
    // must not leave one behind under an id nothing can reach.
    for (const key of [...this.databases.keys()]) {
      if (vscode.Uri.parse(key).authority === profileId) {
        this.databases.delete(key);
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(KEY, Object.fromEntries(this.map));
    await this.context.workspaceState.update(DATABASE_KEY, Object.fromEntries(this.databases));
  }
}

export const QUERY_SCHEME = 'dbquery';
export const DATA_SCHEME = 'dbdata';
export const RUNNER_SCHEME = 'dbrun';
export const OBJECT_SCHEME = 'dbobj';

export function isOwnScheme(scheme: string): boolean {
  return scheme === QUERY_SCHEME || scheme === DATA_SCHEME || scheme === RUNNER_SCHEME || scheme === OBJECT_SCHEME;
}

/**
 * The address of a surface.
 *
 * The profile id goes in the authority rather than in a side table, and that
 * single choice is what makes binding survive everything the workbench can do
 * to a tab: a window reload, a workspace reopen, a drag to another group,
 * Reopen Closed Editor. A `when` clause can read the scheme, a serializer gets
 * the whole address for free, and the status bar can answer "which connection
 * is this?" from the active editor alone.
 */
export function addressOf(scheme: string, profileId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme, authority: profileId, path: path.startsWith('/') ? path : `/${path}` });
}

/**
 * The address of one object: `dbdata://<profile>/<kind>/<schema>.<name>`.
 *
 * The kind rides in the path because a restored tab has nothing else to learn
 * it from, and it matters: a PostgreSQL function is `SELECT * FROM` where a
 * procedure is `CALL`, and a runner that came back after a reload as the wrong
 * one would build the wrong statement.
 */
export function objectAddress(scheme: string, profileId: string, ref: FavouriteRef, extension = ''): vscode.Uri {
  return addressOf(scheme, profileId, `${ref.kind}/${ref.schema}.${ref.name}${extension}`);
}

/**
 * The object an address names, or undefined for an address this version did
 * not write. Reads the pre-kind form too — `/<schema>.<name>` — with the kind
 * the scheme implied, so a tab serialized by an earlier build still restores.
 */
export function objectRefOf(uri: vscode.Uri, fallback: ObjectKind): FavouriteRef | undefined {
  const parts = decodeURIComponent(uri.path.replace(/^\//, ''))
    .replace(/\.sql$/i, '')
    .split('/');
  const label = parts.length > 1 ? parts[1] : parts[0];
  const kind = parts.length > 1 && (OBJECT_KINDS as readonly string[]).includes(parts[0]) ? (parts[0] as ObjectKind) : fallback;
  const dot = label.indexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return { kind, schema: label.slice(0, dot), name: label.slice(dot + 1) };
}
