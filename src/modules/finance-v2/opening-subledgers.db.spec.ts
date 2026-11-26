import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { ManualJournalsService } from "./manual-journals.service";
import { JournalQueryService } from "./journal-query.service";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { ApService } from "./tier3/ap.service";
import { AssetsService } from "./assets/assets.service";
import { AcctReportsService } from "./reports/acct-reports.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { legacyAccountingFor } from "./reports/legacy-accounting";
import { clientMoneyPosition, ownerPosition } from "./client-money";
import { toHalalas } from "./money";
import { join } from "node:path";

/**
 * The accountant's full cycle (27 Nov 2026), notes 13–16: an office migrating onto Dara brings its balances in with
 * the opening journal (dated 31 Oct, ledger start 1 Nov):
 *   Dr 1113 bank 25,000 · 1111 cash box 2,000 · 1114 trust 6,000 · 1221 furniture 18,000
 *   Cr 1229 accumulated depreciation 3,600 · 2111 suppliers 1,500 (a supplier) · 2121 landlord dues 6,000 (a landlord)
 *      · 3100 capital 30,000 · 3300 retained earnings 9,900                                              = 51,000
 *  13 the landlord's 6,000 is in the dues report, the payout's net due and R3's sub-ledger; trust (R16) agrees;
 *  14 the supplier's 1,500 is an open item of that supplier (aging, statement, payments, R12);
 *  15 the furniture gets an existing-asset card that ties to the opening entry and depreciates the rest of its life;
 *  16 a cash flow from 1 January shows the 33,000 as cash at the beginning, not as financing.
 * Synthetic data only.
 */
const U = 7611;
const today = riyadhToday();
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete",
  "contracts.view", "contracts.write"];
const holder = { id: U, ownerUserId: null, ownerScopeId: null, role: "user", email: `fv2-spec-${U}@example.test`, permissions: PERMS } as any;
const empA = { id: 9611, ownerUserId: U, ownerScopeId: null, role: "employee", permissions: PERMS.filter((p) => p !== "invoices.delete") } as any;
const empB = { id: 9612, ownerUserId: U, ownerScopeId: null, role: "employee", permissions: PERMS.filter((p) => p !== "invoices.delete") } as any;
const err = (code: string, status?: number) => (e: any) => {
  const body = e?.getResponse?.();
  if (status && e?.getStatus?.() !== status) return false;
  return body?.error === code;
};

