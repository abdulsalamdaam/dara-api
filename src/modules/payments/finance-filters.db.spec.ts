import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../finance-v2/__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, withoutTrust, type LegacyEnv, type Seed } from "../finance-v2/__tests__/legacy-env";
import { riyadhToday } from "../finance-v2/dates";

/**
 * The finance lists' filters, pages and cards (pagination audit, Oct 2026), on
 * the REAL payments and billing controllers against a throwaway Postgres.
 * Synthetic data only (public repo).
 *
 *  - `contractIds=0` (the portal's "nothing matches") returns nothing — it used
 *    to be dropped, and Invoices / Receipts / Collections showed everything.
 *  - Property / unit / landlord / tenant filters resolve to contracts in SQL,
 *    by id, so two same-name properties and every property's "Unit 1" stay apart.
 *  - Each installment row names the invoice already covering it.
 *  - Receipt-voucher cards count and sum exactly the rows of the list.
 *  - Settlement keeps credit and debit notes apart.
 *  - Customers are grouped in SQL with the old identifier precedence, and
 *    "billed" leaves out drafts and vouchers.
 */
const L = 7701; // legacy (flag off)
const V = 7702; // finance v2 on
const today = riyadhToday();
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });

describe("finance lists: filters by id, contractIds=0, per-row invoices, honest cards", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed, sv: Seed;
  // Two properties with the SAME name and each a "Unit 1" — the case name matching merged.
  let twinProp: number, twinUnit: number;
  let kA1: { id: number; p: number[] }, kTwin: { id: number; p: number[] }, kH: { id: number; p: number[] };

  const contract = async (u: number, unitId: number, rent: string, tenantId: number | null) => {
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m + 10, 0)).toISOString().slice(0, 10);
    const c: any = await env.contracts.create(userFor(u), {
      unitIds: [unitId], tenantId, tenantName: "Synthetic Tenant", startDate: start, endDate: end,
      monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: false,
    });
    const ps = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [c.id]);
    return { id: Number(c.id), p: ps.map((x: any) => Number(x.id)) };
  };
  const pay = (u: number, q: Record<string, unknown>) => env.payments.list(userFor(u), { page: "1", pageSize: "200", ...q });
  const docs = (u: number, q: Record<string, unknown>) => env.billing.list(userFor(u), { page: "1", pageSize: "200", ...q });
  const colls = (u: number, q: Record<string, unknown>) => env.payments.listAllCollections(userFor(u), { page: "1", pageSize: "200", ...q });

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, L);
    // A second "Synthetic Tower" with its own unit "A1".
    twinProp = Number((await env.q(`insert into properties (user_id, name, owner_id) values ($1, 'Synthetic Tower', $2) returning id`, [L, s.holder]))[0].id);
    twinUnit = Number((await env.q(`insert into units (property_id, unit_number) values ($1, 'A1') returning id`, [twinProp]))[0].id);
    kA1 = await contract(L, s.unitA1, "1000", s.tenant);
    kTwin = await contract(L, twinUnit, "2000", null);
    kH = await contract(L, s.unitH1, "3000", null);
    sv = await seedAccount(env, V);
    await enableV2(env, V, "manager");
    await withoutTrust(env, V);
  });
  after(async () => { await env?.t.drop(); });

  it("contractIds=0 (and an id past int4) matches nothing on every list, cards included", async () => {
    // Something to find, so "nothing" is not trivially true.
    await env.payments.addCollection(userFor(L), String(kA1.p[0]), { amount: "1000", collectedDate: today, method: "cash", receiptNumber: "EXT-Z1" });
    for (const contractIds of ["0", "abc", "99999999999"]) {
      const p: any = await pay(L, { contractIds });
      assert.equal(p.total, 0, `payments ${contractIds}`);
      assert.equal(p.stats.paidCount + p.stats.pendingCount + p.stats.overdueCount + p.stats.partiallyPaidCount, 0);
      assert.equal(p.stats.collected, 0);
      const d: any = await docs(L, { contractIds });
      assert.equal(d.total, 0, `simple-invoices ${contractIds}`);
      const c: any = await colls(L, { contractIds });
      assert.equal(c.total, 0, `collections ${contractIds}`);
      assert.equal(c.stats.totalCollected, 0);
      const v: any = await pay(V, { contractIds });
      assert.equal(v.total, 0, `v2 payments ${contractIds}`);
    }
    // And no filter at all still lists everything.
    assert.ok(((await pay(L, {})) as any).total > 0);
    assert.ok(((await colls(L, {})) as any).total > 0);
  });

  it("property / unit / landlord / tenant filters go by id, not name", async () => {
    const contractsOf = async (q: Record<string, unknown>) =>
      [...new Set(((await pay(L, q)) as any).data.map((r: any) => Number(r.contractId)))].sort();
    assert.deepEqual(await contractsOf({ propertyId: String(s.propA) }), [kA1.id]);
    assert.deepEqual(await contractsOf({ propertyId: String(twinProp) }), [kTwin.id]);
    assert.deepEqual(await contractsOf({ unitId: String(twinUnit) }), [kTwin.id]);
    assert.deepEqual(await contractsOf({ ownerId: String(s.holder) }), [kTwin.id, kH.id].sort());
    assert.deepEqual(await contractsOf({ tenantId: String(s.tenant) }), [kA1.id]);
    // Combined filters must all hold.
    assert.deepEqual(await contractsOf({ ownerId: String(s.holder), unitId: String(s.unitH1) }), [kH.id]);
    assert.deepEqual(await contractsOf({ propertyId: String(s.propA), unitId: String(twinUnit) }), []);
    // Another account's ids match nothing.
    assert.deepEqual(await contractsOf({ propertyId: String(sv.propA) }), []);
    // The page of rows agrees with the filter.
    const v: any = await pay(L, { propertyId: String(twinProp) });
    assert.ok(v.data.every((r: any) => r.contractId === kTwin.id));
    // Cards follow the filter (the rows' contracts only).
    const all: any = await pay(L, { contractIds: String(kTwin.id) });
    const byProp: any = await pay(L, { propertyId: String(twinProp) });
    assert.deepEqual(byProp.stats, all.stats);
    const n = (st: any) => st.paidCount + st.pendingCount + st.overdueCount + st.partiallyPaidCount + st.cancelledCount;
    assert.equal(n(byProp.stats), byProp.total);
    assert.equal(n(((await pay(L, { tenantId: String(s.tenant) })) as any).stats), kA1.p.length);
    // The cards of the simple-invoice and collections lists follow it too.
    assert.equal(((await docs(L, { propertyId: String(twinProp) })) as any).total, 0);
  });

  it("each installment row names the invoice already covering it; vouchers and cancelled ones do not count", async () => {
    const [p1, p2, p3] = kA1.p.slice(6, 9);
    const inv: any = await env.billing.create(userFor(L), {
      type: "invoice", contractId: kA1.id, paymentIds: [p1, p2], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 2000, amount: 2000, vat: false }], total: 2000,
    });
    const rows = ((await pay(L, { contractIds: String(kA1.id), order: "asc" })) as any).data;
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    assert.equal((byId.get(p1) as any).invoice?.number, inv.number);
    assert.equal((byId.get(p2) as any).invoice?.id, Number(inv.id));
    assert.equal((byId.get(p3) as any).invoice, null);
    await env.q(`update simple_invoices set status = 'cancelled' where id = $1`, [inv.id]);
    const after = ((await pay(L, { contractIds: String(kA1.id) })) as any).data;
    assert.ok([p1, p2].every((id) => after.find((r: any) => r.id === id).invoice === null));
    // A receipt voucher on an installment is evidence of money, not its invoice.
    await env.q(`update simple_invoices set kind = 'receipt' where id = $1`, [inv.id]);
    assert.equal(((await pay(L, { contractIds: String(kA1.id) })) as any).data.find((r: any) => r.id === p1).invoice, null);
    await env.q(`update simple_invoices set kind = null where id = $1`, [inv.id]);
    await env.q(`update simple_invoices set status = 'draft' where id = $1`, [inv.id]);
  });

  it("sort=paidDate puts the latest collected first, ties by id", async () => {
    await env.payments.addCollection(userFor(L), String(kTwin.p[0]), { amount: "2000", collectedDate: addDays(today, -5), method: "cash" });
    await env.payments.addCollection(userFor(L), String(kTwin.p[1]), { amount: "2000", collectedDate: today, method: "cash" });
    const rows = ((await pay(L, { contractIds: String(kTwin.id), statusIn: "paid", sort: "paidDate", order: "desc" })) as any).data;
    const dates = rows.map((r: any) => r.paidDate);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(rows[0].id, kTwin.p[1]);
  });

  it("the Upcoming card's part-paid figure is what is still owed", async () => {
    await env.payments.addCollection(userFor(L), String(kA1.p[1]), { amount: "400", collectedDate: today, method: "cash" });
    const st = ((await pay(L, { contractIds: String(kA1.id) })) as any).stats;
    assert.equal(st.partiallyPaidCount, 1);
    assert.equal(st.partiallyPaid, 1000);
    assert.equal(st.partiallyPaidRemaining, 600);
  });

  it("receipt-voucher cards count and sum exactly the list's rows", async () => {
    const rv: any = await env.billing.createReceiptVoucher(userFor(L), { paymentId: kH.p[3], amount: 3000, method: "cash", paidDate: today });
    assert.ok(rv.number);
    const r: any = await docs(L, { type: "invoice", status: "confirmed", hasReceipt: "true", excludeDeposit: "false" });
    assert.equal(r.stats.filteredCount, r.total);
    const rowsSum = Math.round(r.data.reduce((a: number, d: any) => a + Number(d.voucherAmount), 0) * 100) / 100;
    assert.equal(r.stats.voucherAmount, rowsSum);
    assert.ok(r.total > 0);
  });

  it("settlement returns credit and debit notes apart", async () => {
    const inv: any = await env.billing.create(userFor(L), {
      type: "invoice", contractId: kA1.id, paymentIds: [kA1.p[4]], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 1000, amount: 1000, vat: false }], total: 1000,
    });
    await env.q(`update simple_invoices set status = 'confirmed' where id = $1`, [inv.id]);
    for (const [type, total] of [["credit", 100], ["debit", 40]] as const) {
      const n: any = await env.billing.create(userFor(L), {
        type, billingReference: inv.number, issueDate: today,
        items: [{ description: "تسوية", quantity: 1, unitPrice: total, amount: total, vat: false }], total,
      });
      await env.q(`update simple_invoices set status = 'confirmed' where id = $1`, [n.id]);
    }
    const r: any = await docs(L, { type: "credit,debit" });
    assert.equal(r.stats.byType.credit.confirmedAmount, 100);
    assert.equal(r.stats.byType.debit.confirmedAmount, 40);
    assert.equal(r.stats.confirmedAmount, 140); // the old combined figure, kept for single-type callers
  });

  it("customers: grouped in SQL by VAT → phone → email → name; billed leaves out drafts and vouchers", async () => {
    const add = (o: Record<string, unknown>) => env.q(
      `insert into simple_invoices (user_id, number, type, status, kind, tenant_name, client, total, issue_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [L, o.number, o.type ?? "invoice", o.status ?? "confirmed", o.kind ?? null, o.name ?? null, JSON.stringify(o.client ?? {}), o.total, o.date]);
    await add({ number: "X-1", name: "Cust One", client: { vatNumber: "399999999900003", phone: "0511" }, total: 100, date: addDays(today, -10) });
    await add({ number: "X-2", name: "Cust 1 typo", client: { vatNumber: " 399999999900003 " }, total: 50, date: addDays(today, -1) });
    await add({ number: "X-3", name: "Cust One", client: { vatNumber: "399999999900003" }, total: 30, type: "credit", date: addDays(today, -2) });
    await add({ number: "X-4", name: "Cust One", client: { vatNumber: "399999999900003" }, total: 999, status: "draft", date: addDays(today, -3) });
    await add({ number: "X-5", name: "Cust One", client: { vatNumber: "399999999900003" }, total: 777, kind: "receipt", date: addDays(today, -4) });
    await add({ number: "X-6", name: null, client: { email: " Mail@Example.Test " }, total: 10, date: addDays(today, -20) });
    await add({ number: "X-7", name: null, client: {}, total: 5, date: today }); // names nobody: no customer

    const all: any[] = await env.billing.customers(userFor(L), {});
    const vat = all.find((c) => c.key === "v:399999999900003");
    assert.ok(vat);
    assert.equal(vat.name, "Cust 1 typo"); // the newest document's name
    assert.equal(vat.phone, "0511"); // filled from an older document
    assert.equal(vat.invoiceCount, 5);
    assert.equal(vat.totalAmount, 120); // 100 + 50 − 30; the draft and the voucher billed nobody
    assert.equal(vat.lastIssueDate, addDays(today, -1));
    assert.equal(vat.invoices, undefined); // documents load on expand
    const mail = all.find((c) => c.key === "e:mail@example.test");
    assert.equal(mail?.name, "mail@example.test");

    const page: any = await env.billing.customers(userFor(L), { page: "1", pageSize: "1", search: "typo" });
    assert.equal(page.total, 1);
    assert.equal(page.data[0].key, vat.key);
    const none: any = await env.billing.customers(userFor(L), { page: "1", search: "%" });
    assert.equal(none.total, 0); // a literal %, not a wildcard

    const inv: any = await env.billing.customerInvoices(userFor(L), { key: vat.key, page: "1", pageSize: "2" });
    assert.equal(inv.total, 5);
    assert.deepEqual(inv.data.map((d: any) => d.number), ["X-2", "X-3"]);
  });

  it("finance v2: the same id filters, cards, sort and per-row invoice on the v2 list", async () => {
    const k = await contract(V, sv.unitA1, "1500", sv.tenant);
    const r: any = await pay(V, { propertyId: String(sv.propA) });
    assert.equal(r.total, k.p.length);
    assert.ok(r.data.every((x: any) => x.contractId === k.id && "invoice" in x));
    const n = (st: any) => st.paidCount + st.pendingCount + st.overdueCount + st.partiallyPaidCount + st.cancelledCount
      + (st.writtenOffCount ?? 0) + (st.settledExternalCount ?? 0);
    assert.equal(n(r.stats), r.total);
    assert.equal(((await pay(V, { propertyId: String(sv.propH) })) as any).total, 0);
    assert.equal(((await pay(V, { unitId: String(sv.unitA2) })) as any).total, 0);
    assert.equal(((await pay(V, { tenantId: String(sv.tenant), ownerId: String(sv.agent) })) as any).total, k.p.length);
    // A future installment part-paid: still owed 1,000, which the card reads as `partiallyPaidRemaining`.
    const fut = ((await pay(V, { contractIds: String(k.id), order: "asc", statusIn: "pending" })) as any).data[0];
    await env.payments.addCollection(userFor(V), String(fut.id), { amount: "500", collectedDate: today, method: "cash" });
    const st = ((await pay(V, { contractIds: String(k.id) })) as any).stats;
    assert.equal(st.partiallyPaidCount, 1);
    assert.equal(st.partiallyPaidRemaining, 1000);
    const paid = ((await pay(V, { contractIds: String(k.id), sort: "paidDate", order: "desc" })) as any).data;
    assert.ok(paid.length > 0);
  });

  it("collections of a deleted installment drop out, and count / sum agree with and without search", async () => {
    await env.payments.addCollection(userFor(L), String(kH.p[5]), { amount: "3000", collectedDate: today, method: "cash", receiptNumber: "EXT-DEL" });
    const before: any = await colls(L, { contractIds: String(kH.id) });
    assert.ok(before.data.some((r: any) => r.receiptNumber === "EXT-DEL"));
    await env.q(`update payments set deleted_at = now() where id = $1`, [kH.p[5]]);
    const after: any = await colls(L, { contractIds: String(kH.id) });
    assert.ok(!after.data.some((r: any) => r.receiptNumber === "EXT-DEL"));
    assert.equal(after.total, before.total - 1);
    assert.equal(after.stats.totalCollected, Math.round((before.stats.totalCollected - 3000) * 100) / 100);
    const sum = (rows: any[]) => Math.round(rows.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
    assert.equal(after.stats.totalCollected, sum(after.data));
    const searched: any = await colls(L, { search: "EXT-Z1" });
    assert.equal(searched.total, searched.data.length);
    assert.equal(searched.stats.totalCollected, sum(searched.data));
  });
});
