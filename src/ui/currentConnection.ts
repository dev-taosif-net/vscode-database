import { ConnectionStore } from '../store/connectionStore';

/**
 * Which connection the user is looking at in the explorer.
 *
 * A command contributed to a view's title bar is given nothing: the workbench
 * passes a target to a context-menu entry and to a tree item, and to a toolbar
 * button it passes the view. So New Query in the connections title bar had no
 * way to know which connection it meant, and asked — a quick pick in front of
 * the one action that should never need one.
 *
 * This is the answer, and it is deliberately one fact rather than a policy.
 * The panel announces the connection its cursor is inside, this holds it, and
 * `QueryCommands` decides what to do when it is empty. Keeping the policy out
 * of here is what lets the same value serve a second caller later without
 * inheriting the first one's fallbacks.
 *
 * It is not `ConnectionsView.selectedId`, which is a different fact wearing a
 * similar name: that one follows the editor and drives the row highlight, and
 * it is seeded with whichever profile happens to sort first. This one is empty
 * until the user has actually landed on something.
 */
export class CurrentConnection {
  private id: string | undefined;
  /**
   * The database last worked in, per connection.
   *
   * Written when the explorer's cursor goes inside a database and when a query
   * tab on that connection becomes active or moves with `USE`, so New Query
   * lands where the user was working rather than in `master`. A cursor resting
   * on the connection row itself names no database and leaves this alone.
   */
  private readonly databases = new Map<string, string>();

  constructor(private readonly store: ConnectionStore) {}

  /** Announced by the explorer whenever its cursor enters a connection. */
  set(id: string | undefined, database?: string): void {
    this.id = id;
    if (id && database) {
      this.databases.set(id, database);
    }
  }

  /** Records that the user is working in a database on a connection. */
  noteDatabase(id: string, database: string | undefined): void {
    if (database?.trim()) {
      this.databases.set(id, database.trim());
    }
  }

  /** The database last worked in on this connection, if any. */
  databaseFor(id: string): string | undefined {
    return this.store.get(id) ? this.databases.get(id) : undefined;
  }

  /**
   * The profile id, or undefined when there is none.
   *
   * Checked against the store on the way out rather than cleared on a store
   * change, because a deleted profile is the only way this can go stale and a
   * lookup is cheaper than a subscription that exists for that one case.
   */
  get value(): string | undefined {
    if (this.id && !this.store.get(this.id)) {
      this.id = undefined;
    }
    return this.id;
  }
}
