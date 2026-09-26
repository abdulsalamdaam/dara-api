import type pg from "pg";

/**
 * Finance v2 talks to Postgres through a plain `pg.Pool` (raw SQL): the ledger
 * needs explicit transactions, advisory locks and `on conflict` control that
 * are clearer in SQL than through the query builder. The pool is injected so
 * the DB specs can hand in a pool bound to their own throwaway schema.
 */
export const FV2_POOL = Symbol("FV2_POOL");

export type Fv2Pool = Pick<pg.Pool, "query" | "connect">;
export type Fv2Client = pg.PoolClient;

/** Run `fn` in one transaction on a dedicated client; rolls back on any throw. */
export async function withTx<T>(pool: Fv2Pool, fn: (c: Fv2Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
