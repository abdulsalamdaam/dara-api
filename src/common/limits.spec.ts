import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountLimitAddonsTable, accountLimitOverridesTable, ownersTable, usersTable } from "@dara/database";
import {
  addonIsActive, combineLimit, effectiveLimit, effectiveLimits, isLimitKey, LIMIT_KEYS, LIMIT_KEY_LIST, normBase,
} from "./limits";
import { UNLIMITED } from "./packages";

describe("combineLimit", () => {
  it("no override: base + active add-ons", () => {
    assert.equal(combineLimit(2, undefined, 0), 2);
    assert.equal(combineLimit(2, undefined, 3), 5);
  });
  it("an override replaces the base (down or up), add-ons still go on top", () => {
    assert.equal(combineLimit(4, 1, 0), 1);
    assert.equal(combineLimit(4, 10, 2), 12);
    assert.equal(combineLimit(null, 3, 1), 4, "an override caps an otherwise unlimited plan");
  });
  it("unlimited stays unlimited — base or override", () => {
    assert.equal(combineLimit(null, undefined, 5), null);
    assert.equal(combineLimit(2, null, 5), null, "override null = unlimited");
    assert.equal(combineLimit(UNLIMITED, undefined, 1), null, "the UNLIMITED sentinel reads as unlimited");
  });
  it("an override of 0 is a real limit, not 'no override'", () => {
    assert.equal(combineLimit(5, 0, 0), 0);
  });
  it("a negative add-on sum never lowers the limit", () => {
    assert.equal(combineLimit(2, undefined, -3), 2);
  });
});

describe("addonIsActive (read-time)", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const past = "2026-10-01T00:00:00Z";
  const future = "2026-11-01T00:00:00Z";
  it("active between starts_at and ends_at, or with no end", () => {
    assert.equal(addonIsActive({ status: "active", startsAt: past, endsAt: future }, now), true);
    assert.equal(addonIsActive({ status: "active", startsAt: past, endsAt: null }, now), true);
  });
  it("expired, not started, unstarted (null start) or not active → ignored", () => {
    assert.equal(addonIsActive({ status: "active", startsAt: past, endsAt: past }, now), false);
    assert.equal(addonIsActive({ status: "active", startsAt: future, endsAt: null }, now), false);
    assert.equal(addonIsActive({ status: "active", startsAt: null, endsAt: null }, now), false);
    for (const status of ["offered", "pending_payment", "cancelled", "expired"]) {
      assert.equal(addonIsActive({ status, startsAt: past, endsAt: future }, now), false, status);
    }
  });
});

describe("registry", () => {
  it("three keys, and only they are limit keys", () => {
    assert.deepEqual([...LIMIT_KEY_LIST], ["users", "landlords", "ejar_lookups"]);
    assert.equal(LIMIT_KEYS.ejar_lookups.window, "period");
    assert.equal(LIMIT_KEYS.users.window, "none");
    assert.ok(isLimitKey("landlords"));
    assert.ok(!isLimitKey("ejar.enabled"));
    assert.ok(!isLimitKey("properties"));
  });
  it("normBase", () => {
    assert.equal(normBase(UNLIMITED), null);
    assert.equal(normBase(undefined), null);
    assert.equal(normBase(3), 3);
  });
});

/** A fake Drizzle: account row, counts, overrides/add-ons, and the Ejar usage query (`execute`). */
function fakeDb(o: {
  plan: string; cycle?: string; startedAt?: Date | null; endsAt?: Date | null;
  seats: number; landlords: number; ejarCalls?: number;
  overrides?: Array<{ limitKey: string; value: number | null }>;
  addons?: Array<{ limitKey: string; quantity: number; status: string; startsAt: Date | null; endsAt: Date | null }>;
}) {
  const thenable = (rows: unknown[]) => Object.assign(Promise.resolve(rows), { limit: async () => rows });
  return {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === usersTable && "packagePlan" in fields) {
            return thenable([{
              packagePlan: o.plan, billingCycle: o.cycle ?? "yearly",
              subscriptionStartedAt: o.startedAt ?? null, subscriptionEndsAt: o.endsAt ?? null,
            }]);
          }
          if (table === usersTable) return thenable([{ c: o.seats }]);
          if (table === ownersTable) return thenable([{ c: o.landlords }]);
          if (table === accountLimitOverridesTable) return thenable(o.overrides ?? []);
          if (table === accountLimitAddonsTable) return thenable(o.addons ?? []);
          throw new Error("unexpected table");
        },
      }),
    }),
    execute: async () => [{ endpoint: "rentalContractInvoices", total: 99, account: o.ejarCalls ?? 0 }],
  } as any;
}

