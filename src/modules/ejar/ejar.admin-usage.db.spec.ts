/**
 * Admin › Ejar usage against a real database (rolled back): outcome labels,
 * success-only deduction, the pool, and the account → user roll-up.
 * Skipped when DATABASE_URL is unset.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, getPool, usersTable, ejarApiLogsTable } from "@dara/database";
import { AdminEjarUsageController } from "./ejar.admin-usage.controller";

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

describe("AdminEjarUsageController (database, rolled back)", { skip: !HAS_DB && "DATABASE_URL not set" }, () => {
  after(async () => { await getPool().end(); });

  it("labels every call, deducts successes only, and rolls usage up account → user", async () => {
    const out = await inRollback(async (tx) => {
      const tag = `ejar-usage-${Date.now()}`;
      const [owner] = await tx.insert(usersTable).values({ email: `${tag}@x.test`, name: "Owner Co", passwordHash: "x" } as never).returning();
      const [emp] = await tx.insert(usersTable).values({ email: `${tag}-e@x.test`, name: "Employee", passwordHash: "x", ownerUserId: owner.id } as never).returning();
      const row = (userId: number | null, endpoint: string, status: number | null, extra: Record<string, unknown> = {}) =>
        ({ userId, env: "balady-stg", endpoint, method: "GET", url: "x", status, params: { contractNumber: "10000000001" }, ...extra });
      await tx.insert(ejarApiLogsTable).values([
        row(owner.id, "rentalContractInvoices", 200),
        row(emp.id, "getRentalContracts", 200),
        row(emp.id, "rentalContractInvoices", 400),
        row(emp.id, "rentalContractInvoices", 503, { error: "unavailable" }),
        row(owner.id, "contractDetails", null, { error: "fetch failed" }),
        row(owner.id, "contractDetails", 401),
        { ...row(emp.id, "rentalContractInvoices", 403), env: "blocked" },
      ]);
      const c = new AdminEjarUsageController(tx as never);
      await c.setPool({ id: owner.id } as never, { total: 500, since: "2020-01-01" });
      const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
      const sum = await c.summary({ accountId: String(owner.id), from: today, to: today });
      const errors = await c.calls({ accountId: String(owner.id), from: today, outcome: "server_error" });
      return { sum, errors, ownerId: owner.id, empId: emp.id };
    });
    const t = out.sum.totals as Record<string, number>;
    assert.equal(t.calls, 7);
    assert.equal(t.deducted, 2);
    assert.equal(t.success, 2);
    assert.equal(t.wrongNumber, 1);
    assert.equal(t.serverError, 1);
    assert.equal(t.network, 1);
    assert.equal(t.clientError, 1);
    assert.equal(t.blocked, 1);
    assert.equal(t.contracts, 1);
    assert.equal(out.sum.pool.total, 500);
    assert.ok(out.sum.pool.used >= 2 && out.sum.pool.remaining === 500 - out.sum.pool.used);
    assert.equal(out.sum.byAccount.length, 1);
    const acc = out.sum.byAccount[0] as Record<string, any>;
    assert.equal(acc.accountId, out.ownerId);
    assert.equal(acc.deducted, 2);
    assert.equal(acc.users.length, 2);
    assert.equal(acc.users.find((u: any) => u.userId === out.empId).deducted, 1);
    assert.equal(out.errors.total, 1);
    assert.equal((out.errors.data[0] as any).outcome, "server_error");
    assert.equal((out.errors.data[0] as any).deducted, false);
  });
});
