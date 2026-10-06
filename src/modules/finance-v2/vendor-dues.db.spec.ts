import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { ApService } from "./tier3/ap.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { legacyAccountingFor } from "./reports/legacy-accounting";
import { FinanceV2BugsController } from "./controllers/bugs.controller";

/**
 * The accountant's test of 5 Oct 2026 (finding #2), end to end on the real
 * legacy routes against a throwaway Postgres. Synthetic data only.
 *
 * Manager mode, the office NOT VAT-registered (no ZATCA link), billed
 * commission basis. One individual landlord, not VAT-registered, residential
 * property at 7%:
 *   contract 36,000 a year in 12 monthly installments of 3,000 (no VAT);
 *   rent receipt voucher (RR-) for this month's installment, approved → the
 *     commission draft (7% = 210) is created;
 *   3,000 collected in cash;
 *   supplier bill 500 + 75 VAT charged to the landlord (his VAT, he is not
 *     registered, so it is part of what he bears), approved → Dr 2121 575;
 *   the supplier paid 575 in cash.
 *
 * Landlord payable (2121) = 3,000 − 575 = 2,425 while the commission is a
 * draft (drafts never enter the books); 2,215 once it is approved (E15 Dr
 * 2121 210). The landlord-dues report and the cash sub-ledger must say the
 * same, so reconciliation R1–R8 is all zero, and the payout refuses more
 * than the net due.
 */
const U = 6311;
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
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const user = { ...userOf(U), permissions: PERMS };
const R1_R8 = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"];

