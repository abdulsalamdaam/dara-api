import type pg from "pg";
import { createAuxPool } from "@dara/database";

/**
 * "Only one news run at a time", across restarts and instances.
 *
 * A session-level `pg_try_advisory_lock` held on a dedicated connection for
 * the whole run (minutes: network fetches + Claude calls). The connection
 * comes from a tiny separate pool for the reason `chain-lock.ts` spells out:
 * a connection parked for minutes must not be one the request pool needs. If
 * the process dies, Postgres drops the session and the lock with it.
 */
const LOCK_KEY = "dara-news-run";

let lockPool: pg.Pool | null = null;
function getLockPool(): pg.Pool {
  if (!lockPool) lockPool = createAuxPool(2, "news-run-lock pool");
  return lockPool;
}

export interface NewsRunLock {
  release(): Promise<void>;
}

/** The lock, or null when another run holds it. Never blocks. */
export async function tryAcquireNewsLock(): Promise<NewsRunLock | null> {
  const client = await getLockPool().connect();
  let got = false;
  try {
    const { rows } = await client.query<{ got: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as got", [LOCK_KEY]);
    got = rows[0]?.got === true;
  } catch (err) {
    client.release(true);
    throw err;
  }
  if (!got) {
    client.release();
    return null;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let broken = false;
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY]);
      } catch {
        broken = true; // destroy the session so the lock cannot linger
      }
      client.release(broken || undefined);
    },
  };
}
