import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";
import * as schema from "../../../../db/src/schema";
import { LEGACY_FULL } from "../../finance-v2/__tests__/with-db";
import { PermissionsGuard } from "../../../common/permissions.decorator";
import { OpsReportsController, runOpsReport } from "./ops-reports.module";
import type { OpsReport } from "./ops-core";
import { A, B, T, d, seed, type Ids } from "./__tests__/ops-fixtures";
import { OPS_DEFS } from "./ops-catalog";

/**
 * Operational reports against a REAL, throwaway, LOCAL Postgres. Synthetic,
 * hand-built fixtures for two accounts; every figure asserted exactly.
 *
 *   OPS_TEST_DATABASE_URL=postgres://you@localhost/dara_ops_reports_test pnpm test
 *
 * (FV2_TEST_DATABASE_URL is accepted too.) Anything but localhost is refused,
 * so the production DATABASE_URL in .env can never be reached. Each run gets
 * a fresh schema, dropped at the end.
 */
const URL = process.env.OPS_TEST_DATABASE_URL ?? process.env.FV2_TEST_DATABASE_URL ?? "";
const LOCAL = /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? "OPS_TEST_DATABASE_URL not set" : !LOCAL ? "OPS_TEST_DATABASE_URL must point at localhost" : false;

describe("operational reports (real Postgres, synthetic fixtures)", { skip }, () => {
  let pool: pg.Pool;
  let schemaName: string;
  let db: any;
  let ids: Ids;
  const run = (uid: number, id: string, raw: Record<string, unknown> = {}) => runOpsReport(db, uid, id, raw) as Promise<OpsReport>;
  const kpis = (r: OpsReport) => Object.fromEntries(r.kpis.map((k) => [k.key, k.value]));
  const byKey = (r: OpsReport, key: string) => Object.fromEntries(r.rows.map((x) => [String(x[key]), x]));

  before(async () => {
    schemaName = `ops_test_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`create schema ${schemaName}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: URL, max: 4, options: `-c search_path=${schemaName}` });
    await pool.query(readFileSync(LEGACY_FULL, "utf8"));
    db = drizzle(pool, { schema });
    ids = await seed(async (s, p) => (await pool.query(s, p as any[])).rows);
  });
  after(async () => {
    await pool?.end();
    if (schemaName) {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      await c.query(`drop schema if exists ${schemaName} cascade`);
      await c.end();
    }
  });

  it("every catalog id builds, with the contract's shape", async () => {
    for (const def of OPS_DEFS) {
      const r = await run(A, def.id);
      assert.equal(r.id, def.id);
      assert.ok(Array.isArray(r.kpis) && Array.isArray(r.charts) && Array.isArray(r.columns) && Array.isArray(r.rows), def.id);
      assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      const keys = new Set(r.columns.map((c) => c.key));
      for (const row of r.rows) for (const k of Object.keys(row)) assert.ok(keys.has(k) || keys.has(k.replace(/En$/, "")) || ["ym", "measuredOn"].includes(k), `${def.id}: stray row key ${k}`);
      for (const k of r.kpis) assert.equal(typeof k.value, "number", `${def.id}.${k.key}`);
    }
  });

  it("tenant_balances", async () => {
    const r = await run(A, "tenant_balances");
    assert.equal(r.params.asOf, T);
    assert.deepEqual(r.rows.map((x) => x.tenant), ["Tenant Badr", "Tenant Ali", "Tenant Cyan"]);
    const t = byKey(r, "tenant");
    assert.deepEqual(t["Tenant Ali"], { tenant: "Tenant Ali", phone: "0501", activeContracts: 1, billed: 4800, collected: 3200, outstanding: 1600, overdue: 1600, oldestOverdueDays: 40 });
    assert.deepEqual(t["Tenant Badr"], { tenant: "Tenant Badr", phone: null, activeContracts: 1, billed: 4000, collected: 2000, outstanding: 2000, overdue: 2000, oldestOverdueDays: 95 });
    assert.deepEqual(t["Tenant Cyan"], { tenant: "Tenant Cyan", phone: "0503", activeContracts: 0, billed: 500, collected: 500, outstanding: 0, overdue: 0, oldestOverdueDays: null });
    assert.deepEqual(r.totals, { activeContracts: 2, billed: 9300, collected: 5700, outstanding: 3600, overdue: 3600 });
    assert.equal(kpis(r).collectionRate, 61.3);
    // As of 45 days ago: I3 (due −40) and I4 not billed yet; I2's money came in at −60.
    const past = byKey(await run(A, "tenant_balances", { asOf: d(-45) }), "tenant");
    assert.deepEqual([past["Tenant Ali"].billed, past["Tenant Ali"].collected, past["Tenant Ali"].overdue, past["Tenant Ali"].activeContracts], [2800, 2800, 0, 2]);
  });

  it("defaulting_tenants with aging", async () => {
    const r = await run(A, "defaulting_tenants");
    assert.deepEqual(r.rows, [
      { tenant: "Tenant Badr", phone: null, overdueCount: 1, overdueAmount: 2000, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 2000, maxDaysLate: 95, lastPaymentDate: d(-148) },
      { tenant: "Tenant Ali", phone: "0501", overdueCount: 2, overdueAmount: 1600, d1_30: 1000, d31_60: 600, d61_90: 0, d90_plus: 0, maxDaysLate: 40, lastPaymentDate: d(-35) },
    ]);
    assert.deepEqual(r.totals, { overdueCount: 3, overdueAmount: 3600, d1_30: 1000, d31_60: 600, d61_90: 0, d90_plus: 2000 });
    assert.deepEqual(r.charts[0].data.map((x) => x.amount), [1000, 600, 0, 2000]);
  });

  it("tenant_payment_behavior", async () => {
    const r = await run(A, "tenant_payment_behavior");
    const t = byKey(r, "tenant");
    assert.deepEqual(t["Tenant Ali"], { tenant: "Tenant Ali", phone: "0501", due: 5, onTime: 2, late: 1, unpaid: 2, onTimeRate: 40, avgDaysLate: 10 });
    assert.deepEqual(t["Tenant Badr"], { tenant: "Tenant Badr", phone: null, due: 2, onTime: 0, late: 1, unpaid: 1, onTimeRate: 0, avgDaysLate: 2 });
    assert.deepEqual(t["Tenant Cyan"], { tenant: "Tenant Cyan", phone: "0503", due: 1, onTime: 1, late: 0, unpaid: 0, onTimeRate: 100, avgDaysLate: null });
    const k = kpis(r);
    assert.deepEqual([k.due, k.onTimeRate, k.late, k.unpaid, k.avgDaysLate], [8, 37.5, 2, 3, 6]);
  });

  it("landlord_portfolio", async () => {
    const r = await run(A, "landlord_portfolio");
    assert.deepEqual(r.rows, [
      { landlord: "Landlord One", phone: "0551", properties: 1, units: 3, rented: 2, occupancy: 66.7, activeContracts: 2, annualRent: 36000, billed: 8500, collected: 4900, outstanding: 3600 },
      { landlord: "Landlord Two", phone: null, properties: 1, units: 1, rented: 0, occupancy: 0, activeContracts: 0, annualRent: 0, billed: 0, collected: 0, outstanding: 0 },
    ]);
    assert.equal(kpis(r).occupancy, 50);
  });

  it("vacant_units", async () => {
    const r = await run(A, "vacant_units");
    assert.deepEqual(r.rows, [
      { property: "Tower A", unit: "U3", type: null, typeEn: null, usage: "سكني", usageEn: "Residential", area: 90, daysVacant: 35, lastAnnualRent: 6000, status: "available" },
      { property: "Villa B", unit: "U4", type: "شقة", typeEn: "Apartment", usage: "سكني", usageEn: "Residential", area: 200, daysVacant: null, lastAnnualRent: null, status: "available" },
    ]);
    const k = kpis(r);
    assert.deepEqual([k.vacant, k.units, k.vacancy, k.lostRent], [2, 4, 50, 575.34]);
  });

  it("property_performance", async () => {
    const r = await run(A, "property_performance");
    assert.deepEqual(r.rows, [
      { property: "Tower A", units: 3, rented: 2, vacant: 1, occupancy: 66.7, activeContracts: 2, annualRent: 36000, billed: 8500, collected: 4900, outstanding: 3600, collectionRate: 57.6 },
      { property: "Villa B", units: 1, rented: 0, vacant: 1, occupancy: 0, activeContracts: 0, annualRent: 0, billed: 0, collected: 0, outstanding: 0, collectionRate: null },
    ]);
    assert.deepEqual(r.totals, { units: 4, rented: 2, vacant: 2, activeContracts: 2, annualRent: 36000, billed: 8500, collected: 4900, outstanding: 3600 });
  });

  it("occupancy_trend", async () => {
    const r = await run(A, "occupancy_trend");
    assert.equal(r.rows.length, 12);
    const last = r.rows[r.rows.length - 1];
    assert.deepEqual([last.measuredOn, last.units, last.occupied, last.occupancy], [T, 4, 2, 50]);
    const m = r.rows.find((x) => x.ym === d(-100).slice(0, 7))!;
    assert.deepEqual([m.units, m.occupied, m.occupancy], [4, 3, 75]);
  });

  it("contracts_report with status filter", async () => {
    const all = await run(A, "contracts_report");
    const k = kpis(all);
    assert.deepEqual([k.total, k.active, k.expired, k.terminated, k.cancelled, k.pending, k.activeAnnualRent], [5, 2, 1, 1, 1, 0, 36000]);
    assert.equal(all.totals!.annualRent, 60000);
    assert.ok(!all.rows.some((x) => x.contractNumber === "C-5"), "drafts excluded");
    const act = await run(A, "contracts_report", { status: "active" });
    assert.deepEqual(act.rows.map((x) => [x.contractNumber, x.daysRemaining, x.status, x.property, x.landlord]), [["C-2", 40, "active", "Tower A", "Landlord One"], ["C-1", 165, "active", "Tower A", "Landlord One"]]);
    assert.equal(act.params.status, "active");
    assert.equal(act.statusOptions?.length, 6);
    await assert.rejects(run(A, "contracts_report", { status: "bogus" }), (e: any) => e.getStatus() === 400);
  });

  it("contracts_report: the status filter narrows the KPIs and chart, not only the rows", async () => {
    const exp = await run(A, "contracts_report", { status: "expired" });
    assert.deepEqual(exp.rows.map((x) => x.contractNumber), ["C-3"]);
    const k = kpis(exp);
    assert.deepEqual([k.total, k.active, k.expired, k.terminated, k.cancelled, k.activeAnnualRent], [1, 0, 1, 0, 0, 0]);
    const donut = exp.charts[0].data.filter((x) => (x.value as number) > 0).map((x) => x.labelEn);
    assert.deepEqual(donut, ["Expired"]);
  });

  it("contracts_report: the as-of date moves the status (not started yet / was still in force)", async () => {
    const r = await run(A, "contracts_report", { asOf: d(-180) });
    const st = Object.fromEntries(r.rows.map((x) => [x.contractNumber, x.status]));
    // C-2 starts at -150: not started on -180. C-3 ran -400..-35: active then. C-4 was terminated at -20: in force on -180.
    assert.deepEqual(st, { "C-1": "active", "C-2": "upcoming", "C-3": "active", "C-4": "active", "C-6": "cancelled" });
    const act = await run(A, "contracts_report", { asOf: d(-180), status: "active" });
    assert.deepEqual(act.rows.map((x) => x.contractNumber).sort(), ["C-1", "C-3", "C-4"]);
    assert.ok(act.rows.every((x) => x.status === "active"));
    assert.equal(kpis(act).active, 3);
  });

  it("expiring_contracts", async () => {
    const r = await run(A, "expiring_contracts");
    assert.deepEqual(r.params.days, 90);
    assert.deepEqual(r.rows.map((x) => [x.contractNumber, x.daysRemaining, x.bucket, x.annualRent]), [["C-2", 40, "d31_60", 24000]]);
    const wide = await run(A, "expiring_contracts", { days: "200" });
    assert.deepEqual(wide.rows.map((x) => [x.contractNumber, x.bucket]), [["C-2", "d31_60"], ["C-1", "d90_plus"]]);
  });

  it("contract_movement", async () => {
    const r = await run(A, "contract_movement");
    assert.deepEqual(r.totals, { started: 3, ended: 1, terminated: 1, net: 1 });
    assert.equal(kpis(r).activeNow, 2);
    assert.equal(r.rows.find((x) => x.ym === d(-20).slice(0, 7))!.terminated, 1);
  });

  it("collections_summary", async () => {
    const r = await run(A, "collections_summary");
    assert.deepEqual(r.totals, { due: 9300, collected: 5700, outstanding: 3600 });
    const k = kpis(r);
    assert.deepEqual([k.overdue, k.collectionRate], [3600, 61.3]);
    const monthSum = r.rows.reduce((s, x) => s + (x.due as number), 0);
    assert.equal(monthSum, 9300);
    const byProp = Object.fromEntries(r.charts[1].data.map((x) => [x.label, x]));
    assert.deepEqual([byProp["Tower A"].collected, byProp["Tower A"].outstanding, byProp["بلا عقار مرتبط"].collected, byProp["بلا عقار مرتبط"].labelEn], [4900, 3600, 800, "No linked property"]);
  });

  it("installments_schedule with live status", async () => {
    const r = await run(A, "installments_schedule", { from: d(-200), to: d(30) });
    assert.equal(r.rows.length, 9);
    const k = kpis(r);
    assert.deepEqual([k.paidCount, k.partialCount, k.pendingCount, k.overdueCount, k.cancelledCount], [4, 1, 1, 2, 1]);
    assert.deepEqual([k.due, k.collected, k.remaining, k.overdueAmount], [9800, 5200, 4600, 3600]);
    assert.deepEqual(r.totals, { amount: 9800, collected: 5200, remaining: 4600 });
    const od = await run(A, "installments_schedule", { from: d(-200), to: d(30), status: "overdue" });
    assert.deepEqual(od.rows.map((x) => [x.dueDate, x.remaining, x.daysLate]), [[d(-95), 2000, 95], [d(-10), 1000, 10]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    // The status filter narrows the KPIs and the chart too.
    const ok = kpis(od);
    assert.deepEqual([ok.paidCount, ok.partialCount, ok.pendingCount, ok.overdueCount, ok.cancelledCount], [0, 0, 0, 2, 0]);
    assert.deepEqual([ok.due, ok.remaining, ok.overdueAmount], [3000, 3000, 3000]);
    assert.deepEqual(od.totals, { amount: 3000, collected: 0, remaining: 3000 });
    const lateDays = Object.fromEntries(r.rows.map((x) => [x.dueDate, x.daysLate]));
    assert.deepEqual([lateDays[d(-70)], lateDays[d(-150)], lateDays[d(-100)], lateDays[d(-40)]], [10, 2, null, 40]);
    const def = await run(A, "installments_schedule");
    assert.equal(def.params.from, `${T.slice(0, 7)}-01`);
  });

  it("maintenance_requests", async () => {
    const r = await run(A, "maintenance_requests");
    const k = kpis(r);
    assert.deepEqual([k.total, k.open, k.closed, k.avgResolutionDays], [3, 2, 1, 10]);
    const done = r.rows.find((x) => x.status === "completed")!;
    assert.deepEqual([done.opened, done.closed, done.daysOpen, done.property], [d(-30), d(-20), 10, "Tower A"]);
    const done1 = await run(A, "maintenance_requests", { status: "completed" });
    assert.deepEqual([kpis(done1).total, kpis(done1).open, kpis(done1).closed], [1, 0, 1]);
    const p1 = await run(A, "maintenance_requests", { propertyId: String(ids.P1) });
    assert.equal(p1.rows.length, 2);
    assert.ok(!r.rows.some((x) => String(x.description).includes("Bee")));
  });

  it("data_quality", async () => {
    const r = await run(A, "data_quality");
    const k = kpis(r);
    assert.deepEqual(
      [k.records, k.contract_no_ejar, k.contract_no_unit, k.unit_no_type, k.unit_no_usage, k.tenant_no_phone, k.tenant_no_id, k.property_no_deed, k.property_no_landlord, k.landlord_no_iban, k.landlord_no_id],
      [8, 2, 0, 1, 1, 1, 1, 1, 0, 1, 1],
    );
    assert.deepEqual(r.rows.map((x) => x.entity), ["contract", "contract", "unit", "unit", "tenant", "tenant", "property", "landlord"]);
  });

  it("ownerId / propertyId narrow within the account", async () => {
    const p2 = await run(A, "property_performance", { ownerId: String(ids.O2) });
    assert.deepEqual(p2.rows.map((x) => x.property), ["Villa B"]);
    const bal = await run(A, "tenant_balances", { propertyId: String(ids.P1) });
    // C4 (terminated, unlinked) drops out under a property filter → Ali loses the 800.
    assert.equal(byKey(bal, "tenant")["Tenant Ali"].billed, 4000);
    const dq = await run(A, "data_quality", { ownerId: String(ids.O2) });
    assert.deepEqual(dq.rows.map((x) => [x.entity, x.record]), [["property", "Villa B"], ["landlord", "Landlord Two"]]);
  });

  it("scoping: account B never sees account A, even when passing A's ownerId / propertyId", async () => {
    for (const def of OPS_DEFS) {
      for (const raw of [{ ownerId: String(ids.O1) }, { propertyId: String(ids.P1) }, { ownerId: String(ids.O1), propertyId: String(ids.P1) }]) {
        const r = await run(B, def.id, raw);
        const blob = JSON.stringify(r.rows);
        assert.ok(!/Tower A|Villa B|Tenant Ali|Tenant Badr|Tenant Cyan|Landlord One|Landlord Two|C-\d/.test(blob), `${def.id} ${JSON.stringify(raw)} leaked: ${blob.slice(0, 200)}`);
        if (def.id !== "occupancy_trend" && def.id !== "contract_movement" && def.id !== "collections_summary") assert.equal(r.rows.length, 0, `${def.id} ${JSON.stringify(raw)}`);
      }
      const own = JSON.stringify((await run(B, def.id)).rows);
      assert.ok(!/Tower A|Tenant Ali|Landlord One/.test(own), `${def.id} unfiltered leaked`);
      const a = JSON.stringify((await run(A, def.id)).rows);
      assert.ok(!/Bee/.test(a), `${def.id}: A sees B`);
    }
    // B's own figures are its own.
    const bb = await run(B, "tenant_balances");
    assert.deepEqual(bb.rows.map((x) => [x.tenant, x.overdue]), [["Tenant Bee", 5000]]);
    const ba = await run(A, "tenant_balances", { ownerId: String(ids.OB) });
    assert.equal(ba.rows.length, 0);
  });

  it("a team member reads the account holder's scope; without reports.view the guard refuses", async () => {
    const ctl = new OpsReportsController(db);
    const member = { id: 99999, ownerUserId: A, permissions: ["reports.view"] } as any;
    const r = await ctl.one(member, "tenant_balances", {});
    assert.deepEqual(r.totals, { activeContracts: 2, billed: 9300, collected: 5700, outstanding: 3600, overdue: 3600 });
    await assert.rejects(ctl.one(member, "nope", {}), (e: any) => e.getStatus() === 404);
    await assert.rejects(ctl.one(member, "tenant_balances", { ownerId: "x" }), (e: any) => e.getStatus() === 400);

    const guard = new PermissionsGuard(new Reflector());
    const ctx = (perms: string[], handler: any) => ({
      getHandler: () => handler, getClass: () => OpsReportsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 1, permissions: perms } }) }),
    }) as any;
    for (const h of [OpsReportsController.prototype.one, OpsReportsController.prototype.list]) {
      assert.throws(() => guard.canActivate(ctx(["contracts.view"], h)), ForbiddenException);
      assert.equal(guard.canActivate(ctx(["reports.view"], h)), true);
    }
  });

  it("multi-unit contract under a property filter: the picked property carries its money (mutates the fixtures, so it runs last)", async () => {
    const q = (s: string, p: unknown[]) => pool.query(s, p as any[]);
    // U4 (Villa B) first, then U3 (Tower A): unfiltered it belongs to Villa B; filtered to Tower A, to Tower A.
    const c = (await q(`insert into contracts (user_id, contract_number, tenant_name, start_date, end_date, monthly_rent, status) values ($1, 'MU-1', 'Multi Unit', $2, $3, 100, 'active') returning id`, [A, d(-30), d(300)])).rows[0].id;
    await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c, ids.U4]);
    await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c, ids.U3]);
    await q(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1234, $3, 'pending')`, [A, c, d(-3)]);
    const pp = await run(A, "property_performance", { propertyId: String(ids.P1) });
    const cs = await run(A, "collections_summary", { propertyId: String(ids.P1) });
    assert.equal(pp.rows.length, 1);
    assert.equal(cs.totals!.due, pp.totals!.billed, "property_performance and collections_summary agree under the same filter");
    assert.ok(cs.charts.find((x) => x.key === "by_property")!.data.every((r) => r.label === "Tower A"));
    const unf = await run(A, "property_performance");
    assert.equal(byKey(unf, "property")["Villa B"].billed, 1234);
  });
});
