import * as vscode from 'vscode';
import { BindingStore, OBJECT_SCHEME, objectAddress } from '../bindingStore';
import { ConnectionStore } from '../../store/connectionStore';
import { DbMember, DbObject, KINDS, ObjectKind } from '../../shared/catalog';
import { fuzzy } from '../../shared/fuzzy';
import { DriverKind, switchesDatabase } from '../../types';
import { Indexed, MetadataIndex } from './index';
import { Clause, RoutineCall, SqlContext, analyse, strip } from './context';
import { aliasFor } from './alias';
import { InsertHighlightProvider } from './insertHighlight';
import {
  ArgumentMode,
  argumentText,
  callText,
  declaration,
  declaredVariables,
  isOutput,
  parameterNote,
  parameterText,
  parametersOf,
  signatureText
} from './routineCall';

/** Writes a procedure's arguments after its name has been accepted. */
const EXPAND_CALL = 'databaseTools.completeRoutineCall';

/** Everything the expansion needs to find a procedure again once it is accepted. */
interface RoutineTarget {
  uri: string;
  profileId: string;
  database?: string;
  driver: DriverKind;
  schema: string;
  name: string;
}

/**
 * Keywords, per engine.
 *
 * They rank last, always, because a person who has typed three characters into
 * a `SELECT` list means a column far more often than they mean `SELECT`. They
 * are here at all because a SQL editor with no keyword completion feels broken
 * in a way that has nothing to do with whether anybody uses it.
 */
const COMMON = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'INSERT INTO', 'UPDATE', 'DELETE FROM',
  'VALUES', 'SET', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON',
  'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'UNION', 'UNION ALL', 'WITH', 'OVER', 'PARTITION BY', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ASC', 'DESC', 'CREATE', 'ALTER', 'DROP', 'BEGIN',
  'COMMIT', 'ROLLBACK'
];

const MSSQL_ONLY = [
  'TOP', 'ISNULL', 'GETDATE', 'NEWID', 'IDENTITY', 'OUTPUT', 'MERGE', 'APPLY', 'NOLOCK', 'OFFSET',
  'FETCH NEXT', 'EXEC',
  // `USE` earns its place on a list that is otherwise about writing queries,
  // because it is the only keyword here that changes what every keyword after
  // it means — and because typing it is how most people discover that this
  // editor follows them into the other database.
  'USE'
];
const POSTGRES_ONLY = ['LIMIT', 'OFFSET', 'ILIKE', 'RETURNING', 'ON CONFLICT', 'NOW()', 'COALESCE', 'ARRAY', 'JSONB_AGG', 'GENERATE_SERIES', 'CALL'];

/**
 * What a keyword leaves behind it.
 *
 * Accepting `SELECT` and then reaching for the space bar is a keystroke the
 * editor already knows is coming, so the space comes with the word. The two
 * exceptions are the words that end a phrase rather than open one, and the
 * words that are functions wearing a keyword's clothes — a space after
 * `COUNT` produces `COUNT (`, which is legal and which nobody writes.
 */
const TERMINAL = new Set(['END', 'ASC', 'DESC', 'IS NULL', 'IS NOT NULL', 'IDENTITY', 'NOLOCK']);
const CALLS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ISNULL', 'JSONB_AGG', 'GENERATE_SERIES'
]);
const NILADIC = new Set(['GETDATE', 'NEWID', 'NOW()']);

/** Re-open the list after an accepted item, as typing the space would have. */
const RESUGGEST: vscode.Command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

/**
 * Ranking bands.
 *
 * VS Code sorts by `sortText` lexically, so the band goes first and the fuzzy
 * score, inverted and padded, goes second. The bands are the whole ranking
 * design: what the caret is inside decides which band a candidate lands in,
 * and the matcher only orders within a band.
 */
const BAND = {
  predicate: '0',
  alias: '1',
  column: '2',
  object: '3',
  schema: '4',
  /**
   * Databases sit in their own band above objects.
   *
   * They are only ever offered where nothing else can go — after `USE` — so
   * the band never competes with anything. It exists so the current database
   * can be pinned to the top of that list without borrowing a band that means
   * something else.
   */
  database: '3',
  keyword: '9'
};

/** Which of the two typing shortcuts are switched on, read once per list. */
interface Prefs {
  space: boolean;
  alias: boolean;
}

function argumentMode(document: vscode.TextDocument): ArgumentMode {
  return vscode.workspace
    .getConfiguration('databaseTools', document)
    .get<ArgumentMode>('completion.procedureArguments', 'required');
}

function prefsFor(document: vscode.TextDocument): Prefs {
  const config = vscode.workspace.getConfiguration('databaseTools', document);
  return {
    space: config.get<boolean>('completion.keywordSpace', true),
    alias: config.get<boolean>('completion.tableAlias', true)
  };
}

