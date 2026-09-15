import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { ExecutionService } from '../exec/executionService';
import { ExecutionRecord, ResultStore } from '../exec/resultStore';
import { encodeCell } from '../exec/encode';
import { confirmProductionWrite } from '../exec/guards';
import { splitBatches } from '../exec/splitter';
import { qualified } from '../catalog/script';
import { CellValue, LOCK_LABELS, QueryHostMessage, QueryWebviewMessage, cellText } from '../shared/query';
import { errorMessage } from '../types';
import { describeMssql } from './mssql';
import { describePostgres } from './postgres';
import { planEdit } from './plan';
import { EditPlan } from './types';
import { comparable, updateCellSql } from './updateSql';

type Post = (message: QueryHostMessage) => void;
type UpdateMessage = Extract<QueryWebviewMessage, { type: 'updateCell' }>;

/**
 * Cells typed into the grid, written back to the table they came from.
 *
 * Two questions, asked in order. "Can this set be edited, and which columns"
 * is answered once per result, on the first attempt and never on Run, and the
 * answer is kept on the record. "Write this cell" is one parameterised
 * `UPDATE` seeking on the table's key, run on the tab's own session, that
 * comes back with the value the server actually stored.
 *
 * Everything that could write to the wrong row is refused before anything is
 * sent: no key, a key with a NULL in it, more than one table, a row that is
 * no longer held in memory. The server's own errors — a type that will not
 * convert, a constraint, a permission — come back as the cell's error, in the
 * server's words, and the cell keeps what it had.
 */
