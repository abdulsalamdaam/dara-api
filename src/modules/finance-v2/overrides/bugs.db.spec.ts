import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, normalise, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { effectiveRate } from "../commission";
import { FinanceV2BugsController } from "../controllers/bugs.controller";

/**
 * DESIGN §9 bug decisions on the REAL legacy routes, against a throwaway
 * Postgres (synthetic data only). Three identical fixtures:
 *   ON   finance_v2 on (manager), hooks wired — the fixed behaviour;
 *   OFF  hooks wired, flag off                 — must equal BARE;
 *   BARE no finance-v2 line at all             — the code as it was (pinned).
 * Dates are relative to the real Riyadh today, because the v2 definitions are.
 */
const U = 5301;
const today = riyadhToday();
const firstOf = (monthsFromNow: number) => {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + monthsFromNow, 1));
  return d.toISOString().slice(0, 10);
};
const lastOf = (monthsFromNow: number) => {
  const d = new Date(`${firstOf(monthsFromNow + 1)}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const approver = { ...userOf(U), permissions: ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve"] };

interface Fx {
  s: Seed;
  tenant2: number;
  noVatOwner: number;
  unitA3: number;
  unitN1: number;
  c4: number; // E4/E5: agent, one installment of 6,900 due last month, 3,000 collected today
  c3: number; // E3: principal, two annual installments of 48,000, both due, paid on receipt vouchers
  c8?: number; // E8 (created in the test)
  c7: number; // E7: agent, monthly 1,000, deposit voucher 2,000
  c9: number; // E9: no-VAT landlord
  p4: number;
  p7: number[];
  p9: number;
}

async function fixtures(env: LegacyEnv): Promise<Fx> {
  const s = await seedAccount(env, U);
  const user = userOf(U);
  const one = async (sql: string, p: unknown[]) => Number((await env.q(sql, p))[0].id);
  // E1: the landlord carries the fee, the property does not.
  await env.q(`update owners set management_fee_percent = 5 where id = $1`, [s.agent]);
  await env.q(`update properties set management_fee_percent = null where id = $1`, [s.propA]);
  const tenant2 = await one(`insert into tenants (user_id, name, email, phone, national_id, type) values ($1, 'Synthetic Tenant Two', 'tenant2-${U}@example.test', '0500000002', '20000${U}', 'individual') returning id`, [U]);
  const noVatOwner = await one(
    `insert into owners (user_id, name, email, phone, id_number, is_account_holder, type) values ($1, 'Synthetic Individual', 'ind-${U}@example.test', '0500000003', '1000000${U}', false, 'individual') returning id`, [U]);
  const propN = await one(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic House', $2) returning id`, [U, noVatOwner]);
  const unitA3 = await one(`insert into units (property_id, unit_number) values ($1, 'A3') returning id`, [s.propA]);
  const unitN1 = await one(`insert into units (property_id, unit_number) values ($1, 'N1') returning id`, [propN]);

  const c4: any = await env.contracts.create(user, {
    unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-1), endDate: lastOf(-1),
    monthlyRent: "6000", paymentFrequency: "monthly", vatEnabled: true,
  });
  const [p4] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date`, [c4.id]);
  await env.payments.addCollection(user, String(p4.id), { amount: "3000", collectedDate: today, method: "cash" });

  const c3: any = await env.contracts.create(user, {
    unitIds: [s.unitH1], tenantId: tenant2, tenantName: "Synthetic Tenant Two", startDate: "2024-06-01", endDate: "2026-05-31",
    monthlyRent: "4000", paymentFrequency: "annual", vatEnabled: false,
  });
  await env.billing.createReceiptVoucher(user, { contractId: c3.id, amount: 96000, paidDate: "2025-06-02", countAsCollection: true });

  const c7: any = await env.contracts.create(user, {
    unitIds: [unitA3], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-2), endDate: lastOf(3),
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
    depositAmount: "2000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: firstOf(-2),
  });
  const p7 = (await env.q(`select id from payments where contract_id = $1 and deleted_at is null and description is null order by due_date`, [c7.id])).map((r: any) => Number(r.id));
  await env.payments.addCollection(user, String(p7[0]), { amount: "400", collectedDate: firstOf(-2), method: "cash" });

  const c9: any = await env.contracts.create(user, {
    unitIds: [unitN1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(0),
    monthlyRent: "3000", paymentFrequency: "monthly", vatEnabled: false, landlordName: "Synthetic Individual",
  });
  const [p9] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date`, [c9.id]);
  return { s, tenant2, noVatOwner, unitA3, unitN1, c4: c4.id, c3: c3.id, c7: c7.id, c9: c9.id, p4: Number(p4.id), p7, p9: Number(p9.id) };
}