/** The kinds that take a bare alias. A table-valued function needs its arguments first. */
const ALIASABLE = new Set<ObjectKind>(['table', 'view', 'synonym']);

export class SqlLanguageProviders implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** The procedure behind each procedure row, for the documentation pane. */
  private readonly routineItems = new WeakMap<vscode.CompletionItem, RoutineTarget>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly bindings: BindingStore,
    private readonly index: MetadataIndex
  ) {}

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  register(): vscode.Disposable[] {
    const selector: vscode.DocumentSelector = { language: 'sql' };
    return [
      vscode.languages.registerCompletionItemProvider(
        selector,
        {
          provideCompletionItems: (d, p, _t, c) => this.complete(d, p, c),
          resolveCompletionItem: (item) => this.resolveItem(item)
        },
        // A dot is the main trigger character. Space was one too, which meant
        // every space in the file opened the list with something preselected,
        // so Enter — meant for a new line — accepted a table instead. Typing a
        // letter still opens the list through `editor.quickSuggestions`.
        '.',
        // `@` opens a procedure's remaining parameters inside an `EXEC`, and
        // answers nothing anywhere else. It is not a word character to the
        // editor, so without this the list would wait for the letter after it.
        '@'
      ),
      vscode.commands.registerCommand(EXPAND_CALL, (target: RoutineTarget) => this.expandCall(target)),
      vscode.languages.registerHoverProvider(selector, {
        provideHover: (d, p) => this.hover(d, p)
      }),
      vscode.languages.registerSignatureHelpProvider(
        selector,
        { provideSignatureHelp: (d, p) => this.signature(d, p) },
        '(',
        ',',
        ' '
      ),
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (d, p) => this.definition(d, p)
      }),
      // Textual, so it does not wait for a binding: pairing a column with its
      // value needs the statement and nothing from the server.
      vscode.languages.registerDocumentHighlightProvider(selector, new InsertHighlightProvider())
    ];
  }

  /* ------------------------------------------------------------ completion */

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    completion?: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    const profileId = this.bindings.get(document.uri);
    const profile = profileId ? this.store.get(profileId) : undefined;
    if (!profileId || !profile) {
      // An unbound `.sql` file belongs to whatever else the user has installed.
      // Offering nothing is what lets this compose rather than compete.
      return undefined;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);
    const context = analyse(text, offset);
    // Where this tab is, which is not always where its connection is. Every
    // read below is scoped by it, so a file that has run `USE Reporting` is
    // completed out of Reporting and the file beside it is not.
    const database = this.databaseOf(document);

    if (completion?.triggerCharacter === '@' && context.routine?.slot !== 'argument') {
      // An `@` outside a call is a variable being written, which this has no
      // list for — and the editor's own words from the document are the
      // better answer there.
      return undefined;
    }

    if (context.wantsDatabase && switchesDatabase(profile.driver)) {
      return this.databases(document, context, profileId, database);
    }

    const index = await this.index.build(profileId, database);
    if (!index) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [];
    const prefs = prefsFor(document);

    if (context.wantsRoutine) {
      // Only procedures go after `EXEC` and `CALL`. Keywords, columns and
      // tables would all be a list of things that cannot be written there.
      this.routines(items, document, index, context, profileId, profile.driver, database);
      return items;
    }

    if (context.routine?.slot === 'argument') {
      const parameters = await this.parameters(document, index, context, context.routine, profileId, profile.driver, database);
      if (parameters.length > 0 || completion?.triggerCharacter === '@') {
        return parameters;
      }
    }

    if (context.qualifier) {
      await this.qualified(items, profileId, index, context, profile.driver, prefs, database);
      // A qualified name is unambiguous. Offering keywords after a dot would
      // put `SELECT` in a list where only a column or an object can go.
      return items;
    }

    if (context.clause === 'on') {
      this.predicates(items, index, context);
    }

    if (context.wantsObject) {
      this.schemas(items, index, context);
      this.objects(items, index, context, profile.driver, prefs);
    } else {
      await this.columnsInScope(items, profileId, context, profile.driver, database);
      this.aliases(items, context);
      this.objects(items, index, context, profile.driver, prefs);
    }

    this.keywords(items, context, profile.driver, prefs);
    return items;
  }

  /** The database a document is in, or undefined for the connection's own. */
  private databaseOf(document: vscode.TextDocument): string | undefined {
    return this.bindings.database(document.uri);
  }

  /**
   * The list behind `USE `.
   *
   * The one the tab is already in is pinned to the top and says so, because
   * the most common reason to open this list is to check where you are before
   * deciding whether to move — and a list of forty database names in which
   * yours is somewhere alphabetical does not answer that.
   *
   * The insertion replaces the whole half-typed name rather than the word the
   * editor found. `USE [Peo` leaves the bracket outside VS Code's own word
   * range, so an item inserted into that range would produce `USE [[Peopl...`.
   */
  private async databases(
    document: vscode.TextDocument,
    context: SqlContext,
    profileId: string,
    current: string | undefined
  ): Promise<vscode.CompletionItem[]> {
    const names = await this.index.databases(profileId);
    const range =
      context.prefixStart !== undefined
        ? new vscode.Range(document.positionAt(context.prefixStart), document.positionAt(context.prefixStart + context.prefix.length))
        : undefined;
    const typed = strip(context.prefix);

    return names
      .filter((name) => !typed || fuzzy(name, typed))
      .map((name) => {
        const here = Boolean(current) && name.toLowerCase() === (current ?? '').toLowerCase();
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Folder);
        item.label = { label: name, description: here ? 'current' : 'database' };
        item.detail = here ? 'the database this tab is already in' : 'database';
        item.filterText = name;
        // The pinned entry takes a band of its own so it survives the matcher:
        // it has to stay first even when what has been typed scores it lower.
        item.sortText = here ? `${BAND.predicate}0` : `${BAND.database}${rank(name, typed)}`;
        item.insertText = quote('mssql', name);
        if (range) {
          item.range = range;
        }
        return item;
      });
  }

  /**
   * The procedures behind `EXEC ` and `CALL `, each of which writes its own
   * arguments when it is accepted.
   *
   * The arguments are written by a command that runs after the name lands,
   * not by the item's own text, because the item's text has to be decided
   * before anybody has chosen it — and reading the parameters of every
   * procedure in the list to build it would be a round trip per row.
   */
  private routines(
    items: vscode.CompletionItem[],
    document: vscode.TextDocument,
    index: Indexed,
    context: SqlContext,
    profileId: string,
    driver: DriverKind,
    database: string | undefined
  ): void {
    const qualifier = context.qualifier?.toLowerCase();
    if (qualifier === undefined) {
      this.schemas(items, index, context);
    }
    const mode = argumentMode(document);
    for (const object of index.objects) {
      if (object.kind !== 'procedure') {
        continue;
      }
      if (qualifier !== undefined && object.schema.toLowerCase() !== qualifier) {
        continue;
      }
      if (context.prefix && !fuzzy(object.name, context.prefix)) {
        continue;
      }
      // SQL Server resolves an unqualified procedure against the caller's
      // default schema before `dbo`, which is both a plan-cache miss and a way
      // to call the wrong procedure. A call says `dbo.` even when it could
      // leave it out. PostgreSQL has a search path, and `public` is on it.
      const qualify =
        qualifier === undefined &&
        (driver === 'mssql' || (index.schemas.size > 1 && object.schema !== defaultSchema(driver)));
      const item = objectItem(object.kind, object.schema, object.name, object.detail, driver, qualify);
      item.sortText = `${BAND.object}${rank(object.name, context.prefix)}`;
      const target: RoutineTarget = {
        uri: document.uri.toString(),
        profileId,
        database,
        driver,
        schema: object.schema,
        name: object.name
      };
      if (mode !== 'none') {
        item.command = { command: EXPAND_CALL, title: 'Write the arguments', arguments: [target] };
      }
      this.routineItems.set(item, target);
      items.push(item);
    }
  }

  /**
   * A procedure's full signature, in the pane beside its row.
   *
   * Read when the row is focused rather than when the list is built, so an
   * arrow key down a list of three hundred procedures reads the parameters of
   * the ones actually looked at. The read is cached, which also means the
   * accepted procedure's arguments are usually written without a round trip.
   */
  private async resolveItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
    const target = this.routineItems.get(item);
    if (!target) {
      return item;
    }
    const members = await this.index.columnsOf(target.profileId, target.schema, target.name, target.database);
    const markdown = new vscode.MarkdownString();
    describeRoutine(markdown, target.driver, `${target.schema}.${target.name}`, members);
    item.documentation = markdown;
    return item;
  }

  /**
   * The parameters not yet given an argument, where the next argument begins.
   *
   * Required ones rank above optional ones, and each keeps its declared order
   * within that, so the first row is always the next thing the call cannot run
   * without.
   */
  private async parameters(
    document: vscode.TextDocument,
    index: Indexed,
    context: SqlContext,
    call: RoutineCall,
    profileId: string,
    driver: DriverKind,
    database: string | undefined
  ): Promise<vscode.CompletionItem[]> {
    // PostgreSQL's arguments live inside parentheses, and before the `(` is
    // typed there is nowhere for one to go.
    if (driver === 'postgres' && !call.parenthesised) {
      return [];
    }
    const object = resolveRoutine(index, call.schema, call.name);
    if (!object) {
      return [];
    }
    const parameters = parametersOf(await this.index.columnsOf(profileId, object.schema, object.name, database));
    const named = new Set(call.named);
    // Positional arguments come first in both engines, so everything before
    // the first named one has been passed by position.
    const positional = call.argument - call.named.length;
    const remaining = parameters.filter(
      (parameter, i) => i >= positional && parameter.name && !named.has(parameter.name.toLowerCase())
    );
    if (remaining.length === 0) {
      return [];
    }

    const range =
      context.prefixStart !== undefined
        ? new vscode.Range(
            document.positionAt(context.prefixStart),
            document.positionAt(context.prefixStart + context.prefix.length)
          )
        : undefined;
    const text = document.getText();
    const declared = driver === 'mssql' ? declaredVariables(text) : new Set<string>();
    const callLine = context.callStart !== undefined ? document.positionAt(context.callStart).line : undefined;
    const first = remaining.find((parameter) => parameter.default === undefined) ?? remaining[0];

    return remaining.map((parameter) => {
      const item = new vscode.CompletionItem(parameter.name, vscode.CompletionItemKind.Property);
      item.label = {
        label: parameter.name,
        detail: `  ${parameter.type}`,
        description: parameterNote(driver, parameter)
      };
      item.detail = parameterText(driver, parameter);
      // The name, `@` and all: `@` is not part of the editor's word, so the
      // range below is what lets `@Cu` be replaced rather than doubled.
      item.filterText = parameter.name;
      item.insertText = new vscode.SnippetString(argumentText(driver, parameter, 1));
      const order = String(parameters.indexOf(parameter)).padStart(3, '0');
      item.sortText = `${BAND.predicate}${parameter.default === undefined ? 0 : 1}${order}`;
      item.preselect = parameter === first;
      if (range) {
        item.range = range;
      }
      if (driver === 'mssql' && isOutput(parameter) && callLine !== undefined && !declared.has(parameter.name.toLowerCase())) {
        const indent = /^\s*/.exec(document.lineAt(callLine).text)?.[0] ?? '';
        item.additionalTextEdits = [
          vscode.TextEdit.insert(new vscode.Position(callLine, 0), `${indent}${declaration(parameter)}\n`)
        ];
      }
      return item;
    });
  }

  /**
   * Writes an accepted procedure's arguments after its name.
   *
   * It gives way to anything that happened in the meantime. A keystroke typed
   * while the parameters were being read, a name accepted in front of an
   * argument list that is already there, a caret that has moved to another
   * editor: each of those is somebody doing something else, and text inserted
   * over the top of it would be text they then have to delete.
   */
  private async expandCall(target: RoutineTarget): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== target.uri) {
      return;
    }
    const document = editor.document;
    const version = document.version;
    const members = await this.index.columnsOf(target.profileId, target.schema, target.name, target.database);
    if (vscode.window.activeTextEditor !== editor || document.version !== version || !editor.selection.isEmpty) {
      return;
    }

    const position = editor.selection.active;
    const rest = document.lineAt(position.line).text.slice(position.character).trim();
    if (rest && !rest.startsWith(';')) {
      return;
    }
    const next = position.line + 1 < document.lineCount ? document.lineAt(position.line + 1).text.trim() : '';
    if (/^[@(,]/.test(next)) {
      // A multi-line call whose name was just swapped for another.
      return;
    }

    const text = document.getText();
    const call = callText(target.driver, members, argumentMode(document), declaredVariables(text));
    if (!call.snippet) {
      return;
    }

    const start = analyse(text, document.offsetAt(position)).callStart;
    if (call.declarations.length > 0 && start !== undefined) {
      const line = document.positionAt(start).line;
      const indent = /^\s*/.exec(document.lineAt(line).text)?.[0] ?? '';
      await editor.edit(
        (builder) =>
          builder.insert(
            new vscode.Position(line, 0),
            call.declarations.map((statement) => `${indent}${statement}\n`).join('')
          ),
        { undoStopBefore: false, undoStopAfter: false }
      );
    }

    await editor.insertSnippet(new vscode.SnippetString(call.snippet), editor.selection.active, {
      undoStopBefore: false,
      undoStopAfter: true
    });
    void vscode.commands.executeCommand('editor.action.triggerParameterHints');
  }

  /** After `c.` or after `dbo.`: columns of that alias, or objects in that schema. */
  private async qualified(
    items: vscode.CompletionItem[],
    profileId: string,
    index: Indexed,
    context: SqlContext,
    driver: DriverKind,
    prefs: Prefs,
    database: string | undefined
  ): Promise<void> {
    const qualifier = context.qualifier ?? '';
    const relation = context.relations.find((r) => r.as.toLowerCase() === qualifier.toLowerCase());

    if (relation) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name, database);
      for (const column of columns) {
        items.push(columnItem(column, BAND.column, context.prefix));
      }
      return;
    }

    if (index.schemas.has(qualifier) || [...index.schemas].some((s) => s.toLowerCase() === qualifier.toLowerCase())) {
      for (const object of index.objects) {
        if (object.schema.toLowerCase() !== qualifier.toLowerCase()) {
          continue;
        }
        const item = objectItem(
          object.kind,
          object.schema,
          object.name,
          object.detail,
          driver,
          false,
          aliasWanted(object.kind, context, prefs) ? aliasFor(object.name, aliasesInScope(context)) : undefined
        );
        item.sortText = `${BAND.object}${rank(object.name, context.prefix)}`;
        items.push(item);
      }
      return;
    }

    // A qualifier that is neither an alias in scope nor a schema is most often
    // a table named without one. Its columns are still what was meant.
    const columns = await this.index.columnsOf(profileId, '', qualifier, database);
    for (const column of columns) {
      items.push(columnItem(column, BAND.column, context.prefix));
    }
  }

  /**
   * The join predicate, ranked first.
   *
   * This is the one that wins people over: after `ON`, when the two relations
   * in scope have a foreign key between them, the first item is the whole
   * predicate rather than a list of columns to assemble it from.
   */
  private predicates(items: vscode.CompletionItem[], index: Indexed, context: SqlContext): void {
    const relations = context.relations;
    if (relations.length < 2) {
      return;
    }
    const right = relations[relations.length - 1];
    for (let i = relations.length - 2; i >= 0; i--) {
      const predicate = this.index.joinPredicate(index, relations[i], right);
      if (!predicate) {
        continue;
      }
      const item = new vscode.CompletionItem(predicate, vscode.CompletionItemKind.Snippet);
      item.label = { label: predicate, description: 'foreign key' };
      item.filterText = predicate;
      item.detail = 'foreign key';
      item.documentation = new vscode.MarkdownString(
        `The declared relationship between \`${relations[i].name}\` and \`${right.name}\`.`
      );
      item.sortText = `${BAND.predicate}0`;
      item.preselect = true;
      items.push(item);
      return;
    }
  }

  private async columnsInScope(
    items: vscode.CompletionItem[],
    profileId: string,
    context: SqlContext,
    driver: DriverKind,
    database: string | undefined
  ): Promise<void> {
    // Only the relations actually named in this statement. Offering every
    // column in the database would be a list nobody can read, ranked by a
    // matcher that has no way to prefer the right one.
    const qualify = context.relations.length > 1;
    for (const relation of context.relations.slice(0, 8)) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name, database);
      for (const column of columns) {
        // With more than one relation in scope the row has to say which table
        // it came from, because two of them will have an `id` and the name on
        // its own cannot tell you which one you are about to write.
        const item = columnItem(column, BAND.column, context.prefix, qualify ? relation.as : undefined);
        if (qualify) {
          item.insertText = `${relation.as}.${quote(driver, column.name)}`;
        }
        items.push(item);
      }
    }
  }

  private aliases(items: vscode.CompletionItem[], context: SqlContext): void {
    for (const relation of context.relations) {
      if (relation.as === relation.name) {
        continue;
      }
      const target = `${relation.schema ? `${relation.schema}.` : ''}${relation.name}`;
      const item = new vscode.CompletionItem(relation.as, vscode.CompletionItemKind.Variable);
      item.label = { label: relation.as, description: target };
      item.detail = `alias for ${target}`;
      item.filterText = relation.as;
      item.sortText = `${BAND.alias}${rank(relation.as, context.prefix)}`;
      items.push(item);
    }
  }

  private schemas(items: vscode.CompletionItem[], index: Indexed, context: SqlContext): void {
    const counts = new Map<string, number>();
    for (const object of index.objects) {
      counts.set(object.schema, (counts.get(object.schema) ?? 0) + 1);
    }
    for (const schema of index.schemas) {
      const count = counts.get(schema) ?? 0;
      const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
      // The word `schema` is what the icon already says. How much is in it is
      // the thing that tells an empty schema from the one being looked for.
      item.label = { label: schema, description: count === 1 ? '1 object' : `${count} objects` };
      item.detail = 'schema';
      item.filterText = schema;
      item.sortText = `${BAND.schema}${rank(schema, context.prefix)}`;
      items.push(item);
    }
  }

  private objects(
    items: vscode.CompletionItem[],
    index: Indexed,
    context: SqlContext,
    driver: DriverKind,
    prefs: Prefs
  ): void {
    const wanted = kindsForClause(context.clause);
    // The relations already named in this statement own their names, so a
    // fresh alias has to step around them — that is what makes a self-join
    // come out as `mas` and `mas2` rather than `mas` twice.
    const taken = aliasesInScope(context);
    for (const object of index.objects) {
      if (wanted && !wanted.has(object.kind)) {
        continue;
      }
      if (context.prefix && !fuzzy(object.name, context.prefix)) {
        continue;
      }
      const qualify = index.schemas.size > 1 && object.schema !== defaultSchema(driver);
      const item = objectItem(
        object.kind,
        object.schema,
        object.name,
        object.detail,
        driver,
        qualify,
        aliasWanted(object.kind, context, prefs) ? aliasFor(object.name, taken) : undefined
      );
      item.sortText = `${BAND.object}${rank(object.name, context.prefix)}`;
      items.push(item);
    }
  }

  private keywords(
    items: vscode.CompletionItem[],
    context: SqlContext,
    driver: DriverKind,
    prefs: Prefs
  ): void {
    // A set, because `COALESCE` is both common and Postgres-flavoured and the
    // list should not say so twice.
    const words = new Set([...COMMON, ...(driver === 'mssql' ? MSSQL_ONLY : POSTGRES_ONLY)]);
    for (const word of words) {
      if (context.prefix && !fuzzy(word, context.prefix)) {
        continue;
      }
      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
      item.sortText = `${BAND.keyword}${keywordTier(word, context)}${rank(word, context.prefix)}`;
      if (prefs.space) {
        const insert = follow(word);
        item.insertText = insert;
        if (insert !== word && !NILADIC.has(word)) {
          item.command = RESUGGEST;
        }
      }
      items.push(item);
    }
  }

  /* ----------------------------------------------------------------- hover */

  private async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const profileId = this.bindings.get(document.uri);
    if (!profileId) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_@#$]*|\[[^\]]+\]|"[^"]+"/);
    if (!range) {
      return undefined;
    }
    const database = this.databaseOf(document);
    const word = strip(document.getText(range));
    const index = this.index.peek(profileId, database);
    if (!index) {
      return undefined;
    }

    const object = this.index.resolve(index, undefined, word);
    if (object) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${object.schema}.${object.name}**\n\n`);
      markdown.appendMarkdown(`${KINDS[object.kind].singular} · ${object.detail}`);
      const profile = this.store.get(profileId);
      if (profile && (object.kind === 'procedure' || object.kind === 'function')) {
        const members = await this.index.columnsOf(profileId, object.schema, object.name, database);
        markdown.appendMarkdown('\n\n');
        describeRoutine(markdown, profile.driver, `${object.schema}.${object.name}`, members);
      }
      return new vscode.Hover(markdown, range);
    }

    const context = analyse(document.getText(), document.offsetAt(position));
    for (const relation of context.relations) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name, database);
      const column = columns.find((candidate) => candidate.name.toLowerCase() === word.toLowerCase());
      if (column) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${column.name}** \`${column.type}\`\n\n`);
        const notes = [
          column.key ? 'primary key' : undefined,
          column.ref ? 'foreign key' : undefined,
          column.auto ? 'supplied by the server' : undefined,
          column.nullable === false ? 'not null' : undefined
        ].filter(Boolean);
        markdown.appendMarkdown(`${relation.schema ? `${relation.schema}.` : ''}${relation.name}${
          notes.length ? ` · ${notes.join(' · ')}` : ''
        }`);
        return new vscode.Hover(markdown, range);
      }
    }
    return undefined;
  }

  /* -------------------------------------------------------- signature help */

  private async signature(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.SignatureHelp | undefined> {
    const profileId = this.bindings.get(document.uri);
    const profile = profileId ? this.store.get(profileId) : undefined;
    if (!profileId || !profile) {
      return undefined;
    }
    const call = analyse(document.getText(), document.offsetAt(position)).routine;
    if (!call || (profile.driver === 'postgres' && !call.parenthesised)) {
      return undefined;
    }
    const database = this.databaseOf(document);
    const index = await this.index.build(profileId, database);
    if (!index) {
      return undefined;
    }
    const object = resolveRoutine(index, call.schema, call.name);
    if (!object) {
      return undefined;
    }
    const members = await this.index.columnsOf(profileId, object.schema, object.name, database);
    const parameters = parametersOf(members);

    // Offsets into the label rather than repeated text, so two parameters of
    // the same type are never highlighted as each other.
    const text = signatureText(profile.driver, `${object.schema}.${object.name}`, members);
    const signature = new vscode.SignatureInformation(text.label);
    signature.parameters = parameters.map(
      (parameter, i) => new vscode.ParameterInformation(text.spans[i], parameterNote(profile.driver, parameter))
    );
    if (parameters.length === 0) {
      signature.documentation = 'Takes no parameters.';
    }
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = activeParameter(parameters, call);
    return help;
  }

  /* ------------------------------------------------------------ definition */

  private async definition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | undefined> {
    const profileId = this.bindings.get(document.uri);
    if (!profileId) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_@#$]*|\[[^\]]+\]|"[^"]+"/);
    if (!range) {
      return undefined;
    }
    const database = this.databaseOf(document);
    const index = await this.index.build(profileId, database);
    if (!index) {
      return undefined;
    }
    const object = this.index.resolve(index, undefined, strip(document.getText(range)));
    if (!object) {
      return undefined;
    }
    // The scripted definition, read-only, at `dbobj:` — resolved lazily by its
    // content provider, so this costs nothing until somebody presses F12. The
    // database goes with it, or F12 in a tab that has moved would script the
    // object of the same name back in the connection's own database.
    const uri = database
      ? objectAddress(OBJECT_SCHEME, profileId, object).with({ query: `db=${encodeURIComponent(database)}` })
      : objectAddress(OBJECT_SCHEME, profileId, object);
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}

/* ------------------------------------------------------------------ helpers */

function kindsForClause(clause: Clause): Set<ObjectKind> | null {
  if (clause === 'from' || clause === 'join') {
    return new Set<ObjectKind>(['table', 'view', 'function', 'synonym']);
  }
  if (clause === 'insert') {
    return new Set<ObjectKind>(['table', 'view']);
  }
  if (clause === 'exec') {
    return new Set<ObjectKind>(['procedure', 'function']);
  }
  return null;
}

/** A procedure or function by name, never the table that happens to share it. */
function resolveRoutine(index: Indexed, schema: string | undefined, name: string): DbObject | undefined {
  const lower = name.toLowerCase();
  return index.objects.find(
    (object) =>
      (object.kind === 'procedure' || object.kind === 'function') &&
      object.name.toLowerCase() === lower &&
      (!schema || object.schema.toLowerCase() === schema.toLowerCase())
  );
}

/**
 * The parameter signature help highlights.
 *
 * By name first, because that is how SQL Server calls are written and the
 * written order need not be the declared one. Then, at the start of an
 * argument in a call that has named some already, the first one still owed.
 * Then by position, which is all a positional call has.
 */
function activeParameter(parameters: DbMember[], call: RoutineCall): number {
  const at = (name: string) => parameters.findIndex((parameter) => parameter.name.toLowerCase() === name);
  if (call.current) {
    const i = at(call.current);
    if (i >= 0) {
      return i;
    }
  }
  if (call.named.length > 0 && call.slot === 'argument') {
    const i = parameters.findIndex((parameter) => !call.named.includes(parameter.name.toLowerCase()));
    if (i >= 0) {
      return i;
    }
  }
  return Math.max(0, Math.min(call.argument, parameters.length - 1));
}

/**
 * A routine's signature and a line per parameter, for hover and the
 * completion list's documentation pane alike.
 */
function describeRoutine(
  markdown: vscode.MarkdownString,
  driver: DriverKind,
  qualifiedName: string,
  members: DbMember[]
): void {
  const parameters = parametersOf(members);
  markdown.appendCodeblock(signatureText(driver, qualifiedName, members).label, 'sql');
  if (parameters.length === 0) {
    markdown.appendMarkdown('Takes no parameters.');
  } else {
    const required = parameters.filter((parameter) => parameter.default === undefined).length;
    markdown.appendMarkdown(
      `${parameters.length === 1 ? '1 parameter' : `${parameters.length} parameters`} · ${required} required\n\n`
    );
    for (const parameter of parameters) {
      markdown.appendMarkdown(`- \`${parameter.name || '(unnamed)'}\` \`${parameter.type}\` · `);
      markdown.appendText(parameterNote(driver, parameter));
      markdown.appendMarkdown('\n');
    }
  }
  const returns = members.find((member) => member.direction === 'returns');
  if (returns) {
    markdown.appendMarkdown(`\n\nReturns \`${returns.type}\``);
  }
}

function defaultSchema(driver: DriverKind): string {
  return driver === 'mssql' ? 'dbo' : 'public';
}

/** The names the statement has already spoken for. */
function aliasesInScope(context: SqlContext): string[] {
  return context.relations.map((relation) => relation.as);
}

/**
 * Whether this item should arrive with an alias attached.
 *
 * Only where an alias is what comes next: naming a relation in `FROM` or a
 * `JOIN`. `INSERT INTO` takes a target, not a correlation name, and nobody
 * aliases a table they are about to write a column list for.
 */
function aliasWanted(kind: ObjectKind, context: SqlContext, prefs: Prefs): boolean {
  return prefs.alias && ALIASABLE.has(kind) && (context.clause === 'from' || context.clause === 'join');
}

/**
 * Which keywords belong where the caret is, as a one-digit prefix inside the
 * keyword band.
 *
 * The matcher alone scores `WHEN` and `WHERE` the same for `whe`, and the
 * editor then breaks the tie alphabetically — so `WHEN`, which is only ever
 * legal inside a `CASE`, used to sit above the keyword nearly everybody meant.
 * Outside a `CASE` the `CASE` words step down; inside one they step up.
 */
const CASE_WORDS = new Set(['WHEN', 'THEN', 'ELSE', 'END']);

function keywordTier(word: string, context: SqlContext): string {
  if (context.inCase) {
    return CASE_WORDS.has(word) ? '0' : '1';
  }
  if (CASE_WORDS.has(word)) {
    return '2';
  }
  return word === 'WHERE' ? '0' : '1';
}

/** What goes in after a keyword, so the space bar is one less thing to press. */
function follow(word: string): string {
  if (CALLS.has(word)) {
    return `${word}(`;
  }
  if (NILADIC.has(word)) {
    return word.endsWith('()') ? word : `${word}()`;
  }
  if (TERMINAL.has(word)) {
    return word;
  }
  return `${word} `;
}

const KIND_ICONS: Record<ObjectKind, vscode.CompletionItemKind> = {
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  procedure: vscode.CompletionItemKind.Method,
  function: vscode.CompletionItemKind.Function,
  trigger: vscode.CompletionItemKind.Event,
  sequence: vscode.CompletionItemKind.Value,
  type: vscode.CompletionItemKind.TypeParameter,
  synonym: vscode.CompletionItemKind.Reference
};

function objectItem(
  kind: ObjectKind,
  schema: string,
  name: string,
  detail: string,
  driver: DriverKind,
  qualify: boolean,
  alias?: string
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, KIND_ICONS[kind]);
  item.detail = `${KINDS[kind].singular} · ${schema}${detail ? ` · ${detail}` : ''}`;
  const target = qualify ? `${quote(driver, schema)}.${quote(driver, name)}` : quote(driver, name);
  item.insertText = alias ? `${target} ${alias} ` : target;
  // Everything the row has to say goes in the label. `CompletionItem.detail`
  // reaches only the pane beside the row the arrow keys happen to be on, so a
  // list read the way people read one — all of it at once — would carry
  // nothing but names. The alias is here for a second reason: text the editor
  // is about to write should be visible before it is accepted.
  item.label = {
    label: name,
    detail: alias ? `  ${alias}` : undefined,
    description: `${schema}${detail ? ` · ${detail}` : ''}`
  };
  // The filter is the bare name, so typing `cust` still finds a qualified
  // insertion — a filter that included the schema would need `dbo.cust` typed.
  item.filterText = name;
  return item;
}