async function drain(env: LegacyEnv) {
  await env.recognizer.runAccount(U);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 finding #2: supplier bills and payments in the landlord dues, cash and payout (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let ap: ApService;
  let owner: number;
  let p1: number;
  let commissionId: number | null = null;
  let sup: any;
  let propId: number;
  const recon = async () => {
    const r = await new ReconciliationService(env.t.pool as any, legacyAccountingFor(drizzle(env.t.pool, { schema })))
      .reconciliation(U, { asOf: today, lang: "en", only: R1_R8.join(",") });
    return r.checks;
  };
  const lp = async () => (await env.q(
    `select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
      where l.user_id = $1 and a.system_key = 'landlord_payable' and l.owner_id = $2`, [U, owner]))[0].b;
  const dues = async () => (await env.reports.accounting(user)).landlordDues.find((d: any) => d.ownerId === owner);
  const assertAllZero = (checks: any[]) => {
    for (const c of checks) {
      assert.equal(c.status, "ok", `${c.id} ${c.status}: ledger ${c.ledger} vs ${c.subLedger} (${JSON.stringify(c.rows)})`);
      if (c.difference != null && c.id !== "R6") assert.equal(c.difference, "0.00", c.id);
    }
    assert.deepEqual(checks.map((c) => c.id), R1_R8);
  };

  before(async () => {
    env = await legacyEnv("wired");
    await seedAccount(env, U);
    // The office is not VAT-registered: no ZATCA link for the account holder (seedAccount links only its own agent landlord).
    await enableV2(env, U, "manager");
    await env.q(`update finance_settings set commission_basis = 'billed' where account_user_id = $1`, [U]);
    ap = new ApService(env.t.pool as any, env.emitter, new BankAccountsService(env.t.pool as any));

    const [o] = await env.q(
      `insert into owners (user_id, name, email, phone, id_number, is_account_holder, type)
       values ($1, 'Synthetic Individual Landlord', 'ind-${U}@example.test', '0500000009', '10${U}000', false, 'individual') returning id`, [U]);
    owner = Number(o.id);
    const [p] = await env.q(`insert into properties (user_id, name, owner_id, management_fee_percent) values ($1, 'Synthetic Residence', $2, 7) returning id`, [U, owner]);
    const [un] = await env.q(`insert into units (property_id, unit_number) values ($1, 'R1') returning id`, [p.id]);
    const c: any = await env.contracts.create(user, {
      unitIds: [Number(un.id)], tenantId: (await env.q(`select id from tenants where user_id = $1 limit 1`, [U]))[0].id, tenantName: "Synthetic Tenant",
      startDate: firstOf(0), endDate: lastOf(11), monthlyRent: "3000", paymentFrequency: "monthly", vatEnabled: false, landlordName: "Synthetic Individual Landlord",
    });
    const pays = await env.q(`select id, amount::text as amount from payments where contract_id = $1 and deleted_at is null order by due_date`, [c.id]);
    assert.deepEqual([pays.length, pays[0].amount], [12, "3000.00"], "36,000 a year in 12 monthly installments");
    p1 = Number(pays[0].id);
    await drain(env);

    // Rent receipt voucher (non-tax: the landlord is not VAT-registered), approved → the 7% commission draft.
    const rr: any = await new FinanceV2BugsController(env.t.pool as any, env.emitter).rentReceipt({ user } as any, { paymentIds: [p1] });
    const ok: any = await env.billing.approve(user, String(rr.id), {});
    assert.equal(ok.status, "confirmed");
    commissionId = ok.commission?.id ?? null;
    await env.payments.addCollection(user, String(p1), { amount: "3000", collectedDate: today, method: "cash" });

    propId = Number(p.id);
    sup = await ap.createSupplier(U, user, { nameAr: "مورد الصيانة", vatNumber: "300000000000013", paymentTermsDays: 0 });
    const bill: any = await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, propertyId: Number(p.id), chargeTo: "landlord",
      lines: [{ description: "صيانة السباكة", amount: "500", vatCategory: "S" }],
    });
    assert.deepEqual([bill.subtotal, bill.vatTotal, bill.total, bill.ownerId], ["500.00", "75.00", "575.00", owner]);
    await ap.approveBill(U, user, bill.id);
    await ap.createPayment(U, user, { supplierId: sup.id, paidOn: today, amount: "575", method: "cash", allocations: [{ billId: bill.id, amount: "575" }] });
    await drain(env);
  });

  after(async () => { await env?.t.drop(); });

  it("the commission draft is 7% of the installment (210) and is not in the books yet", async () => {
    assert.ok(commissionId, "approving the rent receipt drafted the commission");
    const [d] = await env.q(`select status::text as status, total::text as total, contract_id from simple_invoices where id = $1`, [commissionId]);
    assert.deepEqual([d.status, d.total], ["draft", "210.00"]);
  });

  it("before the commission: 2121 = 2,425; the dues report deducts the supplier bill (575) and says 2,425; R1–R8 all zero", async () => {
    assert.equal(await lp(), "2425.00");
    const d = await dues();
    assert.deepEqual([d.net, d.transferred, d.remaining], [2425, 0, 2425]);
    const st = (await env.reports.accounting(user)).landlordStatement.find((r: any) => r.ownerId === owner);
    assert.deepEqual([st.rentCollected, st.vendorBills, st.net], [3000, 575, 2425]);
    assertAllZero(await recon());
  });

  it("the payout refuses more than the net due (409 PAYOUT_EXCEEDS_DUE), nothing written", async () => {
    const over: any = await attempt(() => env.reports.createPayout(user, { ownerId: owner, amount: 3000, method: "cash", transferDate: today }));
    assert.equal(over.status, 409);
    assert.equal(over.body.error, "PAYOUT_EXCEEDS_DUE");
    assert.equal(over.body.netDue, "2425.00");
    assert.equal((await env.q(`select count(*)::int as n from landlord_payouts where user_id = $1`, [U]))[0].n, 0, "nothing written");
  });

  it("after the commission is approved: 2121 = 2,215 = the dues; paying 2,215 out leaves 0 on both sides; R1–R8 all zero", async () => {
    const r: any = await attempt(() => env.billing.approve(user, String(commissionId), {}));
    if (r?.status && r.status >= 400) {
      // Finding #1 (the commission approval gates) is fixed separately; the dues side is checked without it.
      assert.fail(`commission approval refused: ${JSON.stringify(r.body)}`);
    }
    const [doc] = await env.q(`select status::text as status from simple_invoices where id = $1`, [commissionId]);
    assert.equal(doc.status, "confirmed");
    await drain(env);
    assert.equal(await lp(), "2215.00");
    assert.equal((await dues()).remaining, 2215);
    assertAllZero(await recon());

    const over: any = await attempt(() => env.reports.createPayout(user, { ownerId: owner, amount: 2425, method: "cash", transferDate: today }));
    assert.deepEqual([over.status, over.body?.netDue], [409, "2215.00"]);
    await env.reports.createPayout(user, { ownerId: owner, amount: 2215, method: "cash", transferDate: today });
    await drain(env);
    assert.equal(await lp(), "0.00");
    const d = await dues();
    assert.deepEqual([d.transferred, d.remaining], [2215, 0]);
    assertAllZero(await recon());
    const cash = (await recon()).find((c: any) => c.id === "R4");
    assert.equal(cash.ledger, "210.00", "3,000 in − 575 to the supplier − 2,215 to the landlord: the office's 210 commission is still in the box");
  });

  it("a voided supplier payment and a voided bill drop out of the dues and the cash on both sides", async () => {
    const bill: any = await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, propertyId: propId, chargeTo: "landlord", supplierInvoiceNo: "V-2",
      lines: [{ description: "تنظيف", amount: "100", vatCategory: "S" }],
    });
    await ap.approveBill(U, user, bill.id);
    const pay: any = await ap.createPayment(U, user, { supplierId: sup.id, paidOn: today, amount: "115", method: "cash", allocations: [{ billId: bill.id, amount: "115" }] });
    await drain(env);
    assert.equal((await dues()).remaining, -115, "the landlord now owes the office the 115 bill");
    assertAllZero(await recon());
    await ap.voidPayment(U, user, pay.id, { reason: "bounced" });
    await ap.voidBill(U, user, bill.id, { reason: "entered twice" });
    await drain(env);
    assert.equal((await dues()).remaining, 0);
    assert.equal(await lp(), "0.00");
    assertAllZero(await recon());
  });

  it("an explicit advance (allowAdvance) is accepted and shows as a negative remaining on both sides", async () => {
    await env.reports.createPayout(user, { ownerId: owner, amount: 100, method: "cash", transferDate: today, allowAdvance: true });
    await drain(env);
    assert.equal(await lp(), "-100.00");
    assert.equal((await dues()).remaining, -100);
    assertAllZero(await recon());
  });

  it("flag off: the payout is not checked against the dues (legacy unchanged)", async () => {
    const off = 6312;
    const s = await seedAccount(env, off);
    const r: any = await env.reports.createPayout({ ...userOf(off), permissions: PERMS }, { ownerId: s.agent, amount: 999, method: "cash", transferDate: today });
    assert.equal(r.amount, "999.00");
  });
});
