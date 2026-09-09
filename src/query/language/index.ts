import * as vscode from 'vscode';
import { CatalogService } from '../../catalog/catalogService';
import { ConnectionManager } from '../../connections/connectionManager';
import { ConnectionStore } from '../../store/connectionStore';
import { DetailsService } from '../../details/detailsService';
import { ForeignKeyColumn } from '../../details/types';
import { DbMember, DbObject, ObjectKind, kindsFor } from '../../shared/catalog';

/**
 * How many objects of each kind the index holds.
 *
 * Roughly a hundred bytes an object, so a fifty-thousand-object database is
 * about five megabytes — held, because the alternative is a round trip on
 * every keystroke, and a completion list that waits on a VPN is a completion
 * list people turn off.
 */
const PER_KIND = 5000;

interface Indexed {
  schemas: Set<string>;
  objects: DbObject[];
  /** Lower-cased `schema.name` to its columns, filled on demand. */
  columns: Map<string, DbMember[]>;
  foreignKeys: ForeignKeyColumn[];
  builtAt: number;
}

/**
 * How long the list of databases on a server is reused.
 *
 * Longer than the catalog's own five minutes, because databases are created
 * far less often than tables are and the list is read to fill a completion
 * list after `USE` — where a round trip per keystroke is the one thing that
 * would make the feature unusable.
 */
const DATABASES_TTL_MS = 10 * 60 * 1000;

/**
 * What IntelliSense knows about a connection.
 *
 * Built lazily on the first completion in a bound editor rather than on
 * connect, because most sessions are opened to look at the tree and never
 * carry a query. Dropped with the session, because a catalog read through a
 * connection that has closed is not stale but meaningless.
 */
