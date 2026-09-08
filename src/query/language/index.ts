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
 * What IntelliSense knows about a connection.
 *
 * Built lazily on the first completion in a bound editor rather than on
 * connect, because most sessions are opened to look at the tree and never
 * carry a query. Dropped with the session, because a catalog read through a
 * connection that has closed is not stale but meaningless.
 */
export class MetadataIndex implements vscode.Disposable {
  private readonly indexes = new Map<string, Indexed>();
  private readonly building = new Map<string, Promise<Indexed>>();
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
  }

  invalidate(profileId?: string): void {
    if (profileId) {
      this.indexes.delete(profileId);
      this.building.delete(profileId);
      return;
    }
    this.indexes.clear();
    this.building.clear();
  }

  /** What is already known, without waiting. Null until the first build lands. */
  peek(profileId: string): Indexed | undefined {
    return this.indexes.get(profileId);
  }

  async build(profileId: string): Promise<Indexed | undefined> {
    if (!this.manager.isConnected(profileId)) {
      return undefined;
    }
    const existing = this.indexes.get(profileId);
    if (existing) {
      return existing;
    }
    const inFlight = this.building.get(profileId);
    if (inFlight) {
      return inFlight;
    }

    const work = this.doBuild(profileId).finally(() => this.building.delete(profileId));
    this.building.set(profileId, work);
    return work;
  }

  private async doBuild(profileId: string): Promise<Indexed> {
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
      const summary = await this.catalog.summary(profileId);
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

    index.foreignKeys = await this.details.allForeignKeys(profileId);
    this.indexes.set(profileId, index);
    return index;
  }

  /**
   * The columns of one relation, cached.
   *
   * Not read during the build: a thousand tables is a thousand round trips for
   * columns nobody has asked about, and the first `c.` in a statement is the
   * only thing that can say which relation matters.
   */
  async columnsOf(profileId: string, schema: string, name: string): Promise<DbMember[]> {
    const index = await this.build(profileId);
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
      const columns = await this.catalog.members(profileId, {
        kind: object.kind,
        schema: object.schema,
        name: object.name
      });
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
    for (const profileId of [...this.indexes.keys()]) {
      if (!this.manager.isConnected(profileId)) {
        this.indexes.delete(profileId);
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
