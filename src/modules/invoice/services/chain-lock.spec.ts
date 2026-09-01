/**
 * The ZATCA chain lock.
 *
 * The property under test is mutual exclusion across CONNECTIONS, which is the
 * only kind that matters here: two approvals for one landlord are two HTTP
 * requests, each on its own pool connection, and the counter they race over
 * lives in Postgres. So these tests run real concurrent calls against a real
 * database rather than asserting anything about the implementation.
 *
 * Each test also states what it would look like WITHOUT the lock, because a
 * concurrency test that passes for the wrong reason is worse than none.
 *
 * Skipped when DATABASE_URL is unset.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getPool } from "@dara/database";
import { withSellerChainLock } from "./chain-lock";

const HAS_DB = !!process.env.DATABASE_URL;
after(async () => {
  if (HAS_DB) await getPool().end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("two issues for the SAME seller cannot overlap", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  let inside = 0;
  let maxInside = 0;
  const order: string[] = [];

  const body = (tag: string) => async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    order.push(`${tag}:enter`);
    // Stands in for the ZATCA round trip: the whole point is that the counter
    // is read before this and written after it.
    await sleep(60);
    order.push(`${tag}:exit`);
    inside -= 1;
  };

  await Promise.all([
    withSellerChainLock(4242, 7, body("a")),
    withSellerChainLock(4242, 7, body("b")),
  ]);

  // Without the lock both would be inside at once and `order` would read
  // enter,enter,exit,exit — which is exactly the interleaving that let two
  // documents compute the same ICV.
  assert.equal(maxInside, 1, `critical sections overlapped: ${order.join(" ")}`);
  assert.equal(order.length, 4);
  assert.equal(order[1], order[0].replace(":enter", ":exit"), `not serialized: ${order.join(" ")}`);
});

test("different sellers are not serialized against each other", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  let inside = 0;
  let sawBothInside = false;
  const body = async () => {
    inside += 1;
    if (inside > 1) sawBothInside = true;
    await sleep(60);
    inside -= 1;
  };
  // One landlord's chain must not queue behind another's — they are independent
  // counters, and a global lock would turn every busy account into a queue.
  await Promise.all([
    withSellerChainLock(4242, 7, body),
    withSellerChainLock(4242, 8, body),
    withSellerChainLock(4243, 7, body),
  ]);
  assert.equal(sawBothInside, true, "sellers with different chains should run concurrently");
});

test("the account-level seller has its own chain, distinct from landlord 0", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // `ownerId: null` is the account-level seller. It keys to the same string a
  // hypothetical landlord 0 would, which is fine — there is no owner id 0 — but
  // it must not collide with a real landlord id.
  let overlapped = false;
  let inside = 0;
  const body = async () => { inside += 1; if (inside > 1) overlapped = true; await sleep(50); inside -= 1; };
  await Promise.all([
    withSellerChainLock(4244, null, body),
    withSellerChainLock(4244, 1, body),
  ]);
  assert.equal(overlapped, true, "the account-level chain is independent of landlord 1's");
});

test("the lock is released when the body throws", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await assert.rejects(
    () => withSellerChainLock(4245, 9, async () => { throw new Error("ZATCA exploded"); }),
    /ZATCA exploded/,
  );
  // A lock leaked on the failure path would wedge the seller permanently — and
  // failures here are routine, since a rejected submission throws.
  let ran = false;
  await withSellerChainLock(4245, 9, async () => { ran = true; });
  assert.equal(ran, true, "a failed issue must not wedge the seller's chain");
});

/**
 * Is THIS key free? Counting `pg_locks` cluster-wide instead was flaky by
 * construction: node:test runs spec files in parallel, and any other connection
 * in the same database holding any advisory lock failed the assertion.
 */
async function keyIsFree(userId: number, ownerId: number | null): Promise<boolean> {
  const key = `zatca-chain:${userId}:${ownerId ?? 0}`;
  const { rows } = await getPool().query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtextextended($1, 0)) as got", [key]);
  if (rows[0].got) {
    await getPool().query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    return true;
  }
  return false;
}

test("a released connection leaves no advisory lock behind", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withSellerChainLock(4246, 11, async () => {});
  // Session-scoped locks outlive their transaction, so forgetting the unlock
  // would silently accumulate them on pooled connections until the pool itself
  // was poisoned.
  assert.equal(await keyIsFree(4246, 11), true, "the seller's chain is still locked");
});

test("a crowd waiting on one seller does not exhaust the connection pool", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // The pool holds 20 connections for the WHOLE process. Waiting on the
  // blocking `pg_advisory_lock` parks each waiter on one of them, so a burst of
  // approvals for a single landlord could take every connection — including the
  // ones the lock holder needs to do its own work, which is a deadlock rather
  // than a slowdown. 30 waiters is more than the pool has on purpose.
  const CROWD = 30;
  let inside = 0;
  let maxInside = 0;
  let completed = 0;

  await Promise.all(
    Array.from({ length: CROWD }, () =>
      withSellerChainLock(4247, 3, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        // The holder does its own database work while holding the lock, which
        // is what starves under the blocking form.
        await getPool().query("select 1");
        await sleep(5);
        inside -= 1;
        completed += 1;
      })),
  );

  assert.equal(completed, CROWD, "every waiter must eventually run");
  assert.equal(maxInside, 1, "still mutually exclusive under load");
});

test("the body's error survives, and is not replaced by lock bookkeeping", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // `fn` throwing is routine — a rejected ZATCA submission throws — so the
  // error the caller sees has to be the one that matters, not whatever the
  // unlock did on the way out.
  class ZatcaRejected extends Error {}
  await assert.rejects(
    () => withSellerChainLock(4248, 5, async () => { throw new ZatcaRejected("rejected: BR-KSA-63"); }),
    (e: unknown) => e instanceof ZatcaRejected && /BR-KSA-63/.test((e as Error).message),
  );
});

test("a seller stays usable after a failure, and no lock is left behind", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await assert.rejects(() => withSellerChainLock(4249, 6, async () => { throw new Error("boom"); }), /boom/);
  let ran = false;
  await withSellerChainLock(4249, 6, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(await keyIsFree(4249, 6), true, "a failed issue must not strand an advisory lock");
});
