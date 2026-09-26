import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, type TestDb } from "../__tests__/with-db";
import { withTx } from "../db";
import { toHalalas } from "../money";
import { PeriodsService } from "../periods.service";
import { ChartService } from "../chart.service";
import { JournalRepository, type LineInput } from "../journal.repository";
import { CoreReportsService } from "./core-reports.service";
import { FinanceV2CoreReportsController } from "../controllers/reports-core.controller";
import { FinanceV2Guard } from "../finance-v2.guard";

/**
 * Trial balance, general ledger, income statement, balance sheet and cash
 * book (DESIGN §7.1–7.4, §7.9) against a real throwaway Postgres, on a small
 * synthetic ledger whose every expected figure is computed by hand below.
 *
 * Ledger of account U (fiscal year = calendar year, Manager mode):
 *  E1  2025-06-01 opening   Dr 1113 50,000.00 / Cr 3100 50,000.00
 *  E2  2025-11-15 invoice   Dr 1121 11,500.00 / Cr 4110 10,000.00 / Cr 2151 1,500.00      [T1 P1 O1]
 *  E3  2025-12-10 collect   Dr 1113 11,500.00 / Cr 1121 11,500.00                          [T1 P1 O1]
 *  E4  2025-12-20 expense   Dr 5110    800.00 / Cr 1113    800.00                          [P1 O1]
 *  E5  2026-01-05 invoice   Dr 1121 23,000.00 / Cr 4110 20,000.00 / Cr 2151 3,000.00      [T2 P2 O2]
 *  E6  2026-01-20 collect   Dr 1113  5,000.00 / Cr 1121  5,000.00  (bank_transfer, RV-S-1) [T2 P2 O2]
 *  E7  2026-02-03 advance   Dr 1111  2,000.00 / Cr 1121  2,000.00  (cash)                  [T1 P1 O1]
 *  E8  2026-02-10 manual    Dr 5290    300.00 / Cr 1113    300.00                          (no dims)
 *  E9  2026-02-15 manual    Dr 5110    450.00 [P1 O1] / Cr 1111 450.00 (no dims)
 *  E10 2026-02-25 payout    Dr 2121  1,000.00 / Cr 1113  1,000.00                          [O2]
 *  E11 2026-02-26 collect   Dr 1113  3,000.00 / Cr 2121  3,000.00  (bank_transfer)         [O1]
 *  E12 2026-02-27 agency    Dr 1122  1,150.00 / Cr 2122 1,000.00 / Cr 2122 150.00         [T2 P2 O2]
 */
const U = 7301;
const OTHER = 7302;

