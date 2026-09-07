import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionStore } from '../store/connectionStore';
import { FavouriteRef } from '../shared/catalog';
import { OBJECT_SCHEME, QUERY_SCHEME, addressOf } from './bindingStore';

/**
 * The file system behind `dbquery:` documents.
 *
 * A query editor has to be three things at once: a real `TextDocument` so the
 * workbench's own editor draws it, editable and savable so Ctrl+S does not
 * throw, and addressable by a URI carrying the connection it is bound to.
 * Nothing built in is all three. An untitled document cannot carry an
 * authority, and a `TextDocumentContentProvider` document is read-only. So the
 * documents live here, in memory, behind a file system provider — which is the
 * one extension point that gives a custom scheme a writable buffer.
 *
 * Nothing reaches disk. Ctrl+S writes into this map and marks the tab clean;
 * saving somewhere permanent is Save As, which turns the document into an
 * ordinary `.sql` file and hands the binding over to `BindingStore`.
 */
export class QueryFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, { content: Uint8Array; ctime: number; mtime: number }>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private counter = 0;

  dispose(): void {
    this.emitter.dispose();
    this.files.clear();
  }

  /** A fresh, empty query bound to a connection. */
  newQuery(profileId: string, name?: string, content = ''): vscode.Uri {
    const label = name ?? `Query ${++this.counter}`;
    const uri = addressOf(QUERY_SCHEME, profileId, `${label}.sql`);
    this.files.set(uri.toString(), {
      content: Buffer.from(content, 'utf8'),
      ctime: Date.now(),
      mtime: Date.now()
    });
    return uri;
  }

  /**
   * A query with a name that will not collide with one already open.
   *
   * Two tabs on the same address are one tab, so `Customer.sql` opened twice
   * would reveal the first rather than opening a second. That is right for an
   * object and wrong for a scratch query, which is why the name is made unique
   * rather than the address being reused.
   */
  uniqueQuery(profileId: string, base: string, content = ''): vscode.Uri {
    let label = base;
    let n = 1;
    while (this.files.has(addressOf(QUERY_SCHEME, profileId, `${label}.sql`).toString())) {
      label = `${base} ${++n}`;
    }
    return this.newQuery(profileId, label, content);
  }

  /* ------------------------------------------------- FileSystemProvider */

  watch(): vscode.Disposable {
    // Nothing outside this process can change these files, so there is nothing
    // to watch for. Returning a no-op disposable is the honest implementation.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.files.get(uri.toString());
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: vscode.FileType.File, ctime: entry.ctime, mtime: entry.mtime, size: entry.content.byteLength };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Every address is a single file at the root of its authority.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.files.get(uri.toString());
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entry.content;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const key = uri.toString();
    const existing = this.files.get(key);
    if (!existing && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (existing && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    this.files.set(key, { content, ctime: existing?.ctime ?? Date.now(), mtime: Date.now() });
    this.emitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(from: vscode.Uri, to: vscode.Uri): void {
    const entry = this.files.get(from.toString());
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(from);
    }
    this.files.delete(from.toString());
    this.files.set(to.toString(), entry);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to }
    ]);
  }
}

/**
 * Scripted definitions, read-only, at `dbobj:`.
 *
 * The one read-only scheme in phase 3, and deliberately so: a `CREATE` you
 * opened to read is not a draft, and a buffer that looks editable but is
 * thrown away on the next refresh is worse than one that says what it is.
 * Open Definition still opens an editable copy, at `dbquery:`, because that
 * one is a starting point.
 */
export class DefinitionProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly catalog: CatalogService
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  static address(profileId: string, ref: FavouriteRef): vscode.Uri {
    return addressOf(OBJECT_SCHEME, profileId, `${ref.kind}/${ref.schema}.${ref.name}.sql`);
  }

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const profileId = uri.authority;
    const parts = decodeURIComponent(uri.path.replace(/^\//, '')).replace(/\.sql$/i, '').split('/');
    const kind = parts[0] as FavouriteRef['kind'];
    const label = parts[1] ?? '';
    const dot = label.indexOf('.');
    if (!this.store.get(profileId) || dot <= 0) {
      return '-- That connection no longer exists.';
    }
    const ref: FavouriteRef = { kind, schema: label.slice(0, dot), name: label.slice(dot + 1) };
    try {
      return await this.catalog.definition(profileId, ref);
    } catch (error) {
      return `-- ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
