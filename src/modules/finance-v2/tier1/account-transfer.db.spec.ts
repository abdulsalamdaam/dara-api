import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, type TestDb } from "../__tests__/with-db";
import { withTx } from "../db";
import { toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { PeriodsService } from "../periods.service";
import { ChartService } from "../chart.service";
import { FinanceSetupService } from "../setup.service";
import { JournalRepository, type LineInput } from "../journal.repository";
import { PostingEngine } from "../posting.engine";
import { JournalQueryService } from "../journal-query.service";
import { BankAccountsService } from "./bank-accounts.service";
import { AccountTransferService } from "./account-transfer.service";
import { AcctReportsService } from "../reports/acct-reports.service";
import { ExtraChecks } from "../reports/control-checks";
import { FinanceV2Tier1Controller } from "../controllers/tier1.controller";

/**
 * Transfer between accounts (تحويل بين الحسابات, accountant round 5) on a throwaway Postgres, synthetic data.
 * The accountant's case: the cash box (1111) holds 5,425, of which 5,215 is client money (landlord dues 2,215 +
 * deposits 3,000) collected before the trust account; moving it is Dr 1114 trust / Cr 1111 cash.
 */
const U = 7801;
const V = 7802; // another account: its boxes are invisible to U
const ALL = ["reports.view", "payments.view", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete", "payments.write"];
const holder = (id: number) => ({ id, ownerUserId: null, ownerScopeId: null, role: "user", permissions: ALL }) as any;
/** An employee with `money` (payments.write) but not `settings`. */
const cashier = (id: number, scope: number) => ({ id, ownerUserId: scope, ownerScopeId: null, role: "employee", permissions: ["reports.view", "payments.view", "payments.write"] }) as any;

const today = riyadhToday();
const monthStart = `${today.slice(0, 8)}01`;
const prevMonth = (() => { const d = new Date(`${monthStart}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
const prev2Month = (() => { const d = new Date(`${monthStart}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 2); return d.toISOString().slice(0, 10); })();
const tomorrow = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

const fails = (code: string, status?: number) => (e: any) => {
  const body = e?.getResponse?.();
  assert.equal(body?.error, code, JSON.stringify(body ?? String(e)));
  if (status) assert.equal(e.getStatus(), status);
  return true;
};

describe("finance v2 transfer between accounts (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let repo: JournalRepository;
  let banks: BankAccountsService;
  let svc: AccountTransferService;
  let jq: JournalQueryService;
  let reports: AcctReportsService;
  let checks: ExtraChecks;
  const acc: Record<number, Record<string, number>> = {};
  const box: Record<number, { cash: number; bank: number; trust: number }> = {} as any;
  let nSrc = 0;
  let transferEntryId = 0;
  let transferMj = 0;

  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const L = (u: number, code: string, side: "dr" | "cr", amt: string, x: Partial<LineInput> = {}): LineInput =>
    ({ accountId: acc[u][code], [side === "dr" ? "debit" : "credit"]: toHalalas(amt), ...x });
  const post = (u: number, date: string, lines: LineInput[], rule?: string) =>
    withTx(t.pool, (c) => repo.post(c, { userId: u, entryDate: date, origin: "auto", sourceType: "test", sourceId: ++nSrc, event: "posted", lines, payload: rule ? { rule } : {} }));
  const bal = async (u: number, id: number) => (await banks.get(u, id)).balance;

  before(async () => {
    t = await withDb({ legacy: "full" });
    const periods = new PeriodsService(t.pool);
    repo = new JournalRepository(periods);
    const setup = new FinanceSetupService(new ChartService(t.pool), periods);
    banks = new BankAccountsService(t.pool);
    svc = new AccountTransferService(t.pool, repo, periods);
    jq = new JournalQueryService(t.pool, new PostingEngine(t.pool, repo, periods));
    reports = new AcctReportsService(t.pool);
    checks = new ExtraChecks(t.pool);
    for (const u of [U, V]) {
      await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [u, `fv2-trf-${u}@example.test`]);
      await withTx(t.pool, async (c) => {
        await c.query(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, ledger_started_at) values ($1, true, 'manager', now(), now())`, [u]);
        await setup.firstEnable(c, u, null);
      });
      await q(`update finance_settings set agency_collections_to_trust = true where account_user_id = $1`, [u]);
      acc[u] = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [u])).map((r: any) => [r.code, r.id]));
      const list = await banks.list(u);
      box[u] = {
        cash: list.find((b) => b.glCode === "1111")!.id,
        bank: list.find((b) => b.glCode === "1113")!.id,
        trust: list.find((b) => b.glCode === "1114")!.id,
      };
    }
    // The accountant's cash box: landlord rent 2,215 (Cr 2121), deposits 3,000 (Cr 2141) and 210 of the office's own
    // revenue, all collected into 1111 at the start of the month — before the trust account was used.
    const sk = async (u: number, k: string) => Number((await q(`select id from accounts where user_id = $1 and system_key = $2`, [u, k]))[0].id);
    const lp = await sk(U, "landlord_payable");
    const dep = await sk(U, "deposits_held");
    await post(U, monthStart, [L(U, "1111", "dr", "2215.00"), { accountId: lp, credit: toHalalas("2215.00") }]);
    await post(U, monthStart, [L(U, "1111", "dr", "3000.00"), { accountId: dep, credit: toHalalas("3000.00") }]);
    await post(U, monthStart, [L(U, "1111", "dr", "210.00"), L(U, "4390", "cr", "210.00")]);
  });
  after(async () => { await t?.drop(); });

  it("before: cash 5,425, trust 0; R16 is short the 5,215 of client money sitting in the cash box", async () => {
    assert.equal(await bal(U, box[U].cash), "5425.00");
    assert.equal(await bal(U, box[U].trust), "0.00");
    const r16 = await checks.r16(U, today, "manager");
    assert.deepEqual([r16.status, r16.ledger, r16.subLedger, r16.difference], ["difference", "0.00", "5215.00", "-5215.00"]);
  });

  it("validation: same account, bad amounts, future date, missing ids", async () => {
    const base = { fromBankAccountId: box[U].cash, toBankAccountId: box[U].trust, amount: "10" };
    await assert.rejects(svc.create(U, holder(U), { ...base, toBankAccountId: box[U].cash }), fails("SAME_ACCOUNT", 400));
    for (const amount of ["0", "-5", "12.345", "abc", "", null, "1e3", "1000000000", "1000000000000"]) {
      await assert.rejects(svc.create(U, holder(U), { ...base, amount }), fails("BAD_AMOUNT", 400), String(amount));
    }
    await assert.rejects(svc.create(U, holder(U), { ...base, date: tomorrow }), fails("FUTURE_DATE", 400));
    await assert.rejects(svc.create(U, holder(U), { ...base, date: "2026-02-30" }), fails("BAD_DATE", 400));
    await assert.rejects(svc.create(U, holder(U), { ...base, fromBankAccountId: undefined }), fails("BAD_BANK_ACCOUNT", 400));
    await assert.rejects(svc.create(U, holder(U), { ...base, note: "x".repeat(501) }), fails("BAD_INPUT", 400));
    assert.equal((await q(`select count(*)::int as n from manual_journals where user_id = $1`, [U]))[0].n, 0, "nothing was written");
  });

  it("scope: another account's bank account is refused in either position (404), and V cannot use U's ids", async () => {
    await assert.rejects(svc.create(U, holder(U), { fromBankAccountId: box[U].cash, toBankAccountId: box[V].trust, amount: "10" }), fails("BANK_ACCOUNT_NOT_FOUND", 404));
    await assert.rejects(svc.create(U, holder(U), { fromBankAccountId: box[V].cash, toBankAccountId: box[U].trust, amount: "10" }), fails("BANK_ACCOUNT_NOT_FOUND", 404));
    await assert.rejects(svc.create(V, holder(V), { fromBankAccountId: box[U].cash, toBankAccountId: box[U].trust, amount: "10" }), fails("BANK_ACCOUNT_NOT_FOUND", 404));
    assert.equal((await q(`select count(*)::int as n from journal_entries where user_id = $1`, [V]))[0].n, 0);
  });

  it("an inactive account is refused", async () => {
    const extra = await banks.create(U, U, { kind: "cash", nameAr: "عهدة موقوفة", nameEn: "Petty (off)" });
    await banks.update(U, U, extra.id, { isActive: false });
    await assert.rejects(svc.create(U, holder(U), { fromBankAccountId: box[U].cash, toBankAccountId: extra.id, amount: "10" }), fails("BANK_ACCOUNT_INACTIVE", 400));
    await assert.rejects(svc.create(U, holder(U), { fromBankAccountId: extra.id, toBankAccountId: box[U].cash, amount: "10" }), fails("BANK_ACCOUNT_INACTIVE", 400));
  });

  it("periods: a locked period is refused; a closed one needs `settings`", async () => {
    await q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on = $2`, [U, prev2Month]);
    await assert.rejects(svc.create(U, holder(U), { fromBankAccountId: box[U].cash, toBankAccountId: box[U].trust, amount: "10", date: prev2Month }), fails("PERIOD_LOCKED", 409));
    await q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = $2`, [U, prevMonth]);
    await assert.rejects(svc.create(U, cashier(9001, U), { fromBankAccountId: box[U].cash, toBankAccountId: box[U].trust, amount: "10", date: prevMonth }), fails("PERIOD_CLOSED", 409));
    await q(`update fiscal_periods set status = 'open' where user_id = $1 and starts_on = $2`, [U, prevMonth]); // a lock is irreversible
  });

  it("R15 on the trust account before the transfer: a statement with closing 0 reconciles", async () => {
    await q(`insert into bank_statements (user_id, bank_account_id, period_from, period_to, opening_balance, closing_balance, imported_by)
             values ($1, $2, $3, $4, 0, 0, $1)`, [U, box[U].trust, monthStart, today]);
    const r15 = await checks.r15(U, today);
    assert.equal(r15.status, "ok", JSON.stringify(r15));
  });

  it("posts one balanced entry: Dr trust 1114 / Cr cash 1111, both balances move, a posted manual journal links it", async () => {
    const r = await svc.create(U, cashier(9001, U), {
      fromBankAccountId: String(box[U].cash), toBankAccountId: box[U].trust, amount: "5215", date: today, reference: "R-4", note: "أموال عملاء قبل حساب الأمانات",
    });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.amount, "5215.00");
    assert.match(r.entryNo, /^JV-\d{4}-\d{6}$/);
    assert.deepEqual([r.from.glCode, r.from.balance, r.to.glCode, r.to.balance], ["1111", "210.00", "1114", "5215.00"]);
    assert.equal(await bal(U, box[U].cash), "210.00");
    assert.equal(await bal(U, box[U].trust), "5215.00");
    transferEntryId = r.entryId;
    transferMj = r.manualJournalId;

    const e: any = await jq.get(U, r.entryId);
    assert.deepEqual([e.origin, e.sourceType, e.sourceId, e.status, e.total], ["manual", "manual_journal", r.manualJournalId, "posted", "5215.00"]);
    assert.deepEqual(e.lines.map((l: any) => [l.code, l.debit, l.credit, l.bankAccountId]), [
      ["1114", "5215.00", "0.00", box[U].trust],
      ["1111", "0.00", "5215.00", box[U].cash],
    ]);
    assert.match(e.memo, /R-4/);
    assert.equal(e.source.route, `/dashboard/accounting/manual-journals/${r.manualJournalId}`);
    const [mj] = await q(`select kind, status, created_by, approved_by, posted_entry_id::int as pe from manual_journals where id = $1`, [r.manualJournalId]);
    assert.deepEqual(mj, { kind: "manual", status: "posted", created_by: 9001, approved_by: 9001, pe: r.entryId });
    assert.equal((await q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_account_transfer'`, [U]))[0].n, 1);
    // The journal lists it.
    const list = await jq.list(U, { sourceType: "manual_journal" });
    assert.ok(list.items.some((x: any) => x.id === r.entryId));
  });

  it("cash flow: an internal transfer (no inflow or outflow); only the restricted / own split moves", async () => {
    const cf: any = await reports.cashFlow(U, { from: monthStart, to: today });
    assert.equal(cf.internalTransfers.amount, "0.00");
    assert.equal(cf.internalTransfers.restricted, "5215.00");
    assert.equal(cf.internalTransfers.own, "-5215.00");
    assert.equal(cf.internalTransfers.gross, "5215.00");
    // Operating receipts are only the three collections (5,425); the transfer adds nothing.
    const op = cf.sections.find((s: any) => s.key === "operating");
    assert.equal(op.total.amount, "5425.00");
    assert.equal(cf.netChange.amount, "5425.00");
    assert.equal(cf.closing.amount, "5425.00");
    assert.equal(cf.closing.restricted, "5215.00");
  });

  it("R13, R15 and R16 balance after the transfer", async () => {
    const r13 = await checks.r13(U, monthStart, today);
    assert.equal(r13.status, "ok", JSON.stringify(r13));
    const r15 = await checks.r15(U, today); // the unmatched trust line is an outstanding receipt on both sides
    assert.equal(r15.status, "ok", JSON.stringify(r15));
    const r16 = await checks.r16(U, today, "manager");
    assert.deepEqual([r16.status, r16.ledger, r16.subLedger], ["ok", "5215.00", "5215.00"], JSON.stringify(r16.explanations));
  });

  it("a transfer that overdraws the source posts with a SOURCE_BALANCE_NEGATIVE warning", async () => {
    const r = await svc.create(U, holder(U), { fromBankAccountId: box[U].cash, toBankAccountId: box[U].bank, amount: "300.50" });
    assert.deepEqual(r.warnings, ["SOURCE_BALANCE_NEGATIVE"]);
    assert.equal(r.from.balance, "-90.50");
    const [e] = await q(`select warnings from journal_entries where id = $1`, [r.entryId]);
    assert.deepEqual(e.warnings, ["SOURCE_BALANCE_NEGATIVE"]);
    // Reverse it through the existing manual reversal: balances come back and the manual journal is void.
    await jq.reverse(U, holder(U), r.entryId, { reason: "test" });
    assert.equal(await bal(U, box[U].cash), "210.00");
    assert.equal(await bal(U, box[U].bank), "0.00");
    const [mj] = await q(`select status from manual_journals where id = $1`, [r.manualJournalId]);
    assert.equal(mj.status, "void");
  });

  it("reversal of the trust transfer restores both balances and voids the manual journal", async () => {
    await jq.reverse(U, holder(U), transferEntryId, { reason: "undo" });
    assert.equal(await bal(U, box[U].cash), "5425.00");
    assert.equal(await bal(U, box[U].trust), "0.00");
    assert.equal((await q(`select status from manual_journals where id = $1`, [transferMj]))[0].status, "void");
    // R16 reads the reversal as undoing the money moved in, not as office money moved out of trust: short 5,215 again.
    const r16 = await checks.r16(U, today, "manager");
    assert.deepEqual([r16.status, r16.ledger, r16.subLedger, r16.difference], ["difference", "0.00", "5215.00", "-5215.00"]);
  });

  it("the ledger must have started", async () => {
    await q(`update finance_settings set ledger_started_at = null where account_user_id = $1`, [V]);
    await assert.rejects(svc.create(V, holder(V), { fromBankAccountId: box[V].cash, toBankAccountId: box[V].trust, amount: "1" }), fails("LEDGER_NOT_STARTED", 409));
  });

  it("the route needs the `money` capability", () => {
    assert.equal(Reflect.getMetadata("fv2:capability", (FinanceV2Tier1Controller.prototype as any).transfer), "money");
  });

  it("a repeated requestId (double click, retry, or both at once) posts once and returns the first transfer", async () => {
    await q(`update finance_settings set finance_v2_enabled = true, ledger_started_at = coalesce(ledger_started_at, now()) where account_user_id = $1`, [V]);
    const before = await bal(V, box[V].bank);
    const body = { fromBankAccountId: box[V].bank, toBankAccountId: box[V].cash, amount: "7.00", requestId: "dbl-click-0001" };
    const [a, b] = await Promise.all([svc.create(V, holder(V), body), svc.create(V, holder(V), body)]);
    const c = await svc.create(V, holder(V), body);
    assert.equal(a.entryId, b.entryId);
    assert.equal(a.entryId, c.entryId);
    assert.equal([a, b].filter((r) => r.replayed).length, 1);
    assert.equal(c.replayed, true);
    assert.equal(c.amount, "7.00");
    assert.equal(toHalalas(await bal(V, box[V].bank)), toHalalas(before) - toHalalas("7.00"));
    const n = await q(`select count(*)::int as n from journal_entries where user_id = $1 and payload->'transfer'->>'requestId' = 'dbl-click-0001'`, [V]);
    assert.equal(n[0].n, 1);
    // A new request id is a new transfer; a malformed one is refused.
    const d = await svc.create(V, holder(V), { ...body, requestId: "dbl-click-0002" });
    assert.notEqual(d.entryId, a.entryId);
    await assert.rejects(svc.create(V, holder(V), { ...body, requestId: "bad id!" }), fails("BAD_INPUT", 400));
  });
});

