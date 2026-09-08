import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';

/**
 * The header a saved query carries.
 *
 * Two comment lines, at the top, in the SQL's own comment syntax — so the file
 * is still a valid `.sql` that runs anywhere, and so a person reading it in a
 * pull request can see which server it was written against without opening a
 * tool.
 */
const CONNECTION_TAG = /^--\s*@connection\s+(.+)$/im;
const DESCRIPTION_TAG = /^--\s*@description\s+(.+)$/im;

export interface SavedQuery {
  uri: vscode.Uri;
  name: string;
  connectionName?: string;
  profileId?: string;
  description?: string;
}

/**
 * Saved queries, as real files.
 *
 * A memento was the other option and is the wrong one. A saved query is
 * something people diff, review in a pull request, share with a colleague and
 * lose when their laptop dies. Keeping it in a hidden per-user key store makes
 * all four of those impossible; keeping it as a `.sql` file makes all four
 * free, and gets source control decoration, workspace search, rename and the
 * diff editor without a line of code.
 */
export class SavedQueryStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rewatch()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('databaseTools.savedQueryFolder')) {
          this.rewatch();
        }
      })
    );
    this.rewatch();
  }

  dispose(): void {
    this.watcher?.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  /**
   * Where saved queries go.
   *
   * The workspace when there is one, because that is where the rest of the
   * project's SQL lives and where source control can see it. Global storage
   * when there is not, so the action still works in a window with no folder
   * open rather than being disabled with an explanation.
   */
  folder(): vscode.Uri {
    const configured = vscode.workspace
      .getConfiguration('databaseTools')
      .get<string>('savedQueryFolder', '.database/queries');
    const root = vscode.workspace.workspaceFolders?.[0];
    return root ? vscode.Uri.joinPath(root.uri, configured) : vscode.Uri.joinPath(this.context.globalStorageUri, 'queries');
  }

  async list(): Promise<SavedQuery[]> {
    const folder = this.folder();
    let names: [string, vscode.FileType][];
    try {
      names = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return [];
    }
    const files = names.filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.sql'));
    const out: SavedQuery[] = [];
    for (const [name] of files) {
      const uri = vscode.Uri.joinPath(folder, name);
      out.push(await this.describe(uri));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describe(uri: vscode.Uri): Promise<SavedQuery> {
    const name = path.basename(uri.path).replace(/\.sql$/i, '');
    let head = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      head = Buffer.from(bytes).toString('utf8').slice(0, 2048);
    } catch {
      // A file that cannot be read is still a row in the tree, without a
      // connection: the alternative is a tree that silently loses entries.
    }
    const connectionName = CONNECTION_TAG.exec(head)?.[1]?.trim();
    const description = DESCRIPTION_TAG.exec(head)?.[1]?.trim();
    const profile = connectionName
      ? this.store.all().find((p) => (p.name || p.host) === connectionName)
      : undefined;
    return { uri, name, connectionName, description, profileId: profile?.id };
  }

  /** Writes a query, creating the folder the first time. */
  async save(name: string, sql: string, profileId: string, description?: string): Promise<vscode.Uri> {
    const folder = this.folder();
    await vscode.workspace.fs.createDirectory(folder);
    const profile = this.store.get(profileId);
    const header = [
      `-- @connection ${profile?.name || profile?.host || 'unbound'}`,
      description ? `-- @description ${description.replace(/\r?\n/g, ' ')}` : undefined,
      ''
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    const body = stripHeader(sql);
    const uri = vscode.Uri.joinPath(folder, `${safeName(name)}.sql`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${header}${body}`, 'utf8'));
    this.onDidChangeEmitter.fire();
    return uri;
  }

  private rewatch(): void {
    this.watcher?.dispose();
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.watcher = undefined;
      this.onDidChangeEmitter.fire();
      return;
    }
    const configured = vscode.workspace
      .getConfiguration('databaseTools')
      .get<string>('savedQueryFolder', '.database/queries');
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${configured}/*.sql`)
    );
    const fire = () => this.onDidChangeEmitter.fire();
    this.watcher.onDidCreate(fire);
    this.watcher.onDidChange(fire);
    this.watcher.onDidDelete(fire);
    this.onDidChangeEmitter.fire();
  }
}

/** Header lines are rewritten rather than stacked when a query is re-saved. */
function stripHeader(sql: string): string {
  const lines = sql.split('\n');
  let start = 0;
  while (start < lines.length && /^--\s*@(connection|description)\b/i.test(lines[start])) {
    start++;
  }
  while (start < lines.length && lines[start].trim() === '') {
    start++;
  }
  return lines.slice(start).join('\n');
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Query';
}