describe("fv2 opening balances reach the sub-ledgers: landlords, suppliers, assets, cash flow (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let mj: ManualJournalsService, jq: JournalQueryService, ap: ApService, assets: AssetsService, acct: AcctReportsService;
  let acc: Record<string, number>;
  let sup: any;
  let opening: any;
  const recon = async (only: string) => (await new ReconciliationService(env.t.pool as any, legacyAccountingFor(drizzle(env.t.pool, { schema })))
    .reconciliation(U, { asOf: today, lang: "en", only })).checks;
  const dues = async () => (await env.reports.accounting(holder)).landlordDues.find((d: any) => d.ownerId === s.agent);
  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };

  before(async () => {
    env = await legacyEnv("wired");
    // properties.branch_name (0095) is newer than the legacy schema snapshot the harness loads.
    await env.t.apply(join(__dirname, "../../../db/drizzle/0095_property_branch_name.sql"));
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    await env.q(`update finance_settings set ledger_go_live_date = '2026-11-01' where account_user_id = $1`, [U]);
    const periods = new PeriodsService(env.t.pool);
    const journal = new JournalRepository(periods);
    mj = new ManualJournalsService(env.t.pool, journal, periods);
    jq = new JournalQueryService(env.t.pool, env.engine);
    const banks = new BankAccountsService(env.t.pool as any);
    ap = new ApService(env.t.pool as any, env.emitter, banks);
    assets = new AssetsService(env.t.pool as any, env.emitter, banks, new ChartService(env.t.pool));
    acct = new AcctReportsService(env.t.pool as any);
    acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
    sup = await ap.createSupplier(U, holder, { nameAr: "مورد تجريبي أول", paymentTermsDays: 0 });
  });

  after(async () => { await env?.t.drop(); });

  const L = (code: string, side: "dr" | "cr", amt: string, x: Record<string, unknown> = {}) =>
    ({ accountId: acc[code], debit: side === "dr" ? amt : "0", credit: side === "cr" ? amt : "0", ...x });
  const openingLines = () => [
    L("1113", "dr", "25000"), L("1111", "dr", "2000"), L("1114", "dr", "6000"), L("1221", "dr", "18000"),
    L("1229", "cr", "3600"), L("2111", "cr", "1500", { supplierId: sup.id }), L("2121", "cr", "6000", { ownerId: s.agent }),
    L("3100", "cr", "30000"), L("3300", "cr", "9900"),
  ];

  it("note 14 validation: a supplier only on a credit line of 2111, and only this account's supplier", async () => {
    const base = { entryDate: "2026-10-31", memo: "Synthetic opening", attachmentKey: `acct/${U}/journals/opening.pdf` };
    await assert.rejects(mj.create(U, empA, { ...base, lines: [L("2111", "dr", "10", { supplierId: sup.id }), L("1113", "cr", "10")] }, "opening"),
      err("SUPPLIER_LINE_CREDIT_ONLY", 400));
    await assert.rejects(mj.create(U, empA, { ...base, lines: [L("1113", "dr", "10"), L("3100", "cr", "10", { supplierId: sup.id })] }, "opening"),
      err("SUPPLIER_ON_NON_AP_ACCOUNT", 400));
    await assert.rejects(mj.create(U, empA, { ...base, lines: [L("1113", "dr", "10"), L("2111", "cr", "10", { supplierId: 999999 })] }, "opening"),
      err("DIMENSION_NOT_FOUND", 404));
  });

  it("the opening journal posts once approved (maker-checker), and its 2111 line becomes the supplier's open item", async () => {
    const d = await mj.create(U, empA, { entryDate: "2026-10-31", memo: "Synthetic opening", attachmentKey: `acct/${U}/journals/opening.pdf`, lines: openingLines() }, "opening");
    assert.equal(d.total, "51000.00");
    assert.equal(d.lines[5].supplierId, sup.id, "the supplier is kept on the draft");
    await mj.submit(U, empA, d.id);
    opening = await mj.approve(U, empB, d.id);
    assert.equal(opening.status, "posted");
    const bills = (await ap.listBills(U, { supplierId: sup.id })).rows;
    assert.equal(bills.length, 1);
    const b: any = bills[0];
    assert.deepEqual([b.status, b.billDate, b.total, b.remaining, b.journal?.entryId, b.posting?.entryId], ["approved", "2026-10-31", "1500.00", "1500.00", opening.postedEntryId, opening.postedEntryId]);
    const ob = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_type = 'supplier_bill'`, [U]);
    assert.equal(ob[0].n, 0, "nothing posts for the bill: the journal is its entry");
    const [ap2111] = await env.q(`select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l where l.user_id = $1 and l.account_id = $2`, [U, acc["2111"]]);
    assert.equal(ap2111.b, "1500.00", "2111 is credited once");
  });

  it("note 14: R12 ties, the aging and the supplier statement show 1,500; a payment settles it; the bill cannot be voided alone", async () => {
    const [r12] = await recon("R12");
    assert.deepEqual([r12.status, r12.ledger, r12.subLedger], ["ok", "1500.00", "1500.00"]);
    const st: any = await ap.supplierStatement(U, sup.id, { from: "2026-01-01", to: today });
    assert.equal(st.closing, "1500.00");
    const aging: any = await ap.apAging(U, { asOf: today });
    assert.equal(JSON.stringify(aging).includes("1500.00"), true, "the supplier's 1,500 is in the AP aging");
    const bill = (await ap.listBills(U, { supplierId: sup.id })).rows[0];
    await ap.createPayment(U, holder, { supplierId: sup.id, paidOn: today, amount: "500", method: "bank_transfer", allocations: [{ billId: bill.id, amount: "500" }] });
    await drain();
    const after = await ap.getBill(U, bill.id);
    assert.deepEqual([after.paid, after.remaining], ["500.00", "1000.00"]);
    const [r12b] = await recon("R12");
    assert.deepEqual([r12b.status, r12b.ledger, r12b.subLedger], ["ok", "1000.00", "1000.00"]);
    await assert.rejects(ap.voidBill(U, holder, bill.id, { reason: "wrong" }), err("BILL_FROM_JOURNAL", 409));
    await assert.rejects(jq.reverse(U, empB, opening.postedEntryId, { reason: "redo" }), err("JOURNAL_BILL_HAS_PAYMENTS", 409));
  });

  it("note 13: the landlord's opening 6,000 is in the dues report, the payout's net due and R3; trust (R16) agrees", async () => {
    const d = await dues();
    assert.deepEqual([d.net, d.transferred, d.remaining], [6000, 0, 6000]);
    const row = (await env.reports.accounting(holder)).landlordStatement.find((r: any) => r.ownerId === s.agent);
    assert.equal(row.journals, 6000);
    const [r3] = await recon("R3");
    assert.deepEqual([r3.status, r3.ledger, r3.subLedger, r3.difference], ["ok", "6000.00", "6000.00", "0.00"]);
    const pos = await clientMoneyPosition(env.t.pool, U, today);
    assert.equal(ownerPosition(pos, s.agent).payable, toHalalas("6000"), "his money in trust is his opening balance");
    const [r16] = await recon("R16");
    assert.equal(r16.status, "ok", JSON.stringify(r16));
    const over: any = await attempt(() => env.reports.createPayout(holder, { ownerId: s.agent, amount: 6000.01, method: "bank_transfer", transferDate: today }));
    assert.equal((over.body as any)?.error, "PAYOUT_EXCEEDS_DUE", JSON.stringify(over));
  });

  it("note 13: the 2121 lines a cutover backfill proposed are its own Dara history (already in the dues): not counted twice", async () => {
    const [run] = await env.q(
      `insert into finance_backfill_runs (user_id, actor_user_id, mode, dry_run, cutover_date, status, summary)
       values ($1, 1, 'cutover', false, '2026-11-01', 'done', $2::jsonb) returning id`,
      [U, JSON.stringify({ opening: { manualJournalId: opening.id, proposal: { date: "2026-10-31", lines: [
        { accountId: acc["2121"], debit: "0.00", credit: "4000.00", ownerId: s.agent },
      ] } } })]);
    try {
      assert.equal((await dues()).net, 2000, "only what was added on top of the proposal counts");
    } finally {
      await env.q(`delete from finance_backfill_runs where id = $1`, [run.id]);
    }
    assert.equal((await dues()).net, 6000);
  });

  it("note 15: the opening furniture has no card until an existing asset is entered; then it ties and depreciates the rest of its life", async () => {
    const before: any = await assets.openingCheck(U, { lang: "en" });
    assert.equal(before.ledgerStart, "2026-11-01");
    assert.deepEqual(before.rows.map((r: any) => [r.code, r.register, r.opening, r.difference]), [["1221", "0.00", "18000.00", "18000.00"], ["1229", "0.00", "3600.00", "3600.00"]]);
    assert.equal(before.balanced, false);
    await assert.rejects(assets.create(U, holder, {
      existing: true, nameAr: "أثاث المكتب", category: "furniture", cost: "18000", openingAccumulated: "3600", acquisitionDate: "2024-11-01",
      totalLifeMonths: 120, addToOpening: true,
    }), err("OPENING_POSTED", 409));
    await assert.rejects(assets.create(U, holder, {
      existing: true, nameAr: "أثاث المكتب", category: "furniture", cost: "18000", acquisitionDate: "2026-11-05", totalLifeMonths: 120,
    }), err("EXISTING_AFTER_START", 400));
    const a: any = await assets.create(U, holder, {
      existing: true, nameAr: "أثاث المكتب", category: "furniture", cost: "18000", openingAccumulated: "3600", acquisitionDate: "2024-11-01", totalLifeMonths: 120,
    });
    assert.deepEqual([a.acquisitionMode, a.depreciationStart, a.usefulLifeMonths, a.accumulated, a.nbv, a.monthlyCharge],
      ["none", "2026-11-01", 96, "3600.00", "14400.00", "150.00"], "24 of 120 months used: 14,400 over the remaining 96 = 150 a month, as before");
    assert.equal(a.schedule[0].month, "2026-11");
    assert.equal(a.schedule[0].charge, "150.00");
    const acq = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_type = 'fixed_asset' and event = 'acquired'`, [U]);
    assert.equal(acq[0].n, 0, "no acquisition entry: the cost is in the opening entry");
    const chk: any = await assets.openingCheck(U, {});
    assert.equal(chk.balanced, true, JSON.stringify(chk.rows));
  });

  it("note 15: addToOpening puts an existing asset on the opening draft (Dr cost, Cr accumulated, Cr 3900)", async () => {
    // A second account with no opening entry yet: the asset starts the draft, dated the day before the ledger start.
    const V = 7612;
    await seedAccount(env, V);
    await enableV2(env, V, "manager");
    await env.q(`update finance_settings set ledger_go_live_date = '2026-11-01' where account_user_id = $1`, [V]);
    const hv = { ...holder, id: V, email: `fv2-spec-${V}@example.test` };
    await assets.create(V, hv, {
      existing: true, nameAr: "حاسب", category: "computers", cost: "3600", openingAccumulated: "1200", acquisitionDate: "2025-11-01", totalLifeMonths: 36, addToOpening: true,
    });
    const [d] = await env.q(`select id, status, to_char(entry_date,'YYYY-MM-DD') as d, lines from manual_journals where user_id = $1 and kind = 'opening'`, [V]);
    assert.deepEqual([d.status, d.d], ["draft", "2026-10-31"]);
    const code = Object.fromEntries((await env.q(`select id, code from accounts where user_id = $1`, [V])).map((r: any) => [r.id, r.code]));
    assert.deepEqual(d.lines.map((l: any) => [code[l.accountId], l.debit, l.credit]), [["1222", "3600.00", "0.00"], ["1229", "0.00", "1200.00"], ["3900", "0.00", "2400.00"]]);
    const chk: any = await assets.openingCheck(V, {});
    assert.deepEqual([chk.opening.status, chk.balanced], ["draft", true]);
  });

  it("note 16: a cash flow from 1 January shows the opening 33,000 as cash at the beginning, never as financing", async () => {
    for (const from of ["2026-01-01", "2026-11-01"]) {
      const cf: any = await acct.cashFlow(U, { from, to: "2026-11-30", lang: "en" });
      assert.equal(cf.opening.amount, "33000.00", from);
      assert.equal(cf.opening.restricted, "6000.00", `${from}: the trust account's opening`);
      const fin = cf.sections.find((x: any) => x.key === "financing");
      assert.deepEqual(fin.lines, [], `${from}: nothing in financing`);
      assert.equal(cf.sections.find((x: any) => x.key === "operating").lines.find((l: any) => l.key === "supplier_payments")?.amount, "-500.00");
      assert.equal(cf.check.balanced, true);
      assert.equal(cf.closing.amount, "32500.00");
    }
  });
});
