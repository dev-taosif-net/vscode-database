import { DriverSession } from '../drivers/types';

/**
 * `server_version_num`, asked of a session once and kept for its lifetime.
 *
 * Both PostgreSQL readers branch on it — `prokind` arrived in 11, `pg_sequences`
 * and `attidentity` in 10, `attgenerated` in 12 — and each used to keep a map
 * of its own, which cost the same session two identical round trips on its
 * first expansion. A `WeakMap` keyed by the session means a closed session
 * takes its entry with it.
 */
const VERSIONS = new WeakMap<DriverSession, number>();

/** A floor for a server that will not say, which is every branch's oldest form. */
const OLDEST_SUPPORTED = 90600;

export async function serverVersion(session: DriverSession): Promise<number> {
  const known = VERSIONS.get(session);
  if (known !== undefined) {
    return known;
  }
  const rows = await session.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  const value = Number(rows[0]?.v ?? 0) || OLDEST_SUPPORTED;
  VERSIONS.set(session, value);
  return value;
}
