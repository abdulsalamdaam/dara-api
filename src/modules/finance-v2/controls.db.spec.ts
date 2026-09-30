import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, type TestDb } from "./__tests__/with-db";
import { withTx } from "./db";
import { toHalalas } from "./money";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { JournalRepository, type LineInput } from "./journal.repository";
import { ReconciliationService } from "./reports/reconciliation.service";
import { ExtraChecks } from "./reports/control-checks";
import { ControlChecksService, CONTROL_ROWS, canOverrideControls } from "./controls.service";
import { PeriodCloseService } from "./period-close.service";
import { FinanceV2ControlsController } from "./controllers/controls.controller";
import { FinanceV2Guard } from "./finance-v2.guard";
import { DEPOSIT_DESC } from "./hooks/classify";

/**
 * The accountant's control checks (R9–R21, his sheet "فحوصات الرقابة"), the
 * 21-row view, the stored runs and the period-close gate, against a throwaway
 * Postgres. Each check is shown passing and then failing on one offending
 * item; every figure is worked out by hand in the comments. Synthetic data.
 */
const U_A = 7601; // R11, R12, R17–R21
const U_T = 7602; // R16 trust
const U_B = 7603; // R13, R15
const U_G = 7604; // the close gate
const U_O = 7605; // owner mode
const ASOF = "2026-03-31";

