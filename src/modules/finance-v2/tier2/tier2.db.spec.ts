import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { makeSaudiIban } from "../tier1/iban";
import { ManualJournalsService } from "../manual-journals.service";
import { JournalRepository } from "../journal.repository";
import { PeriodsService } from "../periods.service";
import { BankRecService } from "./bank-rec.service";
import { RemindersService } from "./reminders.service";
import { DryRunReminderSender } from "./reminder-sender";
import { TaqnyatService } from "../../sms/taqnyat.service";

/**
 * DESIGN §8.3 Tier 2 on a throwaway Postgres (synthetic data only): bank
 * statement import and matching with a hand-computed reconciliation, and rent
 * reminders built DISABLED — every test asserts nothing is sent.
 */
const U = 5501;
const U_OFF = 5502;
const today = riyadhToday();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const firstOf = (monthsFromNow: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + monthsFromNow, 1)).toISOString().slice(0, 10);
};
const lastOf = (monthsFromNow: number) => {
  const d = new Date(`${firstOf(monthsFromNow + 1)}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const user = { ...userOf(U), permissions: ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve"] };

async function drain(env: LegacyEnv, u = U) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 tier 2: bank reconciliation (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let rec: BankRecService;
  let mj: ManualJournalsService;
  let bank: any;
  let statementId: number;
  const D1 = addDays(today, -6);
  const D2 = addDays(today, -4);
  const D3 = addDays(today, -2);
  const profile = { delimiter: ",", dateCol: "Date", dateFormat: "DD/MM/YYYY", descCol: "Details", refCol: "Ref", debitCol: "Debit", creditCol: "Credit", balanceCol: "Balance" };
  // Hand-computed: +1,000 (RC-7001) +1,000 (RC-7002) +2,500 −700 −15 (a bank charge) = 3,785.
  const CSV = [
    "Date,Details,Ref,Debit,Credit,Balance",
    `${dmy(D1)},Transfer RC-7001,,,"1,000.00","1,000.00"`,
    `${dmy(addDays(D1, 1))},Transfer RC-7002,,,"1,000.00","2,000.00"`,
    `${dmy(addDays(D2, 1))},Transfer,,,"2,500.00","4,500.00"`,
    `${dmy(D3)},Payout,TRF-9,700.00,,"3,800.00"`,
    `${dmy(D3)},Service fee,,15.00,,"3,785.00"`,
  ].join("\n");

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    const banks = new BankAccountsService(env.t.pool as any);
    bank = await banks.create(U, U, { kind: "bank", nameAr: "حساب المطابقة", iban: makeSaudiIban("20", "000000000000777777"), isDefault: true });
    const periods = new PeriodsService(env.t.pool as any);
    mj = new ManualJournalsService(env.t.pool as any, new JournalRepository(periods), periods);
    rec = new BankRecService(env.t.pool as any, mj);
    const c: any = await env.contracts.create(user, {
      unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(1), endDate: lastOf(4),
      monthlyRent: "1500", paymentFrequency: "monthly", vatEnabled: false,
    });
    const pays = (await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date`, [c.id])).map((r: any) => String(r.id));
    await env.payments.addCollection(user, pays[0], { amount: "1000", collectedDate: D1, method: "bank_transfer", receiptNumber: "RC-7001", bankAccountId: bank.id });
    await env.payments.addCollection(user, pays[1], { amount: "1000", collectedDate: D1, method: "bank_transfer", receiptNumber: "RC-7002", bankAccountId: bank.id });
    await env.payments.addCollection(user, pays[2], { amount: "1000", collectedDate: D2, method: "bank_transfer", bankAccountId: bank.id });
    await env.payments.addCollection(user, pays[3], { amount: "1500", collectedDate: D2, method: "bank_transfer", bankAccountId: bank.id });
    await env.reports.createPayout(user, { ownerId: s.holder, amount: 700, transferDate: D3, method: "bank_transfer", reference: "TRF-9", bankAccountId: bank.id });
    await drain(env);
  });

  after(async () => {
    await env?.t.drop();
  });

  it("import: parses, auto-matches the unique candidates (reference beats a tie), leaves the rest", async () => {
    const pv: any = await rec.preview(U, { csv: CSV, profile });
    assert.equal(pv.count, 5);
    assert.equal(pv.errorCount, 0);
    const r: any = await rec.importStatement(U, user, { bankAccountId: bank.id, csv: CSV, profile, openingBalance: "0" });
    statementId = r.statementId;
    assert.equal(r.imported, 5);
    assert.equal(r.duplicates, 0);
    // RC-7001 and RC-7002 by reference; −700 unique. The 2,500 line has no single 2,500 ledger line (1,000 + 1,500) and the fee no entry.
    assert.equal(r.autoMatched, 3);
    const st: any = await rec.get(U, statementId);
    assert.equal(st.statement.closingBalance, "3785.00", "from the last running balance");
    assert.deepEqual(st.lines.map((l: any) => [l.amount, l.matchStatus]), [["1000.00", "auto"], ["1000.00", "auto"], ["2500.00", "unmatched"], ["-700.00", "auto"], ["-15.00", "unmatched"]]);
    const rc = st.lines[0].journal[0];
    assert.equal(rc.amount, "1000.00");
    // ledger 3,800 = bank 3,785 + outstanding receipts 2,500 − 0 − unrecorded (2,500 − 15)
    assert.deepEqual(
      [st.reconciliation.ledgerBalance, st.reconciliation.outstandingReceipts, st.reconciliation.unrecordedBankItems, st.reconciliation.difference, st.reconciliation.balanced],
      ["3800.00", "2500.00", "2485.00", "0.00", true]);
  });

  it("re-importing the same (overlapping) file imports nothing; a Hijri date refuses the whole file", async () => {
    const r: any = await rec.importStatement(U, user, { bankAccountId: bank.id, csv: CSV, profile });
    assert.equal(r.imported, 0);
    assert.equal(r.duplicates, 5);
    await rec.remove(U, user, r.statementId);
    const hijri = CSV.replace(dmy(D3), "10/03/1448");
    const bad: any = await attempt(() => rec.importStatement(U, user, { bankAccountId: bank.id, csv: hijri, profile }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.errors[0].error, "HIJRI_DATE");
  });

  it("manual match n:1 needs exact sums; 1,000 + 1,500 ledger lines match the 2,500 bank line", async () => {
    const st: any = await rec.get(U, statementId);
    const line = st.lines.find((l: any) => l.amount === "2500.00");
    const cand: any = await rec.candidatesFor(U, line.id);
    assert.equal(cand.rows.length, 0, "no single 2,500 ledger line");
    const jl = st.unmatchedLedger.filter((j: any) => ["1000.00", "1500.00"].includes(j.amount)).map((j: any) => j.journalLineId);
    assert.equal(jl.length, 2);
    const wrong: any = await attempt(() => rec.match(U, user, { statementLineIds: [line.id], journalLineIds: [jl[0]] }));
    assert.equal(wrong.body.error, "SUMS_DIFFER");
    const ok: any = await rec.match(U, user, { statementLineIds: [line.id], journalLineIds: jl });
    assert.ok(ok.groupId > 0);
    const again: any = await attempt(() => rec.match(U, user, { statementLineIds: [line.id], journalLineIds: jl }));
    assert.equal(again.status, 409);
  });

  it("an unrecorded bank charge: create-entry drafts Dr 5270 / Cr bank; approved and matched, the statement completes", async () => {
    let st: any = await rec.get(U, statementId);
    const fee = st.lines.find((l: any) => l.amount === "-15.00");
    const [a5270] = await env.q(`select id from accounts where user_id = $1 and code = '5270'`, [U]);
    const draft: any = await rec.createEntry(U, user, fee.id, { accountId: a5270.id });
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.lines.map((l: any) => [l.accountId, l.debit, l.credit]), [[a5270.id, "15.00", "0.00"], [bank.glAccountId, "0.00", "15.00"]]);
    await mj.submit(U, user, draft.id);
    const posted: any = await mj.approve(U, user, draft.id);
    assert.equal(posted.status, "posted");
    st = await rec.get(U, statementId);
    const jl = st.unmatchedLedger.find((j: any) => j.amount === "-15.00");
    await rec.match(U, user, { statementLineIds: [fee.id], journalLineIds: [jl.journalLineId] });
    st = await rec.get(U, statementId);
    assert.deepEqual([st.reconciliation.ledgerBalance, st.reconciliation.bankClosing, st.reconciliation.outstandingReceipts, st.reconciliation.unrecordedBankItems, st.reconciliation.difference],
      ["3785.00", "3785.00", "0.00", "0.00", "0.00"]);
    const done: any = await rec.complete(U, user, statementId);
    assert.equal(done.status, "reconciled");
    const ro: any = await attempt(() => rec.ignore(U, user, fee.id, false));
    assert.equal(ro.body.error, "FINANCE_V2_STATEMENT_RECONCILED");
    const groups = await env.q(`select distinct group_id from bank_matches where user_id = $1`, [U]);
    assert.equal(((await attempt(() => rec.unmatch(U, user, Number(groups[0].group_id)))) as any).status, 409);
  });

  it("scoping: another account cannot see or touch the statement", async () => {
    assert.equal(((await attempt(() => rec.get(U + 100, statementId))) as any).status, 404);
    assert.equal(((await attempt(() => rec.importStatement(U + 100, userOf(U + 100), { bankAccountId: bank.id, csv: CSV, profile }))) as any).status, 404);
  });
});

