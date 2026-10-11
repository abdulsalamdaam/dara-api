/**
 * The real DrizzleEjarLookupStore against a database: the budget-counting
 * SQL, the saved-lookup round trip (incl. contracts_body), UUID matching and
 * the advisory lock. Everything runs inside a rolled-back transaction except
 * the lock, which touches no data. Skipped when DATABASE_URL is unset.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, getPool, usersTable, ejarApiLogsTable, propertiesTable, unitsTable } from "@dara/database";
import { closeEjarLookupLockPool, DrizzleEjarLookupStore } from "./ejar.lookup.store";
import { CN, UUID, PROPERTY_UUID, UNIT_UUID, invoicesFor, contractsFor } from "./__tests__/lookup-harness";

const HAS_DB = !!process.env.DATABASE_URL;
class Rollback extends Error {}
async function inRollback<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await db.transaction(async (tx) => { out = await fn(tx as never); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

describe("DrizzleEjarLookupStore (database, rolled back)", { skip: !HAS_DB && "DATABASE_URL not set" }, () => {
  let userId = 0;
  before(async () => {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    userId = u?.id ?? 0;
  });
  after(async () => { await closeEjarLookupLockPool(); await getPool().end(); });

  it("counts attempts per endpoint on Balady envs only, and the account's share", async () => {
    const out = await inRollback(async (tx) => {
      const store = new DrizzleEjarLookupStore(tx as never);
      const row = (endpoint: string, env: string, attempts: number, uid: number | null = userId) =>
        ({ userId: uid, env, endpoint, method: "GET", url: "x", attempts });
      await tx.insert(ejarApiLogsTable).values([
        row("rentalContractInvoices", "balady-stg", 1),
        row("rentalContractInvoices", "balady-stg", 2, null),
        row("getRentalContracts", "balady-stg", 1),
        row("contractDetails", "balady-stg", 1),
        row("contractDetails", "blocked", 0),
        row("rentalContractInvoices", "uat", 5),
        row("getProperties", "balady-stg", 9),
        { ...row("rentalContractInvoices", "balady-stg", 1), status: 400 }, // a wrong number: free
        { ...row("rentalContractInvoices", "balady-stg", 1), status: 404 }, // also a wrong number
        // staging's answer to a wrong number: 200 with an empty result
        { ...row("rentalContractInvoices", "balady-stg", 1), status: 200,
          responseBody: { statusDetails: { code: 200 }, data: { result: { data: [], meta: { count: 0 }, included: [] } } } },
        // a truncated body is stored as a string: it stays counted
        { ...row("rentalContractInvoices", "balady-stg", 1), status: 200, responseBody: "{\"data\": …[truncated]" },
      ]);
      return {
        now: await store.usage(new Date(Date.now() - 60_000), userId),
        future: await store.usage(new Date(Date.now() + 3_600_000), userId),
        wrong: await store.wrongNumbers(new Date(Date.now() - 60_000), userId),
      };
    });
    assert.equal(out.wrong, 3, "400, 404 and the empty 200 count against the daily cap only");
    assert.equal(out.now.invoices, 4, "a system (null user) call and the truncated-body call count globally");
    assert.equal(out.now.contracts, 1);
    assert.equal(out.now.details, 1);
    assert.deepEqual(out.now.account, { invoices: 2, contracts: 1, details: 1 });
    assert.deepEqual(out.future, { invoices: 0, contracts: 0, details: 0, account: { invoices: 0, contracts: 0, details: 0 } });
  });

  it("saves and re-saves a lookup with its Get Contracts body", async () => {
    const out = await inRollback(async (tx) => {
      const store = new DrizzleEjarLookupStore(tx as never);
      await store.saveLookup({ accountId: userId, contractNumber: CN, ejarUuid: UUID, invoicesBody: invoicesFor(CN), detailsBody: null, contractsBody: null, lookedUpBy: userId });
      await store.saveLookup({ accountId: userId, contractNumber: CN, ejarUuid: UUID, invoicesBody: invoicesFor(CN), detailsBody: null, contractsBody: contractsFor(CN), lookedUpBy: userId });
      return store.getLookup(userId, CN);
    });
    assert.equal(out?.ejarUuid, UUID);
    assert.equal((out?.contractsBody as any)?.meta?.count, 1, "the upsert replaced the first save");
  });

  it("matches property and units by Ejar UUID within the account", async () => {
    const m = await inRollback(async (tx) => {
      const store = new DrizzleEjarLookupStore(tx as never);
      const [p] = await tx.insert(propertiesTable).values({ userId, name: "TEST-EJAR-MATCH", ejarId: PROPERTY_UUID }).returning({ id: propertiesTable.id });
      await tx.insert(unitsTable).values({ propertyId: p.id, unitNumber: "S-01", ejarId: UNIT_UUID });
      return store.findMatches(userId, { landlord: [], tenant: [], propertyEjarId: PROPERTY_UUID, unitEjarIds: [UNIT_UUID] });
    });
    assert.equal(m.property?.name, "TEST-EJAR-MATCH");
    assert.equal(m.units.length, 1);
    assert.equal(m.units[0].ejarId, UNIT_UUID);
  });

  it("the budget lock serialises lookups", async () => {
    const a = new DrizzleEjarLookupStore(db as never);
    const b = new DrizzleEjarLookupStore(db as never); // a second instance stands in for a second container
    const order: string[] = [];
    const job = (store: DrizzleEjarLookupStore, name: string) => store.withBudgetLock(async () => {
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`${name}:out`);
    });
    await Promise.all([job(a, "a"), job(b, "b"), job(a, "c")]);
    for (let i = 0; i < order.length; i += 2) {
      assert.equal(order[i].split(":")[0], order[i + 1].split(":")[0], `no overlap: ${order.join(",")}`);
    }
  });
});