describe("effectiveLimits", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const period = { startedAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2027-01-01T00:00:00Z") };
  const active = (limitKey: string, quantity: number) =>
    ({ limitKey, quantity, status: "active", startsAt: new Date("2026-10-02T00:00:00Z"), endsAt: period.endsAt });

  it("the package alone: base = effective, no override, no add-ons", async () => {
    const ls = await effectiveLimits(fakeDb({ plan: "basic", cycle: "quarterly", ...period, seats: 1, landlords: 1, ejarCalls: 5 }), 7, { now });
    const by = Object.fromEntries(ls.map((l) => [l.key, l]));
    assert.deepEqual(by.users, {
      key: "users", base: 2, override: null, addons: 0, effective: 2, used: 1, remaining: 1, over: false, window: "none", resetsAt: null,
    });
    assert.equal(by.landlords.effective, 1);
    assert.equal(by.landlords.remaining, 0);
    // basic quarterly = floor(90 × 3/12) = 22, counted over the paid period.
    assert.equal(by.ejar_lookups.base, 22);
    assert.equal(by.ejar_lookups.effective, 22);
    assert.equal(by.ejar_lookups.used, 5);
    assert.equal(by.ejar_lookups.window, "period");
    assert.equal(by.ejar_lookups.resetsAt, period.endsAt.toISOString());
  });

  it("override down below usage → over, remaining 0; an Ejar pack adds to the period quota", async () => {
    const db = fakeDb({
      plan: "professional", cycle: "yearly", ...period, seats: 4, landlords: 3, ejarCalls: 150,
      overrides: [{ limitKey: "users", value: 2 }], addons: [active("ejar_lookups", 50)],
    });
    const users = await effectiveLimit(db, 7, "users", now);
    assert.equal(users.base, 4);
    assert.equal(users.override, 2);
    assert.equal(users.effective, 2);
    assert.equal(users.over, true);
    assert.equal(users.remaining, 0);
    const ejar = await effectiveLimit(db, 7, "ejar_lookups", now);
    assert.equal(ejar.base, 150);
    assert.equal(ejar.addons, 50);
    assert.equal(ejar.effective, 200);
    assert.equal(ejar.remaining, 50);
  });

  it("unlimited plans stay unlimited; usage still reads", async () => {
    const ls = await effectiveLimits(fakeDb({ plan: "enterprise", ...period, seats: 30, landlords: 12, ejarCalls: 7, addons: [active("users", 3)] }), 7, { now });
    for (const l of ls) {
      assert.equal(l.effective, null, l.key);
      assert.equal(l.remaining, null, l.key);
      assert.equal(l.over, false, l.key);
    }
    assert.equal(ls.find((l) => l.key === "users")!.addons, 3);
    assert.equal(ls.find((l) => l.key === "ejar_lookups")!.used, 7);
  });

  it("an override can cap an uncapped plan's Ejar quota", async () => {
    const l = await effectiveLimit(fakeDb({ plan: "enterprise", ...period, seats: 1, landlords: 0, ejarCalls: 10, overrides: [{ limitKey: "ejar_lookups", value: 10 }] }), 7, "ejar_lookups", now);
    assert.equal(l.base, null);
    assert.equal(l.effective, 10);
    assert.equal(l.remaining, 0);
    assert.equal(l.over, false, "at the limit is not over it");
  });
});
