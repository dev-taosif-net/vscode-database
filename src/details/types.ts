import { DriverSession } from '../drivers/types';
import { FavouriteRef } from '../shared/catalog';
import { DependencyRef, Fact, IndexInfo, KeyColumns, Tag } from '../shared/details';

/** One relation's foreign key, one column pair at a time. */
export interface ForeignKeyColumn {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}

/**
 * One engine's answers about a single object.
 *
 * Same shape as `CatalogQueries` and the same rule: neither reader imports the
 * other, because `sys.dm_db_partition_stats` and `pg_class.reltuples` are not
 * two spellings of one idea. They are two different approximations with
 * different staleness and different meanings, and a layer that flattened them
 * would be confidently wrong about both.
 */
export interface DetailsQueries {
  /** Header numbers and the badges, in as few round trips as the engine allows. */
  facts(session: DriverSession, ref: FavouriteRef): Promise<{ facts: Fact[]; tags: Tag[] }>;

  indexes(session: DriverSession, ref: FavouriteRef): Promise<IndexInfo[]>;

  /** Both directions, and each one honest about what the catalog can prove. */
  dependencies(
    session: DriverSession,
    ref: FavouriteRef
  ): Promise<{ dependsOn: DependencyRef[]; usedBy: DependencyRef[] }>;

  /**
   * The columns a keyset page can be extended with.
   *
   * `usable` false means the table has no unique key, so paging falls back to
   * OFFSET and the footer says it gets slower with depth. That is a real
   * property of a heap, and pretending otherwise makes page five thousand take
   * a minute with no explanation.
   */
  keyColumns(session: DriverSession, ref: FavouriteRef): Promise<KeyColumns>;

  /** Approximate row count, from statistics. Never `COUNT(*)`. */
  estimate(session: DriverSession, ref: FavouriteRef): Promise<number | undefined>;

  /** Every foreign key in the database, for the completion index's join predicates. */
  foreignKeys(session: DriverSession): Promise<ForeignKeyColumn[]>;
}