/**
 * A column, saying what it is without being asked.
 *
 * The type sits against the name and the rest trails it, in the order a `CREATE
 * TABLE` would put them: `empId  int  NOT NULL · PK`. Nullability is spelled
 * the way the DDL spells it rather than as a badge, because `NULL` on a column
 * means something precise to anyone writing a predicate against it, and
 * finding out by hovering is finding out too late.
 *
 * `origin` is the alias the column will be written under, and it appears only
 * when more than one relation is in scope — the case where the bare name is
 * genuinely ambiguous.
 */
function columnItem(column: DbMember, band: string, prefix: string, origin?: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
  const notes = [
    column.nullable === false ? 'NOT NULL' : column.nullable === true ? 'NULL' : undefined,
    column.key ? 'PK' : undefined,
    column.ref ? 'FK' : undefined,
    column.auto ? 'auto' : undefined,
    origin
  ]
    .filter(Boolean)
    .join(' · ');
  item.label = { label: column.name, detail: `  ${column.type}`, description: notes || undefined };
  item.detail = notes ? `${column.type} · ${notes}` : column.type;
  item.filterText = column.name;
  item.sortText = `${band}${rank(column.name, prefix)}`;
  return item;
}

/**
 * A quoted identifier only where one is needed.
 *
 * Always-quoting is what makes generated SQL unreadable, and it is also what
 * makes it inconsistent with the SQL a person writes beside it. A name that is
 * a plain identifier and not a reserved word goes in bare.
 */
