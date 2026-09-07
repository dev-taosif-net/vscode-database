import * as vscode from 'vscode';
import { ConnectionProfile, environmentLabel } from '../types';
import { leadingKeywords } from './splitter';

/**
 * Statements that only read.
 *
 * Everything not on this list is treated as a write, which is the safe
 * direction to be wrong in: a `SELECT` wrongly flagged costs one confirmation,
 * and an `UPDATE` wrongly allowed costs a production incident. `WITH` is on
 * the list and then looked at again below, because a common table expression
 * is a read right up until the statement it feeds is an `INSERT`.
 */
const READING = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DECLARE',
  'SET',
  'USE',
  'PRINT',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'IF',
  'GO'
]);

/** What a `WITH` may turn into, and every other way to change something. */
const WRITING = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'DROP',
  'ALTER',
  'CREATE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BACKUP',
  'RESTORE',
  'BULK',
  'RENAME',
  'REINDEX',
  'VACUUM',
  'CLUSTER',
  'COPY',
  'CALL',
  'EXEC',
  'EXECUTE',
  'DBCC'
]);

export interface Verdict {
  /** The statements that are not reads, in the order they appear. */
  writes: { keyword: string; offset: number }[];
}

/**
 * What a batch will do, as far as its leading keywords can say.
 *
 * This is deliberately not a parser. A guard that had to parse T-SQL and
 * PL/pgSQL correctly before it could refuse anything would be wrong in both
 * dialects and would fail open, which is the one way a guard must not fail.
 * Leading keywords are coarse, they over-report, and they never miss an
 * `UPDATE`.
 */
export function classify(sql: string): Verdict {
  const keywords = leadingKeywords(sql);
  const writes = keywords.filter((k) => !READING.has(k.keyword));

  // A `WITH` whose statement writes is a write, and it is the one shape the
  // leading keyword gets wrong on its own.
  if (keywords.some((k) => k.keyword === 'WITH')) {
    for (const word of sql.toUpperCase().split(/[^A-Z]+/)) {
      if (WRITING.has(word) && !writes.some((w) => w.keyword === word)) {
        writes.push({ keyword: word, offset: 0 });
        break;
      }
    }
  }
  return { writes };
}

/**
 * Refuses a write on a connection marked read-only, by name.
 *
 * PostgreSQL already holds the whole session read-only and would refuse this
 * itself with a clear message. SQL Server has no session-level switch at all,
 * so on that engine this check is the only thing standing between a read-only
 * profile and an `UPDATE` — which is why the profile flag has been carrying a
 * comment since phase 1 saying the statement gate would arrive with execution.
 * It has.
 */
export function readOnlyRefusal(profile: ConnectionProfile, sql: string): string | undefined {
  if (!profile.readOnly) {
    return undefined;
  }
  const { writes } = classify(sql);
  if (writes.length === 0) {
    return undefined;
  }
  const kinds = [...new Set(writes.map((w) => w.keyword))].join(', ');
  return `${profile.name || profile.host} is marked read-only, and this contains ${kinds}.`;
}

/**
 * Asks before a write reaches production, naming what it will change.
 *
 * The phase 1 guard asks before a session is opened. This one asks again
 * before anything is written, because consenting to look at production is not
 * consenting to change it.
 */
export async function confirmProductionWrite(profile: ConnectionProfile, sql: string): Promise<boolean> {
  if (profile.environment !== 'prod') {
    return true;
  }
  const configured = vscode.workspace
    .getConfiguration('databaseTools')
    .get<boolean>('confirmProductionWrite', true);
  if (!configured) {
    return true;
  }
  const { writes } = classify(sql);
  if (writes.length === 0) {
    return true;
  }
  const kinds = [...new Set(writes.map((w) => w.keyword))].join(', ');
  const choice = await vscode.window.showWarningMessage(
    `Run ${kinds} against ${profile.name || profile.host}?`,
    {
      modal: true,
      detail: `${environmentLabel(profile.environment)} · ${profile.host}${
        profile.database ? ` · ${profile.database}` : ''
      }\n\nThis changes rows on the server.`
    },
    'Run it'
  );
  return choice === 'Run it';
}
