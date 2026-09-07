import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { crudScript, executeScript, qualified, selectTop } from '../catalog/script';
import { ConnectionStore } from '../store/connectionStore';
import { FavouriteRef, KINDS, ObjectKind, OBJECT_KINDS } from '../shared/catalog';
import { DriverKind } from '../types';

/** What `Select Top 100` means. The name is the number, so it is not a setting. */
const TOP = 100;

/**
 * The object row's half of the right-click menu.
 *
 * Every one of these ends in a SQL document rather than in a result grid,
 * because phase 2 has no execution engine: there is no place to put rows yet.
 * That is a real limit and these commands are shaped around it rather than
 * hiding it — each opens an untitled, editable document containing a statement
 * that is complete and correct for the object it came from, which the user runs
 * with whatever they already have. When the grid lands, `Execute` becomes a
 * verb rather than a scaffold, and none of the SQL below has to change.
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

export class ObjectCommands {
  constructor(
    private readonly store: ConnectionStore,
    private readonly catalog: CatalogService,
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
          const message = error instanceof Error ? error.message : String(error);
          this.output.error(`${id}: ${message}`);
          void vscode.window.showErrorMessage(message);
        }
      });

    return [
      on('databaseTools.openDefinition', (t) => this.openDefinition(t, false)),
      on('databaseTools.scriptAsAlter', (t) => this.openDefinition(t, true)),
      on('databaseTools.selectTop100', (t) => this.selectTop(t)),
      on('databaseTools.generateCrud', (t) => this.generateCrud(t)),
      on('databaseTools.executeObject', (t) => this.execute(t)),
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
    await this.show(target, text, asAlter ? 'alter' : 'definition');
  }

  private async selectTop(target: ObjectTarget): Promise<void> {
    const driver = this.driverOf(target.profileId);
    await this.show(target, selectTop(driver, target.ref, TOP), 'select');
  }

  private async generateCrud(target: ObjectTarget): Promise<void> {
    const driver = this.driverOf(target.profileId);
    const columns = await this.catalog.columns(target.profileId, target.ref);
    if (columns.length === 0) {
      throw new Error(`${target.ref.schema}.${target.ref.name} has no columns to script.`);
    }
    await this.show(target, crudScript(driver, target.ref, columns), 'crud');
  }

  private async execute(target: ObjectTarget): Promise<void> {
    const driver = this.driverOf(target.profileId);
    const parameters = await this.catalog.members(target.profileId, target.ref);
    await this.show(target, executeScript(driver, target.ref, parameters), 'execute');
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

  /**
   * Opens the statement in an untitled SQL document.
   *
   * Untitled and not a read-only virtual document, which was the other
   * candidate. A definition is most useful as a starting point — you read it,
   * you change three lines, you run it — and a read-only buffer turns that into
   * a copy, a paste and a new file. Nothing here is saved anywhere unless the
   * user saves it.
   */
  private async show(target: ObjectTarget, content: string, what: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document, { preview: true });
    this.output.info(
      `${what}: ${KINDS[target.ref.kind].singular} ${target.ref.schema}.${target.ref.name}`
    );
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
export function toAlter(source: string): string {
  if (/^\s*CREATE\s+OR\s+REPLACE\b/i.test(source)) {
    return source;
  }
  return source.replace(/^(\s*)CREATE(\s+OR\s+ALTER)?(\s)/i, '$1ALTER$3');
}