const RESERVED = new Set([
  'ORDER', 'USER', 'TABLE', 'SELECT', 'FROM', 'WHERE', 'GROUP', 'KEY', 'VALUES', 'INDEX', 'PRIMARY',
  'CHECK', 'DEFAULT', 'REFERENCES', 'CONSTRAINT', 'COLUMN', 'CASE', 'END', 'LEFT', 'RIGHT', 'FULL',
  'NATURAL', 'UNION', 'ALL', 'ANY', 'SOME', 'AUTHORIZATION', 'LIMIT', 'OFFSET'
]);

function quote(driver: DriverKind, name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase());
  if (plain && driver === 'mssql') {
    return name;
  }
  if (plain && driver === 'postgres' && name === name.toLowerCase()) {
    return name;
  }
  return driver === 'mssql' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}

/**
 * The explorer's own matcher, inverted into a lexical sort key.
 *
 * VS Code sorts `sortText` as a string, so a higher score has to become a
 * lower string. Five digits is enough for every score the matcher produces and
 * keeps the keys the same width, which is what makes the comparison stable.
 */
function rank(candidate: string, prefix: string): string {
  if (!prefix) {
    return candidate.toLowerCase();
  }
  const match = fuzzy(candidate, prefix);
  const score = match ? Math.max(0, Math.min(99999, match.score)) : 0;
  return String(99999 - score).padStart(5, '0');
}
