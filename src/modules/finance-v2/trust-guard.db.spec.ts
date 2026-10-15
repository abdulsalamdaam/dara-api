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
import { TRUST_OVERDRAW_POLICY, trustAvailability } from "./trust-guard";

/**
 * The trust guard (accountant, 15 Oct 2026: «منع ❌ — عشان ما يتحول لمالك من فلوس مالك آخر … نفس القصة العمولة»)
 * and the manual-journal trust rule («تنبيه … سبب او مرفق يكون اجباري … يعتمد من محاسب آخر»), on the real legacy
 * routes against a throwaway Postgres. Synthetic data only. Manager mode: an agent landlord's rent and every
 * deposit land in the trust account (1114).
 */
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

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

const glBalOf = (env: LegacyEnv) => async (u: number, code: string) => (await env.q(
  `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = $2`, [u, code]))[0].b;
const bankIdOf = (env: LegacyEnv) => async (u: number, code: string) =>
  Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = $2`, [u, code]))[0].id);

function refusedWith(r: any, error: string, available: string, required: string) {
  assert.equal(r.status, 409, JSON.stringify(r.body ?? r));
  assert.equal(r.body.error, error, JSON.stringify(r.body));
  assert.equal(r.body.available, available);
  assert.equal(r.body.required, required);
}
function refused(r: any, available: string, required: string) {
  refusedWith(r, "TRUST_INSUFFICIENT", available, required);
  assert.equal(r.body.policy, "block");
  assert.match(r.body.message, new RegExp(`رصيد حساب الأمانات لا يكفي: المتاح ${available.replace(".", "\\.")} والمطلوب ${required.replace(".", "\\.")}`));
  assert.match(r.body.message, /لا يُسمح بالصرف بأكثر من الرصيد/);
  assert.match(r.body.message, /trust account balance is not enough/);
}

describe("fv2 trust guard, policy block (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  /**
   * Account U: the tenant pays 3,000 rent in cash → trust (1114) 3,000, the agent landlord's dues 3,000. 1,000 is parked
   * in a second trust account (trust → trust: client money stays client money), so 1114 holds 2,000 while the dues stay
   * 3,000 — a payout can be within the dues and the landlord's own money and still above what 1114 holds.
   */
  const U = 6431;
  const D = 6432; // the deposit refund at contract end, on its own account
  const user = userFor(U);
  let env: LegacyEnv;
  let s: Seed;
  let banks: BankAccountsService;
  let transfers: AccountTransferService;
  let expenses: ExpensesV2Service;
  let credits: TenantCreditsService;
  let ap: ApService;
  let trustId: number;
  let parkId: number;
  let officeId: number;
  let contractId: number;
  let glBal: (u: number, code: string) => Promise<string>;

  const avail = async (u: number) => (await trustAvailability(env.t.pool as any, u)).accounts.find((a) => a.glCode === "1114")!;
  const count = async (t: string, u = U) => (await env.q(`select count(*)::int as n from ${t} where user_id = $1`, [u]))[0].n;
  const payout = (amount: string, extra: Record<string, unknown> = {}) =>
    env.reports.createPayout(user, { ownerId: s.agent, amount, transferDate: today, method: "bank_transfer", ...extra });
  const overdrawAudits = async () => (await env.q(`select count(*)::int as n from audit_logs where entity = 'finance_v2_trust_overdraw'`))[0].n;

  before(async () => {
    env = await legacyEnv("wired");
    glBal = glBalOf(env);
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    const periods = new PeriodsService(env.t.pool);
    banks = new BankAccountsService(env.t.pool as any);
    transfers = new AccountTransferService(env.t.pool as any, new JournalRepository(periods), periods);
    expenses = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    credits = new TenantCreditsService(env.t.pool as any, env.emitter, banks, new ArAgingService(env.t.pool as any), env.worker);
    ap = new ApService(env.t.pool as any, env.emitter, banks);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [U]))[0].id);
    officeId = await bankIdOf(env)(U, "1113");
    parkId = (await banks.create(U, U, { kind: "bank", nameAr: "حساب أمانات ثانٍ", isTrust: true, isDefault: false })).id;
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
    await env?.t.drop();
  });

  it("the policy constant is 'block' (the accountant's decision); the endpoint says so", async () => {
    assert.equal(TRUST_OVERDRAW_POLICY, "block");
    assert.equal((await trustAvailability(env.t.pool as any, U)).policy, "block");
  });

  it("trust → trust is client money staying client money: posts, no warning, no office cap; 1114 3,000 → 2,000", async () => {
    assert.equal(await glBal(U, "1114"), "3000.00");
    const r = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "1000" });
    assert.deepEqual(r.warnings, []);
    assert.equal(await glBal(U, "1114"), "2000.00");
    assert.deepEqual([(await avail(U)).posted, (await avail(U)).pending, (await avail(U)).available], ["2000.00", "0.00", "2000.00"]);
  });

  it("trust → office bank: never more than the office's money in trust (none yet) — 409 TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY, flag or not", async () => {
    const n = await count("manual_journals");
    assert.equal((await trustAvailability(env.t.pool as any, U)).officeInTrust, "0.00");
    for (const extra of [{}, { allowTrustOverdraw: true }]) {
      const r: any = await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "0.01", ...extra }));
      refusedWith(r, "TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY", "0.00", "0.01");
      assert.match(r.body.message, /لا يمكن تحويل أكثر من أموال المكتب في حساب الأمانات/);
      assert.match(r.body.message, /cannot exceed the office's money in trust/);
    }
    assert.equal(await count("manual_journals"), n, "nothing written");
  });

  it("office bank → trust is unaffected (SOURCE_BALANCE_NEGATIVE only); that office money may go back out, to the halala", async () => {
    const r = await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "1500" });
    assert.deepEqual(r.warnings, ["SOURCE_BALANCE_NEGATIVE"]);
    assert.equal((await trustAvailability(env.t.pool as any, U)).officeInTrust, "1500.00");
    refusedWith(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "1500.01" })),
      "TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY", "1500.00", "1500.01");
    const back = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "1500" });
    assert.deepEqual(back.warnings, []);
    assert.equal(await glBal(U, "1114"), "2000.00");
    assert.equal((await trustAvailability(env.t.pool as any, U)).officeInTrust, "0.00");
  });

  it("trust → trust above the balance: 409 TRUST_INSUFFICIENT; +0.01 over the exact balance is refused too", async () => {
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "2500" })), "2000.00", "2500.00");
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "2000.01", allowTrustOverdraw: true })), "2000.00", "2000.01");
    assert.equal(await glBal(U, "1114"), "2000.00");
  });

  it("landlord payout within the dues but above trust: 409 TRUST_INSUFFICIENT even with allowTrustOverdraw; nothing written, no PV- number, no audit", async () => {
    refused(await attempt(() => payout("2500")), "2000.00", "2500.00");
    refused(await attempt(() => payout("2000.01", { allowTrustOverdraw: true })), "2000.00", "2000.01");
    assert.deepEqual([await count("landlord_payouts"), await count("finance_payout_vouchers"), await count("finance_payout_meta")], [0, 0, 0]);
    assert.equal(await overdrawAudits(), 0);
  });

  it("two payouts at once that each fit alone but not together: exactly one is refused (the first is pending, not posted)", async () => {
    const [a, b] = await Promise.all([attempt(() => payout("1200", { requestId: "trust-race-0001" })), attempt(() => payout("1200", { requestId: "trust-race-0002" }))]);
    const ok = [a, b].filter((x: any) => x?.voucherNumber);
    const ko = [a, b].filter((x: any) => x?.status === 409);
    assert.equal(ok.length, 1, JSON.stringify([a, b]));
    assert.equal(ko.length, 1);
    refused(ko[0], "800.00", "1200.00");
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

  it("no advance under v2: above the net due is 409 PAYOUT_EXCEEDS_DUE even with allowAdvance (the money is in trust)", async () => {
    await transfers.create(U, user, { fromBankAccountId: parkId, toBankAccountId: trustId, amount: "1000" }); // the parked 1,000 back
    assert.equal(await glBal(U, "1114"), "1000.00");
    const r: any = await attempt(() => payout("1000.01", { allowAdvance: true }));
    assert.deepEqual([r.status, r.body.error, r.body.netDue], [409, "PAYOUT_EXCEEDS_DUE", "1000.00"]);
    assert.equal(await count("landlord_payouts"), 2);
  });

  it("tenant credit refund out of trust: above the balance 409 (flag ignored); within it, it posts", async () => {
    // An advance of 1,000 on next month's rent (an agent tenant's credit, collected into trust): 1114 2,000.
    const [p2] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null and due_date >= $2 order by due_date limit 1`, [contractId, firstOf(1)]);
    await env.payments.addCollection(user, String(p2.id), { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "2000.00");
    await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "1500" }); // 1114: 500, below the 1,000 credit
    refused(await attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "500.01", bankAccountId: trustId, allowTrustOverdraw: true })), "500.00", "500.01");
    assert.equal(await count("tenant_credit_actions"), 0);
    const ok = await credits.refund(U, user, { tenantId: s.tenant, amount: "400", bankAccountId: trustId });
    assert.ok(ok.action.number);
    await transfers.create(U, user, { fromBankAccountId: parkId, toBankAccountId: trustId, amount: "1000" });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "1100.00");
  });

  it("a landlord's expense paid from trust: 409 above the balance (flag ignored); an edit counts only its increase", async () => {
    const base = { expenseDate: today, category: "صيانة", ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord", bankAccountId: trustId };
    refused(await attempt(() => expenses.create(U, user, { ...base, amount: "1100.01", allowTrustOverdraw: true })), "1100.00", "1100.01");
    const e = await expenses.create(U, user, { ...base, amount: "1000" });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "100.00");
    refused(await attempt(() => expenses.update(U, user, e.id, { amount: "1100.01" })), "100.00", "100.01");
    const up = await expenses.update(U, user, e.id, { amount: "1100" });
    assert.equal(up.details!.revision, 2);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "0.00");
  });

  it("a supplier payment for a landlord's bill from trust: 409 above the balance; a non-trust account pays it as before", async () => {
    await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "200" }); // trust 200
    const sup = await ap.createSupplier(U, user, { nameAr: "مورد صيانة", paymentTermsDays: 30 });
    const bill = await ap.approveBill(U, user, (await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord", lines: [{ description: "صيانة", amount: "250" }],
    })).id);
    const body = { supplierId: sup.id, paidOn: today, amount: "250", allocations: [{ billId: bill.id, amount: "250" }] };
    refused(await attempt(() => ap.createPayment(U, user, { ...body, bankAccountId: trustId, allowTrustOverdraw: true })), "200.00", "250.00");
    assert.equal(await count("supplier_payments"), 0);
    const paid = await ap.createPayment(U, user, { ...body, bankAccountId: officeId });
    assert.equal(paid.bankAccountId, officeId);
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "200.00");
  });

  it("a collection recorded a moment ago (queued, not yet posted) counts: the money is in trust", async () => {
    const [p3] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null and due_date >= $2 order by due_date limit 1`, [contractId, firstOf(2)]);
    await env.payments.addCollection(user, String(p3.id), { amount: "2000", collectedDate: today, method: "cash" });
    assert.deepEqual([(await avail(U)).posted, (await avail(U)).pending, (await avail(U)).available], ["200.00", "2000.00", "2200.00"]);
    const t = await transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "2200" });
    assert.deepEqual(t.warnings, ["SOURCE_BALANCE_NEGATIVE"], "only the generic note that the POSTED book balance dips until the collection posts");
    refused(await attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: parkId, amount: "0.01" })), "0.00", "0.01");
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), "0.00");
  });

  it("a payment that does not touch trust is never checked (an office expense from the office bank, any amount); no overdraw was ever audited", async () => {
    const e = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "99999", bankAccountId: officeId });
    assert.equal(e.details!.bankAccountId, officeId);
    assert.equal(await overdrawAudits(), 0);
  });

  it("deposit refund at contract end: refused before any legacy write when trust is short (flag ignored); the contract's own deposit is what is refunded", async () => {
    const seed = await seedAccount(env, D);
    await enableV2(env, D, "manager");
    const du = userFor(D);
    const dTrust = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [D]))[0].id);
    const dPark = (await banks.create(D, D, { kind: "bank", nameAr: "أمانات ٢", isTrust: true, isDefault: false })).id;
    const c: any = await env.contracts.create(du, {
      unitIds: [seed.unitA1], tenantId: seed.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
      depositAmount: "2000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: today,
    });
    await drain(env, D);
    assert.equal(await glBal(D, "1114"), "2000.00", "the deposit sits in trust");
    await transfers.create(D, du, { fromBankAccountId: dTrust, toBankAccountId: dPark, amount: "1500" });
    const body = { mode: "cancelled", deposit: "refund", refundMethod: "bank_transfer" };
    refused(await attempt(() => env.contracts.terminate(du, String(c.id), { ...body, allowTrustOverdraw: true })), "500.00", "2000.00");
    const [ct] = await env.q(`select status::text as status from contracts where id = $1`, [c.id]);
    assert.notEqual(ct.status, "cancelled", "nothing written");
    assert.equal(await count("finance_deposit_refunds", D), 0);
    await transfers.create(D, du, { fromBankAccountId: dPark, toBankAccountId: dTrust, amount: "1500" });
    const ok: any = await env.contracts.terminate(du, String(c.id), body);
    assert.equal(ok.success, true);
    await drain(env, D);
    assert.equal(await glBal(D, "1114"), "0.00");
    const [r] = await env.q(`select amount::text as amount from finance_deposit_refunds where user_id = $1`, [D]);
    assert.equal(r.amount, "2000.00", "the contract's deposit held, no more");
  });
});

describe("fv2 trust guard per landlord: never pay one landlord with another's money (real Postgres)", { skip: fv2DbSkip }, () => {
  /**
   * Account P, two agent landlords. A's 2,000 rent was collected into the cash box (as before the trust account was
   * mandatory: it is switched inactive for those collections, and they are posted before it comes back); B's rent is
   * 500 in the cash box + 2,000 in trust, and his tenant's 700 deposit is in trust. Trust holds 2,700 — none of it A's.
   */
  const P = 6434;
  const user = userFor(P);
  let env: LegacyEnv;
  let s: Seed;
  let transfers: AccountTransferService;
  let B: number;
  let trustId: number;
  let cashId: number;
  let glBal: (u: number, code: string) => Promise<string>;
  const payout = (ownerId: number, amount: string, extra: Record<string, unknown> = {}) =>
    env.reports.createPayout(user, { ownerId, amount, transferDate: today, method: "bank_transfer", ...extra });
  const position = async (ownerId: number) => (await trustAvailability(env.t.pool as any, P, ownerId)).landlord;
  const trustActive = (on: boolean) => env.q(`update bank_accounts set is_active = $2 where user_id = $1 and is_trust`, [P, on]);
  const due = async (ownerId: number) => Number(((await env.reports.accounting(user)) as any).landlordDues.find((d: any) => Number(d.ownerId) === ownerId).remaining);

  before(async () => {
    env = await legacyEnv("wired");
    glBal = glBalOf(env);
    s = await seedAccount(env, P);
    await enableV2(env, P, "manager");
    const periods = new PeriodsService(env.t.pool);
    transfers = new AccountTransferService(env.t.pool as any, new JournalRepository(periods), periods);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [P]))[0].id);
    cashId = await bankIdOf(env)(P, "1111");
    B = Number((await env.q(
      `insert into owners (user_id, name, email, phone, id_number, type) values ($1, 'Synthetic Landlord B', $2, '0500000002', $3, 'individual') returning id`,
      [P, `owner-b-${P}@example.test`, `70002${P}`]))[0].id);
    const propB = Number((await env.q(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Court', $2) returning id`, [P, B]))[0].id);
    const unitB = Number((await env.q(`insert into units (property_id, unit_number) values ($1, 'B1') returning id`, [propB]))[0].id);
    const cA: any = await env.contracts.create(user, {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false,
    });
    const cB: any = await env.contracts.create(user, {
      unitIds: [unitB], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false,
      depositAmount: "700", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: today,
    });
    await drain(env, P); // B's deposit posts into trust now
    const inst = async (c: number) => (await env.q(`select id from payments where contract_id = $1 and deleted_at is null and description is distinct from 'تأمين (وديعة)' order by due_date`, [c])).map((r: any) => String(r.id));
    const [a1] = await inst(cA.id);
    const [b1, b2] = await inst(cB.id);
    await trustActive(false); // collected as before the trust account: into the cash box, and posted there
    await env.payments.addCollection(user, a1, { amount: "2000", collectedDate: today, method: "cash" });
    await env.payments.addCollection(user, b1, { amount: "500", collectedDate: today, method: "cash" });
    await drain(env, P);
    await trustActive(true);
    await env.payments.addCollection(user, b1, { amount: "1500", collectedDate: today, method: "bank_transfer" });
    await env.payments.addCollection(user, b2, { amount: "500", collectedDate: today, method: "bank_transfer" });
    await drain(env, P);
  });
  after(async () => { await env?.t.drop(); });

  it("the position: trust 2,700 (B's rent 2,000 + his tenant's deposit 700), the cash box 2,500; A has nothing in trust", async () => {
    assert.equal(await glBal(P, "1114"), "2700.00");
    assert.equal(await glBal(P, "1111"), "2500.00");
    assert.deepEqual(await position(s.agent), { ownerId: s.agent, inTrust: "0.00", deposits: "0.00", payable: "0.00" });
    assert.deepEqual(await position(B), { ownerId: B, inTrust: "2700.00", deposits: "700.00", payable: "2000.00" });
  });

  it("A's dues are in the cash box, B's money in trust: A paid from trust is 409 LANDLORD_TRUST_INSUFFICIENT; nothing written", async () => {
    assert.ok(await due(s.agent) >= 500, "within A's net due");
    const n = (await env.q(`select count(*)::int as n from landlord_payouts where user_id = $1`, [P]))[0].n;
    const r: any = await attempt(() => payout(s.agent, "500", { allowTrustOverdraw: true }));
    refusedWith(r, "LANDLORD_TRUST_INSUFFICIENT", "0.00", "500.00");
    assert.equal(r.body.ownerId, s.agent);
    assert.match(r.body.message, /رصيد المؤجر في حساب الأمانات لا يكفي: المتاح 0\.00/);
    assert.match(r.body.message, /إلى حساب الأمانات أولاً/);
    assert.match(r.body.message, /transfer his money collected outside trust .* into the trust account first/);
    assert.equal((await env.q(`select count(*)::int as n from landlord_payouts where user_id = $1`, [P]))[0].n, n);
  });

  it("his tenants' deposits are not payable to the landlord: B (dues 2,500, 2,700 of his in trust) may take 2,000 from trust, not 2,500", async () => {
    assert.equal(await due(B), 2500);
    refusedWith(await attempt(() => payout(B, "2500")), "LANDLORD_TRUST_INSUFFICIENT", "2000.00", "2500.00");
    const ok: any = await payout(B, "2000");
    assert.ok(ok.voucherNumber);
    await drain(env, P);
    assert.equal(await glBal(P, "1114"), "700.00", "the deposit stays");
    assert.equal((await position(B))!.payable, "0.00");
  });

  it("after A's money is moved into trust (cash box → trust, tagged with A), A may be paid from trust — up to what was moved", async () => {
    const t = await transfers.create(P, user, { fromBankAccountId: cashId, toBankAccountId: trustId, amount: "1000", ownerId: s.agent });
    const [e] = await env.q(`select payload->'transfer'->>'ownerId' as o from journal_entries where id = $1`, [t.entryId]);
    assert.equal(Number(e.o), s.agent);
    assert.deepEqual(await position(s.agent), { ownerId: s.agent, inTrust: "1000.00", deposits: "0.00", payable: "1000.00" });
    refusedWith(await attempt(() => payout(s.agent, "1000.01")), "LANDLORD_TRUST_INSUFFICIENT", "1000.00", "1000.01");
    const ok: any = await payout(s.agent, "400");
    assert.ok(ok.voucherNumber);
  });

  it("two payouts for the same landlord at once, each within his money in trust alone but not together: exactly one is refused", async () => {
    const [a, b] = await Promise.all([
      attempt(() => payout(s.agent, "350", { requestId: "ll-race-0001" })),
      attempt(() => payout(s.agent, "350", { requestId: "ll-race-0002" })),
    ]);
    const ok = [a, b].filter((x: any) => x?.voucherNumber);
    const ko = [a, b].filter((x: any) => x?.status === 409);
    assert.equal(ok.length, 1, JSON.stringify([a, b]));
    assert.equal(ko.length, 1);
    // The 400 posted or not, and the winner still queued: 1,000 − 400 − 350 = 250 left.
    refusedWith(ko[0], "LANDLORD_TRUST_INSUFFICIENT", "250.00", "350.00");
    await drain(env, P);
    assert.equal((await position(s.agent))!.payable, "250.00");
  });

  it("the account holder's drawings from trust never exceed the office's money there (409 TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY)", async () => {
    assert.equal((await trustAvailability(env.t.pool as any, P)).officeInTrust, "0.00");
    const r: any = await attempt(() => payout(s.holder, "1", { bankAccountId: trustId }));
    refusedWith(r, "TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY", "0.00", "1.00");
  });

  it("a tag is only for money moved INTO trust from another account (400), and the landlord must be this account's (404)", async () => {
    const r1: any = await attempt(() => transfers.create(P, user, { fromBankAccountId: trustId, toBankAccountId: cashId, amount: "1", ownerId: s.agent }));
    assert.deepEqual([r1.status, r1.body.error], [400, "OWNER_ONLY_INTO_TRUST"]);
    const r2: any = await attempt(() => transfers.create(P, user, { fromBankAccountId: cashId, toBankAccountId: trustId, amount: "1", ownerId: 999999 }));
    assert.deepEqual([r2.status, r2.body.error], [404, "OWNER_NOT_FOUND"]);
  });
});

