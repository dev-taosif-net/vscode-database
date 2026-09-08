import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { crudScript, executeScript, qualified } from '../catalog/script';
import { QueryFileSystem } from '../query/queryFs';
import { ConnectionStore } from '../store/connectionStore';
import { FavouriteRef, KINDS, ObjectKind, OBJECT_KINDS } from '../shared/catalog';
import { DriverKind, errorMessage } from '../types';

/**
 * The object row's half of the right-click menu: everything that turns an
 * object into SQL text and nothing that runs it.
 *
 * Every one of these ends in a scratch query tab *bound to the connection the
 * object came from*. They used to open untitled documents, which was right
 * when there was no execution engine and wrong the moment there was one: an
 * untitled document has no Run on its title bar and no connection in its
 * status bar, so the first thing a person had to do with a generated
 * statement was repair the tab before they could run it. The verbs that end
 * in rows — View Data, Select Top, Run… — live in `QueryCommands`.
 */

/**
 * The object a menu item was invoked on.
 *
 * The workbench hands a `webview/context` command the whole object the row put
 * in `data-vscode-context`, which reaches the host as JSON parsed out of an
 * attribute. So every field is checked rather than trusted, exactly as
 * `targetId` checks a profile id: a payload that is not an object of the right
 * shape yields undefined and the command reports that it has nothing to act on,
 * instead of composing a statement against `[object Object]`.
 */
export interface ObjectTarget {
  profileId: string;
  ref: FavouriteRef;
}

export function objectTarget(input: unknown): ObjectTarget | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const profileId = raw.connectionId;
  const kind = raw.objectKind;
  const schema = raw.objectSchema;
  const name = raw.objectName;

  if (
    typeof profileId !== 'string' ||
    typeof schema !== 'string' ||
    typeof name !== 'string' ||
    typeof kind !== 'string' ||
    !OBJECT_KINDS.includes(kind as ObjectKind)
  ) {
    return undefined;
  }
  return { profileId, ref: { kind: kind as ObjectKind, schema, name } };
}

/**
 * The context object a command expects, built for a caller that has no row to
 * right-click. The details panel and the palette both use it, so one shape is
 * checked in one place however a command was invoked.
 */
export function contextOf(target: ObjectTarget): Record<string, string> {
  return {
    connectionId: target.profileId,
    objectKind: target.ref.kind,
    objectSchema: target.ref.schema,
    objectName: target.ref.name
  };
}

export class ObjectCommands {
  constructor(
    private readonly store: ConnectionStore,
    private readonly catalog: CatalogService,
    private readonly files: QueryFileSystem,
    private readonly output: vscode.LogOutputChannel
  ) {}

  register(): vscode.Disposable[] {
    const on = (id: string, run: (target: ObjectTarget) => Promise<void>) =>
      vscode.commands.registerCommand(id, async (input?: unknown) => {
        const target = objectTarget(input);
        if (!target) {
          void vscode.window.showInformationMessage('Right-click an object in the explorer to use this.');
          return;
        }
        try {
          await run(target);
        } catch (error) {
          const message = errorMessage(error);
          this.output.error(`${id}: ${message}`);
          void vscode.window.showErrorMessage(message);
        }
      });

    return [
      on('databaseTools.openDefinition', (t) => this.openDefinition(t, false)),
      on('databaseTools.scriptAsAlter', (t) => this.openDefinition(t, true)),
      on('databaseTools.generateCrud', (t) => this.generateCrud(t)),
      on('databaseTools.scriptExecute', (t) => this.scriptExecute(t)),
      on('databaseTools.copyObjectName', (t) => this.copy(t, false)),
      on('databaseTools.copyObjectFullName', (t) => this.copy(t, true)),
      on('databaseTools.addObjectFavourite', (t) =>
        this.store.setObjectFavourite(t.profileId, t.ref, true)
      ),
      on('databaseTools.removeObjectFavourite', (t) =>
        this.store.setObjectFavourite(t.profileId, t.ref, false)
      )
    ];
  }

  /* ------------------------------------------------------------- actions */

  private async openDefinition(target: ObjectTarget, asAlter: boolean): Promise<void> {
    const source = await this.catalog.definition(target.profileId, target.ref);
    const text = asAlter ? toAlter(source) : source;
    await this.show(target, text, asAlter ? `Alter ${target.ref.name}` : target.ref.name);
  }

  /**
   * The four statements, against the columns the table actually has. The
   * generator refuses a table it cannot read, because a scaffold with no
   * columns in it is a scaffold that gets deleted rather than edited.
   */
  private async generateCrud(target: ObjectTarget): Promise<void> {
    const columns = await this.catalog.members(target.profileId, target.ref);
    if (columns.length === 0) {
      throw new Error(`${target.ref.schema}.${target.ref.name} has no columns to script.`);
    }
    await this.show(target, crudScript(this.driverOf(target.profileId), target.ref, columns), `${target.ref.name} CRUD`);
  }

  /** An `EXEC` or `CALL` with one line per parameter, to edit before running. */
  private async scriptExecute(target: ObjectTarget): Promise<void> {
    const parameters = await this.catalog.members(target.profileId, target.ref);
    await this.show(
      target,
      executeScript(this.driverOf(target.profileId), target.ref, parameters),
      `Execute ${target.ref.name}`
    );
  }

  /**
   * Copy Name gives the bare name and Copy Full Name gives the qualified,
   * quoted one.
   *
   * Two commands rather than one with a modifier, because they are used in
   * different places: the bare name goes into prose, a column alias or a
   * search box, and the qualified one goes into a statement, where the quoting
   * is the whole point.
   */
  private async copy(target: ObjectTarget, full: boolean): Promise<void> {
    const text = full ? qualified(this.driverOf(target.profileId), target.ref) : target.ref.name;
    await vscode.env.clipboard.writeText(text);
  }

  private async show(target: ObjectTarget, content: string, name: string): Promise<void> {
    await this.files.openScratch(target.profileId, name, content);
    this.output.info(`${name}: ${KINDS[target.ref.kind].singular} ${target.ref.schema}.${target.ref.name}`);
  }

  private driverOf(profileId: string): DriverKind {
    return this.store.get(profileId)?.driver ?? 'mssql';
  }
}

/**
 * `CREATE PROCEDURE` becomes `ALTER PROCEDURE`, and nothing else moves.
 *
 * The replacement is anchored to the first statement keyword rather than
 * applied globally, because a procedure body legitimately contains the word
 * `CREATE` — a temporary table, an index, a cursor — and rewriting those would
 * turn a script that alters one procedure into a script that fails on its
 * fourth line. `CREATE OR ALTER`, which is what SQL Server 2016 and later
 * generate, collapses to `ALTER` rather than growing to `ALTER OR ALTER`.
 *
 * PostgreSQL has no `ALTER FUNCTION ... AS`: the way to change a body there is
 * `CREATE OR REPLACE`, which is exactly what `pg_get_functiondef` already
 * returns, so its output is passed through untouched.
 */
function toAlter(source: string): string {
  if (/^\s*CREATE\s+OR\s+REPLACE\b/i.test(source)) {
    return source;
  }
  return source.replace(/^(\s*)CREATE(\s+OR\s+ALTER)?(\s)/i, '$1ALTER$3');
}