export class MetadataIndex implements vscode.Disposable {
  /**
   * Keyed by connection *and* database, as `<profile>|<database>`.
   *
   * The database is the whole point of the key. A tab that has run `USE
   * Reporting` is offered Reporting's tables, and the tab beside it that has
   * not is still offered the profile's — two indexes over one connection,
   * which is exactly what `USE` means and what a single per-profile index
   * could never express.
   */
  private readonly indexes = new Map<string, Indexed>();
  private readonly building = new Map<string, Promise<Indexed>>();
  private readonly databaseLists = new Map<string, { value: string[]; at: number }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly catalog: CatalogService,
    private readonly details: DetailsService
  ) {
    this.disposables.push(
      this.manager.onDidChange(() => this.dropClosed()),
      this.catalog.onDidInvalidate((profileId) => this.invalidate(profileId))
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.indexes.clear();
    this.building.clear();
    this.databaseLists.clear();
  }

  invalidate(profileId?: string): void {
    if (profileId) {
      // Every database indexed through this connection, not just its own.
      for (const key of [...this.indexes.keys()]) {
        if (key.startsWith(`${profileId}|`)) {
          this.indexes.delete(key);
          this.building.delete(key);
        }
      }
      this.databaseLists.delete(profileId);
      return;
    }
    this.indexes.clear();
    this.building.clear();
    this.databaseLists.clear();
  }

  private key(profileId: string, database?: string): string {
    return `${profileId}|${(database ?? '').trim().toLowerCase()}`;
  }

  /** What is already known, without waiting. Null until the first build lands. */
  peek(profileId: string, database?: string): Indexed | undefined {
    return this.indexes.get(this.key(profileId, database));
  }

  /**
   * The databases on this server that the login can reach.
   *
   * Cached per connection and read through the control session, so the list
   * behind `USE ` costs one round trip per ten minutes rather than one per
   * keystroke. An unreadable list is cached as empty for the same interval: a
   * login without `VIEW ANY DATABASE` would otherwise be asked again on every
   * character typed, and the answer would be no every time.
   */
  async databases(profileId: string): Promise<string[]> {
    const cached = this.databaseLists.get(profileId);
    if (cached && Date.now() - cached.at < DATABASES_TTL_MS) {
      return cached.value;
    }
    const session = this.manager.sessionFor(profileId);
    if (!session) {
      return [];
    }
    try {
      const value = await session.listDatabases();
      this.databaseLists.set(profileId, { value, at: Date.now() });
      return value;
    } catch {
      this.databaseLists.set(profileId, { value: [], at: Date.now() });
      return [];
    }
  }

  async build(profileId: string, database?: string): Promise<Indexed | undefined> {
    if (!this.manager.isConnected(profileId)) {
      return undefined;
    }
    const key = this.key(profileId, database);
    const existing = this.indexes.get(key);
    if (existing) {
      return existing;
    }
    const inFlight = this.building.get(key);
    if (inFlight) {
      return inFlight;
    }

    const work = this.doBuild(profileId, database, key).finally(() => this.building.delete(key));
    this.building.set(key, work);
    return work;
  }

  private async doBuild(profileId: string, database: string | undefined, key: string): Promise<Indexed> {
    const profile = this.store.get(profileId);
    const index: Indexed = {
      schemas: new Set(),
      objects: [],
      columns: new Map(),
      foreignKeys: [],
      builtAt: Date.now()
    };
    if (!profile) {
      return index;
    }

    try {
      const summary = await this.catalog.summary(profileId, database);
      for (const schema of summary.schemas) {
        index.schemas.add(schema.name);
      }
    } catch {
      // A connection that cannot read its own schema list still gets keyword
      // completion, which is better than an editor that offers nothing.
    }

    for (const kind of kindsFor(profile.driver)) {
      try {
        const page = await this.catalog.page({
          profileId,
          node: `index:${kind}`,
          kind: kind as ObjectKind,
          database,
          offset: 0,
          limit: PER_KIND
        });
        index.objects.push(...page.objects);
        for (const object of page.objects) {
          index.schemas.add(object.schema);
        }
      } catch {
        // One unreadable folder costs that folder's completions and nothing else.
      }
    }

    index.foreignKeys = await this.details.allForeignKeys(profileId, database);
    this.indexes.set(key, index);
    return index;
  }

  /**
   * The columns of one relation, cached.
   *
   * Not read during the build: a thousand tables is a thousand round trips for
   * columns nobody has asked about, and the first `c.` in a statement is the
   * only thing that can say which relation matters.
   */
  async columnsOf(profileId: string, schema: string, name: string, database?: string): Promise<DbMember[]> {
    const index = await this.build(profileId, database);
    if (!index) {
      return [];
    }
    const key = `${schema.toLowerCase()}.${name.toLowerCase()}`;
    const cached = index.columns.get(key);
    if (cached) {
      return cached;
    }
    const object = index.objects.find(
      (candidate) =>
        candidate.name.toLowerCase() === name.toLowerCase() &&
        (schema === '' || candidate.schema.toLowerCase() === schema.toLowerCase())
    );
    if (!object) {
      return [];
    }
    try {
      const columns = await this.catalog.members(
        profileId,
        { kind: object.kind, schema: object.schema, name: object.name },
        database
      );
      index.columns.set(key, columns);
      return columns;
    } catch {
      index.columns.set(key, []);
      return [];
    }
  }

  /** The object a name resolves to, with or without a schema. */
  resolve(index: Indexed, schema: string | undefined, name: string): DbObject | undefined {
    const lower = name.toLowerCase();
    return index.objects.find(
      (object) =>
        object.name.toLowerCase() === lower &&
        (!schema || object.schema.toLowerCase() === schema.toLowerCase())
    );
  }

  /**
   * The join predicate between two relations, if the database declares one.
   *
   * This is the completion that wins people over. When the caret is after `ON`
   * and the two relations in scope have a foreign key between them, the first
   * suggestion is the whole predicate, because the index already knows the
   * constraint and writing it out is the most tedious keystroke in SQL.
   */
  joinPredicate(
    index: Indexed,
    left: { schema?: string; name: string; as: string },
    right: { schema?: string; name: string; as: string }
  ): string | undefined {
    const pairs = index.foreignKeys.filter(
      (fk) =>
        (matches(fk.fromSchema, fk.fromTable, left) && matches(fk.toSchema, fk.toTable, right)) ||
        (matches(fk.fromSchema, fk.fromTable, right) && matches(fk.toSchema, fk.toTable, left))
    );
    if (pairs.length === 0) {
      return undefined;
    }
    const name = pairs[0].name;
    const columns = pairs.filter((fk) => fk.name === name);
    return columns
      .map((fk) => {
        const fromAlias = matches(fk.fromSchema, fk.fromTable, left) ? left.as : right.as;
        const toAlias = fromAlias === left.as ? right.as : left.as;
        return `${fromAlias}.${fk.fromColumn} = ${toAlias}.${fk.toColumn}`;
      })
      .join(' AND ');
  }

  private dropClosed(): void {
    for (const key of [...this.indexes.keys()]) {
      const profileId = key.slice(0, key.indexOf('|'));
      if (!this.manager.isConnected(profileId)) {
        this.indexes.delete(key);
        this.databaseLists.delete(profileId);
      }
    }
  }
}

function matches(schema: string, table: string, relation: { schema?: string; name: string }): boolean {
  if (table.toLowerCase() !== relation.name.toLowerCase()) {
    return false;
  }
  return !relation.schema || relation.schema.toLowerCase() === schema.toLowerCase();
}

export type { Indexed };
