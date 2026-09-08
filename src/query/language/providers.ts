import * as vscode from 'vscode';
import { BindingStore, OBJECT_SCHEME, objectAddress } from '../bindingStore';
import { ConnectionStore } from '../../store/connectionStore';
import { DbMember, KINDS, ObjectKind } from '../../shared/catalog';
import { fuzzy } from '../../shared/fuzzy';
import { DriverKind } from '../../types';
import { Indexed, MetadataIndex } from './index';
import { Clause, SqlContext, analyse, strip } from './context';

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

const MSSQL_ONLY = ['TOP', 'ISNULL', 'GETDATE', 'NEWID', 'IDENTITY', 'OUTPUT', 'MERGE', 'APPLY', 'NOLOCK', 'OFFSET', 'FETCH NEXT'];
const POSTGRES_ONLY = ['LIMIT', 'OFFSET', 'ILIKE', 'RETURNING', 'ON CONFLICT', 'NOW()', 'COALESCE', 'ARRAY', 'JSONB_AGG', 'GENERATE_SERIES'];

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
  column: '1',
  object: '2',
  schema: '3',
  alias: '4',
  keyword: '9'
};

export class SqlLanguageProviders implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

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
        { provideCompletionItems: (d, p) => this.complete(d, p) },
        '.',
        ' '
      ),
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
      })
    ];
  }

  /* ------------------------------------------------------------ completion */

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position
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
    const index = await this.index.build(profileId);
    if (!index) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [];

    if (context.qualifier) {
      await this.qualified(items, profileId, index, context, profile.driver);
      // A qualified name is unambiguous. Offering keywords after a dot would
      // put `SELECT` in a list where only a column or an object can go.
      return items;
    }

    if (context.clause === 'on') {
      this.predicates(items, index, context);
    }

    if (context.wantsObject) {
      this.schemas(items, index, context);
      this.objects(items, index, context, profile.driver);
    } else {
      await this.columnsInScope(items, profileId, context, profile.driver);
      this.aliases(items, context);
      this.objects(items, index, context, profile.driver);
    }

    this.keywords(items, context, profile.driver);
    return items;
  }

  /** After `c.` or after `dbo.`: columns of that alias, or objects in that schema. */
  private async qualified(
    items: vscode.CompletionItem[],
    profileId: string,
    index: Indexed,
    context: SqlContext,
    driver: DriverKind
  ): Promise<void> {
    const qualifier = context.qualifier ?? '';
    const relation = context.relations.find((r) => r.as.toLowerCase() === qualifier.toLowerCase());

    if (relation) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name);
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
        const item = objectItem(object.kind, object.schema, object.name, object.detail, driver, false);
        item.sortText = `${BAND.object}${rank(object.name, context.prefix)}`;
        items.push(item);
      }
      return;
    }

    // A qualifier that is neither an alias in scope nor a schema is most often
    // a table named without one. Its columns are still what was meant.
    const columns = await this.index.columnsOf(profileId, '', qualifier);
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
    driver: DriverKind
  ): Promise<void> {
    // Only the relations actually named in this statement. Offering every
    // column in the database would be a list nobody can read, ranked by a
    // matcher that has no way to prefer the right one.
    for (const relation of context.relations.slice(0, 8)) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name);
      const prefix = context.relations.length > 1 ? `${relation.as}.` : '';
      for (const column of columns) {
        const item = columnItem(column, BAND.column, context.prefix);
        if (prefix) {
          item.insertText = `${prefix}${quote(driver, column.name)}`;
          item.detail = `${column.type} · ${relation.as}`;
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
      const item = new vscode.CompletionItem(relation.as, vscode.CompletionItemKind.Variable);
      item.detail = `alias for ${relation.schema ? `${relation.schema}.` : ''}${relation.name}`;
      item.sortText = `${BAND.alias}${rank(relation.as, context.prefix)}`;
      items.push(item);
    }
  }

  private schemas(items: vscode.CompletionItem[], index: Indexed, context: SqlContext): void {
    for (const schema of index.schemas) {
      const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
      item.detail = 'schema';
      item.sortText = `${BAND.schema}${rank(schema, context.prefix)}`;
      items.push(item);
    }
  }

  private objects(
    items: vscode.CompletionItem[],
    index: Indexed,
    context: SqlContext,
    driver: DriverKind
  ): void {
    const wanted = kindsForClause(context.clause);
    for (const object of index.objects) {
      if (wanted && !wanted.has(object.kind)) {
        continue;
      }
      if (context.prefix && !fuzzy(object.name, context.prefix)) {
        continue;
      }
      const qualify = index.schemas.size > 1 && object.schema !== defaultSchema(driver);
      const item = objectItem(object.kind, object.schema, object.name, object.detail, driver, qualify);
      item.sortText = `${BAND.object}${rank(object.name, context.prefix)}`;
      items.push(item);
    }
  }

  private keywords(items: vscode.CompletionItem[], context: SqlContext, driver: DriverKind): void {
    const words = [...COMMON, ...(driver === 'mssql' ? MSSQL_ONLY : POSTGRES_ONLY)];
    for (const word of words) {
      if (context.prefix && !fuzzy(word, context.prefix)) {
        continue;
      }
      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
      item.sortText = `${BAND.keyword}${rank(word, context.prefix)}`;
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
    const word = strip(document.getText(range));
    const index = this.index.peek(profileId);
    if (!index) {
      return undefined;
    }

    const object = this.index.resolve(index, undefined, word);
    if (object) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${object.schema}.${object.name}**\n\n`);
      markdown.appendMarkdown(`${KINDS[object.kind].singular} · ${object.detail}`);
      return new vscode.Hover(markdown, range);
    }

    const context = analyse(document.getText(), document.offsetAt(position));
    for (const relation of context.relations) {
      const columns = await this.index.columnsOf(profileId, relation.schema ?? '', relation.name);
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
    if (!profileId) {
      return undefined;
    }
    const context = analyse(document.getText(), document.offsetAt(position));
    if (!context.routine) {
      return undefined;
    }
    const index = await this.index.build(profileId);
    if (!index) {
      return undefined;
    }
    const object = this.index.resolve(index, context.routine.schema, context.routine.name);
    if (!object || (object.kind !== 'procedure' && object.kind !== 'function')) {
      return undefined;
    }
    const parameters = (await this.index.columnsOf(profileId, object.schema, object.name)).filter(
      (member) => member.direction !== 'returns'
    );
    if (parameters.length === 0) {
      return undefined;
    }

    const label = `${object.schema}.${object.name}(${parameters
      .map((p) => `${p.name} ${p.type}`)
      .join(', ')})`;
    const signature = new vscode.SignatureInformation(label);
    signature.parameters = parameters.map(
      (p) => new vscode.ParameterInformation(`${p.name} ${p.type}`, p.direction === 'out' ? 'output' : undefined)
    );
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = Math.min(context.routine.argument, parameters.length - 1);
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
    const index = await this.index.build(profileId);
    if (!index) {
      return undefined;
    }
    const object = this.index.resolve(index, undefined, strip(document.getText(range)));
    if (!object) {
      return undefined;
    }
    // The scripted definition, read-only, at `dbobj:` — resolved lazily by its
    // content provider, so this costs nothing until somebody presses F12.
    const uri = objectAddress(OBJECT_SCHEME, profileId, object);
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

function defaultSchema(driver: DriverKind): string {
  return driver === 'mssql' ? 'dbo' : 'public';
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
  qualify: boolean
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, KIND_ICONS[kind]);
  item.detail = `${KINDS[kind].singular} · ${schema}${detail ? ` · ${detail}` : ''}`;
  item.insertText = qualify ? `${quote(driver, schema)}.${quote(driver, name)}` : quote(driver, name);
  // The filter is the bare name, so typing `cust` still finds a qualified
  // insertion — a filter that included the schema would need `dbo.cust` typed.
  item.filterText = name;
  return item;
}

function columnItem(column: DbMember, band: string, prefix: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
  const marks = [column.key ? 'PK' : undefined, column.ref ? 'FK' : undefined, column.auto ? 'auto' : undefined]
    .filter(Boolean)
    .join(' ');
  item.detail = marks ? `${column.type} · ${marks}` : column.type;
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
