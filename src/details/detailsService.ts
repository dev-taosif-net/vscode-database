import * as vscode from 'vscode';
import { CatalogService } from '../catalog/catalogService';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { DriverSession } from '../drivers/types';
import { FavouriteRef, favouriteKey } from '../shared/catalog';
import { KeyColumns, ObjectDetails } from '../shared/details';
import { MssqlDetails } from './mssql';
import { PostgresDetails } from './postgres';
import { DetailsQueries, ForeignKeyColumn } from './types';
import { qualified } from '../catalog/script';
import { errorMessage } from '../types';

/** The same five minutes the catalog uses, for the same reasons. */
const TTL_MS = 5 * 60 * 1000;

/**
 * The separator between a profile id and the object key.
 *
 * The ASCII unit separator, built rather than written, exactly as
 * `shared/catalog.ts` builds its own: a schema or an object name may legally
 * contain a colon, a dot, a slash and a pipe, and a cache key a table called
 * `a|b` could collide with is a cache that answers one object's question with
 * another object's facts.
 */
const SEP = String.fromCharCode(31);

interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Everything the details panel draws, and the metadata the completion index
 * needs, read through the *control* session.
 *
 * That last point is the whole reason this does not go through `SessionPool`.
 * The panel updates as the user moves around the explorer and IntelliSense
 * asks on a keystroke; both would be sitting behind a four-minute scan if they
 * shared a connection with the grid. The control session is never leased out,
 * so neither ever waits on a query.
 */
export class DetailsService implements vscode.Disposable {
  private readonly engines: Record<string, DetailsQueries> = {
    mssql: new MssqlDetails(),
    postgres: new PostgresDetails()
  };