export class EditService {
  /** In-flight describes, so two keystrokes do not compile a statement twice. */
  private readonly describing = new Map<string, Promise<EditPlan | undefined>>();
  private seq = 0;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly execution: ExecutionService,
    private readonly results: ResultStore,
    private readonly output: vscode.LogOutputChannel
  ) {}

  /**
   * Works out whether a set can be edited, keeps the answer on the record and
   * re-announces it so the grid hears. Returns undefined when the answer
   * cannot be given yet — the statement is still streaming — in which case
   * nothing is kept and the next attempt asks again.
   */
  async describe(executionId: string, setIndex: number, post: Post): Promise<EditPlan | undefined> {
    const record = this.results.get(executionId);
    const set = record?.sets[setIndex];
    if (!record || !set) {
      return undefined;
    }
    const cached = record.edits?.get(setIndex);
    if (cached) {
      return cached;
    }
    if (record.status === 'running') {
      post({ type: 'notice', level: 'info', text: 'Wait for the statement to finish before editing.' });
      return undefined;
    }

    const key = `${executionId}:${setIndex}`;
    const inFlight = this.describing.get(key);
    if (inFlight) {
      return inFlight;
    }
    const work = this.resolve(record, setIndex)
      .then((plan) => {
        record.edits ??= new Map();
        record.edits.set(setIndex, plan);
        this.execution.notify(record);
        return plan;
      })
      .catch((error) => {
        post({ type: 'notice', level: 'error', text: `Could not work out whether this result is editable: ${errorMessage(error)}` });
        return undefined;
      })
      .finally(() => this.describing.delete(key));
    this.describing.set(key, work);
    return work;
  }

  private async resolve(record: ExecutionRecord, setIndex: number): Promise<EditPlan> {
    const set = record.sets[setIndex];
    const columns = set.columns;
    const profile = this.store.get(record.profileId);
    const refuse = (reason: string): EditPlan =>
      planEdit(columns, { sources: columns.map(() => null), keyColumns: [], refusal: reason }, false);

    if (!profile) {
      return refuse('That connection no longer exists.');
    }
    if (!vscode.workspace.getConfiguration('databaseTools').get<boolean>('editResults', true)) {
      return refuse('Editing results is turned off by the databaseTools.editResults setting.');
    }
    if (profile.readOnly) {
      return planEdit(columns, { sources: [], keyColumns: [] }, true);
    }
    if (record.source === 'runner') {
      return refuse('Rows returned by a procedure are not edited in place.');
    }
    if (record.plan) {
      return refuse('Run the statement again without a plan to edit its rows.');
    }
    // The engines describe the first result set of a statement, so only the
    // first set with columns is the one they are describing. An UPDATE's row
    // count ahead of the SELECT is an empty set and is skipped over.
    const first = record.sets.findIndex((candidate) => candidate.columns.length > 0);
    if (first !== setIndex) {
      return refuse('Only the first result set of a statement can be edited.');
    }

    const session = await this.manager.scopedSession(profile.id, record.database);
    if (!session) {
      return refuse(`${profile.name || profile.host} is not connected.`);
    }

    if (profile.driver === 'postgres') {
      return planEdit(columns, await describePostgres(session, columns), false);
    }

    // A table page carries its own parameters, which a describe cannot bind;
    // the page is `SELECT *` of the table, so the table is what is described.
    let sql = record.sql;
    if (record.source === 'data' && record.table) {
      sql = `SELECT * FROM ${qualified('mssql', record.table.ref)}`;
    } else {
      const batches = splitBatches(record.sql, 'mssql');
      if (batches.length !== 1) {
        return refuse(`The tab ran ${batches.length} batches. Run the SELECT on its own to edit its rows.`);
      }
      sql = batches[0].text;
    }
    return planEdit(columns, await describeMssql(session, sql, columns), false);
  }

  /** One cell, written back. Always answers the grid, one way or the other. */
  async update(message: UpdateMessage, post: Post): Promise<void> {
    const { executionId, setIndex, row, column } = message;
    const reply = (ok: boolean, extra: { value?: CellValue; error?: string } = {}) =>
      post({ type: 'cell', executionId, setIndex, row, column, ok, value: extra.value, error: extra.error });

    const record = this.results.get(executionId);
    const set = record?.sets[setIndex];
    const profile = record ? this.store.get(record.profileId) : undefined;
    if (!record || !set || !profile) {
      reply(false, { error: 'That result is no longer held.' });
      return;
    }

    const plan = await this.describe(executionId, setIndex, post);
    if (!plan) {
      reply(false);
      return;
    }
    if (!plan.info.editable || !plan.info.target) {
      reply(false, { error: plan.info.reason ?? 'This result cannot be edited.' });
      return;
    }
    const lock = plan.info.locks[column];
    if (lock) {
      reply(false, { error: LOCK_LABELS[lock] });
      return;
    }
    const meta = set.columns[column];
    const sourceName = plan.sourceNames[column];
    if (!meta || !sourceName) {
      reply(false, { error: 'That column is not one of the table.' });
      return;
    }

    const stored = this.results.storedIndex(set, row);
    if (stored === undefined) {
      reply(false, { error: 'This row is past what the grid holds in memory, so it cannot be edited in place.' });
      return;
    }
    const values = set.rows[stored];

    const keys: { name: string; value: CellValue }[] = [];
    for (let i = 0; i < plan.keyIndexes.length; i++) {
      const value = values[plan.keyIndexes[i]] ?? null;
      if (value === null) {
        reply(false, { error: `This row has NULL in its key column ${plan.info.keyColumns[i]}, so it cannot be identified.` });
        return;
      }
      keys.push({ name: plan.info.keyColumns[i], value });
    }

    const current = values[column] ?? null;
    const unchanged = message.value === null ? current === null : current !== null && message.value === cellText(current);
    if (unchanged) {
      reply(true, { value: current });
      return;
    }

    const built = updateCellSql(profile.driver, {
      target: plan.info.target,
      column: { name: sourceName, meta },
      value: message.value,
      keys,
      expected: comparable(profile.driver, meta) ? { value: current } : undefined
    });

    if (!(await confirmProductionWrite(profile, built.sql, record.database))) {
      reply(false);
      return;
    }

    const startedAt = Date.now();
    try {
      const outcome = await this.execution.exclusive(record.tab, profile.id, record.database, async (session) => {
        const rows = await session.query<{ n?: unknown; v?: unknown }>(built.sql, built.params);
        return profile.driver === 'mssql'
          ? { affected: Number(rows[0]?.n ?? 0), value: rows[0]?.v }
          : { affected: rows.length, value: rows[0]?.v };
      });

      if (outcome.affected !== 1) {
        const text =
          outcome.affected === 0
            ? 'The row was not updated: it has been changed or deleted since it was fetched. Refresh and try again.'
            : `${outcome.affected} rows matched the key, which should not be possible. Refresh before editing again.`;
        this.note(record, built.display, startedAt, text);
        reply(false, { error: text });
        return;
      }

      const value = encodeCell(outcome.value);
      this.results.setCell(set, stored, column, value);
      reply(true, { value });
      this.note(record, built.display, startedAt);
    } catch (error) {
      const text = errorMessage(error);
      this.output.error(`${profile.name || profile.host}: edit failed: ${text}`);
      this.note(record, built.display, startedAt, text);
      reply(false, { error: text });
    }
  }

  /**
   * Leaves a trace of the edit where the query's own output goes: the
   * Messages tab, with the statement and its values, and history, as a line
   * of its own. An edit that could only be found by asking the server what
   * changed would be an edit nobody could account for.
   */
  private note(record: ExecutionRecord, display: string, startedAt: number, error?: string): void {
    record.messages.push({
      level: error === undefined ? 'info' : 'error',
      text: `${display}\n${error ?? '(1 row affected)'}`
    });
    this.execution.notify(record);
    this.execution.announce({
      ...record,
      id: `${record.id}e${++this.seq}`,
      sql: display,
      sets: [],
      messages: [],
      status: error === undefined ? 'done' : 'error',
      error: error === undefined ? undefined : { level: 'error', text: error },
      plan: undefined,
      table: undefined,
      edits: undefined,
      source: 'query',
      startedAt,
      finishedAt: Date.now()
    });
  }
}
