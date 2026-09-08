import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionStore } from '../store/connectionStore';
import { DriverSession } from '../drivers/types';
import {
  CatalogSummary,
  DbMember,
  DbObject,
  FavouriteRef,
  ObjectPage,
  ObjectPageRequest,
  SearchAnswer,
  memberNode
} from '../shared/catalog';
import { MssqlCatalog } from './mssql';
import { PostgresCatalog } from './postgres';
import { CatalogQueries } from './types';

/**
 * How long an answer is reused before the server is asked again.
 *
 * Five minutes, and the number is a judgement rather than a measurement. A
 * catalog changes when somebody deploys, which is neither often nor
 * predictable, and the cost of being wrong in each direction is asymmetric: a
 * stale count is a number that is briefly off by one, while a re-read on every
 * expand is a round trip per folder per click on a server that may be across a
 * VPN. Refresh on the connection's menu is the answer for the case where the
 * user knows something changed, and it is instant.
 */
const TTL_MS = 5 * 60 * 1000;

/** Objects per page. See `pageSize` for why this is not a settings key. */
const PAGE = 500;

/** The most a single search may bring back from one connection. */
const SEARCH_LIMIT = 300;

interface Cached<T> {
  value: T;
  at: number;
}

interface NodeCache {
  objects: DbObject[];
  total: number;
  at: number;
}

/**
 * Everything between "the tree wants a folder" and "here are five hundred
 * rows".
 *
 * It owns three things and deliberately not a fourth. It owns the cache, so a
 * folder that is closed and reopened costs nothing. It owns request
 * coalescing, so a double click on a twistie is one query. It owns the mapping
 * from a profile to the engine that answers for it. It does not own the tree's
 * shape, which is the sidebar's, and it does not own the session, which is the
 * manager's — this asks for one and reports honestly when there is none.
 */
export class CatalogService implements vscode.Disposable {
  private readonly engines: Record<string, CatalogQueries> = {
    mssql: new MssqlCatalog(),
    postgres: new PostgresCatalog()
  };

  private readonly summaries = new Map<string, Cached<CatalogSummary>>();
  private readonly nodes = new Map<string, NodeCache>();
  private readonly memberCache = new Map<string, Cached<DbMember[]>>();