describe("fv2 manual journals: trust against an office account needs a reason or an attachment, and another approver (real Postgres)", { skip: fv2DbSkip }, () => {
  const M = 6433; // the account holder, with an employee E who can approve
  const E = 6435;
  const S = 6436; // a one-person account
  const X = 6437; // an employee of S who cannot approve
  let env: LegacyEnv;
  let mj: ManualJournalsService;
  let transfers: AccountTransferService;
  const acc: Record<number, Record<string, number>> = {};
  const holder = { ...userOf(M), permissions: [...PERMS, "settings.write"] } as any;
  const emp = { ...userOf(E), ownerUserId: M, role: "accountant", permissions: PERMS } as any;
  const solo = { ...userOf(S), permissions: PERMS } as any;
  const L = (u: number, code: string, side: "d" | "c", amt: string) => ({ accountId: acc[u][code], debit: side === "d" ? amt : "0", credit: side === "c" ? amt : "0" });
  const flagged = (u: number) => [L(u, "5290", "d", "120"), L(u, "1114", "c", "120")];
  const REASON = "تصحيح قيد مكرر في سند الصرف";
  const err = async (p: Promise<unknown>) => { const r: any = await attempt(() => p); return [r.status, r.body?.error]; };
  const audits = async (u: number, entity: string) => (await env.q(`select entity_id, path from audit_logs where owner_user_id = $1 and entity = $2 order by id`, [u, entity]));

  before(async () => {
    env = await legacyEnv("wired");
    await seedAccount(env, M);
    await enableV2(env, M, "manager");
    await seedAccount(env, S);
    await enableV2(env, S, "manager");
    const role = async (perms: string[]) => Number((await env.q(`insert into roles (key, label_ar, label_en, permissions) values ('accountant', 'محاسب', 'Accountant', $1::jsonb) returning id`, [JSON.stringify(perms)]))[0].id);
    const approver = await role(PERMS);
    const clerk = await role(["reports.view", "invoices.view", "invoices.write", "expenses.write"]);
    await env.q(`insert into users (id, email, password_hash, name, owner_user_id, role_id) values ($1, $2, 'x', 'Synthetic Accountant', $3, $4)`, [E, `fv2-emp-${E}@example.test`, M, approver]);
    await env.q(`insert into users (id, email, password_hash, name, owner_user_id, role_id) values ($1, $2, 'x', 'Synthetic Clerk', $3, $4)`, [X, `fv2-emp-${X}@example.test`, S, clerk]);
    const periods = new PeriodsService(env.t.pool);
    const journal = new JournalRepository(periods);
    mj = new ManualJournalsService(env.t.pool, journal, periods);
    transfers = new AccountTransferService(env.t.pool as any, journal, periods);
    for (const u of [M, S]) acc[u] = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [u])).map((r: any) => [r.code, Number(r.id)]));
  });
  after(async () => { await env?.t.drop(); });

  it("flagged without a reason or an attachment: 400 TRUST_JOURNAL_REASON_REQUIRED on create, nothing saved; a 9-character reason is not enough", async () => {
    const n = (await env.q(`select count(*)::int as n from manual_journals where user_id = $1`, [M]))[0].n;
    assert.deepEqual(await err(mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M) })), [400, "TRUST_JOURNAL_REASON_REQUIRED"]);
    assert.deepEqual(await err(mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: "  123456789  " })), [400, "TRUST_JOURNAL_REASON_REQUIRED"]);
    assert.equal((await env.q(`select count(*)::int as n from manual_journals where user_id = $1`, [M]))[0].n, n);
    const r: any = await attempt(() => mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M) }));
    assert.match(r.body.message, /اكتب السبب \(10 أحرف على الأقل\) أو أرفق مستنداً/);
    assert.match(r.body.message, /give a reason \(at least 10 characters\) or attach a document/);
  });

  it("with a reason: saved with the warning and the reason (shown in the detail); with an attachment only: saved too", async () => {
    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    assert.deepEqual(d.warnings.map((w: any) => w.code), ["TRUST_WITH_OFFICE_ACCOUNT"]);
    assert.equal(d.trustReason, REASON);
    assert.equal(d.lastActorId, M);
    assert.equal((await mj.get(M, d.id)).trustReason, REASON);
    const a: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), attachmentKey: `acct/${M}/journals/support.pdf` });
    assert.equal(a.trustReason, null);
    // An edit that drops the attachment (no reason) is refused; one that keeps the reason may change the lines.
    assert.deepEqual(await err(mj.update(M, holder, a.id, { attachmentKey: null })), [400, "TRUST_JOURNAL_REASON_REQUIRED"]);
    const u: any = await mj.update(M, holder, d.id, { lines: [L(M, "5290", "d", "130"), L(M, "1114", "c", "130")] });
    assert.equal(u.trustReason, REASON, "kept when the edit does not send it");
  });

  it("maker-checker: the holder who drafted it may not approve it while an employee can (403 SAME_USER_APPROVAL); the employee approves", async () => {
    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    await mj.submit(M, holder, d.id);
    const r: any = await attempt(() => mj.approve(M, holder, d.id));
    assert.deepEqual([r.status, r.body.error], [403, "SAME_USER_APPROVAL"]);
    assert.match(r.body.message, /يعتمده مستخدم آخر/);
    assert.match(r.body.message, /must be approved by another user/);
    const ok: any = await mj.approve(M, emp, d.id);
    assert.equal(ok.status, "posted");
    assert.equal(ok.selfApproved, false);
    const [e] = await env.q(`select warnings from journal_entries where id = $1`, [ok.postedEntryId]);
    assert.deepEqual(e.warnings, ["TRUST_WITH_OFFICE_ACCOUNT"]);
  });

  it("the user who last edited or submitted it may not approve either: drafted by the holder, edited and submitted by E → neither approves", async () => {
    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    await mj.update(M, emp, d.id, { memo: "تصحيح بعد المراجعة" });
    await mj.submit(M, emp, d.id);
    assert.deepEqual(await err(mj.approve(M, emp, d.id)), [403, "SAME_USER_APPROVAL"]);
    assert.deepEqual(await err(mj.approve(M, holder, d.id)), [403, "SAME_USER_APPROVAL"]);
    assert.equal((await mj.get(M, d.id)).status, "submitted");
  });

  it("drafted by the employee: he may not approve (403 SAME_USER_APPROVAL), the holder may", async () => {
    const d: any = await mj.create(M, emp, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    await mj.submit(M, emp, d.id);
    assert.deepEqual(await err(mj.approve(M, emp, d.id)), [403, "SAME_USER_APPROVAL"]);
    const ok: any = await mj.approve(M, holder, d.id);
    assert.equal(ok.status, "posted");
  });

  it("a normal journal is unchanged: no reason needed, the holder still approves his own", async () => {
    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تسوية", lines: [L(M, "5290", "d", "10"), L(M, "1113", "c", "10")] });
    assert.deepEqual(d.warnings, []);
    await mj.submit(M, holder, d.id);
    const ok: any = await mj.approve(M, holder, d.id);
    assert.equal(ok.status, "posted");
    assert.equal(ok.selfApproved, false);
    // …and an employee still may not approve his own normal journal (the existing rule).
    const e: any = await mj.create(M, emp, { entryDate: today, memo: "تسوية", lines: [L(M, "5290", "d", "10"), L(M, "1113", "c", "10")] });
    await mj.submit(M, emp, e.id);
    assert.deepEqual(await err(mj.approve(M, emp, e.id)), [403, "SAME_APPROVER"]);
  });

  it("one-person account (its only employee cannot approve): the holder self-approves with a written reason — an attachment alone is not enough — and it is audited", async () => {
    const d: any = await mj.create(S, solo, { entryDate: today, memo: "تصحيح", lines: flagged(S), attachmentKey: `acct/${S}/journals/support.pdf` });
    await mj.submit(S, solo, d.id);
    assert.deepEqual(await err(mj.approve(S, solo, d.id)), [400, "TRUST_JOURNAL_REASON_REQUIRED"]);
    await mj.reject(S, solo, d.id, { reason: "add the written reason" });
    await mj.update(S, solo, d.id, { trustReason: REASON });
    await mj.submit(S, solo, d.id);
    const ok: any = await mj.approve(S, solo, d.id);
    assert.equal(ok.status, "posted");
    assert.equal(ok.selfApproved, true);
    const rows = await audits(S, "finance_v2_manual_journal_self_approval");
    assert.deepEqual(rows, [{ entity_id: String(d.id), path: `/finance/v2/manual-journals/${d.id}/approve?warnings=TRUST_WITH_OFFICE_ACCOUNT` }]);
  });

  it("an inactive employee does not count as another approver; an active one does again", async () => {
    await env.q(`update users set is_active = false where id = $1`, [E]);
    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    await mj.submit(M, holder, d.id);
    const ok: any = await mj.approve(M, holder, d.id);
    assert.equal(ok.selfApproved, true);
    await env.q(`update users set is_active = true where id = $1`, [E]);
    const d2: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: flagged(M), trustReason: REASON });
    await mj.submit(M, holder, d2.id);
    assert.deepEqual(await err(mj.approve(M, holder, d2.id)), [403, "SAME_USER_APPROVAL"]);
  });

  it("not flagged: trust against client money (2121, 2141) or a money box; the opening entry is never flagged", async () => {
    for (const lines of [
      [L(M, "2121", "d", "70"), L(M, "1114", "c", "70")],
      [L(M, "2141", "d", "70"), L(M, "1114", "c", "70")],
      [L(M, "1113", "d", "70"), L(M, "1114", "c", "70")],
      [L(M, "1114", "d", "70"), L(M, "1111", "c", "70")],
    ]) {
      const d: any = await mj.create(M, holder, { entryDate: today, memo: "تحويل", lines });
      assert.deepEqual(d.warnings, [], JSON.stringify(lines));
    }
  });

  it("the transfer between accounts writes its manual journal directly (approved, not flagged): governed by the office-money cap instead", async () => {
    const trust = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [M]))[0].id);
    const office = await bankIdOf(env)(M, "1113");
    await transfers.create(M, holder, { fromBankAccountId: office, toBankAccountId: trust, amount: "500" }); // the posted journals above took 360 out of trust
    const t = await transfers.create(M, holder, { fromBankAccountId: trust, toBankAccountId: office, amount: "100" });
    assert.deepEqual(t.warnings, []);
    const [e] = await env.q(`select warnings from journal_entries where id = $1`, [t.entryId]);
    assert.deepEqual(e.warnings, []);
  });
});
