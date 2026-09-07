import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { DetailsService } from '../details/detailsService';
import { ExecutionService } from '../exec/executionService';
import { ExecutionRecord, ResultStore } from '../exec/resultStore';
import { EXTENSIONS, exportSet, renderCopy } from '../export/exporters';
import { CellValue, QueryHostMessage, QueryWebviewMessage } from '../shared/query';
import { keyValuesOf, selectPage } from './tableSql';

export type Post = (message: QueryHostMessage) => void;

/**
 * The half of every grid-bearing webview that is the same in all three.
 *
 * The results panel, a table data tab and a procedure runner draw different
 * chrome around one grid, and the grid asks the same six questions: give me
 * rows, sort, filter, export, copy, cancel. Putting the answers here rather
 * than in each view is what keeps `Copy as INSERT` from being three
 * implementations that disagree.
 */
export class QueryBridge {
  constructor(
    private readonly store: ConnectionStore,
    private readonly results: ResultStore,
    private readonly execution: ExecutionService,
    private readonly details: DetailsService,
    private readonly output: vscode.LogOutputChannel
  ) {}

  /** Sends a tab's current execution, or null when it has none. */
  project(tab: string | undefined, post: Post): void {
    const record = tab ? this.results.latestFor(tab) : undefined;
    post({ type: 'project', execution: record ? this.results.project(record) : null });
    if (record?.plan) {
      post({ type: 'plan', executionId: record.id, plan: record.plan });
    }
  }

  async handle(message: QueryWebviewMessage, post: Post): Promise<void> {
    switch (message.type) {
      case 'getRows':
        return this.sendRows(message.executionId, message.setIndex, message.offset, message.count, post);

      case 'sort':
        return this.sort(message.executionId, message.setIndex, message.column, message.direction, post);

      case 'filter':
        return this.filter(message.executionId, message.text, message.server, post);

      case 'cancel':
        this.execution.cancel(message.executionId);
        return;

      case 'fetchMore':
        await this.execution.fetchMore(message.executionId, message.all);
        return;

      case 'page':
        return this.page(message.executionId, message.delta);

      case 'pageSize':
        return this.pageSize(message.executionId, message.size);

      case 'refresh':
        return this.refresh(message.executionId);

      case 'goToError':
        return this.goToError(message.executionId);

      case 'export':
        return this.export(message.executionId, message.setIndex, message.format, post);

      case 'copy':
        return this.copy(message, post);

      case 'openConnection':
        await vscode.commands.executeCommand('databaseTools.editConnection', message.profileId);
        return;

      default:
        return;
    }
  }

  private async sendRows(
    executionId: string,
    setIndex: number,
    offset: number,
    count: number,
    post: Post
  ): Promise<void> {
    const record = this.results.get(executionId);
    const set = record?.sets[setIndex];
    if (!record || !set) {
      return;
    }
    const rows = await this.results.read(set, offset, count);
    post({ type: 'rows', executionId, setIndex, offset, rows });
  }

  private async sort(
    executionId: string,
    setIndex: number,
    column: number,
    direction: 'asc' | 'desc' | null,
    post: Post
  ): Promise<void> {
    const record = this.results.get(executionId);
    const set = record?.sets[setIndex];
    if (!record || !set) {
      return;
    }

    // A table data view can sort on the server and be exact about it. Anything
    // else can only reorder the rows it fetched, which is true and useful on a
    // small answer and a lie on a large one — so it is done, and labelled.
    if (record.source === 'data' && record.table) {
      await this.runTablePage(record, { page: 0, sort: direction ? { column, direction } : null });
      return;
    }

    if (!this.results.canReorder(set)) {
      post({
        type: 'notice',
        level: 'error',
        text: 'This answer is larger than the grid can reorder. Add an ORDER BY and run it again.'
      });
      return;
    }
    this.results.sort(set, column, direction);
    this.project(record.tab, post);
  }

  private async filter(executionId: string, text: string, server: boolean, post: Post): Promise<void> {
    const record = this.results.get(executionId);
    if (!record) {
      return;
    }
    if (server && record.source === 'data' && record.table) {
      await this.runTablePage(record, { page: 0, filter: text });
      return;
    }
    for (const set of record.sets) {
      this.results.filter(set, text);
    }
    this.project(record.tab, post);
  }

  private async page(executionId: string, delta: number): Promise<void> {
    const record = this.results.get(executionId);
    if (!record?.table) {
      return;
    }
    const page = Math.max(0, record.table.page + delta);
    await this.runTablePage(record, { page });
  }

  private async pageSize(executionId: string, size: number): Promise<void> {
    const record = this.results.get(executionId);
    if (!record?.table) {
      return;
    }
    await this.runTablePage(record, { page: 0, pageSize: Math.max(10, Math.min(10_000, size)) });
  }

  private async refresh(executionId: string): Promise<void> {
    const record = this.results.get(executionId);
    if (!record) {
      return;
    }
    if (record.table) {
      await this.runTablePage(record, { page: record.table.page });
      return;
    }
    await this.execution.run({
      tab: record.tab,
      profileId: record.profileId,
      sql: record.sql,
      source: record.source,
      quiet: true
    });
  }

