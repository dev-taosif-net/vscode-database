import * as vscode from 'vscode';

const KEY = 'databaseTools.bindings.v1';

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
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<Record<string, string>>(KEY, {});
    this.map = new Map(Object.entries(stored));
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
    if (profileId) {
      this.map.set(key, profileId);
    } else {
      this.map.delete(key);
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
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(KEY, Object.fromEntries(this.map));
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

/** The object a `dbdata:`, `dbrun:` or `dbobj:` address names. */
export function refOf(uri: vscode.Uri): { schema: string; name: string } | undefined {
  const label = decodeURIComponent(uri.path.replace(/^\//, '')).replace(/\.[a-z]+$/i, '');
  const dot = label.indexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return { schema: label.slice(0, dot), name: label.slice(dot + 1) };
}
