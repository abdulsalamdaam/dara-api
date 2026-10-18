import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import { ownersTable, usersTable } from "@dara/database";
import {
  assertWithinQuota, planLimits, planLimitLandlordsBody, PlanLimitLandlordsException,
} from "./quota";

/**
 * The landlord cap (عقاري = exactly one landlord) and the seat numbers, over a
 * tiny fake Drizzle: `select(fields).from(table).where()` answers from the
 * numbers given. Counts are what the real queries return — live owners rows of
 * the account / the account holder + its employees.
 */
function fakeDb(o: { plan: string | null; landlords: number; seats?: number }) {
  const counted: string[] = [];
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === usersTable && "packagePlan" in fields) return [{ packagePlan: o.plan }];
          if (table === usersTable) { counted.push("users"); return [{ c: o.seats ?? 1 }]; }
          if (table === ownersTable) { counted.push("owners"); return [{ c: o.landlords }]; }
          throw new Error("unexpected table");
        },
      }),
    }),
  };
  return { db: db as any, counted };
}

async function thrown(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  return null;
}

describe("landlord cap (CONTRACT2 §5)", () => {
  it("basic (عقاري) may create its first landlord", async () => {
    const { db } = fakeDb({ plan: "basic", landlords: 0 });
    await assertWithinQuota(db, 7, "landlords");
  });

  it("basic at one landlord is refused with the exact 403 body", async () => {
    const { db } = fakeDb({ plan: "basic", landlords: 1 });
    const e = await thrown(assertWithinQuota(db, 7, "landlords"));
    assert.ok(e instanceof PlanLimitLandlordsException);
    assert.ok(e instanceof ForbiddenException);
    assert.equal(e.getStatus(), 403);
    const body = e.getResponse() as any;
    assert.deepEqual(Object.keys(body).sort(), ["code", "limit", "message", "requiredPlan", "statusCode"]);
    assert.equal(body.statusCode, 403);
    assert.equal(body.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(body.requiredPlan, "professional");
    assert.equal(body.limit, 1);
    assert.match(body.message, /مؤجرًا واحدًا/);
    assert.match(body.message, /المكاتب العقارية/);
    assert.equal(e.message, body.message, "the Arabic message is the exception message too (bulk import reports it per row)");
  });

  it("an existing basic account above the cap keeps its rows but cannot add", async () => {
    const { db } = fakeDb({ plan: "basic", landlords: 3 });
    const e = await thrown(assertWithinQuota(db, 7, "landlords"));
    assert.equal(e?.getResponse()?.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(e?.getResponse()?.limit, 1);
  });

  it("tenant, professional, enterprise and the unassigned default are unlimited — no count is even run", async () => {
    for (const plan of ["tenant", "professional", "enterprise", "broker", null]) {
      const { db, counted } = fakeDb({ plan, landlords: 500 });
      await assertWithinQuota(db, 7, "landlords");
      assert.deepEqual(counted, [], String(plan));
    }
  });

  it("the Ejar import variant says why, same shape", () => {
    const b = planLimitLandlordsBody(1, "عقاري", "ejar_import");
    assert.equal(b.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(b.requiredPlan, "professional");
    assert.equal(b.limit, 1);
    assert.match(b.message, /مؤجر هذا العقد/);
  });
});

describe("seat cap numbers (CONTRACT2 §4)", () => {
  it("professional is now 4 seats — the fifth is refused", async () => {
    await assertWithinQuota(fakeDb({ plan: "professional", landlords: 0, seats: 3 }).db, 7, "users");
    const e = await thrown(assertWithinQuota(fakeDb({ plan: "professional", landlords: 0, seats: 4 }).db, 7, "users"));
    assert.ok(e instanceof ForbiddenException);
  });
  it("basic is 2, tenant 1; an account above the cap cannot add", async () => {
    assert.ok(await thrown(assertWithinQuota(fakeDb({ plan: "basic", landlords: 0, seats: 2 }).db, 7, "users")));
    assert.ok(await thrown(assertWithinQuota(fakeDb({ plan: "tenant", landlords: 0, seats: 1 }).db, 7, "users")));
    assert.ok(await thrown(assertWithinQuota(fakeDb({ plan: "professional", landlords: 0, seats: 6 }).db, 7, "users")));
  });
});

describe("planLimits — what /me/package returns as `limits`", () => {
  it("basic: one landlord, two seats; canAdd follows usage", async () => {
    assert.deepEqual(await planLimits(fakeDb({ plan: "basic", landlords: 0, seats: 1 }).db, 7), {
      landlords: { used: 0, limit: 1, canAdd: true }, users: { used: 1, limit: 2, canAdd: true },
    });
    assert.deepEqual(await planLimits(fakeDb({ plan: "basic", landlords: 2, seats: 3 }).db, 7), {
      landlords: { used: 2, limit: 1, canAdd: false }, users: { used: 3, limit: 2, canAdd: false },
    });
  });
  it("unlimited reads as null", async () => {
    const l = await planLimits(fakeDb({ plan: "enterprise", landlords: 9, seats: 9 }).db, 7);
    assert.deepEqual(l, { landlords: { used: 9, limit: null, canAdd: true }, users: { used: 9, limit: null, canAdd: true } });
    const p = await planLimits(fakeDb({ plan: null, landlords: 0, seats: 1 }).db, 7, "professional");
    assert.deepEqual(p.users, { used: 1, limit: 4, canAdd: true });
    assert.equal(p.landlords.limit, null);
  });
});
