import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionStore } from '../store/connectionStore';
import { FavouriteRef } from '../shared/catalog';
import { errorMessage } from '../types';
import { OBJECT_SCHEME, QUERY_SCHEME, addressOf, objectAddress, objectRefOf } from './bindingStore';

/** Where the query buffers are mirrored so a window reload does not lose them. */
const STATE_KEY = 'databaseTools.queryFiles.v1';

/** Past this, a buffer stays in memory rather than going into the memento. */
const MAX_PERSISTED_BYTES = 512 * 1024;

interface StoredFile {
  text: string;
  ctime: number;
  mtime: number;
}

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
 * No query file reaches disk. Ctrl+S writes into this map and marks the tab
 * clean; saving somewhere permanent is Save As, which turns the document into
 * an ordinary `.sql` file and hands the binding over to `BindingStore`.
 *
 * The map is mirrored into `workspaceState` all the same, because a tab that
 * survives a reload and comes back empty — or worse, comes back as "the editor
 * could not be opened" — is somebody's unsaved work gone. The workbench
 * restores the tab either way; this is what still has something to hand it.
 */
export class QueryFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, { content: Uint8Array; ctime: number; mtime: number }>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private counter = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The addresses that came back from the memento, and only those. */
  private readonly restored = new Set<string>();
  /**
   * What is in a tab right now, when that is ahead of its last save.
   *
   * Kept beside the buffers rather than in them, because `stat` is what the
   * workbench builds a document's etag from: moving the buffer under a dirty
   * document would make its next save look like a save over somebody else's
   * edit, and the workbench would refuse it. Nothing reads this but `persist`.
   */
  private readonly drafts = new Map<string, string>();

  constructor(private readonly memento: vscode.Memento) {
    for (const [key, stored] of Object.entries(memento.get<Record<string, StoredFile>>(STATE_KEY, {}))) {
      this.files.set(key, {
        content: Buffer.from(stored.text, 'utf8'),
        ctime: stored.ctime,
        mtime: stored.mtime
      });
      this.restored.add(key);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.persist();
    }
    this.emitter.dispose();
    this.files.clear();
  }

  /**
   * Drops the buffers of restored queries no tab is showing any more.
   *
   * Called once at activation. What came back from the memento without a tab
   * to go with it is a scratch query somebody closed last session, and keeping
   * it would grow the memento without bound and push the next New Query into
   * `Query 7.sql` — the collision check in `uniqueQuery` cannot tell a stale
   * address from a live one.
   *
   * Only restored addresses are candidates, never one created since. A query
   * opened this session exists for a moment before its tab does, and that
   * moment is long enough for a sweep to throw the contents away.
   */
  async prune(): Promise<void> {
    if (this.restored.size === 0) {
      return;
    }
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === QUERY_SCHEME) {
          open.add(tab.input.uri.toString());
        }
      }
    }
    let changed = false;
    for (const key of this.restored) {
      if (!open.has(key)) {
        this.files.delete(key);
        changed = true;
      }
    }
    this.restored.clear();
    if (changed) {
      await this.persist();
    }
  }

  /**
   * Keeps what is in a query tab as it is typed.
   *
   * A scratch query is unsaved by nature — somebody opens one, writes four
   * lines, runs them and never presses Ctrl+S — so persisting only on save
   * would keep the queries nobody was worried about and lose the ones they
   * were. Every keystroke in a `dbquery:` tab lands here and, a beat later,
   * in the memento.
   */
  track(document: vscode.TextDocument): void {
    if (document.uri.scheme !== QUERY_SCHEME) {
      return;
    }
    this.drafts.set(document.uri.toString(), document.getText());
    this.schedulePersist();
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
    this.schedulePersist();
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

  /**
   * Opens a scratch query bound to a connection, in front of the user.
   *
   * Every object action ends here: a definition, a CRUD scaffold, a `SELECT
   * TOP`, a dependency listing. Bound rather than untitled, because a bound
   * tab has Run on its title bar and the connection in its status bar, and an
   * untitled document has neither and is the first thing a person has to
   * repair before the statement can be run.
   */
  async openScratch(profileId: string, name: string, content: string): Promise<vscode.TextDocument> {
    const uri = this.uniqueQuery(profileId, name, content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }

  /* ------------------------------------------------- FileSystemProvider */

  watch(): vscode.Disposable {
    // Nothing outside this process can change these files, so there is nothing
    // to watch for. Returning a no-op disposable is the honest implementation.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entry(uri);
    return { type: vscode.FileType.File, ctime: entry.ctime, mtime: entry.mtime, size: entry.content.byteLength };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Every address is a single file at the root of its authority.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.entry(uri).content;
  }

  /**
   * The buffer at an address, empty when there is nothing there.
   *
   * A missing address used to be `FileNotFound`, and `FileNotFound` while the
   * workbench is restoring a tab is the "editor could not be opened due to an
   * unexpected error" dialog — with no way back to the tab short of closing
   * it. An empty buffer is a tab somebody can carry on typing in, which is the
   * better failure by a distance. Contents that were there before a reload
   * come back from the memento, not from here.
   */
  private entry(uri: vscode.Uri): { content: Uint8Array; ctime: number; mtime: number } {
    const key = uri.toString();
    let entry = this.files.get(key);
    if (!entry) {
      entry = { content: new Uint8Array(0), ctime: Date.now(), mtime: Date.now() };
      this.files.set(key, entry);
    }
    return entry;
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
    // The buffer is the text now, so there is no draft ahead of it.
    this.drafts.delete(key);
    this.schedulePersist();
    this.emitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.toString());
    this.drafts.delete(uri.toString());
    this.schedulePersist();
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(from: vscode.Uri, to: vscode.Uri): void {
    const entry = this.files.get(from.toString());
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(from);
    }
    this.files.delete(from.toString());
    this.files.set(to.toString(), entry);
    const draft = this.drafts.get(from.toString());
    this.drafts.delete(from.toString());
    if (draft !== undefined) {
      this.drafts.set(to.toString(), draft);
    }
    this.schedulePersist();
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to }
    ]);
  }

  /* ------------------------------------------------------------- memento */

  /**
   * Mirrors the map, a beat after the edit rather than on it.
   *
   * Every save of a query tab is a `writeFile`, and auto-save turns that into
   * one memento write per pause in typing. A quarter of a second collapses a
   * burst into one.
   */
  private schedulePersist(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.persist();
    }, 250);
  }

  private async persist(): Promise<void> {
    const out: Record<string, StoredFile> = {};
    for (const [key, entry] of this.files) {
      // What was typed wins over what was last saved: coming back to the tab
      // as it looked when the window closed is the whole point.
      const draft = this.drafts.get(key);
      const text = draft ?? Buffer.from(entry.content).toString('utf8');
      // A buffer this large is a script somebody pasted in, and a memento is
      // not the place for it. It stays in memory and is lost on reload, which
      // is what happened at every size before.
      if (Buffer.byteLength(text, 'utf8') > MAX_PERSISTED_BYTES) {
        continue;
      }
      out[key] = { text, ctime: entry.ctime, mtime: entry.mtime };
    }
    await this.memento.update(STATE_KEY, out);
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
/** The database an object address names, when it names one. */
function databaseOf(uri: vscode.Uri): string | undefined {
  const match = /(?:^|&)db=([^&]*)/.exec(uri.query);
  return match ? decodeURIComponent(match[1]) || undefined : undefined;
}

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

  /**
   * The address of a scripted definition.
   *
   * `database` rides in the query string rather than in the path, and it is
   * the only part of the address that is optional. The path is what
   * `objectRefOf` parses and what an older build's tabs still restore from, so
   * it could not grow a segment; the query string is ignored by everything
   * that does not look for it, which is every caller but this one. Two
   * definitions of `dbo.Staff` in two databases also need two addresses, or
   * the second would be served the first one's cached document.
   */
  static address(profileId: string, ref: FavouriteRef, database?: string): vscode.Uri {
    const base = objectAddress(OBJECT_SCHEME, profileId, ref, '.sql');
    return database ? base.with({ query: `db=${encodeURIComponent(database)}` }) : base;
  }

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const profileId = uri.authority;
    const ref = objectRefOf(uri, 'table');
    if (!this.store.get(profileId) || !ref) {
      return '-- That connection no longer exists.';
    }
    try {
      return await this.catalog.definition(profileId, ref, databaseOf(uri));
    } catch (error) {
      return `-- ${errorMessage(error)}`;
    }
  }
}
