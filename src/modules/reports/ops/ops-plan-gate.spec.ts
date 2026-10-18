import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import { catalog } from "./ops-catalog";
import { OpsPlanGateInterceptor, gateCatalog, lockedFeature, teaserOf } from "./ops-plan-gate";

const LOCKED = ["defaulting_tenants", "tenant_payment_behavior", "landlord_portfolio", "property_performance", "occupancy_trend", "contract_movement"];

class TestGate extends OpsPlanGateInterceptor {
  asked: number[] = [];
  constructor(private readonly plans: Record<number, string | null>) { super(null as any); }
  protected override async planOf(ownerId: number) { this.asked.push(ownerId); return this.plans[ownerId] ?? null; }
}

const ctxFor = (user: any, params: Record<string, string> = {}) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user, params }) }) }) as any;
const handlerOf = (value: unknown) => {
  const h = { calls: 0, handle: () => { h.calls++; return value instanceof Error ? throwError(() => value) : of(value); } };
  return h;
};

const holder = (id: number) => ({ id, ownerUserId: null });
const report = {
  id: "defaulting_tenants", rows: [{ tenant: "X", overdue: 5000 }], columns: [],
  kpis: [
    { key: "tenants", label: { ar: "مستأجرون", en: "Tenants" }, value: 4, unit: "count" },
    { key: "overdue", label: { ar: "متأخر", en: "Overdue" }, value: 38000, unit: "sar", tone: "bad" },
    { key: "oldest", label: { ar: "أقدم", en: "Oldest" }, value: 120, unit: "days" },
  ],
};

async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  assert.fail("expected a rejection");
}

describe("ops reports plan gate (advanced_reports)", () => {
  it("lockedFeature: the six analysis reports on basic/tenant only", () => {
    for (const id of LOCKED) {
      assert.equal(lockedFeature(id, "basic"), "advanced_reports");
      assert.equal(lockedFeature(id, "tenant"), "advanced_reports");
      assert.equal(lockedFeature(id, "professional"), null);
      assert.equal(lockedFeature(id, null), null);
    }
    for (const id of ["tenant_balances", "vacant_units", "contracts_report", "expiring_contracts", "collections_summary", "installments_schedule", "maintenance_requests", "data_quality"]) {
      assert.equal(lockedFeature(id, "basic"), null, id);
    }
  });

  it("catalog: every entry carries locked + requiredPlan for the plan", () => {
    const basic = gateCatalog(catalog("2026-10-18"), "basic");
    assert.equal(basic.reports.length, 14);
    for (const r of basic.reports) {
      const want = LOCKED.includes(r.id);
      assert.equal(r.locked, want, r.id);
      assert.equal(r.requiredPlan, want ? "professional" : null, r.id);
      assert.ok(r.defaults && r.label, "the existing fields stay");
    }
    for (const r of gateCatalog(catalog("2026-10-18"), "enterprise").reports) {
      assert.equal(r.locked, false);
      assert.equal(r.requiredPlan, null);
    }
  });

  it("teaserOf keeps at most two KPI objects unchanged, never rows", () => {
    const t = teaserOf(report)!;
    assert.deepEqual(t, { kpis: report.kpis.slice(0, 2) });
    assert.equal((t as any).rows, undefined);
    assert.equal(teaserOf({}), null);
  });

  it("GET /reports/ops decorates the catalog with the OWNER's plan (employee → owner)", async () => {
    const gate = new TestGate({ 7: "basic" });
    const body: any = await firstValueFrom(gate.intercept(ctxFor({ id: 70, ownerUserId: 7 }), handlerOf(catalog("2026-10-18"))));
    assert.deepEqual(gate.asked, [7]);
    assert.equal(body.reports.find((r: any) => r.id === "defaulting_tenants").locked, true);
    assert.equal(body.reports.find((r: any) => r.id === "tenant_balances").locked, false);
  });

  it("a locked report → 403 PLAN_UPGRADE_REQUIRED with a two-KPI teaser of the caller's own report", async () => {
    const gate = new TestGate({ 5: "basic" });
    const e = await rejection(firstValueFrom(gate.intercept(ctxFor(holder(5), { id: "defaulting_tenants" }), handlerOf(report))));
    assert.ok(e instanceof ForbiddenException);
    assert.equal(e.getStatus(), 403);
    const b: any = e.getResponse();
    assert.equal(b.statusCode, 403);
    assert.equal(b.code, "PLAN_UPGRADE_REQUIRED");
    assert.equal(b.feature, "advanced_reports");
    assert.equal(b.requiredPlan, "professional");
    assert.equal(typeof b.message, "string");
    assert.deepEqual(b.teaser, { kpis: report.kpis.slice(0, 2) });
    assert.ok(!JSON.stringify(b).includes("rows"));
  });

  it("the teaser is null when the report cannot be built (still 403)", async () => {
    const gate = new TestGate({ 5: "tenant" });
    const e = await rejection(firstValueFrom(gate.intercept(ctxFor(holder(5), { id: "occupancy_trend" }), handlerOf(new BadRequestException("bad")))));
    assert.ok(e instanceof ForbiddenException);
    assert.equal((e.getResponse() as any).teaser, null);
  });

  it("an open report on basic, and every report on professional, pass through untouched", async () => {
    const basic = new TestGate({ 5: "basic" });
    const open = { id: "tenant_balances", kpis: [], rows: [] };
    assert.equal(await firstValueFrom(basic.intercept(ctxFor(holder(5), { id: "tenant_balances" }), handlerOf(open))), open);
    const pro = new TestGate({ 5: "professional" });
    assert.equal(await firstValueFrom(pro.intercept(ctxFor(holder(5), { id: "defaulting_tenants" }), handlerOf(report))), report);
  });

  it("a failed plan read never locks anyone out (reads as the default plan)", async () => {
    const gate = new TestGate({});
    (gate as any).planOf = async () => { throw new Error("db down"); };
    assert.equal(await firstValueFrom(gate.intercept(ctxFor(holder(5), { id: "defaulting_tenants" }), handlerOf(report))), report);
  });
});