const ALL = ["reports.view", "payments.view", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete", "payments.write"];
const holder = (id: number) => ({ id, ownerUserId: null, ownerScopeId: null, role: "user", permissions: ALL }) as any;
const clerk = (id: number, scope: number) => ({ id, ownerUserId: scope, ownerScopeId: null, role: "employee", permissions: ["reports.view", "payments.view"] }) as any;
const err = (code: string, status?: number) => (e: any) => {
  const body = e?.getResponse?.();
  assert.equal(body?.error, code, JSON.stringify(body));
  if (status) assert.equal(e.getStatus(), status);
  return true;
};

describe("finance v2 control checks and the close gate (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let repo: JournalRepository;
  let periods: PeriodsService;
  let recon: ReconciliationService;
  let controls: ControlChecksService;
  const acc: Record<number, Record<string, number>> = {};
  let nSrc = 0;

  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const one = async (sql: string, p: unknown[]) => Number((await q(sql, p)).rows[0].id);
  const L = (u: number, code: string, side: "dr" | "cr", amt: string, x: Partial<LineInput> = {}): LineInput =>
    ({ accountId: acc[u][code], [side === "dr" ? "debit" : "credit"]: toHalalas(amt), ...x });
  const post = (u: number, date: string, lines: LineInput[], o: { origin?: any; rule?: string; originalDate?: string; isLate?: boolean; sourceType?: string; sourceId?: number; event?: string } = {}) =>
    withTx(t.pool, (c) => repo.post(c, {
      userId: u, entryDate: date, origin: o.origin ?? "auto", sourceType: o.sourceType ?? "test", sourceId: o.sourceId ?? ++nSrc, event: o.event ?? "posted",
      lines, payload: o.rule ? { rule: o.rule } : {}, originalDate: o.originalDate, isLate: o.isLate,
    }));
  const check = async (u: number, id: string, asOf = ASOF) => {
    const r: any = await recon.reconciliation(u, { asOf, lang: "en", only: id });
    assert.equal(r.checks.length, 1);
    return r.checks[0];
  };

  before(async () => {
    t = await withDb({ legacy: "full" });
    periods = new PeriodsService(t.pool);
    repo = new JournalRepository(periods);
    recon = new ReconciliationService(t.pool);
    controls = new ControlChecksService(t.pool, recon);
    const chart = new ChartService(t.pool);
    for (const [u, mode] of [[U_A, "manager"], [U_T, "manager"], [U_B, "manager"], [U_G, "manager"], [U_O, "owner"]] as const) {
      await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [u, `fv2-ctl-${u}@example.test`]);
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, ledger_started_at) values ($1, true, $2, now())`, [u, mode]);
      await withTx(t.pool, (c) => chart.seedChart(c, u));
      acc[u] = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [u])).rows.map((r: any) => [r.code, r.id]));
    }
  });
  after(async () => { await t?.drop(); });

  // ─────────────────────────────── R9, R10, R14 ───────────────────────────────
  describe("R9 trial balance, R10 balance sheet, R14 income statement", () => {
    it("pass on a real ledger: TB closing debits = credits, assets = liabilities + equity, IS net = TB P&L", async () => {
      const u = U_B;
      await post(u, "2026-01-10", [L(u, "1113", "dr", "5000.00"), L(u, "3100", "cr", "5000.00")]);
      await post(u, "2026-02-10", [L(u, "1113", "dr", "1200.00"), L(u, "4390", "cr", "1200.00")]);
      await post(u, "2026-02-20", [L(u, "5290", "dr", "200.00"), L(u, "1113", "cr", "200.00")]);
      const r9 = await check(u, "R9");
      assert.deepEqual([r9.status, r9.ledger, r9.subLedger, r9.difference], ["ok", "6200.00", "6200.00", "0.00"]); // 1113 6000 + 5290 200 | 3100 5000 + 4390 1200
      const r10 = await check(u, "R10");
      assert.deepEqual([r10.status, r10.ledger, r10.subLedger], ["ok", "6000.00", "6000.00"]); // 5000 capital + 1000 profit
      const r14 = await check(u, "R14");
      assert.deepEqual([r14.status, r14.ledger, r14.subLedger], ["ok", "1000.00", "1000.00"]);
    });

    it("fail when the reports disagree (the ledger itself refuses an unbalanced entry, so the reports are stubbed)", async () => {
      const x = new ExtraChecks(t.pool);
      const r9 = await x.r9({ totals: { closingDebit: "100.00", closingCredit: "99.50" }, params: { from: "2026-01-01", to: ASOF } });
      assert.deepEqual([r9.status, r9.difference], ["difference", "0.50"]);
      (x as any).core.balanceSheet = async () => ({ assets: { total: "100.00" }, totalLiabilitiesAndEquity: "90.00", liabilities: { total: "40.00" }, equity: { total: "50.00" } });
      const r10 = await x.r10(U_B, ASOF);
      assert.deepEqual([r10.status, r10.difference], ["difference", "10.00"]);
      (x as any).core.incomeStatement = async () => ({ netProfit: { total: "1001.00" }, revenue: { total: { total: "1201.00" } }, expenses: { total: { total: "200.00" } } });
      const tb: any = await (x as any).core.trialBalance(U_B, { from: "2026-01-01", to: ASOF, compare: "none" });
      const r14 = await x.r14(U_B, "2026-01-01", ASOF, tb);
      assert.deepEqual([r14.status, r14.ledger, r14.subLedger, r14.difference], ["difference", "1001.00", "1000.00", "1.00"]);
    });
  });

  // ─────────────────────────────── R11 ───────────────────────────────
  describe("R11 managed receivables 1122 = 2122, per landlord", () => {
    let O2: number;
    before(async () => {
      O2 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Agent Landlord') returning id`, [U_A]);
    });
    it("pass: every managed charge and collection moves 1122 and 2122 together", async () => {
      const u = U_A;
      await post(u, "2026-01-05", [L(u, "1122", "dr", "1150.00", { ownerId: O2 }), L(u, "2122", "cr", "1150.00", { ownerId: O2 })], { rule: "E01" });
      await post(u, "2026-01-20", [L(u, "1114", "dr", "400.00", { ownerId: O2 }), L(u, "1122", "cr", "400.00", { ownerId: O2 }),
        L(u, "2122", "dr", "400.00", { ownerId: O2 }), L(u, "2121", "cr", "400.00", { ownerId: O2 })], { rule: "E03" });
      const r = await check(u, "R11");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.rows.length], ["ok", "750.00", "750.00", 0]);
    });
    it("fail: a manual line on 1122 with no 2122 mirror shows the landlord and the amount", async () => {
      const u = U_A;
      await post(u, "2026-02-01", [L(u, "1122", "dr", "50.00", { ownerId: O2 }), L(u, "4390", "cr", "50.00")], { origin: "manual" });
      const r = await check(u, "R11");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["difference", "800.00", "750.00", "50.00"]);
      assert.deepEqual(r.rows.map((x: any) => [x.ownerId, x.landlordName, x.difference]), [[O2, "Synthetic Agent Landlord", "50.00"]]);
      // Put it right for the later checks on this account.
      await post(u, "2026-02-02", [L(u, "4390", "dr", "50.00"), L(u, "1122", "cr", "50.00", { ownerId: O2 })], { origin: "manual" });
      assert.equal((await check(u, "R11")).status, "ok");
    });
  });

  // ─────────────────────────────── R12 ───────────────────────────────
  describe("R12 suppliers 2111 = open supplier bills", () => {
    it("pass: an approved bill, part paid, matches 2111", async () => {
      const u = U_A;
      const S = await one(`insert into suppliers (user_id, name_ar) values ($1, 'مورد تجريبي') returning id`, [u]);
      const B = await one(`insert into supplier_bills (user_id, number, supplier_id, bill_date, due_date, status, subtotal, total, approved_at)
                           values ($1, 'BILL-000001', $2, '2026-02-01', '2026-03-01', 'approved', 1000, 1000, now()) returning id`, [u, S]);
      await post(u, "2026-02-01", [L(u, "5290", "dr", "1000.00"), L(u, "2111", "cr", "1000.00")], { rule: "E38" });
      const P = await one(`insert into supplier_payments (user_id, number, supplier_id, paid_on, amount) values ($1, 'PV-000001', $2, '2026-02-10', 300) returning id`, [u, S]);
      await q(`insert into supplier_payment_allocations (payment_id, bill_id, user_id, amount) values ($1, $2, $3, 300)`, [P, B, u]);
      await post(u, "2026-02-10", [L(u, "2111", "dr", "300.00"), L(u, "1113", "cr", "300.00")], { rule: "E39" });
      const r = await check(u, "R12");
      assert.deepEqual([r.status, r.ledger, r.subLedger], ["ok", "700.00", "700.00"]);
    });
    it("fail: a 2111 line with no bill behind it", async () => {
      const u = U_A;
      await post(u, "2026-03-01", [L(u, "5290", "dr", "80.00"), L(u, "2111", "cr", "80.00")], { origin: "manual" });
      const r = await check(u, "R12");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["difference", "780.00", "700.00", "80.00"]);
      await post(u, "2026-03-02", [L(u, "2111", "dr", "80.00"), L(u, "5290", "cr", "80.00")], { origin: "manual" });
    });
  });

  // ─────────────────────────────── R13, R15 ───────────────────────────────
  describe("R13 cash-flow closing cash = cash/bank book; R15 bank reconciliation", () => {
    let BA: number;
    it("R13 pass: opening + receipts − payments of the 1110 accounts equals the cash and bank book", async () => {
      const u = U_B;
      BA = await one(`insert into bank_accounts (user_id, kind, name_ar, name_en, is_default, gl_account_id) values ($1, 'bank', 'البنك', 'Bank', true, $2) returning id`, [u, acc[u]["1113"]]);
      await post(u, "2025-12-20", [L(u, "1111", "dr", "300.00"), L(u, "3100", "cr", "300.00")]); // opening cash before the fiscal year
      const r = await check(u, "R13");
      // 1113: 5000 + 1200 − 200 = 6000; 1111: 300 (opening) → 6300.
      assert.deepEqual([r.status, r.ledger, r.subLedger], ["ok", "6300.00", "6300.00"]);
      assert.deepEqual(r.explanations[0].items[0], { from: "2026-01-01", opening: "300.00", receipts: "6200.00", payments: "200.00", closing: "6300.00" });
    });
    it("R13 fail: a bank account booked on an account outside the cash group is in the bank book but not in cash", async () => {
      const u = U_B;
      await one(`insert into bank_accounts (user_id, kind, name_ar, gl_account_id) values ($1, 'bank', 'حساب خاطئ', $2) returning id`, [u, acc[u]["1126"]]);
      await post(u, "2026-03-05", [L(u, "1126", "dr", "75.00"), L(u, "4390", "cr", "75.00")]);
      const r = await check(u, "R13");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["difference", "6300.00", "6375.00", "-75.00"]);
      assert.deepEqual(r.rows.map((x: any) => [x.accountId, x.subLedger]), [[acc[u]["1126"], "75.00"]]);
      await q(`delete from bank_accounts where user_id = $1 and gl_account_id = $2`, [u, acc[u]["1126"]]);
    });
    it("R15: not applicable without statements; pass when adjusted bank = adjusted books; fail otherwise", async () => {
      const u = U_B;
      assert.equal((await check(u, "R15")).status, "not_applicable");
      // Ledger 1113 = 6000.00, nothing matched: outstanding receipts 6200, payments 200. Statement closing 0 → adjusted bank 6000 = books 6000.
      const S = await one(`insert into bank_statements (user_id, bank_account_id, period_from, period_to, opening_balance, closing_balance, imported_by)
                           values ($1, $2, '2026-01-01', '2026-03-31', 0, 0, $1) returning id`, [u, BA]);
      let r = await check(u, "R15");
      assert.deepEqual([r.status, r.ledger, r.subLedger], ["ok", "6000.00", "6000.00"]);
      // A bank fee on the statement not yet in the books: books 6000 − 25 = 5975 against adjusted bank 6000 − 25 … the closing moves too.
      await q(`update bank_statements set closing_balance = -25 where id = $1`, [S]);
      await q(`insert into bank_statement_lines (statement_id, user_id, bank_account_id, line_no, txn_date, amount, fingerprint) values ($1, $2, $3, 1, '2026-03-30', -25, 'fee-1')`, [S, u, BA]);
      r = await check(u, "R15"); // adjusted bank 5975; adjusted books 6000 + (−25) = 5975
      assert.deepEqual([r.status, r.ledger, r.subLedger], ["ok", "5975.00", "5975.00"]);
      await q(`update bank_statements set closing_balance = 10 where id = $1`, [S]); // the statement says 35.00 more than the books explain
      r = await check(u, "R15");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["difference", "6010.00", "5975.00", "35.00"]);
      assert.equal(r.rows[0].statementId, S);
      await q(`delete from bank_statement_lines where statement_id = $1`, [S]);
      await q(`delete from bank_statements where id = $1`, [S]);
    });
  });

  // ─────────────────────────────── R16 ───────────────────────────────
  describe("R16 client money: trust account = landlord and tenant money held", () => {
    let O2: number, O1: number;
    before(async () => {
      const u = U_T;
      O1 = await one(`insert into owners (user_id, name, is_account_holder) values ($1, 'Synthetic Holder', true) returning id`, [u]);
      O2 = await one(`insert into owners (user_id, name) values ($1, 'Synthetic Agent Landlord') returning id`, [u]);
    });

    it("not applicable in Owner mode, without a trust account, or with trust routing off", async () => {
      assert.deepEqual([(await check(U_O, "R16")).status, (await check(U_O, "R16")).notes], ["not_applicable", ["owner_mode"]]);
      assert.deepEqual((await check(U_T, "R16")).notes, ["no_trust_account"]);
      await q(`insert into bank_accounts (user_id, kind, name_ar, is_trust, is_default, gl_account_id) values ($1, 'bank', 'أمانات', true, true, $2)`, [U_T, acc[U_T]["1114"]]);
      assert.deepEqual((await check(U_T, "R16")).notes, ["trust_routing_off"]);
      await q(`update finance_settings set agency_collections_to_trust = true where account_user_id = $1`, [U_T]);
    });

    it("pass: rent and a deposit into trust, commission deducted, a transfer to the office, an unpaid landlord bill", async () => {
      const u = U_T;
      const d = { ownerId: O2 };
      await post(u, "2026-01-05", [L(u, "1114", "dr", "1000.00", d), L(u, "1122", "cr", "1000.00", d), L(u, "2122", "dr", "1000.00", d), L(u, "2121", "cr", "1000.00", d)], { rule: "E03" });
      await post(u, "2026-01-06", [L(u, "1114", "dr", "500.00", d), L(u, "2141", "cr", "500.00", d)], { rule: "E09" });
      await post(u, "2026-01-31", [L(u, "2121", "dr", "100.00", d), L(u, "4210", "cr", "100.00")], { rule: "E15" });
      await post(u, "2026-02-01", [L(u, "1113", "dr", "60.00"), L(u, "1114", "cr", "60.00")], { origin: "manual" });
      const S = await one(`insert into suppliers (user_id, name_ar) values ($1, 'مورد') returning id`, [u]);
      await q(`insert into supplier_bills (user_id, number, supplier_id, bill_date, due_date, status, owner_id, charge_to, subtotal, total, approved_at)
               values ($1, 'BILL-000001', $2, '2026-02-05', '2026-03-05', 'approved', $3, 'landlord', 200, 200, now())`, [u, S, O2]);
      await post(u, "2026-02-05", [L(u, "2121", "dr", "200.00", d), L(u, "2111", "cr", "200.00")], { rule: "E38" });
      // The holder's own deposit into the office bank is not client money.
      await post(u, "2026-02-06", [L(u, "1113", "dr", "700.00", { ownerId: O1 }), L(u, "2141", "cr", "700.00", { ownerId: O1 })], { rule: "E09" });
      const r = await check(u, "R16");
      // Trust 1000 + 500 − 60 = 1440 = 2121 (1000 − 100 − 200 = 700) + 2141 agent 500 + office money (100 − 60 = 40) + unpaid bill 200.
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["ok", "1440.00", "1440.00", "0.00"]);
      assert.deepEqual(r.explanations[0].items[0], {
        landlordPayable: "700.00", depositsHeld: "500.00", cashInTransit: "0.00", commissionDeducted: "100.00", landlordExpensesPaidByOffice: "0.00",
        transfersToOffice: "-60.00", officeMoneyNotTransferred: "40.00", landlordBillsUnpaid: "200.00", openingBalanceDifference: "0.00",
      });
    });

    it("pass: the landlord bill paid from trust leaves nothing unpaid and nothing owed to the office", async () => {
      const u = U_T;
      const [b] = (await q(`select id, supplier_id from supplier_bills where user_id = $1`, [u])).rows;
      const P = await one(`insert into supplier_payments (user_id, number, supplier_id, paid_on, amount, bank_account_id) values ($1, 'PV-000001', $2, '2026-02-20', 200, null) returning id`, [u, b.supplier_id]);
      await q(`insert into supplier_payment_allocations (payment_id, bill_id, user_id, amount) values ($1, $2, $3, 200)`, [P, b.id, u]);
      await post(u, "2026-02-20", [L(u, "2111", "dr", "200.00"), L(u, "1114", "cr", "200.00")], { rule: "E39" });
      const r = await check(u, "R16");
      assert.deepEqual([r.status, r.ledger, r.subLedger], ["ok", "1240.00", "1240.00"]);
      assert.equal(r.explanations[0].items[0].landlordBillsUnpaid, "0.00");
    });

    it("fail: managed rent collected into the office's own account is listed entry by entry", async () => {
      const u = U_T;
      const d = { ownerId: O2 };
      const e = await post(u, "2026-03-10", [L(u, "1113", "dr", "300.00", d), L(u, "1122", "cr", "300.00", d), L(u, "2122", "dr", "300.00", d), L(u, "2121", "cr", "300.00", d)], { rule: "E03" });
      const r = await check(u, "R16");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference], ["difference", "1240.00", "1540.00", "-300.00"]);
      assert.deepEqual(r.rows.map((x: any) => [x.entryId, x.rule, x.trust, x.liability, x.difference]), [[Number(e.id), "E03", "0.00", "300.00", "-300.00"]]);
      // A bank fee taken from the trust account also shows (the office must cover it).
      await post(u, "2026-03-11", [L(u, "5270", "dr", "5.00"), L(u, "1114", "cr", "5.00")], { origin: "manual" });
      assert.equal((await check(u, "R16")).rows.length, 2);
    });
  });

  // ─────────────────────────────── R17–R21 ───────────────────────────────
  describe("R17–R21 count checks", () => {
    let C: number, T: number;
    before(async () => {
      const u = U_A;
      T = await one(`insert into tenants (user_id, name) values ($1, 'Synthetic Tenant') returning id`, [u]);
      C = await one(`insert into contracts (user_id, contract_number, tenant_id, tenant_name, start_date, end_date, monthly_rent) values ($1, 'C-1', $2, 'Synthetic Tenant', '2026-01-01', '2026-12-31', 1000) returning id`, [u, T]);
    });

    it("R17: pass with unique numbers; fail on a repeated invoice number and a repeated payment-voucher number", async () => {
      const u = U_A;
      await q(`insert into simple_invoices (user_id, number, status, contract_id, subtotal, total, issue_date) values ($1, 'INV-000001', 'confirmed', null, 10, 10, '2026-01-02')`, [u]);
      let r = await check(u, "R17");
      assert.deepEqual([r.status, r.ledger, r.subLedger, r.difference, r.unit], ["ok", "0", "0", "0", "count"]);
      await q(`insert into simple_invoices (user_id, number, status, subtotal, total, issue_date) values ($1, 'INV-000001', 'draft', 10, 10, '2026-01-03')`, [u]);
      await q(`insert into finance_deposit_refunds (user_id, contract_id, amount, refunded_on, number) values ($1, $2, 5, '2026-01-04', 'PV-000001')`, [u, C]);
      r = await check(u, "R17"); // PV-000001 is also the supplier payment above
      assert.deepEqual([r.status, r.ledger], ["difference", "2"]);
      assert.deepEqual(r.rows.map((x: any) => [x.kind, x.number, x.count]), [["document", "INV-000001", 2], ["payment_voucher", "PV-000001", 2]]);
      await q(`delete from simple_invoices where user_id = $1 and status = 'draft'`, [u]);
      await q(`delete from finance_deposit_refunds where user_id = $1`, [u]);
    });

    it("R18 and R19: a due installment with an invoice passes both; an unlinked rent invoice and an uninvoiced due installment fail", async () => {
      const u = U_A;
      const p1 = await one(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-01-01', 'pending') returning id`, [u, C]);
      await q(`insert into payments (user_id, contract_id, amount, due_date, status, description) values ($1, $2, 2000, '2026-01-01', 'pending', $3)`, [u, C, DEPOSIT_DESC]); // a deposit row: never "due rent"
      await q(`insert into simple_invoices (user_id, number, status, contract_id, payment_id, subtotal, total, issue_date) values ($1, 'INV-000002', 'confirmed', $2, $3, 1000, 1000, '2026-01-01')`, [u, C, p1]);
      assert.equal((await check(u, "R18")).status, "ok");
      assert.equal((await check(u, "R19")).status, "ok");
      // An invoice linked through payment_ids also counts.
      const p2 = await one(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-02-01', 'pending') returning id`, [u, C]);
      await q(`insert into simple_invoices (user_id, number, status, contract_id, payment_ids, subtotal, total, issue_date) values ($1, 'INV-000003', 'confirmed', $2, $3::jsonb, 1000, 1000, '2026-02-01')`, [u, C, JSON.stringify([p2])]);
      assert.equal((await check(u, "R19")).status, "ok");
      // Failures.
      const bad = await one(`insert into simple_invoices (user_id, number, status, contract_id, subtotal, total, issue_date) values ($1, 'INV-000004', 'confirmed', $2, 500, 500, '2026-02-15') returning id`, [u, C]);
      const p3 = await one(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-03-01', 'pending') returning id`, [u, C]);
      await q(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-03-01', 'cancelled')`, [u, C]); // cancelled: not due
      await q(`insert into payments (user_id, contract_id, amount, due_date, status) values ($1, $2, 1000, '2026-04-01', 'pending')`, [u, C]);   // after asOf
      const r18 = await check(u, "R18");
      assert.deepEqual([r18.status, r18.ledger, r18.rows.map((x: any) => x.documentId)], ["difference", "1", [bad]]);
      const r19 = await check(u, "R19");
      assert.deepEqual([r19.status, r19.ledger, r19.rows.map((x: any) => x.paymentId)], ["difference", "1", [p3]]);
      assert.equal(r19.explanations[0].amount, "1000.00");
      // Before the ledger's go-live date nothing counts: those sources are in the opening balance.
      await q(`update finance_settings set ledger_go_live_date = '2026-03-02' where account_user_id = $1`, [u]);
      assert.equal((await check(u, "R19")).status, "ok");
      assert.equal((await check(u, "R18")).status, "ok");
      await q(`update finance_settings set ledger_go_live_date = null where account_user_id = $1`, [u]);
      await q(`update simple_invoices set payment_id = $2 where id = $1`, [bad, p3]);
      assert.equal((await check(u, "R18")).status, "ok");
      assert.equal((await check(u, "R19")).status, "ok");
    });

    it("R20: pass with no late documents; fail on a document dated in a closed period and a queued event there", async () => {
      const u = U_A;
      assert.equal((await check(u, "R20")).status, "ok");
      await q(`update fiscal_periods set status = 'closed', closed_at = now() where user_id = $1 and starts_on = '2026-01-01'`, [u]);
      const late = await post(u, "2026-02-03", [L(u, "5290", "dr", "10.00"), L(u, "1113", "cr", "10.00")], { originalDate: "2026-01-25", isLate: true, rule: "E18" });
      await q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload, next_attempt_at)
               values ($1, 'expense', 880001, 'rev:1', '2026-01-26', '{"rule":"E18"}', now() + interval '1 day')`, [u]);
      const r = await check(u, "R20");
      assert.deepEqual([r.status, r.ledger], ["difference", "2"]);
      assert.deepEqual(r.rows.map((x: any) => [x.kind, x.entryId == null ? null : Number(x.entryId), x.documentDate]), [["late_entry", Number(late.id), "2026-01-25"], ["queued_event", null, "2026-01-26"]]);
      // Once February (where the late entry sits) is closed as well, it is accepted history.
      await q(`update ledger_outbox set status = 'dismissed' where user_id = $1 and source_id = 880001`, [u]);
      await q(`update fiscal_periods set status = 'closed', closed_at = now() where user_id = $1 and starts_on = '2026-02-01'`, [u]);
      assert.equal((await check(u, "R20")).status, "ok");
      await q(`update fiscal_periods set status = 'open', closed_at = null where user_id = $1 and starts_on in ('2026-01-01', '2026-02-01')`, [u]);
    });

    it("R21: pass on leaf accounts; fail on a line whose account became a group (the DB normally refuses it)", async () => {
      const u = U_A;
      assert.deepEqual([(await check(u, "R21")).status, (await check(u, "R21")).ledger], ["ok", "0"]);
      await q(`alter table accounts disable trigger user`);
      try {
        await q(`update accounts set is_group = true where id = $1`, [acc[u]["5290"]]);
      } finally {
        await q(`alter table accounts enable trigger user`);
      }
      const r = await check(u, "R21");
      assert.equal(r.status, "difference");
      assert.ok(Number(r.ledger) >= 1);
      assert.ok(r.rows.every((x: any) => x.code === "5290"));
      await q(`alter table accounts disable trigger user`);
      try { await q(`update accounts set is_group = false where id = $1`, [acc[u]["5290"]]); } finally { await q(`alter table accounts enable trigger user`); }
    });
  });

  // ─────────────────────────────── the 21-row view and stored runs ───────────────────────────────
  describe("the accountant's 21 rows, stored runs", () => {
    it("maps his 21 checks onto R1–R21 in his order, with v2's R4–R7 underneath", async () => {
      assert.deepEqual(CONTROL_ROWS.map((x) => x.no), Array.from({ length: 21 }, (_, i) => i + 1));
      const ev = await controls.evaluate(U_B, ASOF, "en", "2026-05-01");
      assert.equal(ev.checks.length, 21);
      const byNo = (n: number) => ev.checks.find((c) => c.no === n)!;
      assert.equal(byNo(4).checkId, byNo(10).checkId);
      assert.equal(byNo(7).checkId, "R11");
      assert.equal(byNo(16).checkId, "R16");
      assert.equal(byNo(1).label, "Journal balanced (total debits = total credits)");
      assert.deepEqual(ev.additional.map((c) => c.checkId), ["R4", "R5", "R6", "R7"]);
      assert.equal(byNo(17).unit, "count");
      assert.equal(ev.summary.total, 21);
      assert.equal(ev.summary.passed + ev.summary.failed + ev.summary.unavailable, 21);
      // R3 has no legacy computation here: unavailable, neither passed nor blocking.
      assert.equal(byNo(6).result, "unavailable");
      assert.ok(!ev.blocking.includes("R3"));
    });

    it("stores a run and reports the latest; the nightly run covers started flag-on accounts only", async () => {
      assert.equal(await controls.latest(U_O), null);
      const r = await controls.run(U_A, ASOF, "manual", U_A);
      const last = await controls.latest(U_A);
      assert.equal(last!.id, r.runId);
      assert.deepEqual([last!.trigger, last!.asOf, last!.total, last!.failing], ["manual", ASOF, 21, r.blocking]);
      await q(`update finance_settings set ledger_started_at = null where account_user_id = $1`, [U_O]);
      const before = Number((await q(`select count(*)::int n from finance_control_runs`)).rows[0].n);
      const n = await controls.runNightly("2026-05-02");
      assert.equal(n, 4, "U_A, U_T, U_B, U_G; U_O has not started");
      assert.equal(Number((await q(`select count(*)::int n from finance_control_runs where trigger = 'nightly'`)).rows[0].n), 4);
      assert.equal(await controls.runNightly("2026-05-02"), 0, "once a day");
      assert.equal(Number((await q(`select count(*)::int n from finance_control_runs`)).rows[0].n), before + 4);
      const [row] = (await q(`select results from finance_control_runs where user_id = $1 and trigger = 'nightly'`, [U_T])).rows;
      assert.equal(row.results.find((x: any) => x.no === 16).status, "difference");
    });
  });

  // ─────────────────────────────── the close gate ───────────────────────────────
  describe("period close is blocked by a failing check; a finance admin may override with a reason", () => {
    let pc: PeriodCloseService;
    const TODAY = "2026-04-15";
    const pid = async (start: string) => Number((await q(`select id from fiscal_periods where user_id = $1 and starts_on = $2`, [U_G, start])).rows[0].id);
    before(async () => {
      const stubWorker: any = { runAccount: async () => null };
      const stubRecognizer: any = { runAccount: async () => ({ charges: 0, settlements: 0, releases: 0 }) };
      const stubBackfill: any = { missingKeys: async () => [] };
      // R3 against an (empty) legacy dues computation, so every check can pass.
      const gateControls = new ControlChecksService(t.pool, new ReconciliationService(t.pool, async () => ({ landlordDues: [], landlordStatement: [] })));
      pc = new PeriodCloseService(t.pool, periods, repo, stubWorker, stubRecognizer, stubBackfill, gateControls);
      const u = U_G;
      await post(u, "2026-01-10", [L(u, "1113", "dr", "1000.00"), L(u, "3100", "cr", "1000.00")], { origin: "manual" });
      await withTx(t.pool, (c) => periods.ensureFiscalYear(c, u, 2025));
      await withTx(t.pool, (c) => periods.ensureFiscalYear(c, u, 2026));
      await q(`update fiscal_periods set status = 'closed' where user_id = $1 and fiscal_year = 2025`, [u]);
    });

    it("a clean month closes and stores a period_close run", async () => {
      const res: any = await pc.close(U_G, holder(U_G), await pid("2026-01-01"), {}, TODAY);
      assert.equal(res.period.status, "closed");
      assert.deepEqual(res.controls, { passed: 21, total: 21, failing: [], overridden: false });
      const [run] = (await q(`select trigger, period_id, failing from finance_control_runs where user_id = $1 order by id desc limit 1`, [U_G])).rows;
      assert.deepEqual([run.trigger, Number(run.period_id), run.failing], ["period_close", await pid("2026-01-01"), []]);
    });

    it("a failing check refuses the close with the failures; override needs the capability and a reason; it is audited", async () => {
      const u = U_G;
      const feb = await pid("2026-02-01");
      // Two drafts carrying the same number: #17 fails, nothing else moves.
      await q(`insert into simple_invoices (user_id, number, status, subtotal, total, issue_date) values ($1, 'INV-000009', 'draft', 1, 1, '2026-02-10'), ($1, 'INV-000009', 'draft', 1, 1, '2026-02-11')`, [u]);
      await assert.rejects(pc.close(u, holder(u), feb, {}, TODAY), (e: any) => {
        err("CONTROL_CHECKS_FAILED", 409)(e);
        const b = e.getResponse();
        assert.deepEqual(b.blocking, ["R17"]);
        assert.deepEqual(b.failing.map((x: any) => [x.no, x.checkId, x.value1, x.unit]), [[17, "R17", "1", "count"]]);
        assert.deepEqual(b.failing[0].items[0], { kind: "document", number: "INV-000009", count: 2 });
        assert.equal(b.canOverride, true);
        return true;
      });
      assert.equal(canOverrideControls(clerk(9601, u)), false);
      await assert.rejects(pc.close(u, clerk(9601, u), feb, { override: true, overrideReason: "Ejar invoices issued outside Dara" }, TODAY), err("OVERRIDE_NOT_ALLOWED", 403));
      await assert.rejects(pc.close(u, holder(u), feb, { override: true }, TODAY), err("REASON_REQUIRED", 400));
      await assert.rejects(pc.close(u, holder(u), feb, { override: true, overrideReason: "ok" }, TODAY), err("REASON_REQUIRED", 400));
      const [pp] = (await q(`select status from fiscal_periods where id = $1`, [feb])).rows;
      assert.equal(pp.status, "open", "nothing closed on a refusal");
      const res: any = await pc.close(u, holder(u), feb, { override: true, overrideReason: "Ejar invoices issued outside Dara" }, TODAY);
      assert.equal(res.period.status, "closed");
      assert.deepEqual(res.controls, { passed: 20, total: 21, failing: ["R17"], overridden: true });
      const [ev] = (await q(`select old_value, new_value, reason, actor_user_id from finance_settings_events where account_user_id = $1 and field = 'period_close_override'`, [u])).rows;
      assert.deepEqual([ev.old_value, ev.new_value.status, ev.reason, ev.actor_user_id], [{ periodId: feb, failing: ["R17"] }, "closed", "Ejar invoices issued outside Dara", u]);
      const [au] = (await q(`select entity, entity_id, path from audit_logs where owner_user_id = $1 and entity = 'finance_v2_period_override'`, [u])).rows;
      assert.deepEqual([au.entity_id, au.path], [String(feb), `/finance/v2/periods/${feb}/close`]);
      const [run] = (await q(`select trigger, failing from finance_control_runs where user_id = $1 order by id desc limit 1`, [u])).rows;
      assert.deepEqual([run.trigger, run.failing], ["period_close_override", ["R17"]]);
    });

    it("year close runs the same gate for December", async () => {
      const u = U_G;
      for (let m = 3; m <= 11; m++) {
        const id = await pid(`2026-${String(m).padStart(2, "0")}-01`);
        await q(`update fiscal_periods set status = 'closed' where id = $1`, [id]);
      }
      await assert.rejects(pc.closeYear(u, holder(u), { fiscalYear: 2026 }, "2027-01-15"), err("CONTROL_CHECKS_FAILED", 409));
      const res: any = await pc.closeYear(u, holder(u), { fiscalYear: 2026, override: true, overrideReason: "Accepted by the auditor" }, "2027-01-15");
      assert.equal(res.controls.overridden, true);
    });

    it("the gate is off when no controls service is wired (legacy constructor)", async () => {
      const plain = new PeriodCloseService(t.pool, periods, repo, { runAccount: async () => null } as any, { runAccount: async () => ({}) } as any, { missingKeys: async () => [] } as any);
      assert.equal((plain as any).controls, undefined);
    });
  });

  describe("routes", () => {
    it("every route is behind JwtAuthGuard + FinanceV2Guard with the view capability", () => {
      const guards = Reflect.getMetadata("__guards__", FinanceV2ControlsController) ?? [];
      assert.ok(guards.includes(FinanceV2Guard));
      const proto = FinanceV2ControlsController.prototype as any;
      for (const m of ["report", "latest", "run"]) {
        assert.equal(Reflect.getMetadata("fv2:capability", proto[m]), "view", m);
        assert.equal(Reflect.getMetadata("fv2:allowOwnerScope", proto[m]), undefined, m);
      }
    });
  });
});
