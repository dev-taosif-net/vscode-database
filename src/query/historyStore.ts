import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecutionRecord } from '../exec/resultStore';

/** Entries kept per connection, and the file size that overrides the count. */
const MAX_ENTRIES = 1000;
const MAX_BYTES = 8 * 1024 * 1024;

export interface HistoryEntry {
  id: string;
  profileId: string;
  connectionName: string;
  sql: string;
  at: number;
  durationMs: number;
  rows: number;
  status: 'done' | 'error' | 'cancelled';
  error?: string;
  /** True when the statement was withheld because it set a credential. */
  redacted?: boolean;
}

/**
 * Statements whose text must never reach a file.
 *
 * A history file is a plain file on disk. It is backed up, it is synced, and
 * it is occasionally pasted whole into a support ticket. A password typed into
 * an `ALTER LOGIN` would ride along in every one of those, which is why the
 * timing of such a statement is kept and its text is not.
 */
const SECRET_SHAPES = [
  /\bPASSWORD\s*=/i,
  /\bIDENTIFIED\s+BY\b/i,
  /\bCREATE\s+(LOGIN|USER)\b/i,
  /\bALTER\s+(LOGIN|USER)\b/i,
  /\bSECRET\s*=/i,
  /\bCREDENTIAL\b/i
];

function isSecret(sql: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(sql));
}

/**
 * What was run, per connection.
 *
 * Two rules that are not obvious and are the reason this exists rather than a
 * plain array. A failed query is kept, and kept prominently, because the thing
 * people most often want out of history is the query they broke twenty minutes
 * ago. And nothing that looks like a credential is stored at all.
 */
export class HistoryStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly cache = new Map<string, HistoryEntry[]>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  read(profileId: string): HistoryEntry[] {
    const cached = this.cache.get(profileId);
    if (cached) {
      return cached;
    }
    const entries: HistoryEntry[] = [];
    try {
      const text = fs.readFileSync(this.fileFor(profileId), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          entries.push(JSON.parse(line) as HistoryEntry);
        } catch {
          // One unreadable line loses one entry, not the file.
        }
      }
    } catch {
      // No history yet.
    }
    entries.reverse();
    this.cache.set(profileId, entries);
    return entries;
  }

  /** Every connection's history, newest first. Used by the search box. */
  all(): HistoryEntry[] {
    const files = safeReadDir(this.dir).filter((name) => name.endsWith('.jsonl'));
    const entries = files.flatMap((name) => this.read(path.basename(name, '.jsonl')));
    return entries.sort((a, b) => b.at - a.at);
  }

  record(execution: ExecutionRecord): void {
    if (!execution.sql.trim()) {
      return;
    }
    const redacted = isSecret(execution.sql);
    const entry: HistoryEntry = {
      // The execution id keeps two runs that started in the same millisecond
      // apart, and a profile id keeps two windows' histories apart.
      id: `${execution.profileId}:${execution.startedAt}:${execution.id}`,
      profileId: execution.profileId,
      connectionName: execution.connectionName,
      sql: redacted ? '' : execution.sql.trim(),
      at: execution.startedAt,
      durationMs: (execution.finishedAt ?? Date.now()) - execution.startedAt,
      rows: execution.sets.reduce((sum, set) => sum + set.count, 0),
      status: execution.status === 'running' ? 'done' : execution.status,
      error: execution.error?.text,
      redacted: redacted || undefined
    };

    const list = this.read(execution.profileId);
    list.unshift(entry);
    if (list.length > MAX_ENTRIES) {
      list.length = MAX_ENTRIES;
    }
    this.write(execution.profileId, list);
    this.onDidChangeEmitter.fire();
  }

  clear(profileId?: string): void {
    const ids = profileId ? [profileId] : safeReadDir(this.dir).map((name) => path.basename(name, '.jsonl'));
    for (const id of ids) {
      this.cache.delete(id);
      try {
        fs.unlinkSync(this.fileFor(id));
      } catch {
        // Nothing to clear.
      }
    }
    this.onDidChangeEmitter.fire();
  }

  private write(profileId: string, entries: HistoryEntry[]): void {
    // Written oldest-first so an append would be the natural next line, and
    // trimmed by size as well as by count: a thousand entries of one enormous
    // generated statement is not a thousand small ones.
    let text = '';
    const ordered = [...entries].reverse();
    for (const entry of ordered) {
      const line = `${JSON.stringify(entry)}\n`;
      if (text.length + line.length > MAX_BYTES) {
        break;
      }
      text += line;
    }
    try {
      fs.writeFileSync(this.fileFor(profileId), text, 'utf8');
      this.cache.set(profileId, entries);
    } catch {
      // A history that cannot be written is not a reason to fail a query.
    }
  }

  private fileFor(profileId: string): string {
    return path.join(this.dir, `${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
