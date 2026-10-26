import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { planDirection } from "./plan-transition.service";
import {
  assertAdminPlanChangeAllowed, assertCustomerPlanChangeAllowed, requestModeMigration, setModeMigrationHandler,
  setPlanChangeHandler, setPlanGuardHandler, signalPlanChanged, type PlanChangeSignal,
} from "./plan-transition-signal";
import { assertNoCommissionOnHolder } from "./owner-mode-guard";
import { installmentBeforeCommissionStart, keepFromCommissionStart, commissionFrom } from "../../common/commission-start";
import type { Sql } from "../finance-v2/hooks/sql";

/** Pure parts of plan transitions: direction, the signal seams, the holder-fee rule and the commission start. */
describe("plan transitions — direction", () => {
  it("is decided by the accounting feature set", () => {
    assert.equal(planDirection(null, "basic"), "initial");
    assert.equal(planDirection("basic", "professional"), "upgrade");
    assert.equal(planDirection("basic", "enterprise"), "upgrade");
    assert.equal(planDirection("professional", "basic"), "downgrade");
    assert.equal(planDirection("enterprise", "tenant"), "downgrade");
    assert.equal(planDirection("professional", "enterprise"), "lateral", "T17: same features");
    assert.equal(planDirection("enterprise", "professional"), "lateral");
    assert.equal(planDirection("basic", "tenant"), "lateral");
    assert.equal(planDirection("broker", "professional"), "lateral", "the unassigned default resolves to professional");
    assert.equal(planDirection("basic", "basic"), "lateral");
  });
});

describe("plan transitions — signal seams", () => {
  afterEach(() => { setPlanChangeHandler(null); setPlanGuardHandler(null); setModeMigrationHandler(null); });

  it("signalPlanChanged is a no-op without a handler, never throws, and ignores bad ids", () => {
    assert.doesNotThrow(() => signalPlanChanged(5, { from: "basic", to: "professional", source: "admin_package_change" }));
    const seen: Array<[number, PlanChangeSignal]> = [];
    setPlanChangeHandler((id, c) => { seen.push([id, c]); throw new Error("handler blew up"); });
    assert.doesNotThrow(() => signalPlanChanged(5, { from: "basic", to: "professional", source: "admin_package_change", actorUserId: 1 }));
    signalPlanChanged(0, { from: null, to: "basic", source: "sweep" });
    signalPlanChanged(null, { from: null, to: "basic", source: "sweep" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 5);
    assert.equal(seen[0][1].actorUserId, 1);
  });

  it("the guards allow everything without a handler, and pass force/reason to it", async () => {
    await assertCustomerPlanChangeAllowed(5, "basic");
    await assertAdminPlanChangeAllowed(5, "basic", true, "x");
    const calls: any[] = [];
    setPlanGuardHandler(async (id, to, viewer, opts) => { calls.push({ id, to, viewer, opts }); });
    await assertCustomerPlanChangeAllowed(5, "basic");
    await assertAdminPlanChangeAllowed(5, "basic", "true", "a reason");
    await assertAdminPlanChangeAllowed(5, "basic", undefined, 42);
    assert.deepEqual(calls, [
      { id: 5, to: "basic", viewer: "customer", opts: {} },
      { id: 5, to: "basic", viewer: "admin", opts: { force: true, reason: "a reason" } },
      { id: 5, to: "basic", viewer: "admin", opts: { force: false, reason: null } },
    ]);
  });

  it("requestModeMigration returns null without a handler and swallows a failing one", async () => {
    assert.equal(await requestModeMigration(5, "x"), null);
    setModeMigrationHandler(async () => { throw new Error("db down"); });
    assert.equal(await requestModeMigration(5, "x"), null);
    setModeMigrationHandler(async () => ({ outcome: "migrated" }));
    assert.deepEqual(await requestModeMigration(5, "x"), { outcome: "migrated" });
  });
});

describe("plan transitions — COMMISSION_ON_OWN_LANDLORD (B5)", () => {
  const code = (fn: () => void) => {
    try { fn(); return null; } catch (e: any) { assert.ok(e instanceof BadRequestException); return (e.getResponse() as any).code; }
  };
  it("refuses a positive fee being SET on the holder, passes a re-send, a clear, and any non-holder", () => {
    assert.equal(code(() => assertNoCommissionOnHolder(true, "5", null)), "COMMISSION_ON_OWN_LANDLORD");
    assert.equal(code(() => assertNoCommissionOnHolder(true, 7.5, "5.00")), "COMMISSION_ON_OWN_LANDLORD");
    assert.equal(code(() => assertNoCommissionOnHolder(true, "5", "5.00")), null, "re-sending the stored value passes");
    assert.equal(code(() => assertNoCommissionOnHolder(true, 0, "5.00")), null, "clearing passes");
    assert.equal(code(() => assertNoCommissionOnHolder(true, null, null)), null);
    assert.equal(code(() => assertNoCommissionOnHolder(false, "5", null)), null);
  });
});

describe("plan transitions — commission start (D1)", () => {
  it("an installment due before the start never carries commission", () => {
    assert.equal(installmentBeforeCommissionStart("2026-05-31", "2026-06-01"), true);
    assert.equal(installmentBeforeCommissionStart("2026-06-01", "2026-06-01"), false);
    assert.equal(installmentBeforeCommissionStart(new Date("2026-07-01T00:00:00Z"), "2026-06-01"), false);
    assert.equal(installmentBeforeCommissionStart("2026-01-01", null), false, "no start = no restriction");
    assert.equal(installmentBeforeCommissionStart(null, "2026-06-01"), false);
  });

  function fakeSql(opts: { table: boolean; from: string | null; due: Record<number, string> }): Sql & { seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      async rows(text: string, params: unknown[] = []): Promise<any[]> {
        seen.push(text);
        if (text.includes("to_regclass")) return [{ ok: opts.table }];
        if (text.includes("from account_plan_changes")) return opts.from ? [{ d: opts.from }] : [];
        if (text.includes("from payments")) return (params[1] as number[]).map((id) => ({ id, due: opts.due[id] ?? null }));
        return [];
      },
      async exec() { return 0; },
    } as Sql & { seen: string[] };
  }

  it("commissionFrom is null before 0090 is applied, and reads the latest upgrade", async () => {
    assert.equal(await commissionFrom(fakeSql({ table: false, from: "2026-06-01", due: {} }), 1), null);
    assert.equal(await commissionFrom(fakeSql({ table: true, from: "2026-06-01", due: {} }), 1), "2026-06-01");
  });

  it("keepFromCommissionStart drops installments due before the start", async () => {
    const q = fakeSql({ table: true, from: "2026-06-01", due: { 1: "2026-05-01", 2: "2026-06-01", 3: "2026-07-01" } });
    assert.deepEqual(await keepFromCommissionStart(q, 9, [1, 2, 3]), [2, 3]);
    const open = fakeSql({ table: true, from: null, due: { 1: "2026-05-01" } });
    assert.deepEqual(await keepFromCommissionStart(open, 9, [1]), [1]);
    assert.ok(!open.seen.some((s) => s.includes("from payments")), "no start date: the installments are not even read");
  });
});