  /**
   * Answers already in the air, keyed the same way the caches are.
   *
   * A tree fires the same request more than once for reasons that are not
   * bugs: a folder is expanded, collapsed and expanded again inside a second,
   * a search re-fires as the last character is typed, a `state` message
   * re-renders a node whose load has not landed. Without this each of those is
   * another round trip to a database that is already answering the same
   * question.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly disposables: vscode.Disposable[] = [];

  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  /** Fires with a profile id whose cached catalog is no longer valid. */
  readonly onDidInvalidate = this.onDidChangeEmitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly output: vscode.LogOutputChannel
  ) {
    /*
     * A catalog belongs to a session, not to a profile.
     *
     * When a connection closes, everything read through it is not merely stale
     * but meaningless: reconnecting may land on a different database, a
     * different server behind the same listener, or the same server with
     * different permissions. Keeping the rows would show a tree the user no
     * longer has access to, so the whole subtree goes.
     */
    this.disposables.push(
      this.manager.onDidChange(() => this.dropClosed()),
      // A profile that is edited may now point somewhere else entirely.
      this.store.onDidChange(() => this.dropUnknown())
    );
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.onDidChangeEmitter.dispose();
    this.summaries.clear();
    this.nodes.clear();
    this.memberCache.clear();
    this.inFlight.clear();
  }

  /** How many objects a folder asks for at a time. */
  pageSize(): number {
    return PAGE;
  }

  async summary(profileId: string): Promise<CatalogSummary> {
    const cached = this.summaries.get(profileId);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.once(`summary:${profileId}`, async () => {
      const { session, engine } = this.resolve(profileId);
      const started = Date.now();
      const value = await engine.summary(session);
      this.output.info(
        `Catalog summary for ${profileId} in ${Date.now() - started} ms: ${value.schemas.length} schemas`
      );
      this.summaries.set(profileId, { value, at: Date.now() });
      return value;
    });
  }

  /**
   * One page of a folder, accumulated onto whatever the folder already holds.
   *
   * The cache is the whole folder rather than the page, because that is what
   * the tree draws: pressing "Load more" four times leaves two thousand rows in
   * one array, and closing and reopening the folder redraws all two thousand
   * without a query. An out-of-order page is dropped rather than spliced —
   * pages are only ever asked for in order, so a request whose offset does not
   * meet the end of what is held is a request that has already been answered.
   */
  async page(request: ObjectPageRequest): Promise<ObjectPage> {
    const key = `${request.profileId}:${request.node}`;
    const held = this.nodes.get(key);

    if (held && Date.now() - held.at < TTL_MS && held.objects.length >= request.offset + 1) {
      return {
        profileId: request.profileId,
        node: request.node,
        offset: 0,
        objects: held.objects,
        total: held.total
      };
    }

    return this.once(`page:${key}:${request.offset}`, async () => {
      const { session, engine } = this.resolve(request.profileId);
      const result = await engine.page(session, {
        kind: request.kind,
        schema: request.schema,
        offset: request.offset,
        limit: request.limit || PAGE
      });

      const previous = request.offset > 0 ? (this.nodes.get(key)?.objects ?? []) : [];
      const objects =
        request.offset > 0 && previous.length === request.offset
          ? [...previous, ...result.objects]
          : result.objects;

      this.nodes.set(key, { objects, total: result.total, at: Date.now() });
      return {
        profileId: request.profileId,
        node: request.node,
        offset: 0,
        objects,
        total: result.total
      };
    });
  }

  async members(profileId: string, ref: FavouriteRef): Promise<DbMember[]> {
    const node = memberNode(ref);
    const key = `${profileId}:${node}`;
    const cached = this.memberCache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.once(`members:${key}`, async () => {
      const { session, engine } = this.resolve(profileId);
      const value = await engine.members(session, ref);
      this.memberCache.set(key, { value, at: Date.now() });
      return value;
    });
  }

  /**
   * Objects matching `query`, asked of the server.
   *
   * This is not cached. A cache keyed by a prefix of what somebody is still
   * typing holds one entry per keystroke and is read once each, which is a map
   * that only ever grows. Coalescing is enough: the sidebar debounces, and two
   * identical searches in flight share one answer.
   */
  async search(profileId: string, query: string): Promise<SearchAnswer> {
    const needle = query.trim();
    if (needle.length < 2) {
      // One character matches most of a large database, and the answer would be
      // three hundred arbitrary rows presented as though they were the top
      // three hundred. The local fuzzy match still runs, on what is loaded.
      return { profileId, query, objects: [], capped: false };
    }
    return this.once(`search:${profileId}:${needle}`, async () => {
      const { session, engine } = this.resolve(profileId);
      const result = await engine.search(session, needle, SEARCH_LIMIT);
      return { profileId, query, objects: result.objects, capped: result.capped };
    });
  }

  /** The object's source, for Open Definition and Script As ALTER. */
  async definition(profileId: string, ref: FavouriteRef): Promise<string> {
    const { session, engine } = this.resolve(profileId);
    return engine.definition(session, ref);
  }

  /**
   * Forgets everything read through one connection, or through all of them.
   *
   * It forgets and does not re-read: the tree asks again for whatever is on
   * screen, and nothing else is fetched. A refresh that eagerly reloaded every
   * folder anybody had ever opened would be the most expensive button in the
   * product.
   */
  invalidate(profileId?: string): void {
    if (!profileId) {
      this.summaries.clear();
      this.nodes.clear();
      this.memberCache.clear();
      this.onDidChangeEmitter.fire('');
      return;
    }
    this.summaries.delete(profileId);
    this.forgetPrefix(this.nodes, `${profileId}:`);
    this.forgetPrefix(this.memberCache, `${profileId}:`);
    this.onDidChangeEmitter.fire(profileId);
  }

  /* -------------------------------------------------------------- private */

  private resolve(profileId: string): { session: DriverSession; engine: CatalogQueries } {
    const session = this.manager.sessionFor(profileId);
    if (!session) {
      // Phrased for the row it will be drawn on. The tree cannot expand a
      // connection that is not open, and saying so beats a driver message
      // about a closed socket that the user did not cause.
      throw new Error('This connection is not open. Connect it to browse its objects.');
    }
    const profile = this.store.get(profileId);
    const engine = this.engines[profile?.driver ?? 'mssql'];
    if (!engine) {
      throw new Error(`No catalog reader for ${profile?.driver}.`);
    }
    return { session, engine };
  }

  /**
   * Runs `work` unless the same key is already running, in which case the
   * caller joins the answer that is already coming.
   */
  private async once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = work().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private dropClosed(): void {
    for (const profileId of [...this.summaries.keys()]) {
      if (!this.manager.isConnected(profileId)) {
        this.invalidate(profileId);
      }
    }
  }

  private dropUnknown(): void {
    const known = new Set(this.store.all().map((p) => p.id));
    for (const profileId of [...this.summaries.keys()]) {
      if (!known.has(profileId)) {
        this.invalidate(profileId);
      }
    }
  }

  private forgetPrefix(map: Map<string, unknown>, prefix: string): void {
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix)) {
        map.delete(key);
      }
    }
  }
}
