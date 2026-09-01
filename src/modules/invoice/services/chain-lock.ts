import { ConflictException } from "@nestjs/common";
import type pg from "pg";
import { createAuxPool } from "@dara/database";

/** Give up rather than queue forever; a caller can always retry the document. */
const ACQUIRE_TIMEOUT_MS = 90_000;
const RETRY_BASE_MS = 75;

/**
 * How many sellers may be mid-submission at once. Small on purpose: these
 * connections sit idle across a ZATCA round trip, and the product has tens of
 * VAT-registered landlords, not thousands. Raising it costs idle connections;
 * it can never restore the deadlock, because this pool is not the one the
 * request needs to do its work.
 */
const LOCK_POOL_SIZE = 6;

let lockPool: pg.Pool | null = null;
function getLockPool(): pg.Pool {
  if (!lockPool) lockPool = createAuxPool(LOCK_POOL_SIZE, "zatca-chain-lock pool");
  return lockPool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raised when a seller's chain stays busy past the deadline. */
export const CHAIN_BUSY = "zatca_chain_busy";

/**
 * Hold an exclusive lock on one seller's ZATCA chain for the duration of `fn`.
 *
 * A ZATCA chain is a genuinely serial object: invoice N+1 carries ICV N+1 and a
 * PIH that is the hash of invoice N. `InvoiceService.issue` reads the counter,
 * spends up to 30 seconds talking to ZATCA, and only then writes it back — so
 * two approvals for the same landlord arriving together both computed the same
 * ICV. One of them lost: `invoices_user_owner_env_icv_uniq` raised a raw driver
 * error AFTER the document had been signed and submitted, or, where that index
 * did not bite, both reached ZATCA claiming the same counter value.
 *
 * The lock therefore has to span the submission, not merely the read: a cheaper
 * lock around the read alone would still let the second document be built on a
 * chain head the first is about to move.
 *
 * Which means a connection is held idle for as long as ZATCA takes — and that
 * connection must NOT come from the pool serving requests. It did at first, and
 * the result was a deadlock that only appeared above the pool size: with 20
 * connections and 24 unrelated landlords approving at once, every connection is
 * held by a lock holder, and each holder's own work then waits for a connection
 * only another holder can release. They contend over nothing and still stop.
 * Hence a separate, deliberately small pool: it bounds how many submissions run
 * at once, which is a queue rather than a deadlock, and leaves the request pool
 * untouched.
 *
 * Session-scoped rather than transaction-scoped, because issuing is not one
 * transaction — it writes the invoice, its lines and the chain head in three
 * separate statements. The unlock is in a `finally`, and a connection that dies
 * releases its locks anyway, so the lock cannot outlive the request that took
 * it.
 *
 * Acquired with `pg_try_advisory_lock` in a retry loop rather than the blocking
 * form, so that a WAITER holds no connection at all while it waits — otherwise
 * a queue on one busy landlord would exhaust even the dedicated pool.
 *
 * Keyed by (account, seller) through `hashtextextended`. That is the
 * single-bigint advisory space, which Postgres keeps separate from the
 * two-integer form `billing.module.ts` uses for document numbering, so the two
 * cannot collide however the hashes land. A 64-bit hash collision between two
 * different sellers is possible in principle and harmless in practice: it can
 * only make two chains share a lock — over-serializing — never let one chain be
 * entered twice, which is the direction that corrupts.
 */
export async function withSellerChainLock<T>(
  userId: number,
  ownerId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `zatca-chain:${userId}:${ownerId ?? 0}`;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  for (;;) {
    const client = await getLockPool().connect();
    // A session-scoped lock lives on the CONNECTION, so a connection returned
    // to the pool still holding one would wedge this seller for as long as that
    // connection survives — and nothing would ever explain why. If the unlock
    // fails we therefore destroy the connection instead of pooling it; dropping
    // the session drops the lock with it.
    let unlockFailed = false;
    try {
      const { rows } = await client.query<{ got: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as got",
        [key],
      );
      if (rows[0]?.got === true) {
        try {
          return await fn();
        } finally {
          // Never let a failed unlock replace the body's error. `fn` throwing is
          // routine here — a rejected submission throws — and swapping "ZATCA
          // rejected this invoice" for a driver message would hide the only
          // thing the caller needed to know.
          try {
            await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
          } catch {
            unlockFailed = true;
          }
        }
      }
    } finally {
      // Released on BOTH paths, and this is the load-bearing half. The blocking
      // `pg_advisory_lock` would have parked each waiter on a connection while
      // it queued — and the pool holds 20, shared with every other request in
      // the process, including the ones the LOCK HOLDER needs to do its own
      // work. A burst of approvals for one landlord would then have deadlocked:
      // the holder starved of a connection by the very requests waiting on it.
      // Trying, letting go, and coming back costs a little latency and cannot
      // wedge.
      client.release(unlockFailed || undefined);
    }

    if (Date.now() > deadline) {
      // Coded, because "we never got a turn" is not a failed submission: nothing
      // was sent and no counter moved, so the caller must file it under "not
      // sent yet" and let it be retried, not under "ZATCA rejected this".
      throw new ConflictException({
        error: CHAIN_BUSY,
        message: "تعذّر إرسال الفاتورة — هناك فاتورة أخرى قيد الإرسال لنفس المؤجر. أعد المحاولة بعد قليل.",
      });
    }
    // Jittered, so a queue that formed together does not re-collide in step.
    await sleep(RETRY_BASE_MS + Math.floor(Math.random() * RETRY_BASE_MS));
  }
}