async function drain(env: LegacyEnv) {
  await env.recognizer.runAccount(U);
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

async function entryLines(env: LegacyEnv, sourceType: string, sourceId: number, event: string) {
  return env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit from ledger_outbox o
       join journal_entries e on e.id = o.entry_id join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4 order by l.line_no`,
    [U, sourceType, sourceId, event],
  );
}

describe("fv2 E1 effective rate (pure)", () => {
  it("property if not null (0 is a real 0), else landlord, else none", () => {
    assert.deepEqual(effectiveRate(null, "5"), { pct: "5.00", source: "landlord" });
    assert.deepEqual(effectiveRate("0", "5"), { pct: "0.00", source: "property" });
    assert.deepEqual(effectiveRate("2.5", "5"), { pct: "2.50", source: "property" });
    assert.deepEqual(effectiveRate(null, null), { pct: null, source: null });
  });
});

describe("fv2 §9 bug decisions on the real legacy routes (real Postgres)", { skip: fv2DbSkip }, () => {
  let on: LegacyEnv, off: LegacyEnv, bare: LegacyEnv;
  let fOn: Fx, fOff: Fx, fBare: Fx;
  const user = userOf(U);
  const ctl = (env: LegacyEnv) => new FinanceV2BugsController(env.t.pool as any, env.emitter);
  const req = (u: any = approver) => ({ user: u }) as any;

  before(async () => {
    [on, off, bare] = [await legacyEnv("wired"), await legacyEnv("wired"), await legacyEnv("none")];
    await enableV2(on, U, "manager");
    fOn = await fixtures(on);
    fOff = await fixtures(off);
    fBare = await fixtures(bare);
    await drain(on);
  });

  after(async () => {
    for (const e of [on, off, bare]) await e?.t.drop();
  });

  // ── Flag off equals bare on every read the forks touch ───────────────────
  it("flag off: /payments, /dashboard/summary and /reports/accounting equal the code with no v2 line", async () => {
    for (const q of [{ page: "1", pageSize: "50" }, { status: "overdue", page: "1" }, {}]) {
      assert.deepEqual(normalise(await off.payments.list(user, q)), normalise(await bare.payments.list(user, q)), JSON.stringify(q));
    }
    assert.deepEqual(normalise(await off.dashboard.summary(user)), normalise(await bare.dashboard.summary(user)));
    assert.deepEqual(normalise(await off.reports.accounting(user)), normalise(await bare.reports.accounting(user)));
    void fOff;
  });

  // ── E4 ───────────────────────────────────────────────────────────────────
  it("E4: a part-paid installment past due is overdue for its remaining; list, stats, dashboard and arrears agree", async () => {
    const legacyList: any = await bare.payments.list(user, { contractIds: String(fBare.c4), page: "1" });
    assert.equal(legacyList.data[0].status, "partially_paid", "legacy pinned");
    assert.equal(legacyList.stats.overdue, 0, "legacy pinned");
    const v2: any = await on.payments.list(user, { contractIds: String(fOn.c4), page: "1" });
    assert.equal(v2.data[0].status, "overdue");
    assert.equal(v2.data[0].remaining, 3900);
    assert.equal(v2.stats.overdue, 3900);
    assert.equal(v2.stats.overdueCount, 1);
    const tab: any = await on.payments.list(user, { status: "overdue", contractIds: String(fOn.c4), page: "1" });
    assert.deepEqual(tab.data.map((r: any) => r.id), [fOn.p4], "the overdue tab lists it");
    const all: any = await on.payments.list(user, { page: "1", pageSize: "200" });
    const acc: any = await on.reports.accounting(user);
    const arrears = acc.tenantOverdue.reduce((a: number, r: any) => a + r.amount, 0);
    assert.equal(Math.round(arrears * 100), Math.round(all.stats.overdue * 100), "list-stats overdue = arrears report total");
    const dash: any = await on.dashboard.summary(user);
    assert.equal(Math.round(dash.overdueAmount * 100), Math.round(all.stats.overdue * 100), "dashboard = list");
  });

  // ── E2 ───────────────────────────────────────────────────────────────────
  it("E2: the v2 dashboard counts collections this Riyadh month (legacy counts only rows stored paid)", async () => {
    const legacy: any = await bare.dashboard.summary(user);
    const v2: any = await on.dashboard.summary(user);
    const [thisMonth] = await on.q(
      `select coalesce(sum(pc.amount), 0)::numeric as s from payment_collections pc left join payments p on p.id = pc.payment_id
        where pc.user_id = $1 and to_char(pc.collected_date,'YYYY-MM') = $2 and (p.id is null or coalesce(p.description,'') <> 'تأمين (وديعة)')`,
      [U, today.slice(0, 7)]);
    assert.ok(Number(thisMonth.s) >= 3000);
    assert.equal(v2.monthlyRevenue, Number(thisMonth.s));
    assert.equal(v2.monthlyRevenueBasis, "collections");
    assert.equal(v2.revenueByMonth.months[Number(today.slice(5, 7)) - 1], Number(thisMonth.s));
    assert.notEqual(legacy.monthlyRevenue, v2.monthlyRevenue, "legacy pinned: the 3,000 partial is not revenue there");
    assert.deepEqual(Object.keys(legacy).filter((k) => !(k in v2)), [], "same shape (v2 only adds)");
  });

  // ── E3 ───────────────────────────────────────────────────────────────────
  it("E3: a tenant paid on receipt vouchers with no invoice nets to 0 under v2 (legacy −96,000)", async () => {
    const row = (r: any, t: number) => r.tenantStatement.find((x: any) => x.tenantId === t);
    const legacy = row(await bare.reports.accounting(user), fBare.tenant2);
    assert.equal(legacy.balance, -96000, "legacy pinned");
    const v2 = row(await on.reports.accounting(user), fOn.tenant2);
    assert.equal(v2.invoiced, 96000);
    assert.equal(v2.collected, 96000);
    assert.equal(v2.balance, 0);
  });

  // ── E1 ───────────────────────────────────────────────────────────────────
  // The account holder is VAT-registered but not linked to ZATCA here (only the agent landlord is). Its agency fee is drafted
  // without VAT (§9 E8); its commission is a 15% tax invoice held as a draft until the link exists (accountant review,
  // 7 Oct 2026; the linked case is billing-docs.db.spec).
  it("E1: approving a 6,900 rent invoice under v2 creates a COM draft of 300 + 15% (held: the account is not ZATCA-linked) from the landlord's 5%; legacy creates none", async () => {
    const mk = async (env: LegacyEnv, f: Fx) => {
      const inv: any = await env.billing.create(user, {
        type: "invoice", paymentIds: [f.p4], issueDate: today,
        items: [{ description: "إيجار", quantity: 1, unitPrice: 6000, amount: 6000, vat: true }], total: 6900,
      });
      return env.billing.approve(user, String(inv.id), { confirmations: { tenantNoVat: true } });
    };
    const legacy: any = await mk(bare, fBare);
    assert.equal(legacy.commission, null, "legacy pinned: the property has no rate, so 0%");
    const v2: any = await mk(on, fOn);
    assert.ok(v2.commission, "v2 commission created");
    assert.equal(v2.commission.kind, "commission");
    assert.equal(v2.commission.status, "draft");
    assert.equal(v2.commission.subtotal, "300.00");
    assert.equal(v2.commission.total, "345.00");
    assert.match(v2.commission.notes, /from landlord/);
    const rate: any = await ctl(on).contractRate(req(), String(fOn.c4));
    assert.deepEqual([rate.pct, rate.source], ["5.00", "landlord"]);
    const acc: any = await on.reports.accounting(user);
    const rev = acc.revenue.find((r: any) => r.propertyId === fOn.s.propA);
    assert.deepEqual([rev.commissionPct, rev.commissionSource], [5, "landlord"]);

    // E36: a 1,150 credit note on that invoice (1,000 of its 6,000 rent) drafts a commission credit of 50 once the COM is confirmed.
    const held: any = await attempt(() => on.billing.approve(user, String(v2.commission.id), {}));
    assert.equal(held.status, 409, "the commission tax invoice is held until the office is linked");
    // E36 only needs a confirmed COM: the draft is made a non-tax document by hand (what a non-registered office drafts).
    await on.q(`update simple_invoices set total = subtotal, items = jsonb_build_array(items->0 || '{"vat":false,"vatCategory":"O"}'::jsonb) where id = $1`, [v2.commission.id]);
    await on.billing.approve(user, String(v2.commission.id), {});
    const crn: any = await on.billing.create(user, {
      type: "credit", billingReference: v2.number, issueDate: today,
      items: [{ description: "خصم", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], total: 1150,
    });
    await on.billing.approve(user, String(crn.id), {});
    const [cc] = await on.q(
      `select type::text as type, kind, status::text as status, subtotal::text as subtotal, total::text as total, billing_reference
         from simple_invoices where user_id = $1 and type = 'credit' and kind = 'commission' and notes like $2`, [U, `%${crn.number}%`]);
    assert.deepEqual([cc?.status, cc?.subtotal, cc?.total, cc?.billing_reference], ["draft", "50.00", "50.00", v2.commission.number]);
  });

  // ── E5 ───────────────────────────────────────────────────────────────────
  it("E5: the contract summary counts partial collections", async () => {
    const f = fOn;
    const out: any = await ctl(on).summary(req(), String(f.c7));
    // c7: the first installment 1,000 with 400 collected; deposit 2,000 held.
    assert.equal(out.collected, "400.00");
    assert.equal(out.depositHeld, "2000.00");
    const s4: any = await ctl(on).summary(req(), String(f.c4));
    assert.equal(s4.collected, "3000.00");
    assert.equal(s4.overdue, "3900.00");
    assert.deepEqual([s4.commission.pct, s4.commission.source], ["5.00", "landlord"]);
    assert.equal((await attempt(() => ctl(on).summary(req(), "999999")) as any).status, 404);
  });

  // ── E9 ───────────────────────────────────────────────────────────────────
  it("E9: a no-VAT landlord gets a non-tax rent receipt, approved without ZATCA and posted; a VAT-registered landlord is refused", async () => {
    const rr: any = await ctl(on).rentReceipt(req(), { paymentIds: [fOn.p9] });
    assert.equal(rr.kind, "rent_receipt");
    assert.match(rr.number, /^RR-\d{6}$/);
    assert.equal((await on.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = $2 and entity_id = $3`, [U, "finance_v2_rent_receipt", String(rr.id)]))[0].n, 1, "audited");
    assert.equal(rr.total, "3000.00");
    const ok: any = await on.billing.approve(user, String(rr.id), {});
    assert.equal(ok.status, "confirmed");
    assert.equal(ok.zatcaStatus, null);
    assert.equal(ok.zatca, null);
    await drain(on);
    const lines = await entryLines(on, "simple_invoice", rr.id, "confirmed");
    assert.ok(lines.length >= 2, "E08 posted");
    const vatReg: any = await attempt(() => ctl(on).rentReceipt(req(), { paymentIds: [fOn.p7[4]] }));
    assert.equal(vatReg.status, 400);
    assert.equal(vatReg.body.error, "FINANCE_V2_SELLER_VAT_REGISTERED");
    // Legacy: a tax invoice for the no-VAT landlord is still blocked at approval (pinned).
    const inv: any = await bare.billing.create(user, { type: "invoice", paymentIds: [fBare.p9], issueDate: today, items: [{ description: "إيجار", quantity: 1, unitPrice: 3000, amount: 3000 }], total: 3000 }).catch((e: any) => e);
    const blocked: any = inv?.id ? await attempt(() => bare.billing.approve(user, String(inv.id), {})) : { status: 400 };
    assert.equal(blocked.status, 400);
  });

  // ── EX-4 ─────────────────────────────────────────────────────────────────
  it("EX-4: with the flag off a v2 document kind is refused by the legacy approve and skipped by ZATCA submission", async () => {
    const [d] = await off.q(
      `insert into simple_invoices (user_id, number, type, kind, status, subtotal, total, items) values ($1, 'RR-900001', 'invoice', 'rent_receipt', 'draft', 10, 10, '[]') returning id`, [U]);
    const r: any = await attempt(() => off.billing.approve(user, String(d.id), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "FINANCE_V2_KIND_REQUIRES_V2");
    const z: any = await off.billing.runZatcaSubmission(U, { id: d.id, kind: "agency_fee", contractId: null, number: "AGF-900001" });
    assert.equal(z.code, "skipped");
    const [n] = await off.q(`select count(*)::int as n from invoices`);
    assert.equal(n.n, 0);
  });

  // ── EX-3 ─────────────────────────────────────────────────────────────────
  it("EX-3: an expense or payout naming another account's landlord or property is refused (all flag states)", async () => {
    for (const env of [bare, off]) await env.q(`insert into users (id, email, password_hash, name) values (99991, 'foreign-99991@example.test', 'x', 'Foreign Co')`);
    const [fo] = await bare.q(`insert into owners (user_id, name, type) values (99991, 'Foreign Landlord', 'individual') returning id`);
    const [fp] = await bare.q(`insert into properties (user_id, name, owner_id) values (99991, 'Foreign Property', $1) returning id`, [fo.id]);
    for (const env of [bare, off]) {
      const [o2] = env === bare ? [fo] : await env.q(`insert into owners (user_id, name, type) values (99991, 'Foreign Landlord', 'individual') returning id`);
      const [p2] = env === bare ? [fp] : await env.q(`insert into properties (user_id, name, owner_id) values (99991, 'Foreign Property', $1) returning id`, [o2.id]);
      const f = env === bare ? fBare : fOff;
      const e1: any = await attempt(() => env.reports.createExpense(user, { ownerId: f.s.agent, propertyId: p2.id, category: "صيانة", amount: 10, expenseDate: today }));
      assert.equal(e1.status, 400, "foreign property");
      const e2: any = await attempt(() => env.reports.createExpense(user, { ownerId: o2.id, propertyId: f.s.propA, category: "صيانة", amount: 10, expenseDate: today }));
      assert.equal(e2.status, 400, "foreign landlord");
      const e3: any = await attempt(() => env.reports.createPayout(user, { ownerId: o2.id, amount: 10, transferDate: today }));
      assert.equal(e3.status, 400, "foreign payout landlord");
      const ok: any = await env.reports.createExpense(user, { ownerId: f.s.agent, propertyId: f.s.propA, category: "صيانة", amount: 10, expenseDate: today });
      assert.ok(ok.id, "own ids still pass");
    }
  });

  // ── E8 ───────────────────────────────────────────────────────────────────
  it("E8: a contract with an agency fee gets one AGF draft of 2,500 (not a tax invoice: the account is not ZATCA-linked) under v2; approving posts Dr 1121 2,500 / Cr 4220 2,500", async () => {
    const mk = async (env: LegacyEnv, f: Fx) => {
      await env.q(`insert into units (property_id, unit_number) values ($1, 'A9')`, [f.s.propA]);
      const [u] = await env.q(`select id from units where unit_number = 'A9' and property_id = $1`, [f.s.propA]);
      return env.contracts.create(user, {
        unitIds: [u.id], tenantId: f.s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(1), endDate: lastOf(12),
        monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, agencyFee: "2500",
      });
    };
    const cb: any = await mk(bare, fBare);
    const [nb] = await bare.q(`select count(*)::int as n from simple_invoices where contract_id = $1 and kind = 'agency_fee'`, [cb.id]);
    assert.equal(nb.n, 0, "legacy pinned: never billed");
    const c: any = await mk(on, fOn);
    const docs = await on.q(`select id, number, status::text as status, subtotal::text as subtotal, total::text as total from simple_invoices where contract_id = $1 and kind = 'agency_fee'`, [c.id]);
    assert.equal(docs.length, 1);
    assert.match(docs[0].number, /^AGF-\d{6}$/);
    assert.deepEqual([docs[0].status, docs[0].subtotal, docs[0].total], ["draft", "2500.00", "2500.00"]);
    const again: any = await ctl(on).agencyFee(req(), String(c.id));
    assert.equal(again.id, docs[0].id, "idempotent");
    assert.equal((await on.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_agency_fee' and entity_id = $2`, [U, String(docs[0].id)]))[0].n, 0,
      "the idempotent repeat of a draft the contract hook made writes no row");
    const ap: any = await on.billing.approve(user, String(docs[0].id), {});
    assert.equal(ap.status, "confirmed");
    assert.equal(ap.zatca, null);
    await drain(on);
    assert.deepEqual((await entryLines(on, "simple_invoice", docs[0].id, "confirmed")).map((l: any) => [l.code, l.debit, l.credit]), [
      ["1121", "2500.00", "0.00"], ["4220", "0.00", "2500.00"],
    ]);
    const unbilled: any = await ctl(on).unbilled(req());
    assert.ok(!unbilled.rows.some((r: any) => r.contractId === c.id));
    // Collected under the agent landlord's contract, the fee is still the account's own: it clears 1121 into cash,
    // never 1122/2122/2121 (which would pay the landlord the manager's fee).
    await on.billing.collect(approver, String(docs[0].id), { method: "cash", paidDate: today });
    await drain(on);
    const [pc] = await on.q(`select id from payment_collections where invoice_id = $1`, [docs[0].id]);
    assert.deepEqual((await entryLines(on, "payment_collection", pc.id, "collected")).map((l: any) => [l.code, l.debit, l.credit]), [
      ["1111", "2500.00", "0.00"], ["1121", "0.00", "2500.00"],
    ]);
    // A POST that does create the draft (here after the first one is soft-deleted) is audited.
    await on.q(`update simple_invoices set deleted_at = now() where id = $1`, [docs[0].id]);
    const fresh: any = await ctl(on).agencyFee(req(), String(c.id));
    assert.notEqual(fresh.id, docs[0].id);
    assert.equal((await on.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_agency_fee' and entity_id = $2`, [U, String(fresh.id)]))[0].n, 1);
    await on.q(`update simple_invoices set deleted_at = now() where id = $1`, [fresh.id]);
    await on.q(`update simple_invoices set deleted_at = null where id = $1`, [docs[0].id]);
  });

  // ── E7 ───────────────────────────────────────────────────────────────────
  it("E7: terminate under v2 needs a disposition for every open installment; nothing is written without one", async () => {
    const before = await on.q(`select id, status::text as status from payments where contract_id = $1 order by id`, [fOn.c7]);
    const r: any = await attempt(() => on.contracts.terminate(approver, String(fOn.c7), {}));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "FINANCE_V2_DISPOSITION_REQUIRED");
    assert.ok(r.body.openInstallments.length >= 5);
    assert.deepEqual(await on.q(`select id, status::text as status from payments where contract_id = $1 order by id`, [fOn.c7]), before);
    const [ct] = await on.q(`select status::text as status from contracts where id = $1`, [fOn.c7]);
    assert.equal(ct.status, "active");
    const noCap: any = await attempt(() => on.contracts.terminate(user, String(fOn.c7), {
      dispositions: [{ paymentId: fOn.p7[0], action: "write_off" }], mode: "cancelled",
    }));
    assert.equal(noCap.status, 403, "write-off needs the approve capability");
  });

  it("E7: two terminate requests at once (a double-click) collect each open installment once", async () => {
    const [u] = await on.q(`insert into units (property_id, unit_number) values ($1, 'R1') returning id`, [fOn.s.propA]);
    const c: any = await on.contracts.create(user, {
      unitIds: [u.id], tenantId: fOn.s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-3), endDate: lastOf(2),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
    });
    const open = await on.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date`, [c.id]);
    const body = () => ({ dispositions: open.map((p: any) => ({ paymentId: p.id, action: "collect", method: "cash", date: today })) });
    for (let round = 0; round < 3; round++) {
      await Promise.allSettled([on.contracts.terminate(approver, String(c.id), body()), on.contracts.terminate(approver, String(c.id), body())]);
    }
    const per = await on.q(`select p.id, count(pc.id)::int as n, coalesce(sum(pc.amount), 0)::text as amt from payments p
                              left join payment_collections pc on pc.payment_id = p.id where p.contract_id = $1 and p.deleted_at is null group by p.id order by p.id`, [c.id]);
    assert.deepEqual(per.map((r: any) => [r.n, r.amt]), open.map(() => [1, "1000.00"]), "never collected twice");
  });

  it("E7: write off / collect / cancel, then the deposit refund is recorded as a payment voucher", async () => {
    const [p0, p1, ...rest] = fOn.p7;
    const res: any = await on.contracts.terminate(approver, String(fOn.c7), {
      mode: "cancelled", deposit: "refund", refundMethod: "bank_transfer",
      dispositions: [
        { paymentId: p0, action: "write_off", reason: "tenant left" },
        { paymentId: p1, action: "collect", date: today, method: "cash" },
      ],
    });
    assert.equal(res.success, true);
    const st = new Map((await on.q(`select id, status::text as status from payments where contract_id = $1`, [fOn.c7])).map((r: any) => [Number(r.id), r.status]));
    assert.equal(st.get(p0), "cancelled");
    assert.equal(st.get(p1), "paid");
    for (const p of rest) assert.equal(st.get(p), "cancelled");
    const [w] = await on.q(`select amount::text as amount, payment_ids from finance_write_offs where contract_id = $1`, [fOn.c7]);
    assert.equal(w.amount, "600.00");
    const [dr] = await on.q(`select number, amount::text as amount, voucher_ids from finance_deposit_refunds where contract_id = $1`, [fOn.c7]);
    assert.match(dr.number, /^RFND-\d{4}$/);
    assert.equal(dr.amount, "2000.00");
    await drain(on);
    const [wid] = await on.q(`select id from finance_write_offs where contract_id = $1`, [fOn.c7]);
    assert.deepEqual((await entryLines(on, "write_off", Number(wid.id), "posted")).map((l: any) => [l.code, l.debit, l.credit]), [
      ["2122", "600.00", "0.00"], ["1122", "0.00", "600.00"],
    ], "agent: the landlord bears it");
    const [skip] = await on.q(`select status, skip_reason from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event = 'charge_cancelled'`, [U, p0]);
    assert.deepEqual([skip?.status, skip?.skip_reason], ["skipped", "written_off"], "E05 never clears the written-off AR twice");
    const refunds: any = await ctl(on).depositRefunds(req(), String(fOn.c7));
    assert.equal(refunds.rows[0].amount, "2000.00");
    const [bad] = await on.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]);
    assert.equal(bad.n, 0, "nothing failed to post");
  });

  it("E7: a standalone write-off clears the remaining of a charged installment; mark-as-paid stays refused", async () => {
    const r: any = await ctl(on).writeOffs(req(), { paymentIds: [fOn.p4], reason: "synthetic" });
    assert.deepEqual(r.writeOffs.map((w: any) => [w.paymentId, w.amount]), [[fOn.p4, "3900.00"]]);
    assert.equal((await on.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = $2 and entity_id = $3`, [U, "finance_v2_write_off", String(r.writeOffs[0].id)]))[0].n, 1, "audited");
    const again: any = await attempt(() => ctl(on).writeOffs(req(), { paymentIds: [fOn.p4], reason: "synthetic" }));
    assert.equal(again.status, 409, "nothing left to write off");
    await drain(on);
    const v2: any = await on.payments.list(user, { contractIds: String(fOn.c4), page: "1" });
    assert.equal(v2.stats.overdue, 0);
    const paid: any = await attempt(() => on.contracts.terminate(approver, String(fOn.c9), { mode: "paid" }));
    assert.equal(paid.status, 409);
  });
});
