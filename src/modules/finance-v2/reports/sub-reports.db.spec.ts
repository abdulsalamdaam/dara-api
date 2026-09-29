import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../__tests__/with-db";
import { withTx } from "../db";
import { toHalalas } from "../money";
import { PeriodsService } from "../periods.service";
import { ChartService } from "../chart.service";
import { JournalRepository, type LineInput } from "../journal.repository";
import { PostingEngine } from "../posting.engine";
import { VatReturnsService } from "../vat-returns.service";
import { VatReportService } from "./vat-report.service";
import { ArAgingService } from "./aging.service";
import { StatementsService } from "./statements.service";
import { ReconciliationService } from "./reconciliation.service";
import { legacyAccountingFor } from "./legacy-accounting";
import { FinanceV2SubReportsController } from "../controllers/reports-sub.controller";
import { FinanceV2Guard } from "../finance-v2.guard";
import { DEPOSIT_DESC } from "../hooks/classify";

/**
 * VAT return (§7.5, with the §8.2(b) apportionment), AR aging (§7.6), tenant
 * ledger (§7.7), landlord statement (§7.8) and reconciliation (§7.10) against
 * a throwaway Postgres. Every expected figure is worked out by hand in the
 * comments; all data is synthetic.
 */
const U_VAT = 7401;
const U_AGE = 7402;
const U_ST = 7403;
const U_REC = 7404;
const OTHER = 7405;

