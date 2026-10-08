import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { InstallmentDocsService } from "../installment-docs.service";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { EmailService } from "../../email/email.service";
import { TaqnyatService } from "../../sms/taqnyat.service";

/**
 * Accountant test (5 Oct 2026) #3 and #6, on a throwaway Postgres with the
 * REAL billing and payments controllers and the v2 hooks, worker and
 * recognizer. ZATCA is stubbed by the harness (counted here, must not move
 * for a rent receipt); every message sender is stubbed and must stay at
 * zero. Synthetic data only (public repo).
 */
const M = 7451; // manager mode: the agent landlord HAS a VAT number (tax invoice path)
const U = 7452; // manager mode: the agent landlord has NO VAT number (rent receipt path)
const F = 7453; // flag off
const today = riyadhToday();
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });

describe("fv2 installments screen: rent receipt for an unregistered landlord (#3), trust account in Manager mode (#6)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let sM: Seed, sU: Seed, sF: Seed;
  let svc: InstallmentDocsService;
  let banks: BankAccountsService;
  const sends = { email: 0, sms: 0, fetch: 0, zatca: 0 };
  const orig = { email: EmailService.prototype.send, sms: TaqnyatService.prototype.send, fetch: globalThis.fetch };

  const drain = async (u: number, asOf = today) => {
    await env.recognizer.runAccount(u, asOf);
    for (let i = 0; i < 10; i++) {
      const r = await env.worker.runAccount(u);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };
  let unitNo = 0;
  /** A monthly contract on a NEW unit of `prop`; its installments re-dated to `dues` (in order), the rest pushed a year out. */
  const contract = async (u: number, s: Seed, prop: number, rent: string, dues: string[]) => {
    const unit = Number((await env.q(`insert into units (property_id, unit_number) values ($1, $2) returning id`, [prop, `T${++unitNo}`]))[0].id);
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1 + 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m - 1 + 13, 0)).toISOString().slice(0, 10);
    const c: any = await env.contracts.create(userFor(u), {
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: start, endDate: end,
      monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: false,
    });
    const ps = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [c.id]);
    for (let i = 0; i < ps.length; i++) {
      await env.q(`update payments set due_date = $2 where id = $1`, [ps[i].id, i < dues.length ? dues[i] : addDays(today, 400 + i * 30)]);
    }
    return { id: Number(c.id), p: ps.map((x: any) => Number(x.id)) };
  };
  const docsFor = (u: number, pid: number) => env.q(
    `select id, number, kind, status::text as status, total::text as total, subtotal::text as subtotal, zatca_status
       from simple_invoices where user_id = $1 and deleted_at is null and type = 'invoice' and coalesce(kind,'invoice') <> 'commission'
        and (payment_id = $2 or coalesce(payment_ids,'[]'::jsonb) @> jsonb_build_array($2::int)) order by id`, [u, pid]);
  /** Net tenant receivable (1121 + 1122) booked for one installment, over its own charge lines and its documents' lines. */
  const arNet = async (u: number, pid: number) => {
    const [r] = await env.q(
      `select coalesce(sum(l.debit - l.credit), 0)::text as n from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.code in ('1121','1122')
          and (l.payment_id = $2 or l.document_id in (
                select id from simple_invoices si where si.user_id = $1 and coalesce(si.kind,'invoice') <> 'commission'
                   and (si.payment_id = $2 or coalesce(si.payment_ids,'[]'::jsonb) @> jsonb_build_array($2::int))))`, [u, pid]);
    return r.n;
  };
  const collect = (u: number, pid: number, body: any) => attempt(() => env.payments.addCollection(userFor(u), String(pid), { amount: 100, collectedDate: today, ...body }));
  const status = (r: any) => (r && typeof r === "object" && "status" in r && typeof r.status === "number" ? r.status : 200);

  before(async () => {
    env = await legacyEnv("wired");
    const origZatca = env.billing.submitApprovedDocToZatca;
    env.billing.submitApprovedDocToZatca = async (...a: any[]) => { sends.zatca++; return origZatca(...a); };
    EmailService.prototype.send = async function () { sends.email++; return false; };
    TaqnyatService.prototype.send = async function () { sends.sms++; return { ok: false } as any; };
    globalThis.fetch = (async () => { sends.fetch++; throw new Error("fv2 spec: no network"); }) as any;

    sM = await seedAccount(env, M);
    await enableV2(env, M, "manager");
    sU = await seedAccount(env, U);
    await env.q(`update owners set tax_number = null where id = $1`, [sU.agent]);
    await enableV2(env, U, "manager");
    sF = await seedAccount(env, F);

    svc = new InstallmentDocsService(env.t.pool as any);
    svc.billing = env.billing;
    banks = new BankAccountsService(env.t.pool as any);
  });
  after(async () => {
    EmailService.prototype.send = orig.email;
    TaqnyatService.prototype.send = orig.sms;
    globalThis.fetch = orig.fetch;
    await env?.t.drop();
  });

  // ─── #3 ────────────────────────────────────────────────────────────────

  it("#3 routes: an unregistered landlord's contract takes the rent receipt, a registered one keeps the tax invoice", async () => {
    const ku = await contract(U, sU, sU.propA, "3000", [addDays(today, 5)]);
    const km = await contract(M, sM, sM.propA, "3000", [addDays(today, 5)]);
    assert.deepEqual((await svc.routes(U, String(ku.id))).rows.map((r) => [r.contractId, r.route, r.vatRegistered]), [[ku.id, "rent_receipt", false]]);
    assert.deepEqual((await svc.routes(M, String(km.id))).rows.map((r) => [r.contractId, r.route, r.vatRegistered]), [[km.id, "tax_invoice", true]]);
    // Another account's contract is simply absent (scope).
    assert.deepEqual((await svc.routes(U, `${km.id}`)).rows, []);
  });

  it("#3 issue: an unregistered landlord's installment becomes a confirmed RR- (no VAT number demanded, never ZATCA), with the commission invoice", async () => {
    const k = await contract(U, sU, sU.propA, "4000", [addDays(today, 3)]);
    const z0 = sends.zatca;
    const r: any = await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] });
    assert.match(r.document.number, /^RR-/);
    assert.equal(r.document.status, "confirmed");
    assert.equal(r.document.kind, "rent_receipt");
    assert.equal(sends.zatca, z0, "a rent receipt never reaches ZATCA");
    const [doc] = await docsFor(U, k.p[0]);
    assert.equal(doc.total, doc.subtotal, "no VAT on a non-tax rent receipt");
    assert.equal(doc.zatca_status, null);
    // The automatic commission invoice (5% on the property), referencing the receipt — the same as the reports path.
    assert.ok(r.commission, "the commission invoice is created");
    assert.equal(r.commission.kind, "commission");
    assert.equal(r.commission.billingReference, r.document.number);
    assert.equal(Number(r.commission.subtotal), 200);
    await drain(U);
    assert.equal(await arNet(U, k.p[0]), "4000.00");
    // A second click / second tab: the installment is already on a document.
    const again: any = await attempt(() => svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] }));
    assert.equal(again.status, 409);
    assert.equal((await docsFor(U, k.p[0])).length, 1);
  });

  it("#3 a past-due installment already accrued by the recognizer is reversed and replaced, never charged twice", async () => {
    const k = await contract(U, sU, sU.propA, "2500", [addDays(today, -3)]);
    await drain(U);
    const [ch] = await env.q(`select charged_by from finance_installment_charges where user_id = $1 and payment_id = $2 order by generation limit 1`, [U, k.p[0]]);
    assert.ok(ch, "the recognizer charged the overdue installment (E02)");
    assert.equal(await arNet(U, k.p[0]), "2500.00");
    const r: any = await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] });
    assert.equal(r.document.status, "confirmed");
    await drain(U);
    assert.equal(await arNet(U, k.p[0]), "2500.00", "the accrual was reversed, not duplicated");
    const [dup] = await env.q(
      `select count(*)::int as n from simple_invoices where user_id = $1 and kind = 'commission' and billing_reference = $2 and deleted_at is null`,
      [U, r.document.number]);
    assert.equal(dup.n, 1, "one commission invoice per receipt");
  });

  it("#3 a registered landlord is refused here (400) and nothing is created: he keeps the tax-invoice flow", async () => {
    const k = await contract(M, sM, sM.propA, "3000", [addDays(today, 2)]);
    const r: any = await attempt(() => svc.issueRentReceipt(M, userFor(M), { paymentIds: [k.p[0]] }));
    assert.equal(r.status, 400);
    assert.equal((r.body as any).error, "FINANCE_V2_SELLER_VAT_REGISTERED");
    assert.equal((await docsFor(M, k.p[0])).length, 0);
    // The legacy create of a tax invoice still works for him, unchanged.
    const doc: any = await env.billing.create(userFor(M), {
      type: "invoice", paymentIds: [k.p[0]], paymentId: k.p[0], contractId: k.id, issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 3000, amount: 3000, vat: false, vatCategory: "E", exemptionReason: "VATEX-SA-30" }],
      total: 3000, tenantId: sM.tenant, tenantName: "Synthetic Tenant",
    });
    assert.equal(doc.kind ?? "invoice", "invoice");
    assert.match(String(doc.number), /^(?!RR-)/);
  });

  it("#3 needs invoices.write", async () => {
    const k = await contract(U, sU, sU.propA, "1000", [addDays(today, 9)]);
    const r: any = await attempt(() => svc.issueRentReceipt(U, { ...userOf(U), permissions: ["payments.view"] }, { paymentIds: [k.p[0]] }));
    assert.equal(r.status, 403);
  });

  // ─── #6 ────────────────────────────────────────────────────────────────

  it("#6 Manager mode: the first enable made the trust account with routing on; the context preselects it; an operating account is refused, with no override", async () => {
    const [trust] = await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default and is_active`, [M]);
    assert.ok(trust, "seeded at the first enable (round 3)");
    const k = await contract(M, sM, sM.propA, "800", [addDays(today, 4)]);
    const ctx = await svc.collectContext(M, k.p[0]);
    assert.equal(ctx.trustRequired, true);
    assert.equal(ctx.trustAccountId, Number(trust.id));
    assert.equal(ctx.treatment, "agent");
    assert.equal(ctx.deposit, false);
    assert.deepEqual(ctx.defaultInTrust, { cash: true, other: true }, "routing on: a collection left on the default lands in trust");

    // Into the main cash box, named: refused, and the old confirmation no longer lets it through.
    const box = (await banks.list(M)).find((b) => b.kind === "cash")!;
    for (const body of [{ method: "cash", bankAccountId: box.id }, { method: "cash", bankAccountId: box.id, trustOverride: true }]) {
      const refused: any = await collect(M, k.p[0], body);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "FINANCE_V2_TRUST_REQUIRED");
      assert.equal(refused.body.trustAccountId, Number(trust.id));
    }
    assert.equal((await env.q(`select count(*)::int as n from payment_collections where payment_id = $1`, [k.p[0]]))[0].n, 0, "nothing written");

    // Cash on the default, and a transfer into the trust account by name: both accepted, both posted to trust.
    assert.equal(status(await collect(M, k.p[0], { method: "cash" })), 200);
    assert.equal(status(await collect(M, k.p[0], { method: "bank_transfer", bankAccountId: Number(trust.id) })), 200);
    await drain(M);
    const [bl] = await env.q(
      `select count(*)::int as n from journal_lines l where l.user_id = $1 and l.bank_account_id = $2 and l.payment_id = $3`, [M, trust.id, k.p[0]]);
    assert.equal(bl.n, 2, "both collections posted to the trust account");
  });

  it("#6 the account holder's own property: its rent is the office's money, but its deposit is the tenant's and goes to trust", async () => {
    const k = await contract(M, sM, sM.propH, "700", [addDays(today, 6)]);
    const ctx = await svc.collectContext(M, k.p[0]);
    assert.equal(ctx.treatment, "principal");
    assert.equal(ctx.trustRequired, false);
    const box = (await banks.list(M)).find((b) => b.kind === "cash")!;
    assert.equal(status(await collect(M, k.p[0], { method: "cash", bankAccountId: box.id })), 200);

    await env.q(`update contracts set deposit_amount = 1200, deposit_status = 'pending' where id = $1`, [k.id]);
    const refused: any = await attempt(() => env.contracts.collectDeposit(userFor(M), String(k.id), { paidDate: today, method: "cash", bankAccountId: box.id }));
    assert.deepEqual([refused.status, refused.body?.error], [409, "FINANCE_V2_TRUST_REQUIRED"]);
    const ok: any = await env.contracts.collectDeposit(userFor(M), String(k.id), { paidDate: today, method: "cash" });
    assert.ok(ok.voucher?.id);
    await drain(M);
    const [l] = await env.q(
      `select b.is_trust from journal_lines l join journal_entries e on e.id = l.entry_id join bank_accounts b on b.id = l.bank_account_id
        where l.user_id = $1 and e.payload->>'rule' = 'E09' and l.document_id = $2 and l.debit > 0`, [M, ok.voucher.id]);
    assert.equal(l?.is_trust, true, "E09 on the account holder's own contract debits the trust account");
  });

  it("#6 a deposit receipt voucher into an operating account is refused; an invoice collection follows the same rule", async () => {
    const k = await contract(M, sM, sM.propA, "650", [addDays(today, 7)]);
    const bank = (await banks.list(M)).find((b) => b.kind === "bank" && !b.isTrust)!;
    const rv: any = await attempt(() => env.billing.createReceiptVoucher(userFor(M), { contractId: k.id, kind: "deposit", amount: 300, paidDate: today, method: "bank_transfer", bankAccountId: bank.id }));
    assert.deepEqual([rv.status, rv.body?.error], [409, "FINANCE_V2_TRUST_REQUIRED"]);
    const ok: any = await attempt(() => env.billing.createReceiptVoucher(userFor(M), { contractId: k.id, kind: "deposit", amount: 300, paidDate: today, method: "bank_transfer" }));
    assert.equal(status(ok), 200);
  });

  it("#6 flag off: the same collection is accepted exactly as before", async () => {
    const k = await contract(F, sF, sF.propA, "600", [addDays(today, 2)]);
    assert.equal(status(await collect(F, k.p[0], { method: "cash" })), 200);
  });

  // ─── #7 ────────────────────────────────────────────────────────────────

  it("#7 the context marks a residential unit (the dialog warns on cash; never blocks)", async () => {
    const [l] = await env.q(`insert into lookups (category, key, label_ar, label_en) values ('property_usage', 'families', 'عائلي', 'Families') returning id`);
    await env.q(`update properties set usage_lookup_id = $1 where id = $2`, [l.id, sU.propA]);
    const k = await contract(U, sU, sU.propA, "1500", [addDays(today, 8)]);
    assert.equal((await svc.collectContext(U, k.p[0])).residential, true);
    await env.q(`update properties set usage_lookup_id = null where id = $1`, [sU.propA]);
  });

  it("no message was sent to anybody by any of the above (email, SMS, push)", () => {
    assert.deepEqual({ email: sends.email, sms: sends.sms, fetch: sends.fetch }, { email: 0, sms: 0, fetch: 0 });
  });
});
