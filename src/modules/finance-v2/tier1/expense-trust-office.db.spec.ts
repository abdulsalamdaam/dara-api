import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../db/src/schema";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { BankAccountsService } from "./bank-accounts.service";
import { ExpensesV2Service } from "./expenses-v2.service";
import { AccountTransferService } from "./account-transfer.service";
import { PeriodsService } from "../periods.service";
import { JournalRepository } from "../journal.repository";
import { ApService } from "../tier3/ap.service";
import { ReconciliationService } from "../reports/reconciliation.service";
import { legacyAccountingFor } from "../reports/legacy-accounting";

/**
 * Review of the 15 Oct 2026 trust guard. "Office money" is whatever the office
 * bears, not only an expense with no landlord: in Manager mode the account
 * holder's own property is principal (its rent never goes to trust), and an
 * agent landlord's expense charged to the company posts Dr expense / Cr bank
 * with no landlord payable — from trust it would leave client money short.
 * Synthetic data only, Manager mode.
 */
const U = 5473;
const today = riyadhToday();
const user = { ...userOf(U), permissions: ["reports.view", "expenses.write", "expenses.approve"] };

async function drain(env: LegacyEnv) {
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2: the trust guard covers every office outflow (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let banks: BankAccountsService;
  let expenses: ExpensesV2Service;
  let ap: ApService;
  let trustId: number;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    banks = new BankAccountsService(env.t.pool as any);
    expenses = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    ap = new ApService(env.t.pool as any, env.emitter, banks);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [U]))[0].id);
    // Fund the trust account (office bank → trust, never capped): these specs are about WHICH outflows may use trust;
    // the balance guard itself (policy block, no confirmation) is covered in trust-guard.db.spec.ts.
    {
      const periods = new PeriodsService(env.t.pool);
      // From the cash box (1111): the operating bank's own test below needs it unused.
      const office = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1111'`, [U]))[0].id);
      await new AccountTransferService(env.t.pool as any, new JournalRepository(periods), periods).create(U, user as any, { fromBankAccountId: office, toBankAccountId: trustId, amount: "10000" });
    }
    // The agent landlord's own money in trust (his rent, collected into trust): a landlord's expense or bill paid from trust
    // takes only HIS money there (trust-guard.ts, LANDLORD_TRUST_INSUFFICIENT) — the office's money above is not his.
    {
      const setup = { ...userOf(U), permissions: ["contracts.write", "payments.write", "invoices.write"] } as any;
      const c: any = await env.contracts.create(setup, { unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant",
        startDate: today, endDate: `${Number(today.slice(0, 4)) + 1}-12-31`, monthlyRent: "5000", paymentFrequency: "monthly", vatEnabled: false });
      const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
      await env.payments.addCollection(setup, String(p.id), { amount: "5000", collectedDate: today, method: "bank_transfer" });
      await env.recognizer.runAccount(U);
      await drain(env);
    }
  });

  after(async () => {
    await env?.t.drop();
  });

  it("an expense on the account holder's own property is office money: refused from trust", async () => {
    const r: any = await attempt(() => expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "100", propertyId: s.propH, bankAccountId: trustId }));
    assert.deepEqual([r.status, r.body?.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
  });

  it("an agent landlord's expense charged to the company is office money: refused from trust; charged to the landlord it may be", async () => {
    const r: any = await attempt(() => expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "100", propertyId: s.propA, chargeTo: "company", bankAccountId: trustId }));
    assert.deepEqual([r.status, r.body?.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
    const ok = await expenses.create(U, user, { expenseDate: today, category: "صيانة", amount: "100", propertyId: s.propA, chargeTo: "landlord", bankAccountId: trustId });
    assert.equal(ok.details!.bankAccountId, trustId);
    // An edit that moves it back to the company while trust stays selected is refused.
    const e: any = await attempt(() => expenses.update(U, user, ok.id, { chargeTo: "company" }));
    assert.deepEqual([e.status, e.body?.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
  });

  it("a supplier payment for the holder's bill, or an agent bill charged to the company, is refused from trust", async () => {
    const sup = await ap.createSupplier(U, user, { nameAr: "مورد", paymentTermsDays: 30 });
    const bill = async (extra: any) => ap.approveBill(U, user, (await ap.createBill(U, user, { supplierId: sup.id, billDate: today, lines: [{ description: "صيانة", amount: "100" }], ...extra })).id);
    for (const b of [await bill({ ownerId: s.holder, propertyId: s.propH }), await bill({ ownerId: s.agent, propertyId: s.propA, chargeTo: "company" })]) {
      const r: any = await attempt(() => ap.createPayment(U, user, { supplierId: sup.id, paidOn: today, amount: "100", bankAccountId: trustId, allocations: [{ billId: b.id, amount: "100" }] }));
      assert.deepEqual([r.status, r.body?.error], [409, "TRUST_FOR_OFFICE_EXPENSE"]);
    }
    const lb = await bill({ ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord" });
    const paid = await ap.createPayment(U, user, { supplierId: sup.id, paidOn: today, amount: "100", bankAccountId: trustId, allocations: [{ billId: lb.id, amount: "100" }] });
    assert.equal(paid.bankAccountId, trustId);
  });

  it("the settings default cannot be switched to trust (else a defaulted office expense falls back onto the same GL, now client money)", async () => {
    const main = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [U]))[0].id);
    const r: any = await attempt(() => banks.update(U, U, main, { isTrust: true }));
    if (r?.status == null) {
      const e = await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "40" });
      await drain(env);
      const [line] = await env.q(`select a.code, l.bank_account_id from ledger_outbox o join journal_lines l on l.entry_id = o.entry_id join accounts a on a.id = l.account_id
        where o.user_id = $1 and o.source_type = 'expense' and o.source_id = $2 and l.credit > 0`, [U, e.id]);
      assert.fail(`flip accepted; the office expense then posted to ${JSON.stringify(line)} — the GL of an account that is now trust`);
    }
    assert.deepEqual([r.status, r.body?.error], [409, "BANK_ACCOUNT_IS_DEFAULT"]);
  });

  it("R4 routes a defaulted expense like the engine when a stale settings default points at trust", async () => {
    await env.q(`update finance_settings set default_bank_account_id = $2 where account_user_id = $1`, [U, trustId]);
    await expenses.create(U, user, { expenseDate: today, category: "قرطاسية", amount: "60" });
    await drain(env);
    const r: any = await new ReconciliationService(env.t.pool as any, legacyAccountingFor(drizzle(env.t.pool, { schema }) as any))
      .reconciliation(U, { asOf: today, lang: "en", only: "R4" });
    const r4 = r.checks.find((c: any) => c.id === "R4");
    assert.equal(r4.status, "ok", JSON.stringify(r4.rows));
  });
});
