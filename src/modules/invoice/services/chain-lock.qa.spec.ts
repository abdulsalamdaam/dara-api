/**
 * QA pass over the ZATCA chain lock — the cases `chain-lock.spec.ts` does not
 * reach.
 *
 * The existing suite proves mutual exclusion with an in-process counter. That
 * is necessary but not sufficient: the bug being fixed is a read-modify-write
 * of a row in Postgres adjudicated by `invoices_user_owner_env_icv_uniq`, and a
 * lock can serialize a JavaScript closure while still failing to protect that.
 * So QA-1 races the REAL shape of the write and lets the unique index be the
 * judge.
 *
 * QA-5 asserts a property the implementation does NOT currently have. It is
 * expected to FAIL, and that failure is a reported finding, not flake.
 *
 * Skipped when DATABASE_URL is unset.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { getPool } from "@dara/database";
import { withSellerChainLock } from "./chain-lock";

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && "DATABASE_URL not set";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A user row to hang the foreign keys off. */
let QA_USER = 0;

before(async () => {
  if (!HAS_DB) return;
  const { rows } = await getPool().query<{ id: number }>(
    `insert into users (email, password_hash, name)
     values ('chain-lock-qa@dara.local', 'x', 'chain lock qa')
     on conflict (email) do update set name = excluded.name
     returning id`,
  );
  QA_USER = rows[0].id;
});

after(async () => {
  if (!HAS_DB) return;
  await getPool().query("delete from invoices where user_id = $1", [QA_USER]);
  await getPool().query("delete from zatca_credentials where user_id = $1", [QA_USER]);
  await getPool().query("delete from users where id = $1", [QA_USER]);
  await getPool().end();
});

/* ── QA-1 ────────────────────────────────────────────────────────────────
 * The actual bug, reproduced against the actual constraint.
 *
 * `issue()` reads `zatca_credentials.sandbox_icv`, spends up to 30s at ZATCA,
 * inserts an `invoices` row carrying icv+1, then writes the counter back. Two
 * of those interleaved is the defect. `invoices_user_owner_env_icv_uniq` is
 * (user_id, coalesce(owner_id,0), environment, icv), so a collision surfaces
 * as a 23505 — which is what the landlord actually saw, AFTER the document had
 * been signed and filed.
 *
 * BREAK-IT EVIDENCE: replace `withSellerChainLock(...)` below with a direct
 * `issueLike()` call and this test fails with
 * `duplicate key value violates unique constraint
 *  "invoices_user_owner_env_icv_uniq"` — see the QA report.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-1 the real ICV read-modify-write cannot produce a duplicate under the lock", { skip }, async () => {
  const OWNER = null; // account-level seller; coalesce(owner_id,0) covers it

  await getPool().query("delete from invoices where user_id = $1", [QA_USER]);
  await getPool().query("delete from zatca_credentials where user_id = $1", [QA_USER]);
  await getPool().query(
    `insert into zatca_credentials
       (user_id, owner_id, active_environment, seller_name, seller_vat_number,
        seller_street, seller_building_no, seller_district, seller_city, seller_postal_zone,
        serial_number, organization_identifier, organization_unit_name,
        location_address, industry_category, common_name, sandbox_icv, sandbox_pih)
     values ($1, null, 'sandbox', 'QA Seller', '300000000000003',
             'St', '1234', 'D', 'Riyadh', '12345',
             '1-Dara|2-QA|3-0001', '300000000000003', 'QA', 'Riyadh', 'Real Estate', 'QA', 0, 'SEED')`,
    [QA_USER],
  );

  /** The read-modify-write `issue()` performs, with the ZATCA round trip stubbed. */
  const issueLike = async (invoiceNumber: string) => {
    const { rows } = await getPool().query<{ sandbox_icv: number }>(
      "select sandbox_icv from zatca_credentials where user_id = $1 and owner_id is null",
      [QA_USER],
    );
    const nextIcv = rows[0].sandbox_icv + 1;
    // The window. In production this is a 30s HTTPS call to ZATCA.
    await sleep(80);
    await getPool().query(
      `insert into invoices
         (user_id, owner_id, invoice_number, uuid, profile, issue_date, issue_time,
          icv, pih, environment, seller_snapshot, totals, unsigned_xml)
       values ($1, null, $2, gen_random_uuid()::text, 'standard', current_date, '00:00:00',
               $3, 'PIH', 'sandbox', '{}'::jsonb, '{}'::jsonb, '<x/>')`,
      [QA_USER, invoiceNumber, nextIcv],
    );
    await getPool().query(
      "update zatca_credentials set sandbox_icv = $2 where user_id = $1 and owner_id is null",
      [QA_USER, nextIcv],
    );
    return nextIcv;
  };

  const icvs = await Promise.all([
    withSellerChainLock(QA_USER, OWNER, () => issueLike("QA-1-A")),
    withSellerChainLock(QA_USER, OWNER, () => issueLike("QA-1-B")),
    withSellerChainLock(QA_USER, OWNER, () => issueLike("QA-1-C")),
  ]);

  assert.deepEqual([...icvs].sort((a, b) => a - b), [1, 2, 3], "the chain must be 1,2,3 — no value reused, none skipped");

  const { rows: head } = await getPool().query<{ sandbox_icv: number }>(
    "select sandbox_icv from zatca_credentials where user_id = $1 and owner_id is null",
    [QA_USER],
  );
  assert.equal(head[0].sandbox_icv, 3, "the persisted chain head must match the last document issued");
});