describe("finance v2 core reports (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let rep: CoreReportsService;
  let repo: JournalRepository;
  const acc: Record<string, number> = {};
  let O1: number, O2: number, P1: number, P2: number, T1: number, T2: number, OTHER_OWNER: number;
  let bankBA: number, cashBA: number;
  let nSrc = 0;

  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const one = async (sql: string, p: unknown[]) => Number((await q(sql, p)).rows[0].id);
  type D = Partial<Pick<LineInput, "ownerId" | "propertyId" | "tenantId">>;
  const dr = (code: string, amt: string, d: D = {}, user = U): LineInput => ({ accountId: accId(code, user), debit: toHalalas(amt), ...d });
  const cr = (code: string, amt: string, d: D = {}, user = U): LineInput => ({ accountId: accId(code, user), credit: toHalalas(amt), ...d });
  const otherAcc: Record<string, number> = {};
  const accId = (code: string, user: number) => (user === U ? acc[code] : otherAcc[code]);
  const post = (date: string, lines: LineInput[], o: { origin?: any; sourceType?: string; sourceId?: number; event?: string; user?: number } = {}) =>
    withTx(t.pool, (c) => repo.post(c, {
      userId: o.user ?? U, entryDate: date, origin: o.origin ?? "auto", sourceType: o.sourceType ?? "test", sourceId: o.sourceId ?? ++nSrc,
      event: o.event ?? "posted", lines,
    }));

  before(async () => {
    t = await withDb({ legacy: "full" });
    const periods = new PeriodsService(t.pool);
    const chart = new ChartService(t.pool);
    repo = new JournalRepository(periods);
    rep = new CoreReportsService(t.pool);
    for (const u of [U, OTHER]) {
      await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [u, `fv2-rep-${u}@example.test`]);
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, true, 'manager')`, [u]);
      await withTx(t.pool, (c) => chart.seedChart(c, u));
    }
    for (const r of (await q(`select code, id from accounts where user_id = $1`, [U])).rows) acc[r.code] = r.id;
    for (const r of (await q(`select code, id from accounts where user_id = $1`, [OTHER])).rows) otherAcc[r.code] = r.id;
    O1 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Landlord One') returning id`, [U]);
    O2 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Landlord Two') returning id`, [U]);
    OTHER_OWNER = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Other Landlord') returning id`, [OTHER]);
    P1 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Tower', $2) returning id`, [U, O1]);
    P2 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Villa', $2) returning id`, [U, O2]);
    T1 = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant A') returning id`, [U]);
    T2 = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant B') returning id`, [U]);
    bankBA = await one(`insert into bank_accounts (user_id, kind, name_ar, name_en, is_default, gl_account_id) values ($1, 'bank', 'البنك', 'Bank', true, $2) returning id`, [U, acc["1113"]]);
    cashBA = await one(`insert into bank_accounts (user_id, kind, name_ar, name_en, is_default, gl_account_id) values ($1, 'cash', 'الصندوق', 'Cash box', true, $2) returning id`, [U, acc["1111"]]);
    const col = (amt: string, date: string, method: string, rn: string | null) =>
      one(`insert into payment_collections (user_id, amount, collected_date, method, receipt_number) values ($1, $2, $3, $4, $5) returning id`, [U, amt, date, method, rn]);
    const c6 = await col("5000.00", "2026-01-20", "bank_transfer", "RV-S-1");
    const c7 = await col("2000.00", "2026-02-03", "cash", null);
    const c11 = await col("3000.00", "2026-02-26", "bank_transfer", null);
    const d1 = { tenantId: T1, propertyId: P1, ownerId: O1 };
    const d2 = { tenantId: T2, propertyId: P2, ownerId: O2 };

    await post("2025-06-01", [dr("1113", "50000.00"), cr("3100", "50000.00")], { origin: "opening", sourceType: "opening_balance" });
    await post("2025-11-15", [dr("1121", "11500.00", d1), cr("4110", "10000.00", d1), cr("2151", "1500.00", d1)]);
    await post("2025-12-10", [dr("1113", "11500.00", d1), cr("1121", "11500.00", d1)]);
    await post("2025-12-20", [dr("5110", "800.00", { propertyId: P1, ownerId: O1 }), cr("1113", "800.00", { propertyId: P1, ownerId: O1 })]);
    await post("2026-01-05", [dr("1121", "23000.00", d2), cr("4110", "20000.00", d2), cr("2151", "3000.00", d2)]);
    await post("2026-01-20", [dr("1113", "5000.00", d2), cr("1121", "5000.00", d2)], { sourceType: "payment_collection", sourceId: c6, event: "collected" });
    await post("2026-02-03", [dr("1111", "2000.00", d1), cr("1121", "2000.00", d1)], { sourceType: "payment_collection", sourceId: c7, event: "collected" });
    await post("2026-02-10", [dr("5290", "300.00"), cr("1113", "300.00")], { origin: "manual", sourceType: "manual_journal" });
    await post("2026-02-15", [dr("5110", "450.00", { propertyId: P1, ownerId: O1 }), cr("1111", "450.00")], { origin: "manual", sourceType: "manual_journal" });
    await post("2026-02-25", [dr("2121", "1000.00", { ownerId: O2 }), cr("1113", "1000.00", { ownerId: O2 })], { sourceType: "landlord_payout" });
    await post("2026-02-26", [dr("1113", "3000.00", { ownerId: O1 }), cr("2121", "3000.00", { ownerId: O1 })], { sourceType: "payment_collection", sourceId: c11, event: "collected" });
    await post("2026-02-27", [dr("1122", "1150.00", d2), cr("2122", "1000.00", d2), cr("2122", "150.00", d2)]);
    // Another account's postings must never appear.
    await post("2026-02-05", [dr("1113", "999.00", {}, OTHER), cr("4110", "999.00", {}, OTHER)], { user: OTHER });
  });
  after(async () => { await t?.drop(); });

  const row = (rows: any[], code: string) => rows.find((r) => r.code === code && r.kind === "account");
  const kind = (rows: any[], k: string) => rows.find((r) => r.kind === k);

  describe("trial balance", () => {
    it("February 2026: opening, period and closing columns, comparative January, all balanced", async () => {
      const tb = await rep.trialBalance(U, { from: "2026-02-01", to: "2026-02-28" });
      assert.equal(tb.params.cmpFrom, "2026-01-01");
      assert.equal(tb.params.cmpTo, "2026-01-31");
      const exp: Record<string, [string, string, string, string, string, string]> = {
        // code: openingDr, openingCr, periodDr, periodCr, closingDr, closingCr
        "1111": ["0.00", "0.00", "2000.00", "450.00", "1550.00", "0.00"],
        "1113": ["65700.00", "0.00", "3000.00", "1300.00", "67400.00", "0.00"],
        "1121": ["18000.00", "0.00", "0.00", "2000.00", "16000.00", "0.00"],
        "1122": ["0.00", "0.00", "1150.00", "0.00", "1150.00", "0.00"],
        "2121": ["0.00", "0.00", "1000.00", "3000.00", "0.00", "2000.00"],
        "2122": ["0.00", "0.00", "0.00", "1150.00", "0.00", "1150.00"],
        "2151": ["0.00", "4500.00", "0.00", "0.00", "0.00", "4500.00"],
        "3100": ["0.00", "50000.00", "0.00", "0.00", "0.00", "50000.00"],
        "4110": ["0.00", "20000.00", "0.00", "0.00", "0.00", "20000.00"],
        "5110": ["0.00", "0.00", "450.00", "0.00", "450.00", "0.00"],
        "5290": ["0.00", "0.00", "300.00", "0.00", "300.00", "0.00"],
      };
      const accountRows = tb.rows.filter((r) => r.kind === "account");
      assert.deepEqual(accountRows.map((r) => r.code).sort(), Object.keys(exp).sort(), "only accounts with activity, leaves only");
      for (const [code, e] of Object.entries(exp)) {
        const r = row(tb.rows, code);
        assert.deepEqual([r.openingDebit, r.openingCredit, r.periodDebit, r.periodCredit, r.closingDebit, r.closingCredit], e, code);
      }
      // 2025 P&L (10,000 revenue − 800 expense) is not closed: it sits on the synthetic row.
      const un = kind(tb.rows, "unclosed_prior_years");
      assert.deepEqual([un.openingCredit, un.closingCredit, un.accountId], ["9200.00", "9200.00", null]);
      assert.equal(kind(tb.rows, "unallocated"), undefined);
      assert.deepEqual(
        [tb.totals.openingDebit, tb.totals.openingCredit, tb.totals.periodDebit, tb.totals.periodCredit, tb.totals.closingDebit, tb.totals.closingCredit, tb.totals.balanced],
        ["83700.00", "83700.00", "7900.00", "7900.00", "86850.00", "86850.00", true]);
      // Comparative: January 2026.
      const c1113 = row(tb.rows, "1113").cmp;
      assert.deepEqual([c1113.openingDebit, c1113.periodDebit, c1113.closingDebit], ["60700.00", "5000.00", "65700.00"]);
      const c1121 = row(tb.rows, "1121").cmp;
      assert.deepEqual([c1121.periodDebit, c1121.periodCredit, c1121.closingDebit], ["23000.00", "5000.00", "18000.00"]);
      assert.equal(kind(tb.rows, "unclosed_prior_years").cmp.openingCredit, "9200.00");
      assert.deepEqual([tb.cmpTotals!.openingDebit, tb.cmpTotals!.closingDebit, tb.cmpTotals!.balanced], ["60700.00", "83700.00", true]);
      assert.deepEqual(row(tb.rows, "1113").drill, { accountId: acc["1113"], from: "2026-02-01", to: "2026-02-28" });
      assert.equal(row(tb.rows, "1113").name, "الحساب البنكي الرئيسي");
    });

    it("group level rolls leaves into their groups; totals still count leaves only", async () => {
      const tb = await rep.trialBalance(U, { from: "2026-02-01", to: "2026-02-28", level: "group", lang: "en", compare: "none" });
      assert.equal(tb.cmpTotals, null);
      assert.equal(row(tb.rows, "1110").closingDebit, "68950.00");  // 1,550 + 67,400
      assert.equal(row(tb.rows, "1120").closingDebit, "17150.00");  // 16,000 + 1,150
      assert.equal(row(tb.rows, "1000").closingDebit, "86100.00");
      assert.equal(row(tb.rows, "2120").closingCredit, "3150.00");  // 2,000 + 1,150
      assert.equal(row(tb.rows, "3000").closingCredit, "59200.00"); // 50,000 + 9,200 unclosed
      assert.equal(row(tb.rows, "1110").drill, null);
      assert.equal(row(tb.rows, "1000").name, "Assets");
      assert.equal(row(tb.rows, "1110").depth, 2);
      assert.equal(tb.totals.closingDebit, "86850.00");
    });

    it("filtered by property: dimensioned lines only, the part outside the filter on an 'unallocated' row", async () => {
      const tb = await rep.trialBalance(U, { from: "2026-02-01", to: "2026-02-28", propertyId: String(P1) });
      assert.deepEqual(tb.rows.filter((r) => r.kind === "account").map((r) => r.code), ["1111", "1113", "1121", "2151", "5110"]);
      assert.equal(row(tb.rows, "1113").closingDebit, "10700.00");  // 11,500 − 800
      assert.deepEqual([row(tb.rows, "1111").periodDebit, row(tb.rows, "1111").closingDebit], ["2000.00", "2000.00"]);
      assert.equal(row(tb.rows, "1121").closingCredit, "2000.00");
      assert.equal(kind(tb.rows, "unclosed_prior_years").closingCredit, "9200.00");
      const ua = kind(tb.rows, "unallocated");
      assert.deepEqual([ua.openingDebit, ua.openingCredit, ua.periodDebit, ua.periodCredit, ua.closingCredit], ["0.00", "0.00", "0.00", "450.00", "450.00"]);
      assert.deepEqual([tb.totals.openingDebit, tb.totals.periodDebit, tb.totals.periodCredit, tb.totals.closingDebit, tb.totals.closingCredit, tb.totals.balanced],
        ["10700.00", "2450.00", "2450.00", "13150.00", "13150.00", true]);
      assert.equal(row(tb.rows, "5110").drill.propertyId, P1);
    });

    it("scoping: another account's landlord is a 404; bad input is a 400", async () => {
      await assert.rejects(rep.trialBalance(U, { ownerId: String(OTHER_OWNER) }), (e: any) => e.getStatus() === 404);
      await assert.rejects(rep.trialBalance(U, { from: "2026-03-01", to: "2026-02-01" }), (e: any) => e.getStatus() === 400);
      await assert.rejects(rep.trialBalance(U, { from: "2026-02-30" }), (e: any) => e.getStatus() === 400);
      const other = await rep.trialBalance(OTHER, { from: "2026-02-01", to: "2026-02-28" });
      assert.deepEqual(other.rows.map((r) => [r.code, r.periodDebit, r.periodCredit]), [["1113", "999.00", "0.00"], ["4110", "0.00", "999.00"]]);
    });
  });

  describe("general ledger", () => {
    it("bank account 1113, Jan–Feb 2026: opening, running balance, totals, sources and counterparties", async () => {
      const gl = await rep.generalLedger(U, { accountId: String(acc["1113"]), from: "2026-01-01", to: "2026-02-28" });
      const s = gl.accounts[0];
      assert.equal(gl.accounts.length, 1);
      assert.deepEqual([s.opening, s.periodDebit, s.periodCredit, s.closing, s.totalLines], ["60700.00", "8000.00", "1300.00", "67400.00", 4]);
      assert.deepEqual(s.lines.map((l: any) => [l.entryDate, l.debit, l.credit, l.balance]), [
        ["2026-01-20", "5000.00", "0.00", "65700.00"],
        ["2026-02-10", "0.00", "300.00", "65400.00"],
        ["2026-02-25", "0.00", "1000.00", "64400.00"],
        ["2026-02-26", "3000.00", "0.00", "67400.00"],
      ]);
      const first = s.lines[0] as any;
      assert.deepEqual(first.source, { type: "payment_collection", id: first.sourceId, number: "RV-S-1", route: null, exists: true });
      assert.deepEqual(first.counterparty, { type: "tenant", id: T2, name: "Synthetic Tenant B" });
      assert.deepEqual((s.lines[2] as any).counterparty, { type: "landlord", id: O2, name: "Synthetic Landlord Two" });
      assert.equal((s.lines[1] as any).counterparty, null);
      assert.equal((s.lines[1] as any).source.type, "manual_journal");
      assert.ok(Number.isInteger(first.entryId) && typeof first.entryNo === "string");
    });

    it("the running balance is right on every page", async () => {
      const gl = await rep.generalLedger(U, { accountId: String(acc["1113"]), from: "2026-01-01", to: "2026-02-28", pageSize: "2", page: "2" });
      const s = gl.accounts[0];
      assert.deepEqual([s.page, s.pages, s.opening, s.closing], [2, 2, "60700.00", "67400.00"]);
      assert.deepEqual(s.lines.map((l: any) => l.balance), ["64400.00", "67400.00"]);
    });

    it("a credit-normal P&L account opens at the fiscal-year start, balances signed as credits", async () => {
      const feb = await rep.generalLedger(U, { accountId: String(acc["4110"]), from: "2026-02-01", to: "2026-02-28" });
      assert.deepEqual([feb.accounts[0].opening, feb.accounts[0].lines.length, feb.accounts[0].closing], ["20000.00", 0, "20000.00"]);
      const fy = await rep.generalLedger(U, { accountId: String(acc["4110"]), to: "2026-02-28" }); // from defaults to the FY start
      assert.equal(fy.params.from, "2026-01-01");
      assert.deepEqual([fy.accounts[0].opening, fy.accounts[0].lines[0].balance], ["0.00", "20000.00"]);
    });

    it("a group expands to its leaves; dimension filters apply; foreign ids are 404", async () => {
      const gl = await rep.generalLedger(U, { accountId: String(acc["1120"]), from: "2026-01-01", to: "2026-02-28", tenantId: String(T2) });
      const byCode = Object.fromEntries(gl.accounts.map((s: any) => [s.account.code, s]));
      assert.deepEqual([byCode["1121"].opening, byCode["1121"].periodDebit, byCode["1121"].periodCredit, byCode["1121"].closing], ["0.00", "23000.00", "5000.00", "18000.00"]);
      assert.equal(byCode["1122"].closing, "1150.00");
      await assert.rejects(rep.generalLedger(U, { accountId: String(otherAcc["1113"]) }), (e: any) => e.getStatus() === 404);
      await assert.rejects(rep.generalLedger(U, {}), (e: any) => e.getStatus() === 400);
    });
  });

  describe("income statement", () => {
    it("Jan–Feb 2026 in total, with the comparative 2025 and the agency-rent memo", async () => {
      const is = await rep.incomeStatement(U, { from: "2026-01-01", to: "2026-02-28", cmpFrom: "2025-01-01", cmpTo: "2025-12-31" });
      const r = (rows: any[], code: string) => rows.find((x) => x.code === code);
      assert.deepEqual(is.columns.map((c) => c.key), ["total"]);
      assert.deepEqual([r(is.revenue.rows, "4110").total, r(is.revenue.rows, "4100").total, r(is.revenue.rows, "4000").total], ["20000.00", "20000.00", "20000.00"]);
      assert.deepEqual([r(is.expenses.rows, "5110").total, r(is.expenses.rows, "5290").total, r(is.expenses.rows, "5100").total, r(is.expenses.rows, "5000").total],
        ["450.00", "300.00", "450.00", "750.00"]);
      assert.deepEqual([is.revenue.total.total, is.expenses.total.total, is.netProfit.total], ["20000.00", "750.00", "19250.00"]);
      assert.deepEqual([is.revenue.total.cmpTotal, is.expenses.total.cmpTotal, is.netProfit.cmpTotal], ["10000.00", "800.00", "9200.00"]);
      assert.equal(is.memo.rentCollectedForLandlords, "3000.00");
      assert.equal(is.mode, "manager");
    });

    it("columns by property (with Unallocated), by month, and filtered by landlord", async () => {
      const byProp = await rep.incomeStatement(U, { from: "2026-01-01", to: "2026-02-28", columns: "property", lang: "en" });
      assert.deepEqual(byProp.columns.map((c) => [c.key, c.label]), [[String(P1), "Synthetic Tower"], [String(P2), "Synthetic Villa"], ["unallocated", "Unallocated"]]);
      assert.deepEqual(byProp.netProfit.amounts, { [P1]: "-450.00", [P2]: "20000.00", unallocated: "-300.00" });
      assert.equal(byProp.netProfit.total, "19250.00");
      const byMonth = await rep.incomeStatement(U, { from: "2026-01-01", to: "2026-02-28", columns: "month" });
      assert.deepEqual(byMonth.netProfit.amounts, { "2026-01": "20000.00", "2026-02": "-750.00" });
      const o1 = await rep.incomeStatement(U, { from: "2026-01-01", to: "2026-02-28", ownerId: String(O1) });
      assert.deepEqual([o1.revenue.total.total, o1.expenses.total.total, o1.netProfit.total, o1.memo.rentCollectedForLandlords], ["0.00", "450.00", "-450.00", "3000.00"]);
    });
  });

  describe("balance sheet", () => {
    it("at 2026-02-28 (net agency presentation): reclassifications, computed equity, balanced; comparative at 2025-12-31", async () => {
      const bs = await rep.balanceSheet(U, { asOf: "2026-02-28", cmpAsOf: "2025-12-31" });
      const a = (sec: any, code: string) => sec.rows.find((x: any) => x.code === code);
      const k = (sec: any, kd: string) => sec.rows.find((x: any) => x.kind === kd);
      assert.deepEqual([a(bs.assets, "1111").amount, a(bs.assets, "1113").amount, a(bs.assets, "1121").amount], ["1550.00", "67400.00", "18000.00"]);
      assert.equal(a(bs.assets, "1122"), undefined, "net: 1122 offsets 2122");
      assert.equal(k(bs.assets, "landlord_debits").amount, "1000.00");
      assert.equal(k(bs.assets, "agency_difference"), undefined);
      assert.equal(bs.assets.total, "87950.00");
      assert.deepEqual([a(bs.liabilities, "2121").amount, k(bs.liabilities, "tenant_credits").amount, a(bs.liabilities, "2151").amount], ["3000.00", "2000.00", "4500.00"]);
      assert.equal(a(bs.liabilities, "2122"), undefined);
      assert.equal(bs.liabilities.total, "9500.00");
      assert.deepEqual([a(bs.equity, "3100").amount, k(bs.equity, "unclosed_prior_years").amount, k(bs.equity, "current_year_profit").amount], ["50000.00", "9200.00", "19250.00"]);
      assert.equal(bs.equity.total, "78450.00");
      assert.deepEqual([bs.totalLiabilitiesAndEquity, bs.check.difference, bs.check.balanced], ["87950.00", "0.00", true]);
      assert.deepEqual(bs.memo && [bs.memo.managedReceivables, bs.memo.heldForLandlords, bs.memo.agentTenantCredits], ["1150.00", "1150.00", "0.00"]);
      // Group rows roll up the reclassified figures: 1120 = 18,000 AR + 1,000 due from landlords.
      assert.equal(a(bs.assets, "1120").amount, "19000.00");
      // Comparative: 2025 year end, the whole 2025 profit is current-year.
      assert.deepEqual([a(bs.assets, "1113").cmpAmount, bs.assets.cmpTotal, bs.liabilities.cmpTotal, bs.equity.cmpTotal, bs.check.cmpDifference],
        ["60700.00", "60700.00", "1500.00", "59200.00", "0.00"]);
      assert.equal(k(bs.equity, "current_year_profit").cmpAmount, "9200.00");
    });

    it("gross presentation shows 1122 and 2122; filtered by property it still balances", async () => {
      const g = await rep.balanceSheet(U, { asOf: "2026-02-28", presentation: "gross" });
      assert.deepEqual([g.assets.total, g.liabilities.total, g.equity.total, g.check.balanced, g.memo], ["89100.00", "10650.00", "78450.00", true, null]);
      const p1 = await rep.balanceSheet(U, { asOf: "2026-02-28", propertyId: String(P1) });
      // P1 lines: 1113 10,700; 1111 2,000; 1121 −2,000 (tenant credit); 2151 1,500; P&L 2025 9,200, 2026 −450; E9 half outside → unallocated.
      assert.deepEqual([p1.assets.total, p1.liabilities.total, p1.equity.total, p1.check.balanced], ["12700.00", "3500.00", "9200.00", true]);
      const k = (sec: any, kd: string) => sec.rows.find((x: any) => x.kind === kd);
      assert.deepEqual([k(p1.equity, "current_year_profit").amount, k(p1.equity, "unallocated").amount], ["-450.00", "450.00"]);
    });
  });

  describe("cash and bank book", () => {
    it("one bank account for February: opening, receipts, payments, running balance, by method", async () => {
      const cb = await rep.cashBook(U, { bankAccountId: String(bankBA), from: "2026-02-01", to: "2026-02-28" });
      const s = cb.sections[0];
      assert.equal(cb.sections.length, 1);
      assert.deepEqual([s.bankAccount.id, s.opening, s.receipts, s.payments, s.closing], [bankBA, "65700.00", "3000.00", "1300.00", "67400.00"]);
      assert.deepEqual(s.lines.map((l: any) => [l.entryDate, l.receipt, l.payment, l.balance, l.method]), [
        ["2026-02-10", "0.00", "300.00", "65400.00", null],
        ["2026-02-25", "0.00", "1000.00", "64400.00", null],
        ["2026-02-26", "3000.00", "0.00", "67400.00", "bank_transfer"],
      ]);
      assert.deepEqual(s.byMethod, [{ method: "bank_transfer", receipts: "3000.00", payments: "0.00" }, { method: "other", receipts: "0.00", payments: "1300.00" }]);
    });

    it("all accounts: the cash box too; totals across sections; a foreign bank account is 404", async () => {
      const cb = await rep.cashBook(U, { from: "2026-02-01", to: "2026-02-28", lang: "en" });
      const cash = cb.sections.find((s: any) => s.bankAccount?.id === cashBA)!;
      assert.deepEqual([cash.bankAccount.name, cash.opening, cash.receipts, cash.payments, cash.closing], ["Cash box", "0.00", "2000.00", "450.00", "1550.00"]);
      assert.deepEqual(cash.byMethod, [{ method: "cash", receipts: "2000.00", payments: "0.00" }, { method: "other", receipts: "0.00", payments: "450.00" }]);
      assert.deepEqual(cb.totals, { opening: "65700.00", receipts: "5000.00", payments: "1750.00", closing: "68950.00" });
      const foreign = await one(`insert into bank_accounts (user_id, kind, name_ar, gl_account_id) values ($1, 'bank', 'x', $2) returning id`, [OTHER, otherAcc["1115"]]);
      await assert.rejects(rep.cashBook(U, { bankAccountId: String(foreign) }), (e: any) => e.getStatus() === 404);
    });
  });

  describe("year-end closing entry", () => {
    it("after closing 2025 into 3300: the prior-year row disappears, statements stay balanced and unchanged in total", async () => {
      await post("2025-12-31", [dr("4110", "10000.00"), cr("5110", "800.00"), cr("3300", "9200.00")], { origin: "closing", sourceType: "year_close" });
      const tb = await rep.trialBalance(U, { from: "2026-02-01", to: "2026-02-28" });
      assert.equal(kind(tb.rows, "unclosed_prior_years"), undefined);
      assert.equal(row(tb.rows, "3300").openingCredit, "9200.00");
      assert.equal(tb.totals.balanced, true);
      const bs = await rep.balanceSheet(U, { asOf: "2026-02-28" });
      assert.deepEqual([bs.equity.total, bs.check.balanced], ["78450.00", true]);
      // At the closed year's end, 3300 carries the year and current-year profit is zero (no double count).
      const ye = await rep.balanceSheet(U, { asOf: "2025-12-31" });
      const k = (sec: any, kd: string) => sec.rows.find((x: any) => x.kind === kd);
      assert.deepEqual([ye.equity.rows.find((x: any) => x.code === "3300").amount, k(ye.equity, "current_year_profit"), ye.check.balanced], ["9200.00", undefined, true]);
      // The P&L excludes the closing entry; a December TB keeps revenue in the period columns unless postClosing.
      const is25 = await rep.incomeStatement(U, { from: "2025-01-01", to: "2025-12-31" });
      assert.equal(is25.netProfit.total, "9200.00");
      const dec = await rep.trialBalance(U, { from: "2025-12-01", to: "2025-12-31" });
      assert.equal(row(dec.rows, "3300"), undefined);
      const decPost = await rep.trialBalance(U, { from: "2025-12-01", to: "2025-12-31", postClosing: "true" });
      assert.equal(row(decPost.rows, "3300").periodCredit, "9200.00");
      assert.equal(decPost.totals.balanced, true);
    });
  });

  it("routes: every report needs the flag guard and the view capability", () => {
    const guards = Reflect.getMetadata("__guards__", FinanceV2CoreReportsController) as unknown[];
    assert.ok(guards.includes(FinanceV2Guard));
    for (const m of ["trialBalance", "generalLedger", "incomeStatement", "balanceSheet", "cashBook"]) {
      assert.equal(Reflect.getMetadata("fv2:capability", (FinanceV2CoreReportsController.prototype as any)[m]), "view", m);
    }
  });
});