describe("finance v2 sub-ledger reports (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let repo: JournalRepository;
  let periods: PeriodsService;
  const acc: Record<number, Record<string, number>> = {};
  let nSrc = 0;

  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const one = async (sql: string, p: unknown[]) => Number((await q(sql, p)).rows[0].id);
  type X = Partial<LineInput>;
  const L = (u: number, code: string, side: "dr" | "cr", amt: string, x: X = {}): LineInput =>
    ({ accountId: acc[u][code], [side === "dr" ? "debit" : "credit"]: toHalalas(amt), ...x, vatBase: x.vatBase });
  const base = (s: string) => toHalalas(s);
  const post = (u: number, date: string, lines: LineInput[], o: { origin?: any; sourceType?: string; sourceId?: number; event?: string; rule?: string; originalDate?: string; isLate?: boolean; warnings?: string[] } = {}) =>
    withTx(t.pool, (c) => repo.post(c, {
      userId: u, entryDate: date, origin: o.origin ?? "auto", sourceType: o.sourceType ?? "test", sourceId: o.sourceId ?? ++nSrc,
      event: o.event ?? "posted", lines, payload: o.rule ? { rule: o.rule } : {}, originalDate: o.originalDate, isLate: o.isLate, warnings: o.warnings,
    }));

  before(async () => {
    t = await withDb({ legacy: "full" });
    periods = new PeriodsService(t.pool);
    repo = new JournalRepository(periods);
    const chart = new ChartService(t.pool);
    for (const u of [U_VAT, U_AGE, U_ST, U_REC, OTHER]) {
      await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [u, `fv2-sub-${u}@example.test`]);
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, true, 'manager')`, [u]);
      await withTx(t.pool, (c) => chart.seedChart(c, u));
      acc[u] = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [u])).rows.map((r: any) => [r.code, r.id]));
    }
  });
  after(async () => { await t?.drop(); });

  // ─────────────────────────────── VAT return ───────────────────────────────
  describe("VAT return (ZATCA boxes) and the lock", () => {
    let P1: number, O2: number;
    before(async () => {
      const u = U_VAT;
      const O1 = await one(`insert into owners (user_id, name, is_account_holder) values ($1, 'Synthetic Holder', true) returning id`, [u]);
      O2 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Agent Landlord') returning id`, [u]);
      P1 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Tower', $2) returning id`, [u, O1]);
      const out = (cat: "S" | "Z" | "E" | "O", b: string, doc: string, seller = "account") => ({ vatCategory: cat, vatBase: base(b), taxRole: "output" as const, sellerKey: seller, docClass: doc });
      const inp = (cat: "S" | "Z" | "E" | "O", b: string, role: "input" | "input_nonrecoverable" = "input", x: X = {}) =>
        ({ vatCategory: cat, vatBase: base(b), taxRole: role, sellerKey: "account", docClass: "expense", ...x });
      // Prior year 2025 (the apportionment basis): taxable 10,000 (S), exempt 30,000 (E) → 25.00 %.
      await post(u, "2025-06-10", [L(u, "1121", "dr", "11500.00"), L(u, "4120", "cr", "10000.00", { vatCategory: "S", docClass: "invoice" }), L(u, "2151", "cr", "1500.00", out("S", "10000.00", "invoice"))]);
      await post(u, "2025-07-10", [L(u, "1121", "dr", "30000.00"), L(u, "4110", "cr", "30000.00", out("E", "30000.00", "invoice"))]);
      // 2026-Q1.
      await post(u, "2026-01-05", [L(u, "1121", "dr", "23000.00"), L(u, "4120", "cr", "20000.00", { vatCategory: "S", docClass: "invoice" }), L(u, "2151", "cr", "3000.00", out("S", "20000.00", "invoice"))]);   // V1
      await post(u, "2026-01-10", [L(u, "1121", "dr", "8000.00"), L(u, "2131", "cr", "8000.00", out("E", "8000.00", "charge"))]);                                                                               // V2
      await post(u, "2026-01-20", [L(u, "1121", "dr", "5000.00"), L(u, "4140", "cr", "5000.00", out("Z", "5000.00", "invoice"))]);                                                                               // V3
      await post(u, "2026-02-01", [L(u, "4120", "dr", "2000.00", { vatCategory: "S", docClass: "credit" }), L(u, "2151", "dr", "300.00", out("S", "-2000.00", "credit")), L(u, "1121", "cr", "2300.00")]);   // V4
      await post(u, "2026-02-05", [L(u, "1121", "dr", "150.00"), L(u, "2151", "cr", "150.00", out("S", "1000.00", "advance"))], { warnings: ["vat_without_tax_invoice"] });                                   // V5
      await post(u, "2026-02-10", [L(u, "2141", "dr", "700.00"), L(u, "4310", "cr", "700.00", out("O", "700.00", "other"))]);                                                                                  // V6
      await post(u, "2026-02-15", [L(u, "5110", "dr", "1000.00", { propertyId: P1, vatCategory: "S", docClass: "expense" }), L(u, "1151", "dr", "150.00", inp("S", "1000.00", "input", { propertyId: P1 })), L(u, "1113", "cr", "1150.00")]); // V7
      await post(u, "2026-02-20", [L(u, "5290", "dr", "2000.00", { vatCategory: "S", docClass: "expense" }), L(u, "5500", "dr", "300.00", inp("S", "2000.00", "input_nonrecoverable")), L(u, "1113", "cr", "2300.00")]); // V8 overhead
      await post(u, "2026-02-25", [L(u, "5290", "dr", "400.00", { vatCategory: "S", docClass: "expense" }), L(u, "1151", "dr", "60.00", inp("S", "400.00")), L(u, "1113", "cr", "460.00")]);                  // V9 overhead
      await post(u, "2026-03-01", [L(u, "5120", "dr", "500.00", inp("Z", "500.00")), L(u, "1113", "cr", "500.00")]);                                                                                            // V10 Z, "recoverable"
      await post(u, "2026-03-05", [L(u, "5150", "dr", "900.00", inp("E", "900.00", "input_nonrecoverable")), L(u, "1113", "cr", "900.00")]);                                                                    // V11
      await post(u, "2026-03-10", [L(u, "5170", "dr", "250.00", inp("O", "250.00", "input_nonrecoverable")), L(u, "1113", "cr", "250.00")]);                                                                    // V12
      const v13 = await post(u, "2026-03-12", [L(u, "5110", "dr", "200.00", { propertyId: P1, vatCategory: "S", docClass: "expense" }), L(u, "1151", "dr", "30.00", inp("S", "200.00", "input", { propertyId: P1 })), L(u, "1113", "cr", "230.00")]);
      await withTx(t.pool, (c) => repo.reverse(c, u, v13.id, { entryDate: "2026-03-20" })); // V13 reversed
      await post(u, "2026-03-15", [L(u, "1122", "dr", "1150.00"), L(u, "2122", "cr", "1000.00", { vatCategory: "S", sellerKey: `owner:${O2}`, docClass: "invoice" }), L(u, "2122", "cr", "150.00", out("S", "1000.00", "invoice", `owner:${O2}`))]); // V14 agent
      await post(u, "2026-01-02", [L(u, "1121", "dr", "575.00"), L(u, "4120", "cr", "500.00", { vatCategory: "S", docClass: "charge" }), L(u, "2151", "cr", "75.00", out("S", "500.00", "charge"))],
        { originalDate: "2025-12-28", isLate: true });                                                                                                                                                             // V15 late
      await post(u, "2026-03-25", [L(u, "1121", "dr", "115.00"), L(u, "4120", "cr", "100.00", { vatCategory: "S", docClass: "debit" }), L(u, "2151", "cr", "15.00", out("S", "100.00", "debit"))]);         // V16 debit note
    });

    const box = (r: any, n: number) => r.boxes.find((b: any) => b.box === n);

    it("the input VAT claimed counts standard-rated input VAT only (a Z purchase's net is not VAT)", async () => {
      // Bug: VatReturnsService summed every `tax_role='input'` line, so V10's 500.00 net (category Z) counted as input VAT.
      const vat = new VatReturnsService(t.pool, periods, repo, new PostingEngine(t.pool, repo, periods));
      const v: any = await vat.get(U_VAT, "2026-Q1");
      assert.equal(v.box6Vat, "2940.00");
      assert.equal(v.box12Vat, "240.00", "210.00 booked (150 + 60 + 30 − 30) + 30.00 apportionment");
      assert.equal(v.box13, "2700.00");
    });

    it("boxes 1–16 with amounts, adjustments and VAT, computed by hand", async () => {
      const r: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1", lang: "en" });
      assert.deepEqual(r.params, { period: "2026-Q1", from: "2026-01-01", to: "2026-03-31", seller: "account", frequency: "quarterly" });
      const triple = (n: number) => { const b = box(r, n); return [b.amount, b.adjustment, b.vat]; };
      // Box 1: V1 20,000 + V5 1,000 + V15 500 | V4 −2,000 + V16 100 | VAT 3,000 − 300 + 150 + 75 + 15.
      assert.deepEqual(triple(1), ["21500.00", "-1900.00", "2940.00"]);
      assert.deepEqual(triple(2), ["0.00", "0.00", "0.00"]);
      assert.deepEqual(triple(3), ["5000.00", "0.00", null]);
      assert.deepEqual(triple(4), ["0.00", "0.00", null]);
      assert.deepEqual(triple(5), ["8000.00", "0.00", null]);
      assert.deepEqual(triple(6), ["34500.00", "-1900.00", "2940.00"]);
      // Box 7: V7 1,000 + V9 400 + V13 200 | reversal −200 | 210 booked + 30 apportionment.
      assert.deepEqual(triple(7), ["1600.00", "-200.00", "240.00"]);
      assert.deepEqual(triple(8), ["0.00", "0.00", "0.00"]);
      assert.deepEqual(triple(9), ["0.00", "0.00", "0.00"]);
      assert.deepEqual(triple(10), ["500.00", "0.00", null]);
      assert.deepEqual(triple(11), ["900.00", "0.00", null]);
      assert.deepEqual(triple(12), ["3000.00", "-200.00", "240.00"]);
      assert.equal(r.box13.vat, "2700.00");
      assert.equal(r.box14.vat, "0.00");
      assert.equal(r.box15.vat, "0.00");
      assert.equal(r.box16.vat, "2700.00");
      assert.equal(box(r, 1).label, "Standard rated sales");
      assert.deepEqual(r.memo, {
        outOfScopeSales: { amount: "700.00", adjustment: "0.00" },
        outOfScopePurchases: { amount: "250.00", adjustment: "0.00" },
        nonRecoverableInput: { base: "2000.00", vat: "300.00" },
        inputVatBooked: "210.00",
      });
    });

    it("apportionment: overheads at the previous year's ratio (25 %), the adjustment is target − booked", async () => {
      const r: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1" });
      const a = r.apportionment;
      assert.equal(a.method, "direct_plus_ratio");
      assert.equal(a.applies, true);
      assert.deepEqual(a.basis, { from: "2025-01-01", to: "2025-12-31", source: "previous_year", taxable: "10000.00", exempt: "30000.00" });
      assert.equal(a.ratioPercent, "25.00");
      // Overheads (no property): V8 300 non-recoverable + V9 60 recoverable = 360; 25 % = 90; booked 60 → +30.
      assert.deepEqual([a.overheadVat, a.overheadBookedRecoverable, a.recoverableAtRatio, a.adjustment], ["360.00", "60.00", "90.00", "30.00"]);
      assert.equal(a.trueUp, null, "Q1 is not the last return of the fiscal year");
      // direct_only: no ratio, the per-expense choice stands.
      await q(`update finance_settings set input_vat_method = 'direct_only' where account_user_id = $1`, [U_VAT]);
      const d: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1" });
      assert.deepEqual([d.apportionment.applies, d.apportionment.reason, box(d, 7).vat, d.box13.vat], [false, "direct_only", "210.00", "2730.00"]);
      await q(`update finance_settings set input_vat_method = 'direct_plus_ratio' where account_user_id = $1`, [U_VAT]);
    });

    it("the last return of the year proposes the annual true-up (never posted)", async () => {
      const r: any = await new VatReportService(t.pool).vatReturn(U_VAT, { year: "2026", quarter: "4" });
      // FY 2026 actual: taxable S 21,500 − 1,900 + Z 5,000 = 24,600; exempt 8,000 → 24,600 / 32,600.
      // FY overhead VAT 360: actual round(360 × 24,600 / 32,600) = 271.66; provisional 25 % = 90.00; true-up +181.66.
      assert.deepEqual(r.apportionment.trueUp, {
        fiscalYearFrom: "2026-01-01", to: "2026-12-31", actualRatioPercent: "75.46", overheadVat: "360.00",
        provisionalRecoverable: "90.00", actualRecoverable: "271.66", amount: "181.66",
        proposedJournal: [{ accountCode: "1151", debit: "181.66", credit: "0.00" }, { accountCode: "5500", debit: "0.00", credit: "181.66" }],
      });
    });

    it("prior-period items, tax-invoice gaps, and the agent landlord's own return", async () => {
      const r: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1" });
      assert.equal(r.priorPeriodItems.length, 1);
      assert.deepEqual([r.priorPeriodItems[0].originalDate, r.priorPeriodItems[0].entryDate, r.priorPeriodItems[0].outputVat, r.priorPeriodItems[0].includedInBoxes], ["2025-12-28", "2026-01-02", "75.00", true]);
      assert.deepEqual(r.taxInvoiceGaps.map((g: any) => g.vat), ["150.00"]);
      const o: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1", seller: `owner:${O2}` });
      assert.deepEqual([box(o, 1).amount, box(o, 1).vat, o.box13.vat, o.apportionment.reason], ["1000.00", "150.00", "150.00", "landlord_return"]);
      const foreign = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Other') returning id`, [OTHER]);
      await assert.rejects(new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1", seller: `owner:${foreign}` }), (e: any) => e.getStatus() === 404);
      await assert.rejects(new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q5" }), (e: any) => e.getStatus() === 400);
    });

    it("the lock posts the settlement from the same boxes: Dr 2151 2,940 / Cr 1151 210 / Cr 5500 30 / Cr 2152 2,700", async () => {
      const vat = new VatReturnsService(t.pool, periods, repo, new PostingEngine(t.pool, repo, periods));
      const user = { id: U_VAT, ownerUserId: null, ownerScopeId: null, role: "user", permissions: [] } as any;
      await vat.put(U_VAT, user, "2026-Q1", { lock: true });
      const lines = (await q(
        `select a.code, l.debit::text as dr, l.credit::text as cr, l.tax_role from journal_lines l join journal_entries e on e.id = l.entry_id
           join accounts a on a.id = l.account_id where e.user_id = $1 and e.source_type = 'vat_return' and e.event = 'settled' order by l.line_no`, [U_VAT])).rows;
      assert.deepEqual(lines.map((l: any) => [l.code, l.dr, l.cr, l.tax_role]), [
        ["2151", "2940.00", "0.00", null], ["1151", "0.00", "210.00", null], ["5500", "0.00", "30.00", null], ["2152", "0.00", "2700.00", null],
      ]);
      const r: any = await new VatReportService(t.pool).vatReturn(U_VAT, { period: "2026-Q1" });
      assert.equal(r.draft.locked, true);
      assert.ok(r.settlement?.entryNo);
      assert.equal(r.box13.vat, "2700.00", "the settlement carries no tax_role, so the boxes do not move");
    });
  });

  // ─────────────────────────────── AR aging ───────────────────────────────
  describe("AR aging (part-paid correct)", () => {
    let T1: number, T2: number, C1: number, C2: number, O2: number, D1: number, D2: number, I7: number;
    before(async () => {
      const u = U_AGE;
      const O1 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Landlord One') returning id`, [u]);
      O2 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Landlord Two') returning id`, [u]);
      const P1 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic P1', $2) returning id`, [u, O1]);
      const P2 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic P2', $2) returning id`, [u, O2]);
      const U1 = await one(`insert into units (property_id, unit_number) values ($1, '1') returning id`, [P1]);
      const U2 = await one(`insert into units (property_id, unit_number) values ($1, '2') returning id`, [P2]);
      T1 = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant One') returning id`, [u]);
      T2 = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant Two') returning id`, [u]);
      const con = (tn: number, name: string, no: string) => one(
        `insert into contracts (user_id, contract_number, tenant_id, tenant_name, start_date, end_date, monthly_rent) values ($1, $2, $3, $4, '2025-01-01', '2027-12-31', 5000) returning id`,
        [u, no, tn, name]);
      C1 = await con(T1, "Synthetic Tenant One", "C-SYN-1");
      C2 = await con(T2, "Synthetic Tenant Two", "C-SYN-2");
      await q(`insert into contract_units (contract_id, unit_id) values ($1, $2), ($3, $4)`, [C1, U1, C2, U2]);
      const pay = (c: number, amt: string, due: string, status = "pending", desc: string | null = null) =>
        one(`insert into payments (user_id, contract_id, amount, due_date, status, description) values ($1, $2, $3, $4, $5, $6) returning id`, [u, c, amt, due, status, desc]);
      const col = (p: number | null, amt: string, d: string, inv: number | null = null) =>
        one(`insert into payment_collections (user_id, payment_id, amount, collected_date, invoice_id) values ($1, $2, $3, $4, $5) returning id`, [u, p, amt, d, inv]);
      const doc = (o: any) => one(
        `insert into simple_invoices (user_id, number, type, status, kind, contract_id, tenant_id, payment_id, payment_ids, subtotal, total, issue_date, due_date, billing_reference)
         values ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [u, o.number, o.type ?? "invoice", o.kind ?? null, o.contract ?? null, o.tenant ?? null, o.payment ?? null, o.paymentIds ? JSON.stringify(o.paymentIds) : null,
          o.subtotal ?? o.total, o.total, o.issue, o.due ?? null, o.ref ?? null]);
      // Tenant One.
      const I1 = await pay(C1, "6900.00", "2026-03-01", "partially_paid"); await col(I1, "3000.00", "2026-03-05");   // 30 days: 3,900 in 0–30
      const I2 = await pay(C1, "5000.00", "2026-01-15"); await col(I2, "1000.00", "2026-04-02");                     // 75 days: 5,000 (the April collection is after asOf)
      const I3 = await pay(C1, "5000.00", "2025-12-01", "paid"); await col(I3, "4000.00", "2025-12-01");             // 120 days: 1,000 (paid, short)
      const I4 = await pay(C1, "5000.00", "2026-04-15"); await col(I4, "1000.00", "2026-03-20");                     // future: an advance, −1,000 credit
      await pay(C1, "2000.00", "2026-01-01", "pending", DEPOSIT_DESC);                                               // deposit row: not AR
      await pay(C1, "3000.00", "2026-02-10", "cancelled");                                                           // cancelled: not AR
      I7 = await pay(C1, "4000.00", "2026-02-20");
      D1 = await doc({ number: "INV-SYN-1", contract: C1, tenant: T1, payment: I7, subtotal: "4000.00", total: "4600.00", issue: "2026-02-18", due: "2026-02-25" });
      await col(I7, "1000.00", "2026-03-01"); await col(I7, "500.00", "2026-03-02", D1);                            // both count, once each
      await doc({ number: "CRN-SYN-1", type: "credit", contract: C1, tenant: T1, subtotal: "200.00", total: "230.00", issue: "2026-03-10", ref: "INV-SYN-1" });
      // D1: 4,600 − 230 − 1,500 = 2,870, due 2026-02-25 → 34 days → 31–60.
      const I8 = await pay(C1, "2000.00", "2026-03-25"); await col(I8, "2500.00", "2026-03-25");                    // overpaid: 0, −500 credit
      await doc({ number: "COM-SYN-1", kind: "commission", contract: C1, total: "300.00", issue: "2026-03-01" });     // landlord-billed: excluded
      const DV = await doc({ number: "DV-SYN-1", kind: "deposit", contract: C1, tenant: T1, total: "2000.00", issue: "2026-01-01" });
      await col(null, "2000.00", "2026-01-01", DV);                                                                    // the deposit: not AR
      // Tenant Two.
      D2 = await doc({ number: "INV-SYN-2", contract: C2, tenant: T2, subtotal: "1000.00", total: "1150.00", issue: "2026-03-20", due: "2026-04-20" }); // not yet due
      const RV = await doc({ number: "RV-SYN-1", kind: "receipt", contract: C2, tenant: T2, total: "800.00", issue: "2026-03-22" });
      await col(null, "800.00", "2026-03-22", RV);                                                                     // receipt remainder: −800 credit
      const I9 = await pay(C2, "2000.00", "2026-03-31");
      await q(`insert into finance_write_offs (user_id, tenant_id, contract_id, payment_ids, amount, written_off_on, reason, created_by)
               values ($1, $2, $3, $4, 2000, '2026-03-31', 'Synthetic write-off', $1)`, [u, T2, C2, `{${I9}}`]);
      await q(`insert into tenant_credit_actions (user_id, tenant_id, contract_id, kind, amount, action_on, target_document_id)
               values ($1, $2, $3, 'apply', 300, '2026-03-25', $4)`, [u, T2, C2, D2]);                             // D2 850; credit −800 + 300 = −500
    });

    it("buckets per tenant and in total, with part-paid items aged at their remainder", async () => {
      const r: any = await new ArAgingService(t.pool).arAging(U_AGE, { asOf: "2026-03-31" });
      const t1 = r.rows.find((x: any) => x.tenantId === T1);
      const t2 = r.rows.find((x: any) => x.tenantId === T2);
      const cols = (x: any) => [x.notDue, x.d0_30, x.d31_60, x.d61_90, x.d90p, x.pastDue, x.open, x.unappliedCredit, x.net];
      assert.deepEqual(cols(t1), ["0.00", "3900.00", "2870.00", "5000.00", "1000.00", "12770.00", "12770.00", "-1500.00", "11270.00"]);
      assert.deepEqual(cols(t2), ["850.00", "0.00", "0.00", "0.00", "0.00", "0.00", "850.00", "-500.00", "350.00"]);
      assert.deepEqual(cols(r.totals), ["850.00", "3900.00", "2870.00", "5000.00", "1000.00", "12770.00", "13620.00", "-2000.00", "11620.00"]);
      assert.equal(t1.tenantName, "Synthetic Tenant One");
      const d1 = t1.items.find((i: any) => i.type === "document" && i.id === D1);
      assert.deepEqual([d1.amount, d1.collected, d1.credited, d1.remaining, d1.daysPastDue, d1.bucket], ["4600.00", "1500.00", "230.00", "2870.00", 34, "d31_60"]);
      assert.equal(t1.items.some((i: any) => i.type === "installment" && i.id === I7), false, "an invoiced installment is not counted twice");
      // No ledger postings in this account: the difference is shown, not hidden.
      assert.deepEqual(r.reconciliation, { ledgerAr: "0.00", subLedger: "11620.00", advanceVatOpen: "0.00", difference: "-11620.00", balanced: false });
    });

    it("bucket edges move with asOf; filters by landlord and tenant; group by contract", async () => {
      const early: any = await new ArAgingService(t.pool).arAging(U_AGE, { asOf: "2026-03-01" });
      const t1 = early.rows.find((x: any) => x.tenantId === T1);
      // asOf 1 Mar: I1 is day 0 (6,900, nothing collected yet) → 0–30; D1: 4,600 − 1,000 = 3,600 at 4 days → 0–30;
      // I2 45 days → 31–60; I3 90 days → 61–90; the credit note and I8 are later.
      assert.deepEqual([t1.d0_30, t1.d31_60, t1.d61_90, t1.d90p], ["10500.00", "5000.00", "1000.00", "0.00"]);
      const o2: any = await new ArAgingService(t.pool).arAging(U_AGE, { asOf: "2026-03-31", ownerId: String(O2) });
      assert.deepEqual(o2.rows.map((x: any) => x.tenantId), [T2]);
      const tt: any = await new ArAgingService(t.pool).arAging(U_AGE, { asOf: "2026-03-31", tenantId: String(T1), groupBy: "contract" });
      assert.deepEqual(tt.rows.map((x: any) => [x.contractId, x.contractNumber, x.net]), [[C1, "C-SYN-1", "11270.00"]]);
      const foreign = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Foreign') returning id`, [OTHER]);
      await assert.rejects(new ArAgingService(t.pool).arAging(U_AGE, { tenantId: String(foreign) }), (e: any) => e.getStatus() === 404);
      void C2;
    });
  });

  // ─────────────────────────────── statements ───────────────────────────────
  describe("tenant ledger and landlord statement", () => {
    let T: number, T2: number, C: number, O: number, H: number, P: number, PH: number;
    before(async () => {
      const u = U_ST;
      O = await one(`insert into owners (user_id, name, tax_number) values ($1, 'Synthetic Agent Landlord', '300000000000003') returning id`, [u]);
      H = await one(`insert into owners (user_id, name, is_account_holder) values ($1, 'Synthetic Holder', true) returning id`, [u]);
      P = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Tower', $2) returning id`, [u, O]);
      PH = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Villa', $2) returning id`, [u, H]);
      T = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant') returning id`, [u]);
      T2 = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant Two') returning id`, [u]);
      C = await one(`insert into contracts (user_id, contract_number, tenant_id, tenant_name, start_date, end_date, monthly_rent) values ($1, 'C-ST-1', $2, 'Synthetic Tenant', '2025-01-01', '2026-12-31', 1000) returning id`, [u, T]);
      const inv = await one(`insert into simple_invoices (user_id, number, status, contract_id, tenant_id, subtotal, total, issue_date) values ($1, 'INV-ST-1', 'confirmed', $2, $3, 1000, 1150, '2026-01-01') returning id`, [u, C, T]);
      const colId = await one(`insert into payment_collections (user_id, amount, collected_date, method, receipt_number) values ($1, 1000, '2026-01-10', 'bank_transfer', 'RV-ST-1') returning id`, [u]);
      const exp = await one(`insert into expenses (user_id, property_id, owner_id, category, amount, expense_date) values ($1, $2, $3, 'maintenance', 230, '2026-03-05') returning id`, [u, P, O]);
      await q(`insert into finance_expense_details (expense_id, user_id, gross_amount, net_amount, vat_rate, vat_amount, vat_category, supplier_name, supplier_invoice_no, charge_to)
               values ($1, $2, 230, 200, 15, 30, 'S', 'Synthetic Supplier', 'SUP-1', 'landlord')`, [exp, u]);
      const d = { tenantId: T, contractId: C, ownerId: O, propertyId: P };
      const a = (code: string, side: "dr" | "cr", amt: string, x: X = {}) => L(u, code, side, amt, { ...d, ...x });
      const vatOut = { vatCategory: "S" as const, vatBase: base("1000.00"), taxRole: "output" as const, sellerKey: `owner:${O}`, docClass: "invoice" };
      await post(u, "2025-12-15", [a("1113", "dr", "400.00"), a("1122", "cr", "400.00"), a("2122", "dr", "400.00"), a("2121", "cr", "400.00")], { rule: "E03" });                           // S0
      await post(u, "2026-01-01", [a("1122", "dr", "1150.00"), a("2122", "cr", "1000.00", { vatCategory: "S", sellerKey: `owner:${O}` }), a("2122", "cr", "150.00", vatOut)],
        { rule: "E01", sourceType: "simple_invoice", sourceId: inv, event: "confirmed" });                                                                                                          // S1
      await post(u, "2026-01-10", [a("1113", "dr", "1000.00"), a("1122", "cr", "1000.00"), a("2122", "dr", "1000.00"), a("2121", "cr", "1000.00")],
        { rule: "E03", sourceType: "payment_collection", sourceId: colId, event: "collected" });                                                                                                  // S2
      await post(u, "2026-02-01", [a("1122", "dr", "1150.00"), a("2122", "cr", "1000.00", { vatCategory: "S", sellerKey: `owner:${O}` }), a("2122", "cr", "150.00", { ...vatOut, docClass: "charge" })], { rule: "E02" }); // S3
      await post(u, "2026-02-05", [a("2122", "dr", "100.00"), a("1122", "cr", "100.00")], { rule: "E06" });                                                                                        // S4
      await post(u, "2026-02-10", [a("1113", "dr", "2000.00"), a("2141", "cr", "2000.00")], { rule: "E09" });                                                                                      // S5
      await post(u, "2026-02-20", [a("2141", "dr", "500.00"), a("1122", "cr", "500.00"), a("2122", "dr", "500.00"), a("2121", "cr", "500.00")], { rule: "E12B" });                                // S6
      await post(u, "2026-03-01", [L(u, "2121", "dr", "115.00", { ownerId: O }), L(u, "4210", "cr", "100.00", { ownerId: O }), L(u, "2151", "cr", "15.00", { ownerId: O })], { rule: "E15" });   // S7
      await post(u, "2026-03-05", [L(u, "2121", "dr", "200.00", { ownerId: O, propertyId: P, vatCategory: "S", sellerKey: `owner:${O}`, docClass: "expense" }),
        L(u, "2121", "dr", "30.00", { ownerId: O, propertyId: P, vatCategory: "S", vatBase: base("200.00"), taxRole: "input_nonrecoverable", sellerKey: `owner:${O}`, docClass: "expense" }),
        L(u, "1113", "cr", "230.00", { ownerId: O, propertyId: P })], { rule: "E18", sourceType: "expense", sourceId: exp, event: "rev:1" });                                                    // S8
      await post(u, "2026-03-10", [L(u, "2121", "dr", "1000.00", { ownerId: O }), L(u, "1113", "cr", "1000.00", { ownerId: O })], { rule: "E19" });                                            // S9
      await post(u, "2026-03-15", [a("2141", "dr", "300.00"), a("1113", "cr", "300.00")], { rule: "E10" });                                                                                        // S10
      await post(u, "2026-02-28", [L(u, "1121", "dr", "5750.00", { tenantId: T2, ownerId: H, propertyId: PH }), L(u, "4120", "cr", "5000.00", { tenantId: T2, ownerId: H, propertyId: PH }),
        L(u, "2151", "cr", "750.00", { tenantId: T2, ownerId: H, propertyId: PH })], { rule: "E01" });                                                                                          // S11
      await post(u, "2026-03-03", [L(u, "5110", "dr", "700.00", { ownerId: H, propertyId: PH }), L(u, "1113", "cr", "700.00", { ownerId: H, propertyId: PH })], { rule: "E18" });              // S12
    });

    it("tenant ledger: opening −400 (credit), running balance, closing 300; deposits held 1,200", async () => {
      const r: any = await new StatementsService(t.pool).tenantLedger(U_ST, { tenantId: String(T), from: "2026-01-01", to: "2026-03-31" });
      assert.equal(r.opening, "-400.00");
      assert.deepEqual(r.lines.map((l: any) => [l.date, l.type, l.charge, l.credit, l.balance]), [
        ["2026-01-01", "invoice", "1150.00", "0.00", "750.00"],
        ["2026-01-10", "collection", "0.00", "1000.00", "-250.00"],
        ["2026-02-01", "installment_charge", "1150.00", "0.00", "900.00"],
        ["2026-02-05", "credit_note", "0.00", "100.00", "800.00"],
        ["2026-02-20", "deposit_applied", "0.00", "500.00", "300.00"],
      ]);
      assert.equal(r.lines[0].documentNumber, "INV-ST-1");
      assert.equal(r.lines[1].documentNumber, "RV-ST-1");
      assert.deepEqual([r.totals.charges, r.totals.credits, r.closing, r.closingSide], ["2300.00", "1600.00", "300.00", "owed"]);
      const dep = r.deposits;
      assert.deepEqual([dep.opening, dep.received, dep.applied, dep.refunded, dep.converted, dep.forfeited, dep.held], ["0.00", "2000.00", "500.00", "300.00", "0.00", "0.00", "1200.00"]);
      assert.deepEqual(dep.lines.map((l: any) => [l.type, l.held]), [["received", "2000.00"], ["applied", "1500.00"], ["refunded", "1200.00"]]);
    });

    it("landlord statement (agent): opening 400, movements with net/VAT and supplier, closing 555, memo", async () => {
      const r: any = await new StatementsService(t.pool).landlordStatement(U_ST, { ownerId: String(O), from: "2026-01-01", to: "2026-03-31", lang: "en" });
      assert.equal(r.variant, "agent");
      assert.deepEqual(r.landlord, { id: O, name: "Synthetic Agent Landlord", taxNumber: "300000000000003", idNumber: null, isAccountHolder: false });
      assert.equal(r.opening, "400.00");
      assert.deepEqual(r.lines.map((l: any) => [l.date, l.type, l.debit, l.credit, l.balance, l.net, l.vat]), [
        ["2026-01-10", "rent_collected", "0.00", "1000.00", "1400.00", null, null],
        ["2026-02-20", "deposit_applied", "0.00", "500.00", "1900.00", null, null],
        ["2026-03-01", "commission", "115.00", "0.00", "1785.00", "100.00", "15.00"],
        ["2026-03-05", "expense", "230.00", "0.00", "1555.00", "200.00", "30.00"],
        ["2026-03-10", "payout", "1000.00", "0.00", "555.00", null, null],
      ]);
      assert.deepEqual(r.lines[3].supplier, { name: "Synthetic Supplier", invoiceNo: "SUP-1", vatNumber: null });
      assert.equal(r.closing, "555.00");
      assert.deepEqual([r.summary.rentCollected, r.summary.commission, r.summary.expenses, r.summary.payouts], ["1000.00", "-115.00", "-230.00", "-1000.00"]);
      assert.deepEqual(r.rentByProperty, [{ propertyId: P, propertyName: "Synthetic Tower", amount: "1000.00" }]);
      assert.deepEqual([r.memo.uncollectedRent.total, r.memo.depositsHeld.total], ["300.00", "1200.00"]);
      assert.deepEqual(r.memo.vat.standardRated, { base: "2000.00", vat: "300.00" });
      assert.deepEqual(r.memo.vat.inputNonRecoverable, { base: "200.00", vat: "30.00" });
    });

    it("landlord statement (principal): property performance; owner-scope tokens see only their own landlord", async () => {
      const r: any = await new StatementsService(t.pool).landlordStatement(U_ST, { ownerId: String(H), from: "2026-01-01", to: "2026-03-31" });
      assert.equal(r.variant, "principal");
      assert.deepEqual(r.properties, [{ propertyId: PH, propertyName: "Synthetic Villa", revenue: "5000.00", expenses: "700.00", net: "4300.00" }]);
      assert.deepEqual(r.totals, { revenue: "5000.00", expenses: "700.00", net: "4300.00" });
      await assert.rejects(new StatementsService(t.pool).landlordStatement(U_ST, { ownerId: String(O) }, H), (e: any) => e.getStatus() === 403);
      const own: any = await new StatementsService(t.pool).landlordStatement(U_ST, { ownerId: String(O), from: "2026-01-01", to: "2026-03-31" }, O);
      assert.equal(own.closing, "555.00");
      const foreign = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Other 2') returning id`, [OTHER]);
      await assert.rejects(new StatementsService(t.pool).landlordStatement(U_ST, { ownerId: String(foreign) }), (e: any) => e.getStatus() === 404);
      await assert.rejects(new StatementsService(t.pool).tenantLedger(U_ST, {}), (e: any) => e.getStatus() === 400);
    });
  });

  // ─────────────────────────────── reconciliation ───────────────────────────────
  describe("reconciliation (R1–R8)", () => {
    let OR: number, CR: number, I1: number;
    const legacyOf = () => legacyAccountingFor(drizzle(t.pool, { schema }));
    before(async () => {
      const u = U_REC;
      OR = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Agent Landlord') returning id`, [u]);
      const PR = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Tower', $2) returning id`, [u, OR]);
      const UN = await one(`insert into units (property_id, unit_number) values ($1, '1') returning id`, [PR]);
      const TR = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant') returning id`, [u]);
      CR = await one(`insert into contracts (user_id, contract_number, tenant_id, tenant_name, start_date, end_date, monthly_rent) values ($1, 'C-R-1', $2, 'Synthetic Tenant', '2026-01-01', '2026-12-31', 1000) returning id`, [u, TR]);
      await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [CR, UN]);
      I1 = await one(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-01-01', 'partially_paid') returning id`, [u, CR]);
      const col = await one(`insert into payment_collections (user_id, payment_id, amount, collected_date, method) values ($1, $2, 600, '2026-01-05', 'bank_transfer') returning id`, [u, I1]);
      const DV = await one(`insert into simple_invoices (user_id, number, status, kind, contract_id, tenant_id, subtotal, total, issue_date, payment_method)
                            values ($1, 'DV-R-1', 'confirmed', 'deposit', $2, $3, 2000, 2000, '2026-01-01', 'cash') returning id`, [u, CR, TR]);
      const d = { tenantId: TR, contractId: CR, ownerId: OR, propertyId: PR };
      const e1 = await post(u, "2026-01-01", [L(u, "1122", "dr", "1000.00", { ...d, paymentId: I1 }), L(u, "2122", "cr", "1000.00", { ...d, paymentId: I1 })],
        { rule: "E02", sourceType: "payment", sourceId: I1, event: "charge" });
      await q(`insert into finance_installment_charges (payment_id, user_id, charged_on, charged_by, amount, entry_id) values ($1, $2, '2026-01-01', 'due', 1000, $3)`, [I1, u, e1.id]);
      await post(u, "2026-01-01", [L(u, "1111", "dr", "2000.00", d), L(u, "2141", "cr", "2000.00", d)], { rule: "E09", sourceType: "simple_invoice", sourceId: DV, event: "deposit_received" });
      await post(u, "2026-01-05", [L(u, "1113", "dr", "600.00", d), L(u, "1122", "cr", "600.00", d), L(u, "2122", "dr", "600.00", d), L(u, "2121", "cr", "600.00", d)],
        { rule: "E03", sourceType: "payment_collection", sourceId: col, event: "collected" });
    });

    it("a consistent ledger: all eight checks pass (R3 against the real legacy dues computation)", async () => {
      const r: any = await new ReconciliationService(t.pool, legacyOf()).reconciliation(U_REC, { asOf: "2026-01-31", lang: "en" });
      const by = (id: string) => r.checks.find((c: any) => c.id === id);
      assert.deepEqual(r.checks.map((c: any) => [c.id, c.status]), [
        ["R1", "ok"], ["R2", "ok"], ["R3", "ok"], ["R4", "ok"], ["R5", "ok"], ["R6", "ok"], ["R7", "ok"], ["R8", "ok"],
      ]);
      assert.deepEqual([by("R1").ledger, by("R1").subLedger, by("R1").difference], ["400.00", "400.00", "0.00"]);
      assert.deepEqual([by("R2").ledger, by("R2").subLedger], ["2000.00", "2000.00"]);
      assert.deepEqual([by("R3").ledger, by("R3").subLedger], ["600.00", "600.00"]);
      assert.deepEqual([by("R4").ledger, by("R4").subLedger], ["2600.00", "2600.00"]);
      assert.deepEqual([by("R8").ledger, by("R8").subLedger, by("R8").difference], ["4200.00", "4200.00", "0.00"]);
      assert.equal(by("R1").label, "AR control vs open items");
    });

    it("an unposted collection shows as a difference on R1, R3, R4 and a missing key on R6; nothing is plugged", async () => {
      await q(`insert into payment_collections (user_id, payment_id, amount, collected_date, method) values ($1, $2, 100, '2026-01-20', 'bank_transfer')`, [U_REC, I1]);
      const r: any = await new ReconciliationService(t.pool, legacyOf()).reconciliation(U_REC, { asOf: "2026-01-31" });
      const by = (id: string) => r.checks.find((c: any) => c.id === id);
      assert.deepEqual([by("R1").status, by("R1").ledger, by("R1").subLedger, by("R1").difference], ["difference", "400.00", "300.00", "100.00"]);
      assert.deepEqual([by("R3").status, by("R3").difference], ["difference", "-100.00"]);
      assert.deepEqual(by("R3").rows.map((x: any) => [x.ownerId, x.ledger, x.subLedger]), [[OR, "600.00", "700.00"]]);
      assert.deepEqual([by("R4").status, by("R4").difference], ["difference", "-100.00"]);
      assert.deepEqual([by("R6").status, by("R6").difference, by("R6").rows.map((x: any) => x.sourceType)], ["attention", "1", ["payment_collection"]]);
      assert.equal(by("R8").status, "ok");
      assert.deepEqual(r.summary.withDifferences, ["R1", "R3", "R4", "R6"]);
      // Without the legacy computation R3 says so rather than guessing.
      const n: any = await new ReconciliationService(t.pool).reconciliation(U_REC, { asOf: "2026-01-31" });
      assert.equal(n.checks.find((c: any) => c.id === "R3").status, "unavailable");
      void CR;
    });
  });

  describe("routes", () => {
    it("every route is behind JwtAuthGuard + FinanceV2Guard with the view capability; the landlord statement admits owner tokens", () => {
      const guards = Reflect.getMetadata("__guards__", FinanceV2SubReportsController) ?? [];
      assert.ok(guards.includes(FinanceV2Guard));
      const proto = FinanceV2SubReportsController.prototype as any;
      for (const m of ["vatReturn", "arAging", "tenantLedger", "reconciliation"]) {
        assert.equal(Reflect.getMetadata("fv2:capability", proto[m]), "view", m);
        assert.equal(Reflect.getMetadata("fv2:allowOwnerScope", proto[m]), undefined, m);
      }
      assert.equal(Reflect.getMetadata("fv2:allowOwnerScope", proto.landlordStatement), true);
    });
  });
});