/* ── QA-2 ────────────────────────────────────────────────────────────────
 * The comment on chain-lock.ts asserts the single-bigint advisory space and
 * the two-integer space `billing.module.ts` uses are disjoint. That is a claim
 * about this Postgres, so check it here rather than trusting the docs: take
 * the two-int lock (k1,k2) and then the bigint lock whose 64 bits ARE (k1,k2)
 * concatenated. If the spaces overlapped, the second would be refused.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-2 the bigint and two-int advisory spaces cannot collide", { skip }, async () => {
  const a = await getPool().connect();
  const b = await getPool().connect();
  try {
    // billing.module.ts:859 → pg_advisory_xact_lock(uid, typeKey)
    const uid = 987654;
    const typeKey = 1;
    await a.query("select pg_advisory_lock($1::int, $2::int)", [uid, typeKey]);

    // The bigint whose high/low halves are exactly (uid, typeKey).
    const { rows } = await b.query<{ got: boolean }>(
      "select pg_try_advisory_lock(($1::bigint << 32) | $2::bigint) as got",
      [uid, typeKey],
    );
    assert.equal(rows[0].got, true, "the bigint form was blocked by a two-int lock — the spaces are NOT disjoint");

    const { rows: locks } = await getPool().query<{ objsubid: number }>(
      "select distinct objsubid from pg_locks where locktype='advisory' and classid=$1 and objid=$2 order by objsubid",
      [uid, typeKey],
    );
    assert.deepEqual(locks.map((l) => l.objsubid), [1, 2], "Postgres must tag the two forms differently (objsubid 1 vs 2)");

    await b.query("select pg_advisory_unlock(($1::bigint << 32) | $2::bigint)", [uid, typeKey]);
    await a.query("select pg_advisory_unlock($1::int, $2::int)", [uid, typeKey]);
  } finally {
    a.release();
    b.release();
  }
});

/* ── QA-3 ────────────────────────────────────────────────────────────────
 * `hashtextextended` is a hash, so the lock key is not injective in principle.
 * Two distinct sellers sharing a key would silently serialize against each
 * other — a latency bug, not a correctness one, but the code's comment claims
 * collision is impossible. Show it does not happen over a realistic estate.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-3 no two (user, owner) pairs share a lock key over a realistic estate", { skip }, async () => {
  const { rows } = await getPool().query<{ total: number; distinct_hashes: number }>(
    `with keys as (
       select 'zatca-chain:' || u || ':' || o as k
       from generate_series(1, 600) u, generate_series(0, 400) o
     )
     select count(*)::int as total, count(distinct hashtextextended(k, 0))::int as distinct_hashes from keys`,
  );
  assert.equal(rows[0].distinct_hashes, rows[0].total, "two sellers hash to the same advisory key");
});

/* ── QA-4 ────────────────────────────────────────────────────────────────
 * A `finally { await unlock }` that rejects while `fn` is ALSO throwing would
 * replace the body's error on the way out. That matters because the errors
 * `fn` throws are the ones the caller acts on: billing.module.ts:1585 inspects
 * `e.response.error === "zatca_link_invalid"` to decide whether the document
 * travelled. Swap that for `Error: Connection terminated` and an invoice ZATCA
 * refused the credentials for is recorded as a generic failure instead.
 *
 * The unlock is genuinely performed here before the simulated rejection, so
 * this test leaks no lock — QA-7 covers the case where it does not run at all.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-4 the body's error survives an unlock that itself rejects", { skip }, async () => {
  class ZatcaLinkInvalid extends Error {}

  const realPool = getPool();
  const origConnect = realPool.connect.bind(realPool);
  (realPool as unknown as { connect: unknown }).connect = async function connect(this: unknown) {
    const client = await origConnect();
    const origQuery = client.query.bind(client);
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (text.includes("pg_advisory_unlock")) {
        // Really release it, then fail the way a dropped connection would.
        await origQuery(...(args as Parameters<typeof origQuery>));
        throw new Error("Connection terminated unexpectedly");
      }
      return origQuery(...(args as Parameters<typeof origQuery>));
    };
    return client;
  };

  try {
    await assert.rejects(
      () => withSellerChainLock(QA_USER, 4321, async () => {
        throw new ZatcaLinkInvalid("zatca_link_invalid");
      }),
      (e: unknown) =>
        e instanceof ZatcaLinkInvalid,
      "the unlock's own failure replaced the error the caller has to act on",
    );
  } finally {
    (realPool as unknown as { connect: unknown }).connect = origConnect;
  }
});

/* ── QA-5 ── EXPECTED TO FAIL — this is a reported finding ────────────────
 * The header comment on chain-lock.ts argues the try/release loop "cannot
 * wedge". That is true of WAITERS. It is not true of HOLDERS: a holder keeps
 * its pool connection for the whole of `fn` — up to the 30s ZATCA timeout —
 * while `fn` itself needs a connection to do its own work.
 *
 * The pool holds 20 for the entire process. Twenty-four DISTINCT landlords
 * approving at once is not contention on one chain, so nothing here should
 * queue on the lock at all — yet every holder takes a connection, the pool
 * empties, and each `fn` then waits on a connection that only another holder
 * can return. `connectionTimeoutMillis: 10_000` (db/src/index.ts:45) turns the
 * deadlock into a 10-second stall and a raw driver error, which
 * billing.module.ts:1590 records as a failed ZATCA submission.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-5 twenty-four distinct sellers do not exhaust the pool", { skip }, async () => {
  const CROWD = 24; // pool max is 20
  const failures: string[] = [];

  await Promise.all(
    Array.from({ length: CROWD }, (_, i) =>
      withSellerChainLock(QA_USER, 900_000 + i, async () => {
        // The holder does its own database work, exactly as `issue()` does.
        await getPool().query("select 1");
        await sleep(20);
      }).catch((e: Error) => { failures.push(e.message); }),
    ),
  );

  assert.deepEqual(
    failures, [],
    `sellers with unrelated chains starved each other of pool connections: ${failures.slice(0, 3).join(" | ")}`,
  );
});

/* ── QA-6 ────────────────────────────────────────────────────────────────
 * The key is built by string concatenation, so it is only injective if the
 * delimiter cannot be forged out of the ids. It can't — ids are integers and
 * ':' is not a digit — but the `ownerId ?? 0` fold means the account-level
 * seller and a landlord with id 0 would share a chain. Pin that the id space
 * really excludes 0, since the fold is silent if it ever stops being true.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-6 owner id 0 does not exist, so the `?? 0` fold is safe", { skip }, async () => {
  const { rows } = await getPool().query<{ min: number | null; seqmin: string | null }>(
    `select (select min(id) from owners) as min,
            (select s.seqmin::text from pg_sequence s
               join pg_class c on c.oid = s.seqrelid
              where c.relname = 'owners_id_seq') as seqmin`,
  );
  assert.notEqual(rows[0].min, 0, "a landlord with id 0 exists — it shares a chain with the account-level seller");
  assert.equal(rows[0].seqmin, "1", "owners.id must be generated from a sequence that starts at 1 for the `?? 0` fold to be safe");
});

/* ── QA-7 ────────────────────────────────────────────────────────────────
 * The failure mode a swallowed unlock error creates: the advisory lock is
 * SESSION-scoped, so a connection handed back to the pool still holding one
 * wedges that seller for as long as the connection survives — up to
 * `idleTimeoutMillis: 60_000`, and indefinitely if it keeps getting reused.
 * Nothing in the logs would explain it.
 *
 * Here the unlock does not run at all, only reports failure. The only way the
 * lock can be gone afterwards is if the connection was DESTROYED rather than
 * pooled — `client.release(err)` — so this test is the one that pins that
 * behaviour rather than the swallow.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-7 a failed unlock destroys the connection rather than pooling a held lock", { skip }, async () => {
  const KEY_OWNER = 5150;

  const realPool = getPool();
  const origConnect = realPool.connect.bind(realPool);
  (realPool as unknown as { connect: unknown }).connect = async function connect(this: unknown) {
    const client = await origConnect();
    const origQuery = client.query.bind(client);
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      // Do NOT unlock — fail the way a half-dead session would.
      if (text.includes("pg_advisory_unlock")) throw new Error("Connection terminated unexpectedly");
      return origQuery(...(args as Parameters<typeof origQuery>));
    };
    return client;
  };

  try {
    await withSellerChainLock(QA_USER, KEY_OWNER, async () => {});
  } finally {
    (realPool as unknown as { connect: unknown }).connect = origConnect;
  }

  // Deliberately NOT a `count(*) from pg_locks where locktype='advisory'`:
  // that is cluster-wide, so it reports locks belonging to other test files
  // running in parallel and to anything else pointed at this database. Ask the
  // only question that is actually about THIS key instead.
  const probe = await getPool().connect();
  try {
    const { rows } = await probe.query<{ got: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as got",
      [`zatca-chain:${QA_USER}:${KEY_OWNER}`],
    );
    assert.equal(rows[0].got, true, "the seller's chain is wedged: a pooled connection still holds its advisory lock");
    await probe.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`zatca-chain:${QA_USER}:${KEY_OWNER}`]);
  } finally {
    probe.release();
  }

  // And the seller must still be reachable through the lock itself.
  let ran = false;
  await withSellerChainLock(QA_USER, KEY_OWNER, async () => { ran = true; });
  assert.equal(ran, true, "the seller could not be re-entered after a failed unlock");
});