describe("fv2 tier 2: rent reminders are built disabled — nothing is ever sent", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let svc: RemindersService;
  let sends = 0;
  let fetches = 0;
  const origSend = TaqnyatService.prototype.send;
  const origFetch = globalThis.fetch;
  const origEnv = process.env.FINANCE_REMINDERS_ENABLED;

  before(async () => {
    TaqnyatService.prototype.send = async function () {
      sends++;
      throw new Error("fv2 spec: SMS must not be sent");
    } as any;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("fv2 spec: no network call");
    }) as any;
    env = await legacyEnv("wired");
    const s = await seedAccount(env, U);
    await seedAccount(env, U_OFF);
    await enableV2(env, U, "manager");
    svc = new RemindersService(env.t.pool as any, env.flag, new DryRunReminderSender());
    await env.q(`update tenants set fcm_token = 'ExponentPushToken[synthetic]' where user_id = $1`, [U]);
    // Due in 3 days (offset −3) and today (offset 0), relative to "tomorrow" as the run date.
    const c: any = await env.contracts.create(userOf(U), {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: addDays(today, 4), endDate: addDays(today, 200),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
    });
    void c;
  });

  after(async () => {
    TaqnyatService.prototype.send = origSend;
    globalThis.fetch = origFetch;
    if (origEnv === undefined) delete process.env.FINANCE_REMINDERS_ENABLED;
    else process.env.FINANCE_REMINDERS_ENABLED = origEnv;
    await env?.t.drop();
  });

  it("defaults: disabled, env gate off, 'coming soon'; enabling is refused while the env gate is off", async () => {
    delete process.env.FINANCE_REMINDERS_ENABLED;
    const st: any = await svc.getSettings(U);
    assert.deepEqual([st.enabled, st.gates.env, st.gates.flag, st.active, st.comingSoon, st.sender], [false, false, true, false, true, "dry_run"]);
    assert.deepEqual(st.offsets, [-3, 0, 7]);
    const r: any = await attempt(() => svc.updateSettings(U, { enabled: true }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "FINANCE_V2_REMINDERS_DISABLED");
    assert.equal((await svc.getSettings(U)).enabled, false);
    // other settings save
    const saved: any = await svc.updateSettings(U, { offsets: [0, -3], channels: ["sms", "push"] });
    assert.deepEqual([saved.offsets, saved.channels], [[-3, 0], ["sms", "push"]]);
  });

  it("the scheduler does nothing at all while the env gate is off (no timer, tick returns 0, no rows)", async () => {
    delete process.env.FINANCE_REMINDERS_ENABLED;
    svc.onModuleInit();
    assert.equal((svc as any).timer, null);
    assert.deepEqual(await svc.tick(), { accounts: 0, logged: 0 });
    assert.equal((await env.q(`select count(*)::int as n from reminder_log`))[0].n, 0);
  });

  it("preview lists who WOULD be reminded; dry-run logs hashed rows with status dry_run; nothing is sent", async () => {
    const date = addDays(today, 1);
    const pv: any = await svc.preview(U, date);
    assert.equal(pv.rows.length, 1, "the installment due in 3 days (offset −3)");
    assert.equal(pv.rows[0].offsetDays, -3);
    assert.deepEqual(pv.rows[0].channels, ["sms", "push"]);
    assert.ok(!String(pv.rows[0].phoneMasked).includes("0500000001".slice(0, 7)), "phone is masked");
    const run: any = await svc.dryRun(U, date);
    assert.deepEqual([run.sender, run.candidates, run.attempts, run.logged, run.sent], ["dry_run", 1, 2, 2, 0]);
    const log = await env.q(`select status, recipient_hash from reminder_log where user_id = $1`, [U]);
    assert.equal(log.length, 2);
    for (const l of log) {
      assert.equal(l.status, "dry_run");
      assert.match(l.recipient_hash, /^[0-9a-f]{64}$/);
    }
    assert.equal((await svc.dryRun(U, date)).logged, 0, "idempotent per (installment, offset, channel)");
    assert.equal(sends, 0, "Taqnyat never called");
    assert.equal(fetches, 0, "no network call (Expo push, email, SMS)");
  });

  it("all three gates on: the tick still only dry-runs; an account with the flag off is skipped (gate 3)", async () => {
    process.env.FINANCE_REMINDERS_ENABLED = "1";
    try {
      await svc.updateSettings(U, { enabled: true, offsets: [-4] });
      await env.q(`insert into reminder_settings (user_id, enabled) values ($1, true)`, [U_OFF]);
      await env.q(`delete from reminder_log`);
      (svc as any).lastRunDay = null;
      const r = await svc.tick();
      assert.equal(r.accounts, 1, "only the flag-on account");
      const rows = await env.q(`select user_id, status from reminder_log`);
      assert.ok(rows.every((x: any) => x.status === "dry_run" && x.user_id === U));
      assert.equal(sends, 0);
      assert.equal(fetches, 0);
    } finally {
      delete process.env.FINANCE_REMINDERS_ENABLED;
      svc.onModuleDestroy();
    }
  });
});