  /**
   * The next page of a table, in whatever way the table allows.
   *
   * Keyset where a unique key exists and `OFFSET` where none does, and the
   * difference is not cosmetic: `OFFSET 9000000 ROWS` makes the server walk
   * nine million rows in order to discard them, so every page is slower than
   * the last. Keyset carries the previous page's key forward and is an index
   * seek at any depth.
   */
  async runTablePage(
    record: ExecutionRecord,
    change: {
      page: number;
      pageSize?: number;
      filter?: string;
      sort?: { column: number; direction: 'asc' | 'desc' } | null;
    }
  ): Promise<void> {
    const table = record.table;
    const profile = this.store.get(record.profileId);
    if (!table || !profile) {
      return;
    }

    const columns = record.sets[0]?.columns ?? [];
    const pageSize = change.pageSize ?? table.pageSize;
    const sort =
      change.sort === null
        ? undefined
        : change.sort
          ? { column: columns[change.sort.column]?.name ?? '', direction: change.sort.direction }
          : table.sortColumn
            ? { column: table.sortColumn, direction: table.sortDirection ?? 'asc' }
            : undefined;
    const filter = change.filter ?? table.filter;
    const keys = await this.details.keyColumns(record.profileId, table.ref);

    // Keyset only works when this page follows the one before it. A jump has
    // nowhere to seek from, so it skips — and the footer is told which.
    const stepping = change.page === table.page + 1;
    const page = selectPage(profile.driver, {
      ref: table.ref,
      columns,
      keyColumns: keys.columns,
      sort: sort && sort.column ? sort : undefined,
      filter,
      page: change.page,
      pageSize,
      after: stepping ? table.after : undefined
    });

    const next = await this.execution.run({
      tab: record.tab,
      profileId: record.profileId,
      sql: page.sql,
      params: page.params,
      source: 'data',
      limit: pageSize,
      quiet: true,
      table: {
        ...table,
        pageSize,
        page: change.page,
        keyset: keys.usable && !sort,
        filter,
        sortColumn: sort?.column,
        sortDirection: sort?.direction,
        hasMore: true,
        after: undefined
      }
    });

    if (!next?.table) {
      return;
    }
    const set = next.sets[0];
    const fetched = set?.count ?? 0;
    next.table.hasMore = fetched >= pageSize;
    if (set) {
      const last = (await this.results.read(set, Math.max(0, fetched - 1), 1))[0];
      next.table.after = keyValuesOf(set.columns, last, keys.columns);
      if (sort) {
        const index = set.columns.findIndex((column) => column.name === sort.column);
        if (index !== -1) {
          // Server-side, so the grid draws a solid arrow and says nothing
          // about a thousand fetched rows.
          set.sort = { column: index, direction: sort.direction, server: true };
        }
      }
    }
  }

  private async goToError(executionId: string): Promise<void> {
    const record = this.results.get(executionId);
    const line = record?.error?.line;
    if (!record || line === undefined) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(record.tab));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch {
      // The tab has been closed. The message is still readable where it is.
    }
  }

  private async export(
    executionId: string,
    setIndex: number,
    format: Parameters<typeof exportSet>[2],
    post: Post
  ): Promise<void> {
    const record = this.results.get(executionId);
    const set = record?.sets[setIndex];
    if (!record || !set) {
      return;
    }
    const profile = this.store.get(record.profileId);
    const base = record.table ? `${record.table.ref.schema}.${record.table.ref.name}` : 'results';
    const target = await vscode.window.showSaveDialog({
      title: 'Export results',
      defaultUri: vscode.Uri.file(`${base}.${EXTENSIONS[format]}`),
      filters: { [format.toUpperCase()]: [EXTENSIONS[format]] }
    });
    if (!target) {
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting to ${target.fsPath}`, cancellable: false },
      async (progress) => {
        try {
          const written = await exportSet(
            this.results,
            set,
            format,
            target,
            record.table?.ref,
            profile?.driver ?? 'mssql',
            (rows) => progress.report({ message: `${rows.toLocaleString('en-US')} rows` })
          );
          post({ type: 'exported', path: target.fsPath, rows: written });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.output.error(`export: ${text}`);
          post({ type: 'notice', level: 'error', text });
        }
      }
    );
  }

  private async copy(
    message: Extract<QueryWebviewMessage, { type: 'copy' }>,
    post: Post
  ): Promise<void> {
    const record = this.results.get(message.executionId);
    const set = record?.sets[message.setIndex];
    if (!record || !set) {
      return;
    }
    const profile = this.store.get(record.profileId);
    const { top, bottom, left, right } = message.range;
    const height = Math.max(0, bottom - top + 1);

    // A selection reaching past the fetched window fetches what is missing
    // first, through the host, rather than copying blanks.
    const rows = await this.results.read(set, top, height);
    const sliced: CellValue[][] = rows.map((row) => row.slice(left, right + 1));
    const columns = set.columns.slice(left, right + 1);

    const text = renderCopy(columns, sliced, message.shape, record.table?.ref, profile?.driver ?? 'mssql');
    await vscode.env.clipboard.writeText(text);
    post({ type: 'copied', cells: sliced.length * columns.length });
  }
}