/**
 * R16 with the accountant's round-5 figures, on a fresh account: deposits 3,000 collected into trust; rent 6,000
 * collected into the cash box, less 210 commission (E15) and 575 cleaning paid from the cash box (E18), so the cash
 * box holds 5,215 of landlord dues. Expected client money in trust is 8,215 throughout; the trust balance moves with
 * the transfer and its reversal, and a commission transfer trust → office (and its reversal) keeps R16 balanced.
 */
describe("finance v2 transfer between accounts: R16 through transfer and reversal (real Postgres)", { skip: fv2DbSkip }, () => {
  const W = 7803;
  let t: TestDb;
  let svc: AccountTransferService;
  let jq: JournalQueryService;
  let reports: AcctReportsService;
  let checks: ExtraChecks;
  let acc: Record<string, number> = {};
  let box = { cash: 0, bank: 0, trust: 0 };
  let n = 0;
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  let repo: JournalRepository;
  const post = (lines: LineInput[], rule: string) =>
    withTx(t.pool, (c) => repo.post(c, { userId: W, entryDate: monthStart, origin: "auto", sourceType: "test", sourceId: ++n, event: "posted", lines, payload: { rule } }));
  const dr = (id: number, amt: string): LineInput => ({ accountId: id, debit: toHalalas(amt) });
  const cr = (id: number, amt: string): LineInput => ({ accountId: id, credit: toHalalas(amt) });
  const r16 = async () => { const r = await checks.r16(W, today, "manager"); return [r.status, r.ledger, r.subLedger, r.difference]; };

  before(async () => {
    t = await withDb({ legacy: "full" });
    const periods = new PeriodsService(t.pool);
    repo = new JournalRepository(periods);
    const setup = new FinanceSetupService(new ChartService(t.pool), periods);
    const banks = new BankAccountsService(t.pool);
    svc = new AccountTransferService(t.pool, repo, periods);
    jq = new JournalQueryService(t.pool, new PostingEngine(t.pool, repo, periods));
    reports = new AcctReportsService(t.pool);
    checks = new ExtraChecks(t.pool);
    await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [W, `fv2-trf-${W}@example.test`]);
    await withTx(t.pool, async (c) => {
      await c.query(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, ledger_started_at) values ($1, true, 'manager', now(), now())`, [W]);
      await setup.firstEnable(c, W, null);
    });
    await q(`update finance_settings set agency_collections_to_trust = true where account_user_id = $1`, [W]);
    acc = Object.fromEntries((await q(`select coalesce(system_key, code) as k, id from accounts where user_id = $1`, [W])).map((r: any) => [r.k, Number(r.id)]));
    const codes = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [W])).map((r: any) => [r.code, Number(r.id)]));
    const list = await banks.list(W);
    box = { cash: list.find((b) => b.glCode === "1111")!.id, bank: list.find((b) => b.glCode === "1113")!.id, trust: list.find((b) => b.glCode === "1114")!.id };
    await post([dr(codes["1114"], "3000.00"), cr(acc.deposits_held, "3000.00")], "E05");
    await post([dr(codes["1111"], "6000.00"), cr(acc.landlord_payable, "6000.00")], "E03");
    await post([dr(acc.landlord_payable, "210.00"), cr(codes["4390"], "210.00")], "E15");
    await post([dr(acc.landlord_payable, "575.00"), cr(codes["1111"], "575.00")], "E18");
  });
  after(async () => { await t?.drop(); });

  it("before: actual 3,000, expected 8,215", async () => {
    assert.deepEqual(await r16(), ["difference", "3000.00", "8215.00", "-5215.00"]);
  });

  let inEntry = 0;
  it("after moving 5,215 cash → trust: balanced", async () => {
    inEntry = (await svc.create(W, holder(W), { fromBankAccountId: box.cash, toBankAccountId: box.trust, amount: "5215" })).entryId;
    assert.deepEqual(await r16(), ["ok", "8215.00", "8215.00", "0.00"]);
  });

  it("after reversing that transfer: back to −5,215 (not ok)", async () => {
    await jq.reverse(W, holder(W), inEntry, { reason: "undo" });
    assert.deepEqual(await r16(), ["difference", "3000.00", "8215.00", "-5215.00"]);
  });

  it("transfer again, then commission trust → office: balanced, and its reversal stays balanced", async () => {
    await svc.create(W, holder(W), { fromBankAccountId: box.cash, toBankAccountId: box.trust, amount: "5215" });
    const codes = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [W])).map((r: any) => [r.code, Number(r.id)]));
    await post([dr(codes["1114"], "1000.00"), cr(acc.landlord_payable, "1000.00")], "E03");
    await post([dr(acc.landlord_payable, "100.00"), cr(codes["4390"], "100.00")], "E15");
    assert.deepEqual(await r16(), ["ok", "9215.00", "9215.00", "0.00"]);
    const out = await svc.create(W, holder(W), { fromBankAccountId: box.trust, toBankAccountId: box.bank, amount: "100" });
    assert.deepEqual(await r16(), ["ok", "9115.00", "9115.00", "0.00"]);
    const cf: any = await reports.cashFlow(W, { from: monthStart, to: today });
    assert.equal(cf.internalTransfers.amount, "0.00");
    assert.equal(cf.internalTransfers.restricted, "5115.00", "trust in 5,215 (twice, one reversed) less 100 out");
    assert.equal(cf.internalTransfers.own, "-5115.00");
    await jq.reverse(W, holder(W), out.entryId, { reason: "undo" });
    assert.deepEqual(await r16(), ["ok", "9215.00", "9215.00", "0.00"]);
    // Taking more than the commission out of trust is client money leaving: flagged.
    await svc.create(W, holder(W), { fromBankAccountId: box.trust, toBankAccountId: box.bank, amount: "400" });
    assert.deepEqual(await r16(), ["difference", "8815.00", "9115.00", "-300.00"]);
  });

  it("A → B and B → A at once both post (one lock per account, no deadlock)", async () => {
    const [a, b] = await Promise.all([
      svc.create(W, holder(W), { fromBankAccountId: box.cash, toBankAccountId: box.bank, amount: "10" }),
      svc.create(W, holder(W), { fromBankAccountId: box.bank, toBankAccountId: box.cash, amount: "10" }),
    ]);
    assert.notEqual(a.entryNo, b.entryNo);
  });

  it("a closed period takes a transfer from a `settings` holder, as an approved manual journal does", async () => {
    await q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = $2`, [W, prevMonth]);
    const r = await svc.create(W, holder(W), { fromBankAccountId: box.cash, toBankAccountId: box.bank, amount: "1", date: prevMonth });
    assert.equal(r.date, prevMonth);
  });
});