  private readonly details = new Map<string, Cached<ObjectDetails>>();
  private readonly keys = new Map<string, Cached<KeyColumns>>();
  private readonly estimates = new Map<string, Cached<number | undefined>>();
  private readonly foreignKeys = new Map<string, Cached<ForeignKeyColumn[]>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly catalog: CatalogService,
    private readonly output: vscode.LogOutputChannel
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
    this.invalidate();
  }

  invalidate(profileId?: string): void {
    for (const map of this.caches()) {
      for (const key of [...map.keys()]) {
        if (!profileId || key.split(SEP)[0] === profileId) {
          map.delete(key);
        }
      }
    }
  }

  /**
   * Everything about one object, in as few round trips as the engine allows.
   *
   * Columns are free where the explorer has already read them: `CatalogService`
   * caches them, so expanding a table in the tree and then opening details
   * costs one query rather than two.
   */
  async describe(profileId: string, ref: FavouriteRef): Promise<ObjectDetails> {
    const profile = this.store.get(profileId);
    if (!profile) {
      throw new Error('That connection no longer exists.');
    }
    const base: ObjectDetails = {
      profileId,
      connectionName: profile.name || profile.host,
      environment: profile.environment,
      driver: profile.driver,
      ref
    };

    const key = this.key(profileId, ref);
    const cached = this.details.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }

    return this.coalesce(`d${SEP}${key}`, async () => {
      const session = this.sessionFor(profileId);
      if (!session) {
        return { ...base, error: 'The connection is not open.' };
      }
      const engine = this.engines[profile.driver];
      const value: ObjectDetails = { ...base };

      try {
        const answer = await engine.facts(session, ref);
        value.facts = answer.facts;
        value.tags = answer.tags;
      } catch (error) {
        value.error = errorMessage(error);
      }

      try {
        value.columns = await this.catalog.members(profileId, ref);
      } catch {
        // A login with rights to the object but not its columns is ordinary on
        // production. The panel drops the section rather than the object.
      }

      if (ref.kind === 'table' || ref.kind === 'view') {
        try {
          value.indexes = await engine.indexes(session, ref);
        } catch {
          // Same reasoning as columns.
        }
      }

      try {
        const dependencies = await engine.dependencies(session, ref);
        value.dependsOn = dependencies.dependsOn;
        value.usedBy = dependencies.usedBy;
      } catch (error) {
        this.output.warn(`dependencies ${ref.schema}.${ref.name}: ${errorMessage(error)}`);
      }

      this.details.set(key, { value, at: Date.now() });
      return value;
    });
  }

  /** The columns a keyset page can extend its sort with. */
  async keyColumns(profileId: string, ref: FavouriteRef): Promise<KeyColumns> {
    const key = this.key(profileId, ref);
    const cached = this.keys.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.coalesce(`k${SEP}${key}`, async () => {
      const session = this.sessionFor(profileId);
      const profile = this.store.get(profileId);
      if (!session || !profile) {
        return { columns: [], usable: false };
      }
      const value = await this.engines[profile.driver].keyColumns(session, ref);
      this.keys.set(key, { value, at: Date.now() });
      return value;
    });
  }

  /** The approximate row count. Never a `COUNT(*)`; see the two readers. */
  async estimate(profileId: string, ref: FavouriteRef): Promise<number | undefined> {
    const key = this.key(profileId, ref);
    const cached = this.estimates.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.coalesce(`e${SEP}${key}`, async () => {
      const session = this.sessionFor(profileId);
      const profile = this.store.get(profileId);
      if (!session || !profile) {
        return undefined;
      }
      const value = await this.engines[profile.driver].estimate(session, ref);
      this.estimates.set(key, { value, at: Date.now() });
      return value;
    });
  }

  /**
   * The exact count, and only when somebody asked for it by name.
   *
   * It is a full scan on a heap and an index scan everywhere else, which on
   * the tables this extension is built for is tens of seconds. That is a fine
   * thing to spend when a person clicked "count exactly" and an inexcusable
   * one to spend filling a label nobody asked about.
   */
  async exactCount(profileId: string, ref: FavouriteRef): Promise<number | undefined> {
    const session = this.sessionFor(profileId);
    const profile = this.store.get(profileId);
    if (!session || !profile) {
      return undefined;
    }
    const rows = await session.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM ${qualified(profile.driver, ref)}`
    );
    const value = Number(rows[0]?.n);
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * Every foreign key in the database.
   *
   * Read once and cached, because it is what makes the first completion after
   * `ON` the whole join predicate rather than a list of columns. A thousand
   * tables is a few thousand rows of three short strings, which is cheap to
   * hold and far too slow to fetch on a keystroke.
   */
  async allForeignKeys(profileId: string): Promise<ForeignKeyColumn[]> {
    const key = `${profileId}${SEP}fk`;
    const cached = this.foreignKeys.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.coalesce(key, async () => {
      const session = this.sessionFor(profileId);
      const profile = this.store.get(profileId);
      if (!session || !profile) {
        return [];
      }
      try {
        const value = await this.engines[profile.driver].foreignKeys(session);
        this.foreignKeys.set(key, { value, at: Date.now() });
        return value;
      } catch (error) {
        // A login without rights to the constraint catalog loses the join
        // predicate and keeps every other completion.
        this.output.warn(`foreign keys: ${errorMessage(error)}`);
        this.foreignKeys.set(key, { value: [], at: Date.now() });
        return [];
      }
    });
  }

  private caches(): Map<string, unknown>[] {
    return [
      this.details as Map<string, unknown>,
      this.keys as Map<string, unknown>,
      this.estimates as Map<string, unknown>,
      this.foreignKeys as Map<string, unknown>
    ];
  }

  private sessionFor(profileId: string): DriverSession | undefined {
    return this.manager.sessionFor(profileId);
  }

  private key(profileId: string, ref: FavouriteRef): string {
    return `${profileId}${SEP}${favouriteKey(ref)}`;
  }

  /** One request in the air per key, the way `CatalogService` does it. */
  private coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * A connection that closes loses everything read through it.
   *
   * Not merely stale: reconnecting may land on a different database, a
   * different server behind the same listener, or the same server with
   * different permissions. `CatalogService` drops its subtree for exactly this
   * reason and this drops its facts alongside.
   */
  private dropClosed(): void {
    for (const map of this.caches()) {
      for (const key of [...map.keys()]) {
        if (!this.manager.isConnected(key.split(SEP)[0])) {
          map.delete(key);
        }
      }
    }
  }
}
