import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, withoutTrust, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { InstallmentDocsService } from "../installment-docs.service";
import { EmailService } from "../../email/email.service";
import { TaqnyatService } from "../../sms/taqnyat.service";

/**
 * C-1 (accountant, 14 Oct 2026): the Collections screen's "invoice number" was
 * "—" for RV-000003 that paid RR-000002. `GET payments/collections-all` took
 * the number from the collection's own invoice_id, which for a voucher is the
 * voucher itself (RV-) and for the installment's own collect is NULL — never
 * the rent receipt covering the installment. Both flows, on the REAL billing
 * and payments controllers, against a throwaway Postgres. Every sender is
 * stubbed and must stay at zero. Synthetic data only (public repo).
 */
const U = 7461; // manager mode, the agent landlord has NO VAT number → rent receipts (RR-)
const F = 7462; // flag off: legacy INV- documents must read exactly as before
const today = riyadhToday();
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });

describe("fv2 C-1: Collections shows the document each collection paid", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let sU: Seed, sF: Seed;
  let svc: InstallmentDocsService;
  const sends = { email: 0, sms: 0, fetch: 0 };
  const orig = { email: EmailService.prototype.send, sms: TaqnyatService.prototype.send, fetch: globalThis.fetch };

  let unitNo = 0;
  /** A monthly contract on a new unit; the first installment due in 3 days, the rest a year out. */
  const contract = async (u: number, s: Seed, rent: string) => {
    const unit = Number((await env.q(`insert into units (property_id, unit_number) values ($1, $2) returning id`, [s.propA, `C${++unitNo}`]))[0].id);
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m + 12, 0)).toISOString().slice(0, 10);
    const c: any = await env.contracts.create(userFor(u), {
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: start, endDate: end,
      monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: false,
    });
    const ps = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [c.id]);
    for (let i = 0; i < ps.length; i++) await env.q(`update payments set due_date = $2 where id = $1`, [ps[i].id, addDays(today, i === 0 ? 3 : 400 + i * 30)]);
    return { id: Number(c.id), number: String(c.contractNumber ?? ""), p: ps.map((x: any) => Number(x.id)) };
  };
  const list = async (u: number, query: Record<string, unknown> = {}) =>
    (await env.payments.listAllCollections(userFor(u), { page: 1, pageSize: 100, ...query })) as { data: any[]; total: number; stats: { totalCollected: number } };
  const byReceipt = async (u: number, receipt: string) => {
    const rows = (await list(u)).data.filter((r) => r.receiptNumber === receipt);
    assert.equal(rows.length, 1, `one Collections row for ${receipt}`);
    return rows[0];
  };

  before(async () => {
    env = await legacyEnv("wired");
    EmailService.prototype.send = async function () { sends.email++; return false; };
    TaqnyatService.prototype.send = async function () { sends.sms++; return { ok: false } as any; };
    globalThis.fetch = (async () => { sends.fetch++; throw new Error("fv2 spec: no network"); }) as any;
    sU = await seedAccount(env, U);
    await env.q(`update owners set tax_number = null where id = $1`, [sU.agent]);
    await enableV2(env, U, "manager");
    await withoutTrust(env, U);
    sF = await seedAccount(env, F);
    svc = new InstallmentDocsService(env.t.pool as any);
    svc.billing = env.billing;
  });
  after(async () => {
    EmailService.prototype.send = orig.email;
    TaqnyatService.prototype.send = orig.sms;
    globalThis.fetch = orig.fetch;
    await env?.t.drop();
  });

  it("(a) RR issued, then its installment collected by a receipt voucher: the row shows RV- as the voucher and RR- as the document", async () => {
    const k = await contract(U, sU, "3000");
    const rr: any = (await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] })).document;
    assert.match(rr.number, /^RR-/);
    const rv: any = await env.billing.createReceiptVoucher(userFor(U), { paymentId: k.p[0], amount: 3000, method: "cash", paidDate: today });
    assert.match(rv.number, /^RV-/);
    // The root cause: the collection is booked on the VOUCHER, not on the RR.
    const [pc] = await env.q(`select invoice_id from payment_collections where payment_id = $1`, [k.p[0]]);
    assert.equal(Number(pc.invoice_id), Number(rv.id));

    const row = await byReceipt(U, rv.number);
    assert.equal(row.invoiceNumber, rr.number);
    assert.equal(Number(row.invoiceId), Number(rr.id));
    assert.equal(Number(row.amount), 3000);
    // The RR's detail modal is fed by GET /simple-invoices/:id — it opens, and reads as collected.
    const doc: any = await env.billing.get(userFor(U), String(row.invoiceId));
    assert.equal(doc.number, rr.number);
    assert.equal(Number(doc.collectedAmount), 3000);
    // Searching by the document number finds the voucher's row.
    const found = await list(U, { search: rr.number });
    assert.deepEqual(found.data.map((r) => r.receiptNumber), [rv.number]);
  });

  it("(a') RR issued, then the installment's own collect (no invoice_id at all): the row still shows the RR", async () => {
    const k = await contract(U, sU, "2000");
    const rr: any = (await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] })).document;
    await env.payments.addCollection(userFor(U), String(k.p[0]), { amount: "2000", collectedDate: today, method: "cash", receiptNumber: "EXT-C1" });
    const [pc] = await env.q(`select invoice_id from payment_collections where payment_id = $1`, [k.p[0]]);
    assert.equal(pc.invoice_id, null);
    const row = await byReceipt(U, "EXT-C1");
    assert.equal(row.invoiceNumber, rr.number);
    assert.equal(Number(row.invoiceId), Number(rr.id));
  });

  it("(b) RR collected on the document itself: the row shows the RR (as before, now also on screen)", async () => {
    const k = await contract(U, sU, "1500");
    const rr: any = (await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] })).document;
    await env.billing.collect(userFor(U), String(rr.id), { method: "cash", paidDate: today });
    const [pc] = await env.q(`select invoice_id, receipt_number from payment_collections where payment_id = $1`, [k.p[0]]);
    assert.equal(Number(pc.invoice_id), Number(rr.id));
    const row = await byReceipt(U, pc.receipt_number);
    assert.match(row.receiptNumber, /^RV-/);
    assert.equal(row.invoiceNumber, rr.number);
    assert.equal(Number(row.invoiceId), Number(rr.id));
  });

  it("a voucher on an installment no document covers has no invoice number (genuinely none)", async () => {
    const k = await contract(U, sU, "1200");
    const rv: any = await env.billing.createReceiptVoucher(userFor(U), { paymentId: k.p[0], amount: 1200, method: "cash", paidDate: today });
    const row = await byReceipt(U, rv.number);
    assert.equal(row.invoiceNumber, null);
    assert.equal(row.invoiceId, null);
  });

  it("a deleted or cancelled document is not reported as the one paid", async () => {
    const k = await contract(U, sU, "1100");
    const rr: any = (await svc.issueRentReceipt(U, userFor(U), { paymentIds: [k.p[0]] })).document;
    const rv: any = await env.billing.createReceiptVoucher(userFor(U), { paymentId: k.p[0], amount: 1100, method: "cash", paidDate: today });
    await env.q(`update simple_invoices set deleted_at = now() where id = $1`, [rr.id]);
    assert.equal((await byReceipt(U, rv.number)).invoiceNumber, null);
    await env.q(`update simple_invoices set deleted_at = null, status = 'cancelled' where id = $1`, [rr.id]);
    assert.equal((await byReceipt(U, rv.number)).invoiceNumber, null);
  });

  it("flag off: INV- collected on the document, INV- via a voucher, and a free invoice — grouping, totals and numbers", async () => {
    const k = await contract(F, sF, "1000");
    // A confirmed legacy tax invoice over installment 1 (inserted directly: approval would reach the ZATCA stub).
    const inv = (n: string, pids: number[], total: number, extra = "") => env.q(
      `insert into simple_invoices (user_id, number, type, status, contract_id, payment_id, payment_ids, tenant_name, items, subtotal, total, issue_date, confirmed_at${extra ? ", paid_date" : ""})
       values ($1, $2, 'invoice', 'confirmed', $3, $4, $5::jsonb, 'Synthetic Tenant', '[]'::jsonb, $6, $6, $7, now()${extra ? ", $7" : ""}) returning id`,
      [F, n, k.id, pids[0] ?? null, JSON.stringify(pids), total.toFixed(2), today]).then((r) => Number(r[0].id));
    const inv1 = await inv("INV-900001", [k.p[0]], 1000);
    await env.billing.collect(userFor(F), String(inv1), { method: "cash", paidDate: today });
    const inv2 = await inv("INV-900002", [k.p[1]], 1000);
    const rv: any = await env.billing.createReceiptVoucher(userFor(F), { paymentId: k.p[1], amount: 1000, method: "cash", paidDate: today });
    // A free invoice: confirmed, collected (paid_date), no installment.
    const free = Number((await env.q(
      `insert into simple_invoices (user_id, number, type, status, contract_id, tenant_name, items, subtotal, total, issue_date, confirmed_at, paid_date)
       values ($1, 'INV-900003', 'invoice', 'confirmed', $2, 'Synthetic Tenant', '[]'::jsonb, 250, 250, $3, now(), $3) returning id`, [F, k.id, today]))[0].id);

    const res = await list(F);
    assert.equal(res.total, 3);
    assert.equal(res.stats.totalCollected, 2250);
    const byNo = new Map(res.data.map((r) => [r.invoiceNumber, r]));
    assert.equal(Number(byNo.get("INV-900001")?.invoiceId), inv1);
    assert.match(byNo.get("INV-900001")?.receiptNumber, /^RV-/);
    assert.equal(Number(byNo.get("INV-900002")?.invoiceId), inv2, "the voucher's row names the invoice it paid");
    assert.equal(byNo.get("INV-900002")?.receiptNumber, rv.number);
    assert.equal(Number(byNo.get("INV-900003")?.invoiceId), free);
    assert.ok(Number(byNo.get("INV-900003")?.id) < 0, "the free-invoice branch keeps its negative id space");
  });

  it("nothing was sent", () => {
    assert.deepEqual(sends, { email: 0, sms: 0, fetch: 0 });
  });
});
