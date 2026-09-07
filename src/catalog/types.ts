import {
  CatalogSummary,
  DbMember,
  DbObject,
  FavouriteRef,
  ObjectKind
} from '../shared/catalog';
import { DriverSession } from '../drivers/types';

export interface PageArgs {
  kind: ObjectKind;
  /** Undefined in general mode; the schema to restrict to in schema mode. */
  schema?: string;
  offset: number;
  limit: number;
}

export interface PageResult {
  objects: DbObject[];
  /** Every row that matched, not just the page. `Load more` needs the rest. */
  total: number;
}

export interface SearchResult {
  objects: DbObject[];
  /** The server had more than the cap allowed, so the answer is a top slice. */
  capped: boolean;
}

/**
 * One engine's catalog, as a set of statements.
 *
 * There is no portable dialect here and no attempt at one. `sys.objects` and
 * `pg_class` disagree about what an object even is — SQL Server has synonyms
 * and PostgreSQL has materialized views, a SQL Server function is one of six
 * `type` codes and a PostgreSQL function is a `prokind` — and a layer that
 * flattened the two would produce a tree that is wrong about both. So each
 * engine answers in its own words and this interface is the only thing they
 * share: the shape of the answer.
 *
 * Every method takes a live session. None of them opens one, none of them
 * caches, and none of them knows what a profile is. That belongs to
 * `CatalogService`, which is the only caller.
 */
export interface CatalogQueries {
  /**
   * Counts for every kind and every schema, in as few round trips as the
   * engine allows. This is what lets `Tables 1240` be drawn without reading
   * 1240 rows, and it is the whole reason the tree opens instantly on a
   * database it has never seen.
   */
  summary(session: DriverSession): Promise<CatalogSummary>;

  /** One page of one folder, plus how many there are in total. */
  page(session: DriverSession, args: PageArgs): Promise<PageResult>;

  /** The columns of a table or view, or the parameters of a routine. */
  members(session: DriverSession, ref: FavouriteRef): Promise<DbMember[]>;

  /**
   * Objects whose name or schema contains `needle`, across every kind, capped.
   *
   * Server-side and deliberately unranked beyond a prefix-first ordering: the
   * sidebar fuzzy-ranks what comes back, and a ranking computed twice in two
   * places is a ranking that disagrees with itself.
   */
  search(session: DriverSession, needle: string, limit: number): Promise<SearchResult>;

  /**
   * The object's source, for Open Definition and Script As ALTER.
   *
   * A table has no source, so one is composed from its columns. Returning
   * something for every kind is what lets Open Definition be an action the
   * tree can always offer rather than one that fails on a third of its rows.
   */
  definition(session: DriverSession, ref: FavouriteRef): Promise<string>;
}
