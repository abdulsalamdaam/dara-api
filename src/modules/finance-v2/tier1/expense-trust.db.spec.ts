import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { BankAccountsService } from "./bank-accounts.service";
import { ExpensesV2Service } from "./expenses-v2.service";
import { ApService } from "../tier3/ap.service";
import { AssetsService } from "../assets/assets.service";
import { ChartService } from "../chart.service";

/**
 * Accountant note (15 Oct 2026): the trust account (أمانات) holds landlords'
 * and tenants' money, so an office expense — no landlord, directly or through
 * the property — can never be paid from it. An expense on a landlord may.
 * The "default" for an office expense never resolves to trust either.
 * Synthetic data only, Manager mode (trust mandatory).
 */
const U = 5471;
const today = riyadhToday();
const user = { ...userOf(U), permissions: ["reports.view", "expenses.write", "expenses.approve"] };

async function drain(env: LegacyEnv) {
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2: office outflows are never paid from the trust account (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let banks: BankAccountsService;
  let expenses: ExpensesV2Service;
  let trustId: number;

  const bankCodeOf = async (expenseId: number, event: string) => (await env.q(
    `select a.code, l.bank_account_id from ledger_outbox o join journal_lines l on l.entry_id = o.entry_id join accounts a on a.id = l.account_id
      where o.user_id = $1 and o.source_type = 'expense' and o.source_id = $2 and o.event = $3 and l.credit > 0`, [U, expenseId, event]))[0];
  const expenseCount = async () => (await env.q(`select count(*)::int as n from expenses where user_id = $1`, [U]))[0].n;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    banks = new BankAccountsService(env.t.pool as any);
    expenses = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [U]))[0].id);
  });

  after(async () => {
    await env?.t.drop();
  });

  it("an office expense (no landlord, no property) from the trust account is refused with TRUST_FOR_OFFICE_EXPENSE; nothing is written", async () => {
    const before = await expenseCount();
    const r: any = await attempt(() => expenses.create(U, user, { expenseDate: today, category: "إيجار المكتب", amount: "500", bankAccountId: trustId }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "TRUST_FOR_OFFICE_EXPENSE");
    assert.match(r.body.message, /حساب الأمانات/);
    assert.match(r.body.message, /trust/);
    assert.equal(await expenseCount(), before, "no legacy row");
  });

  it("an expense on a landlord (directly, or through the landlord's property) may be paid from trust", async () => {
    const direct = await expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "200", ownerId: s.agent, bankAccountId: trustId });
    const viaProp = await expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "300", propertyId: s.propA, bankAccountId: trustId });
    assert.equal(direct.details!.bankAccountId, trustId);
    assert.equal(viaProp.ownerId, s.agent, "the landlord comes from the property");
    await drain(env);
    assert.deepEqual(await bankCodeOf(direct.id, "rev:1"), { code: "1114", bank_account_id: trustId });
    assert.deepEqual(await bankCodeOf(viaProp.id, "rev:1"), { code: "1114", bank_account_id: trustId });
  });

  it("an office expense left on the default posts to the operating account, never trust — even if the settings default was left on a trust account", async () => {
    const e1 = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "50" });
    await drain(env);
    const c1 = await bankCodeOf(e1.id, "rev:1");
    assert.equal(c1.code, "1113", "the default operating bank");
    assert.notEqual(c1.bank_account_id, trustId);
    // A stale settings default that points at a trust account (data from before the settings check) is skipped.
    await env.q(`update finance_settings set default_bank_account_id = $2 where account_user_id = $1`, [U, trustId]);
    const e2 = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "60" });
    await drain(env);
    const c2 = await bankCodeOf(e2.id, "rev:1");
    assert.notEqual(c2.code, "1114");
    assert.notEqual(c2.bank_account_id, trustId);
    const op = Number((await env.q(`select id from bank_accounts where user_id = $1 and not is_trust and kind = 'bank' and is_default`, [U]))[0].id);
    await env.q(`update finance_settings set default_bank_account_id = $2 where account_user_id = $1`, [U, op]);
  });

  it("an unused operating account switched to trust stops being the settings default", async () => {
    const b = await banks.create(U, U, { kind: "bank", nameAr: "حساب مؤقت", isDefault: true });
    assert.equal((await env.q(`select default_bank_account_id from finance_settings where account_user_id = $1`, [U]))[0].default_bank_account_id, b.id);
    await banks.update(U, U, b.id, { isTrust: true });
    assert.equal((await env.q(`select default_bank_account_id from finance_settings where account_user_id = $1`, [U]))[0].default_bank_account_id, null);
    const e = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "70" });
    await drain(env);
    const c = await bankCodeOf(e.id, "rev:1");
    assert.notEqual(c.bank_account_id, b.id, "not the account that became trust");
    assert.notEqual(c.bank_account_id, trustId);
  });

  it("an edit that removes the landlord while the trust account stays selected is refused; the expense is unchanged", async () => {
    const e = await expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "400", ownerId: s.agent, propertyId: s.propA, bankAccountId: trustId });
    const r: any = await attempt(() => expenses.update(U, user, e.id, { ownerId: null, propertyId: null }));
    assert.deepEqual([r.status, r.body.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
    const [row] = await env.q(`select e.owner_id, d.revision, d.bank_account_id from expenses e join finance_expense_details d on d.expense_id = e.id where e.id = $1`, [e.id]);
    assert.deepEqual(row, { owner_id: s.agent, revision: 1, bank_account_id: trustId });
    // Clearing the landlord together with a non-trust account is fine.
    const ok = await expenses.update(U, user, e.id, { ownerId: null, propertyId: null, bankAccountId: null });
    assert.deepEqual([ok.ownerId, ok.details!.bankAccountId, ok.details!.revision], [null, null, 2]);
    // And an office expense cannot be moved onto trust by an edit.
    const r2: any = await attempt(() => expenses.update(U, user, e.id, { bankAccountId: trustId }));
    assert.equal(r2.body.error, "TRUST_FOR_OFFICE_EXPENSE");
  });

  it("a fixed-asset purchase and a supplier payment for a bill with no landlord are refused from trust; a landlord's bill may be", async () => {
    const assets = new AssetsService(env.t.pool as any, env.emitter, banks, new ChartService(env.t.pool as any));
    const a: any = await attempt(() => assets.create(U, user, {
      nameAr: "طابعة", category: "computers", acquisitionDate: today, cost: "1200", usefulLifeMonths: 12, acquisitionMode: "bank", acquisitionBankAccountId: trustId,
    }));
    assert.deepEqual([a.status, a.body?.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);

    const ap = new ApService(env.t.pool as any, env.emitter, banks);
    const sup = await ap.createSupplier(U, user, { nameAr: "مورد", paymentTermsDays: 30 });
    const office = await ap.approveBill(U, user, (await ap.createBill(U, user, { supplierId: sup.id, billDate: today, lines: [{ description: "قرطاسية", amount: "100" }] })).id);
    const landlord = await ap.approveBill(U, user, (await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, ownerId: s.agent, propertyId: s.propA, lines: [{ description: "صيانة", amount: "100" }],
    })).id);
    const refused: any = await attempt(() => ap.createPayment(U, user, {
      supplierId: sup.id, paidOn: today, amount: "100", bankAccountId: trustId, allocations: [{ billId: office.id, amount: "100" }],
    }));
    assert.deepEqual([refused.status, refused.body.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
    const paid = await ap.createPayment(U, user, {
      supplierId: sup.id, paidOn: today, amount: "100", bankAccountId: trustId, allocations: [{ billId: landlord.id, amount: "100" }],
    });
    assert.equal(paid.bankAccountId, trustId);
  });
});
