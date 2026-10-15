import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { PeriodsService } from "./periods.service";
import { JournalRepository } from "./journal.repository";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { AccountTransferService } from "./tier1/account-transfer.service";
import { ExpensesV2Service } from "./tier1/expenses-v2.service";
import { TenantCreditsService } from "./tier1/tenant-credits.service";
import { ArAgingService } from "./reports/aging.service";
import { ApService } from "./tier3/ap.service";
import { ManualJournalsService } from "./manual-journals.service";
import { setTrustOverdrawPolicyForTests, TRUST_OVERDRAW_POLICY, trustAvailability } from "./trust-guard";

/**
 * The trust overdraw guard (accountant, 15 Oct 2026) and the manual-journal trust warning, on the real legacy
 * routes against a throwaway Postgres. Synthetic data only. Manager mode: the agent landlord's rent and every
 * deposit land in the trust account (1114).
 *
 * Main account U: the tenant pays 3,000 rent in cash → trust 3,000, landlord dues 3,000. 1,000 is moved from
 * trust to the office bank (transfer between accounts) → trust 2,000, while the dues stay 3,000: from here a
 * payout can be within the dues and still above what trust holds.
 */
const U = 6431;
const D = 6432; // the deposit refund at contract end, on its own account
const today = riyadhToday();
const firstOf = (monthsFromNow: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + monthsFromNow, 1)).toISOString().slice(0, 10);
};
const lastOf = (monthsFromNow: number) => {
  const d = new Date(`${firstOf(monthsFromNow + 1)}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write", "contracts.delete"];
const userFor = (id: number) => ({ ...userOf(id), permissions: PERMS });
const user = userFor(U);

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 trust overdraw guard (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let banks: BankAccountsService;
  let transfers: AccountTransferService;
  let expenses: ExpensesV2Service;
  let credits: TenantCreditsService;
  let ap: ApService;
  let trustId: number;
  let officeId: number;
  let contractId: number;

  const glBal = async (u: number, code: string) => (await env.q(
    `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = $2`, [u, code]))[0].b;
  const avail = async (u: number) => (await trustAvailability(env.t.pool as any, u)).accounts.find((a) => a.glCode === "1114")!;
  const count = async (t: string, u = U) => (await env.q(`select count(*)::int as n from ${t} where user_id = $1`, [u]))[0].n;
  const payout = (amount: string, extra: Record<string, unknown> = {}) =>
    env.reports.createPayout(user, { ownerId: s.agent, amount, transferDate: today, method: "bank_transfer", ...extra });
  const refused = (r: any, available: string, required: string, policy = "confirm") => {
    assert.equal(r.status, 409, JSON.stringify(r.body ?? r));
    assert.equal(r.body.error, "TRUST_INSUFFICIENT");
    assert.equal(r.body.available, available);
    assert.equal(r.body.required, required);
    assert.equal(r.body.policy, policy);
    assert.match(r.body.message, new RegExp(`رصيد حساب الأمانات لا يكفي: المتاح ${available.replace(".", "\\.")} والمطلوب ${required.replace(".", "\\.")}`));
    assert.match(r.body.message, /trust account balance is not enough/);
  };

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    const periods = new PeriodsService(env.t.pool);
    banks = new BankAccountsService(env.t.pool as any);
    transfers = new AccountTransferService(env.t.pool as any, new JournalRepository(periods), periods);
    expenses = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    credits = new TenantCreditsService(env.t.pool as any, env.emitter, banks, new ArAgingService(env.t.pool as any), env.worker);
    ap = new ApService(env.t.pool as any, env.emitter, banks);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [U]))[0].id);
    officeId = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [U]))[0].id);
    const c: any = await env.contracts.create(user, {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant",
      startDate: firstOf(0), endDate: lastOf(11), monthlyRent: "3000", paymentFrequency: "monthly", vatEnabled: false,
    });
    contractId = c.id;
    const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    await env.payments.addCollection(user, String(p.id), { amount: "3000", collectedDate: today, method: "cash" });
    await drain(env, U);
  });

  after(async () => {
    setTrustOverdrawPolicyForTests(null);
    await env?.t.drop();
  });

  it("the policy constant is 'confirm' (one line flips it to 'block')", () => {
    assert.equal(TRUST_OVERDRAW_POLICY, "confirm");
  });

  it("transfer between accounts out of trust, under the balance: posts, no warning; trust 3,000 → 2,000", async () => {
    assert.equal(await glBal(U, "1114"), "3000.00");
    const r = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "1000" });
    assert.deepEqual(r.warnings, []);
    assert.equal(await glBal(U, "1114"), "2000.00");
    assert.deepEqual(await avail(U), { ...(await avail(U)), posted: "2000.00", pending: "0.00", available: "2000.00" });
  });

  it("a non-trust source is unaffected: the office bank may still go negative, with the SOURCE_BALANCE_NEGATIVE warning only", async () => {
    const r = await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "1500" });
    assert.deepEqual(r.warnings, ["SOURCE_BALANCE_NEGATIVE"]);
    // …and back, so trust is 2,000 again (out of trust, within its 3,500)
    const back = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "1500" });
    assert.deepEqual(back.warnings, []);
    assert.equal(await glBal(U, "1114"), "2000.00");
  });

  it("transfer out of trust above the balance: 409 TRUST_INSUFFICIENT, nothing posted; +0.01 over the exact balance is refused too", async () => {
    const n = await count("manual_journals");
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "2500" })), "2000.00", "2500.00");
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "2000.01" })), "2000.00", "2000.01");
    assert.equal(await count("manual_journals"), n);
    assert.equal(await glBal(U, "1114"), "2000.00");
  });

  it("landlord payout within the dues but above trust: 409 TRUST_INSUFFICIENT; nothing written, no PV- number used", async () => {
    refused(await attempt(() => payout("2500")), "2000.00", "2500.00");
    refused(await attempt(() => payout("2000.01")), "2000.00", "2000.01");
    assert.deepEqual([await count("landlord_payouts"), await count("finance_payout_vouchers"), await count("finance_payout_meta")], [0, 0, 0]);
  });

  it("two payouts at once that each fit alone but not together: exactly one is refused (the first is pending, not posted)", async () => {
    const [a, b] = await Promise.all([attempt(() => payout("1200", { requestId: "trust-race-0001" })), attempt(() => payout("1200", { requestId: "trust-race-0002" }))]);
    const ok = [a, b].filter((x: any) => x?.voucherNumber);
    const ko = [a, b].filter((x: any) => x?.status === 409);
    assert.equal(ok.length, 1, JSON.stringify([a, b]));
    assert.equal(ko.length, 1);
    refused(ko[0], "800.00", "1200.00");
    // The worker has not posted the first yet: the endpoint shows it as pending.
    assert.deepEqual([(await avail(U)).posted, (await avail(U)).pending, (await avail(U)).available], ["2000.00", "-1200.00", "800.00"]);
    await drain(env, U);
    assert.deepEqual([(await avail(U)).posted, (await avail(U)).pending, (await avail(U)).available], ["800.00", "0.00", "800.00"]);
  });

  it("exact balance: paying exactly 800.00 is allowed; then 0.01 is refused", async () => {
    const r: any = await payout("800.00");
    assert.ok(r.voucherNumber);
    refused(await attempt(() => payout("0.01")), "0.00", "0.01");
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "0.00");
  });

  it("over the balance with allowTrustOverdraw: posts, takes trust below zero, and is audited", async () => {
    const r: any = await payout("100", { allowTrustOverdraw: true });
    assert.ok(r.voucherNumber);
    const [a] = await env.q(`select entity, entity_id, path from audit_logs where owner_user_id = $1 and entity = 'finance_v2_trust_overdraw' order by id desc limit 1`, [U]);
    assert.deepEqual(a, { entity: "finance_v2_trust_overdraw", entity_id: "1114:0.00/100.00", path: "/reports/landlord-payouts" });
    const t = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "10", allowTrustOverdraw: true });
    assert.deepEqual(t.warnings, ["TRUST_OVERDRAW_CONFIRMED", "SOURCE_BALANCE_NEGATIVE"]);
    const [e] = await env.q(`select warnings from journal_entries where id = $1`, [t.entryId]);
    assert.deepEqual(e.warnings, ["TRUST_OVERDRAW_CONFIRMED", "SOURCE_BALANCE_NEGATIVE"]);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "-110.00");
  });

  it("policy 'block': refused even with allowTrustOverdraw (payout and transfer); 'confirm' restored afterwards", async () => {
    setTrustOverdrawPolicyForTests("block");
    try {
      const p: any = await attempt(() => payout("5", { allowTrustOverdraw: true }));
      refused(p, "-110.00", "5.00", "block");
      assert.match(p.body.message, /لا يُسمح بالصرف بأكثر من الرصيد/);
      refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "5", allowTrustOverdraw: true })), "-110.00", "5.00", "block");
      assert.equal((await trustAvailability(env.t.pool as any, U)).policy, "block");
    } finally {
      setTrustOverdrawPolicyForTests(null);
    }
    assert.equal((await trustAvailability(env.t.pool as any, U)).policy, "confirm");
  });

  it("tenant credit refund out of trust: above the balance 409; with the flag it posts", async () => {
    // Bring trust back to 890: an advance of 1,000 on next month's rent (an agent tenant's credit, collected into trust).
    const [p2] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null and due_date >= $2 order by due_date limit 1`, [contractId, firstOf(1)]);
    await env.payments.addCollection(user, String(p2.id), { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "890.00");
    refused(await attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "890.01", bankAccountId: trustId })), "890.00", "890.01");
    assert.equal(await count("tenant_credit_actions"), 0);
    const ok = await credits.refund(U, user, { tenantId: s.tenant, amount: "900", bankAccountId: trustId, allowTrustOverdraw: true });
    assert.ok(ok.action.number);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "-10.00");
  });

  it("a landlord's expense paid from trust: 409 above the balance; with the flag it posts; an edit counts only its increase", async () => {
    await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "510" }); // trust 500
    assert.equal(await glBal(U, "1114"), "500.00");
    const base = { expenseDate: today, category: "صيانة", ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord", bankAccountId: trustId };
    refused(await attempt(() => expenses.create(U, user, { ...base, amount: "500.01" })), "500.00", "500.01");
    const e = await expenses.create(U, user, { ...base, amount: "400" });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "100.00");
    // 400 → 450 needs 50 more (100 available).
    const up = await expenses.update(U, user, e.id, { amount: "450" });
    assert.equal(up.details!.revision, 2);
    // 450 → 600 while revision 2 (and the reversal of revision 1) still wait to post: the posted 100, plus the queued
    // reversal of the posted 400, is 500 against the whole new 600 (the unposted 450 is replaced, not counted).
    refused(await attempt(() => expenses.update(U, user, e.id, { amount: "600" })), "500.00", "600.00");
    // Once posted: 50 left in trust against the 150 increase.
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "50.00");
    refused(await attempt(() => expenses.update(U, user, e.id, { amount: "600" })), "50.00", "150.00");
    const conf = await expenses.update(U, user, e.id, { amount: "600", allowTrustOverdraw: true });
    assert.equal(conf.details!.revision, 3);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "-100.00");
  });

  it("a supplier payment for a landlord's bill from trust: 409 above the balance; a non-trust account pays it as before", async () => {
    await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "300" }); // trust 200
    const sup = await ap.createSupplier(U, user, { nameAr: "مورد صيانة", paymentTermsDays: 30 });
    const bill = await ap.approveBill(U, user, (await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord", lines: [{ description: "صيانة", amount: "250" }],
    })).id);
    const body = { supplierId: sup.id, paidOn: today, amount: "250", allocations: [{ billId: bill.id, amount: "250" }] };
    refused(await attempt(() => ap.createPayment(U, user, { ...body, bankAccountId: trustId })), "200.00", "250.00");
    assert.equal(await count("supplier_payments"), 0);
    const paid = await ap.createPayment(U, user, { ...body, bankAccountId: officeId });
    assert.equal(paid.bankAccountId, officeId);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "200.00");
  });

  it("deposit refund at contract end: refused before any legacy write when trust is short; with the flag the contract ends and the refund posts", async () => {
    const seed = await seedAccount(env, D);
    await enableV2(env, D, "manager");
    const du = userFor(D);
    const dTrust = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [D]))[0].id);
    const dOffice = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [D]))[0].id);
    const c: any = await env.contracts.create(du, {
      unitIds: [seed.unitA1], tenantId: seed.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
      depositAmount: "2000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: today,
    });
    await drain(env, D);
    assert.equal(await glBal(D, "1114"), "2000.00", "the deposit sits in trust");
    await transfers.create(D, du, { fromBankAccountId: dTrust, toBankAccountId: dOffice, amount: "1500" });
    const body = { mode: "cancelled", deposit: "refund", refundMethod: "bank_transfer" };
    const r: any = await attempt(() => env.contracts.terminate(du, String(c.id), body));
    refused(r, "500.00", "2000.00");
    const [ct] = await env.q(`select status::text as status from contracts where id = $1`, [c.id]);
    assert.notEqual(ct.status, "cancelled", "nothing written");
    assert.equal(await count("finance_deposit_refunds", D), 0);
    const ok: any = await env.contracts.terminate(du, String(c.id), { ...body, allowTrustOverdraw: true });
    assert.equal(ok.success, true);
    await drain(env, D);
    assert.equal(await glBal(D, "1114"), "-1500.00");
    assert.equal(await count("finance_deposit_refunds", D), 1);
  });

  it("a collection recorded a moment ago (queued, not yet posted) counts: the money is in trust", async () => {
    assert.equal(await glBal(U, "1114"), "200.00");
    const [p3] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null and due_date >= $2 order by due_date limit 1`, [contractId, firstOf(2)]);
    await env.payments.addCollection(user, String(p3.id), { amount: "2000", collectedDate: today, method: "cash" });
    assert.deepEqual([(await avail(U)).posted, (await avail(U)).pending, (await avail(U)).available], ["200.00", "2000.00", "2200.00"]);
    const t = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "2200" });
    // Not refused; only the generic note that the POSTED book balance dips until the collection posts.
    assert.deepEqual(t.warnings, ["SOURCE_BALANCE_NEGATIVE"]);
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "0.01" })), "0.00", "0.01");
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "0.00");
  });

  it("a payment that does not touch trust is never checked (an office expense from the office bank, any amount)", async () => {
    const e = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "99999", bankAccountId: officeId });
    assert.equal(e.details!.bankAccountId, officeId);
  });
});

describe("fv2 manual journals: trust against an office account is warned, never refused (real Postgres)", { skip: fv2DbSkip }, () => {
  const M = 6433;
  let env: LegacyEnv;
  let mj: ManualJournalsService;
  let transfers: AccountTransferService;
  const acc: Record<string, number> = {};
  const holder = { ...userOf(M), permissions: [...PERMS, "settings.write"] } as any;
  const L = (code: string, side: "d" | "c", amt: string) => ({ accountId: acc[code], debit: side === "d" ? amt : "0", credit: side === "c" ? amt : "0" });
  const make = async (lines: any[], memo = "تصحيح") => mj.create(M, holder, { entryDate: today, memo, lines });

  before(async () => {
    env = await legacyEnv("wired");
    await seedAccount(env, M);
    await enableV2(env, M, "manager");
    const periods = new PeriodsService(env.t.pool);
    const journal = new JournalRepository(periods);
    mj = new ManualJournalsService(env.t.pool, journal, periods);
    transfers = new AccountTransferService(env.t.pool as any, journal, periods);
    for (const r of await env.q(`select code, id from accounts where user_id = $1`, [M])) acc[r.code] = Number(r.id);
  });
  after(async () => { await env?.t.drop(); });

  it("trust (1114) against an office expense (5290): created with TRUST_WITH_OFFICE_ACCOUNT, audited; approved with the warning on the entry", async () => {
    const d: any = await make([L("5290", "d", "120"), L("1114", "c", "120")]);
    assert.equal(d.status, "draft");
    assert.deepEqual(d.warnings.map((w: any) => [w.code, w.trustAccounts, w.officeAccounts]), [["TRUST_WITH_OFFICE_ACCOUNT", ["1114"], ["5290"]]]);
    assert.match(d.warnings[0].message, /حساب الأمانات/);
    assert.match(d.warnings[0].message, /office costs are not paid with client money/);
    const s: any = await mj.submit(M, holder, d.id);
    assert.equal(s.warnings.length, 1);
    const a: any = await mj.approve(M, holder, d.id);
    assert.equal(a.status, "posted");
    assert.deepEqual(a.warnings.map((w: any) => w.code), ["TRUST_WITH_OFFICE_ACCOUNT"]);
    const [e] = await env.q(`select warnings from journal_entries where id = $1`, [a.postedEntryId]);
    assert.deepEqual(e.warnings, ["TRUST_WITH_OFFICE_ACCOUNT"]);
    const paths = (await env.q(`select path from audit_logs where owner_user_id = $1 and entity = 'finance_v2_manual_journal' and entity_id = $2 order by id`, [M, String(d.id)])).map((r: any) => r.path);
    assert.deepEqual(paths, [
      "/finance/v2/manual-journals?warnings=TRUST_WITH_OFFICE_ACCOUNT",
      `/finance/v2/manual-journals/${d.id}/submit?warnings=TRUST_WITH_OFFICE_ACCOUNT`,
      `/finance/v2/manual-journals/${d.id}/approve?warnings=TRUST_WITH_OFFICE_ACCOUNT`,
    ]);
  });

  it("an office revenue against trust is warned too; an edit that moves it to 2121 clears the warning", async () => {
    const d: any = await make([L("1114", "d", "50"), L("4390", "c", "50")]);
    assert.deepEqual(d.warnings[0].officeAccounts, ["4390"]);
    const u: any = await mj.update(M, holder, d.id, { lines: [L("1114", "d", "50"), L("2121", "c", "50")] });
    assert.deepEqual(u.warnings, []);
  });

  it("trust against client money (2121, 2141) or a money box (office bank 1113, cash 1111): no warning", async () => {
    for (const lines of [
      [L("2121", "d", "70"), L("1114", "c", "70")],
      [L("2141", "d", "70"), L("1114", "c", "70")],
      [L("1113", "d", "70"), L("1114", "c", "70")],
      [L("1114", "d", "70"), L("1111", "c", "70")],
    ]) {
      const d: any = await make(lines);
      assert.deepEqual(d.warnings, [], JSON.stringify(lines));
    }
    const plain: any = await make([L("5290", "d", "10"), L("1113", "c", "10")]);
    assert.deepEqual(plain.warnings, [], "no trust account at all");
  });

  it("the transfer between accounts (trust → office bank) writes its manual journal with no such warning", async () => {
    const trust = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [M]))[0].id);
    const office = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [M]))[0].id);
    await transfers.create(M, holder, { fromBankAccountId: office, toBankAccountId: trust, amount: "300" }); // trust: 300 − the 120 journal above = 180
    const t = await transfers.create(M, holder, { fromBankAccountId: trust, toBankAccountId: office, amount: "180" });
    assert.deepEqual(t.warnings, []);
    const [e] = await env.q(`select warnings from journal_entries where id = $1`, [t.entryId]);
    assert.deepEqual(e.warnings, []);
  });
});
