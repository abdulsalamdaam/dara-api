import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { ApService } from "./ap.service";
import { JournalExportService } from "./journal-export.service";
import { BOM } from "./journal-csv";
import { VatReportService } from "../reports/vat-report.service";
import { extractEvents, keyOf } from "../backfill/extract";
import { loadSettings } from "../hooks/facts-loader";
import { sqlOf } from "../hooks/sql";
import { FinanceV2Tier3Controller } from "../controllers/tier3.controller";
import { riyadhToday } from "../dates";

/**
 * DESIGN §8.4 tier 3 on a throwaway Postgres (synthetic data only): the
 * supplier master, bills with input VAT (E38), supplier payments (E39), voids
 * (reversals), AP aging with its control check, the supplier statement, the
 * VAT return picking bills up, the backfill extraction, and the journal CSV.
 *
 * Hand-computed figures (Manager mode; the account is VAT-registered):
 *   B1 (S1, overhead, 2026-08-05, terms 30 → due 2026-09-04):
 *      line 1 S 1,000.00 + 150.00 VAT recoverable → Dr 5290 1,000 / Dr 1151 150
 *      line 2 E   250.00 on 5270                  → Dr 5270 250
 *      Cr 2111 1,400.00
 *   B2 (S2 without a VAT number, 2026-08-10): S 100.00 + 15.00, not recoverable → Dr 5290 100 / Dr 5500 15 / Cr 2111 115
 *   B3 (S1, agent landlord's property, charged to the landlord, 2026-08-12): S 200 + 30 → Dr 2121 230 / Cr 2111 230
 *   P1 PV-000001 (S1, 2026-08-20): 1,000.00 to B1 → Dr 2111 1,000 / Cr 1113 1,000
 *   AP 2026-09-27: B1 400 (23 days past due, 0–30), B2 115 (due 2026-09-09, 18 days), B3 230 (due 2026-09-11) → 745
 *   S1 statement Aug: 1,400 Cr, 230 Cr, 1,000 Dr → closing 630
 */
const U = 5601;
const OTHER = 5602;
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve"];
const user = { id: U, ownerUserId: null, ownerScopeId: null, email: "fv2-spec-5601@example.test", role: "user", permissions: PERMS } as any;
const AS_OF = "2026-09-27";

async function drain(env: LegacyEnv, u = U) {
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 tier 3: suppliers, bills and AP, journal export (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let ap: ApService;
  let exp: JournalExportService;
  let acc: Record<string, number>;
  let s1: any, s2: any;
  let b1: any, b2: any, b3: any;
  let p1: any;

  const linesOf = (sourceType: string, sourceId: number, event: string) => env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit, l.tax_role, l.vat_category, l.vat_base::text as vat_base, l.seller_key, l.owner_id
       from ledger_outbox o join journal_entries e on e.id = o.entry_id join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4 order by l.line_no`,
    [U, sourceType, sourceId, event]);
  const codes = (ls: any[]) => ls.map((l) => `${l.code} ${Number(l.debit) ? "Dr" : "Cr"} ${Number(l.debit) || Number(l.credit)}`);
  const apBalance = async () => (await env.q(
    `select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = '2111'`, [U]))[0].b;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await seedAccount(env, OTHER);
    await enableV2(env, U, "manager");
    await enableV2(env, OTHER, "manager");
    ap = new ApService(env.t.pool as any, env.emitter, new BankAccountsService(env.t.pool as any));
    exp = new JournalExportService(env.t.pool as any);
    acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
  });

  after(async () => {
    await env?.t.drop();
  });

  it("suppliers: VAT number validated and unique per account; list with the open balance; another account's id is 404", async () => {
    const badVat: any = await attempt(() => ap.createSupplier(U, user, { nameAr: "مورد", vatNumber: "123" }));
    assert.deepEqual([badVat.status, badVat.body.error], [400, "BAD_SUPPLIER_VAT"]);
    s1 = await ap.createSupplier(U, user, { nameAr: "مورد الصيانة", nameEn: "Synthetic Maintenance Co", vatNumber: "٣٠٠٠٠٠٠٠٠٠٠٠٠١٣", paymentTermsDays: 30 });
    assert.equal(s1.vatNumber, "300000000000013", "Arabic-Indic digits are accepted");
    const dup: any = await attempt(() => ap.createSupplier(U, user, { nameAr: "مكرر", vatNumber: "300000000000013" }));
    assert.deepEqual([dup.status, dup.body.error], [409, "SUPPLIER_VAT_EXISTS"]);
    s2 = await ap.createSupplier(U, user, { nameAr: "مورد بلا رقم ضريبي", paymentTermsDays: 30 });
    const badGl: any = await attempt(() => ap.updateSupplier(U, user, s2.id, { defaultGlAccountId: acc["1113"] }));
    assert.deepEqual([badGl.status, badGl.body.error], [400, "BAD_ACCOUNT"], "a bank account is not a bill account");
    const list = await ap.listSuppliers(U, { lang: "en" });
    assert.deepEqual(list.rows.map((r) => [r.name, r.balance]), [["Synthetic Maintenance Co", "0.00"], ["مورد بلا رقم ضريبي", "0.00"]]);
    assert.equal(((await attempt(() => ap.getSupplier(OTHER, s1.id))) as any).status, 404);
  });

  it("a bill is a draft until approved (nothing queued); numbering BILL-######; due date from the terms; duplicate supplier invoice refused", async () => {
    b1 = await ap.createBill(U, user, {
      supplierId: s1.id, supplierInvoiceNo: "INV-77", billDate: "2026-08-05",
      lines: [
        { description: "صيانة المكتب", amount: "1000", vatCategory: "S" },
        { description: "رسوم", amount: "250", vatCategory: "E", glAccountId: acc["5270"] },
      ],
    });
    assert.deepEqual([b1.number, b1.status, b1.dueDate, b1.subtotal, b1.vatTotal, b1.total, b1.paymentStatus], ["BILL-000001", "draft", "2026-09-04", "1250.00", "150.00", "1400.00", null]);
    assert.deepEqual(b1.lines.map((l: any) => [l.net, l.vat, l.vatCategory, l.vatRecoverable]), [["1000.00", "150.00", "S", true], ["250.00", "0.00", "E", false]]);
    assert.equal((await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_type = 'supplier_bill'`, [U]))[0].n, 0);
    const dup: any = await attempt(() => ap.createBill(U, user, { supplierId: s1.id, supplierInvoiceNo: "inv-77", billDate: "2026-08-06", lines: [{ description: "x", amount: "1" }] }));
    assert.deepEqual([dup.status, dup.body.error, dup.body.existing], [409, "DUPLICATE_SUPPLIER_INVOICE", "BILL-000001"]);
    const other: any = await attempt(() => ap.createBill(OTHER, user, { supplierId: s1.id, billDate: "2026-08-06", lines: [{ description: "x", amount: "1" }] }));
    assert.equal(other.status, 404, "another account's supplier");
    // edit the draft: a VAT figure copied from the tax invoice (within tolerance)
    b1 = await ap.updateBill(U, user, b1.id, { lines: [
      { description: "صيانة المكتب", amount: "1000", vatCategory: "S", vat: "150.00" },
      { description: "رسوم", amount: "250", vatCategory: "E", glAccountId: acc["5270"] },
    ] });
    assert.equal(b1.total, "1400.00");
  });

  it("approve posts E38: Dr expense / Dr 1151 / Dr 5270 / Cr 2111, with the VAT report attributes", async () => {
    b1 = await ap.approveBill(U, user, b1.id);
    assert.deepEqual([b1.status, b1.paymentStatus, b1.remaining], ["approved", "unpaid", "1400.00"]);
    await drain(env);
    const ls = await linesOf("supplier_bill", b1.id, "approved");
    assert.deepEqual(codes(ls), ["5290 Dr 1000", "1151 Dr 150", "5270 Dr 250", "2111 Cr 1400"]);
    assert.deepEqual([ls[1].tax_role, ls[1].vat_category, ls[1].vat_base, ls[1].seller_key], ["input", "S", "1000.00", "account"]);
    assert.deepEqual([ls[2].tax_role, ls[2].vat_category, ls[2].vat_base], ["input_nonrecoverable", "E", "250.00"]);
    b1 = await ap.getBill(U, b1.id);
    assert.equal(b1.posting?.status, "posted");
    const again: any = await attempt(() => ap.approveBill(U, user, b1.id));
    assert.deepEqual([again.status, again.body.error], [409, "BILL_NOT_DRAFT"]);
    const edit: any = await attempt(() => ap.updateBill(U, user, b1.id, { notes: "x" }));
    assert.equal(edit.body.error, "BILL_NOT_DRAFT");
  });

  it("input VAT needs the supplier's VAT number; without it the VAT goes to 5500", async () => {
    const refuse: any = await attempt(() => ap.createBill(U, user, { supplierId: s2.id, billDate: "2026-08-10", lines: [{ description: "x", amount: "100", vatRecoverable: true }] }));
    assert.deepEqual([refuse.status, refuse.body.error], [400, "SUPPLIER_VAT_REQUIRED"]);
    b2 = await ap.createBill(U, user, { supplierId: s2.id, billDate: "2026-08-10", lines: [{ description: "قرطاسية", amount: "100" }] });
    assert.equal(b2.lines[0].vatRecoverable, false);
    b2 = await ap.approveBill(U, user, b2.id);
    await drain(env);
    assert.deepEqual(codes(await linesOf("supplier_bill", b2.id, "approved")), ["5290 Dr 100", "5500 Dr 15", "2111 Cr 115"]);
  });

  it("charged to an agent landlord: Dr 2121 for net + VAT on the landlord's seller key; not allowed for the account holder's property", async () => {
    const no: any = await attempt(() => ap.createBill(U, user, { supplierId: s1.id, billDate: "2026-08-12", propertyId: s.propH, chargeTo: "landlord", lines: [{ description: "x", amount: "1" }] }));
    assert.deepEqual([no.status, no.body.error], [400, "CHARGE_TO_NOT_ALLOWED"]);
    const mismatch: any = await attempt(() => ap.createBill(U, user, { supplierId: s1.id, billDate: "2026-08-12", ownerId: s.holder, propertyId: s.propA, lines: [{ description: "x", amount: "1" }] }));
    assert.equal(mismatch.body.error, "OWNER_PROPERTY_MISMATCH");
    b3 = await ap.createBill(U, user, { supplierId: s1.id, billDate: "2026-08-12", propertyId: s.propA, chargeTo: "landlord", supplierInvoiceNo: "INV-78",
      lines: [{ description: "سباكة", amount: "200" }] });
    assert.deepEqual([b3.ownerId, b3.chargeTo, b3.lines[0].vatRecoverable], [s.agent, "landlord", false]);
    await ap.approveBill(U, user, b3.id);
    await drain(env);
    const ls = await linesOf("supplier_bill", b3.id, "approved");
    assert.deepEqual(codes(ls), ["2121 Dr 200", "2121 Dr 30", "2111 Cr 230"]);
    assert.deepEqual([ls[1].seller_key, ls[1].owner_id], [`owner:${s.agent}`, s.agent]);
  });

  it("supplier payment: allocations must add up and stay within each bill's open amount; PV numbering; E39 Dr 2111 / Cr bank", async () => {
    const pay = (over: any) => attempt(() => ap.createPayment(U, user, { supplierId: s1.id, paidOn: "2026-08-20", amount: "1000", allocations: [{ billId: b1.id, amount: "1000" }], ...over }));
    const mism: any = await pay({ allocations: [{ billId: b1.id, amount: "999.99" }] });
    assert.deepEqual([mism.status, mism.body.error], [400, "ALLOCATION_MISMATCH"]);
    const over: any = await pay({ amount: "1400.01", allocations: [{ billId: b1.id, amount: "1400.01" }] });
    assert.deepEqual([over.status, over.body.error, over.body.open], [409, "FINANCE_V2_EXCEEDS_BILL", "1400.00"]);
    const wrong: any = await pay({ amount: "115", allocations: [{ billId: b2.id, amount: "115" }] });
    assert.deepEqual([wrong.status, wrong.body.error], [400, "BILL_OTHER_SUPPLIER"]);
    const foreignBank: any = await pay({ bankAccountId: 999999 });
    assert.equal(foreignBank.body.error, "BAD_BANK_ACCOUNT");
    p1 = await pay({ method: "bank_transfer", reference: "TRX-1" });
    assert.deepEqual([p1.number, p1.status, p1.allocations.map((a: any) => [a.billNumber, a.amount])], ["PV-000001", "posted", [["BILL-000001", "1000.00"]]]);
    await drain(env);
    assert.deepEqual(codes(await linesOf("supplier_payment", p1.id, "paid")), ["2111 Dr 1000", "1113 Cr 1000"]);
    b1 = await ap.getBill(U, b1.id);
    assert.deepEqual([b1.paid, b1.remaining, b1.paymentStatus], ["1000.00", "400.00", "partial"]);
    const voidBill: any = await attempt(() => ap.voidBill(U, user, b1.id, { reason: "entered twice" }));
    assert.deepEqual([voidBill.status, voidBill.body.error], [409, "BILL_HAS_PAYMENTS"]);
    assert.equal(await apBalance(), "745.00", "1,400 + 115 + 230 − 1,000");
  });

  it("AP aging by due date with the 2111 control check; the supplier statement runs a balance", async () => {
    const r: any = await ap.apAging(U, { asOf: AS_OF, lang: "en" });
    const byS = Object.fromEntries(r.rows.map((x: any) => [x.supplierId, x]));
    assert.deepEqual([byS[s1.id].open, byS[s1.id].d0_30, byS[s1.id].pastDue], ["630.00", "630.00", "630.00"]);
    assert.deepEqual(byS[s1.id].items.map((i: any) => [i.number, i.daysPastDue, i.bucket, i.remaining]), [["BILL-000001", 23, "d0_30", "400.00"], ["BILL-000003", 16, "d0_30", "230.00"]]);
    assert.deepEqual([byS[s2.id].open, byS[s2.id].items[0].daysPastDue], ["115.00", 18]);
    assert.equal(r.totals.open, "745.00");
    assert.deepEqual(r.reconciliation, { ledgerAp: "745.00", subLedger: "745.00", difference: "0.00", balanced: true, pendingPostings: 0 });
    // As of before the payment: the whole of B1 is open and not yet due.
    const early: any = await ap.apAging(U, { asOf: "2026-08-15" });
    assert.deepEqual([early.totals.open, early.totals.notDue], ["1745.00", "1745.00"]);
    const st: any = await ap.supplierStatement(U, s1.id, { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(st.lines.map((l: any) => [l.type, l.number, l.debit, l.credit, l.balance]), [
      ["bill", "BILL-000001", "0.00", "1400.00", "1400.00"],
      ["bill", "BILL-000003", "0.00", "230.00", "1630.00"],
      ["payment", "PV-000001", "1000.00", "0.00", "630.00"],
    ]);
    assert.deepEqual([st.opening, st.closing], ["0.00", "630.00"]);
    const sep: any = await ap.supplierStatement(U, s1.id, { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual([sep.opening, sep.lines.length, sep.closing], ["630.00", 0, "630.00"]);
  });

  it("the supplier statement prints the stored dates whatever the server's time zone (Asia/Riyadh is UTC+3)", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Riyadh";
    try {
      const st: any = await ap.supplierStatement(U, s1.id, { from: "2026-08-05", to: "2026-08-31" });
      assert.deepEqual(st.lines.map((l: any) => [l.number, l.date]), [["BILL-000001", "2026-08-05"], ["BILL-000003", "2026-08-12"], ["PV-000001", "2026-08-20"]]);
      assert.equal(st.opening, "0.00", "a bill dated on `from` is in the period, not the opening");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("the VAT return picks bills up: recoverable input VAT booked, exempt purchases in box 11; a landlord's bill is not the account's", async () => {
    const r: any = await new VatReportService(env.t.pool as any).vatReturn(U, { period: "2026-Q3" });
    assert.equal(r.memo.inputVatBooked, "150.00");
    assert.equal(r.boxes.find((b: any) => b.box === 11).amount, "250.00");
    assert.deepEqual(r.memo.nonRecoverableInput, { base: "100.00", vat: "15.00" });
  });

  it("voids reverse: a payment, then its bill; the sub-ledger and 2111 agree after each", async () => {
    await ap.voidPayment(U, user, p1.id, { reason: "bounced" });
    await drain(env);
    assert.equal(await apBalance(), "1745.00");
    b1 = await ap.getBill(U, b1.id);
    assert.deepEqual([b1.paid, b1.remaining, b1.paymentStatus], ["0.00", "1400.00", "unpaid"]);
    const again: any = await attempt(() => ap.voidPayment(U, user, p1.id, { reason: "x" }));
    assert.equal(again.body.error, "FINANCE_V2_ALREADY_VOID");
    const noReason: any = await attempt(() => ap.voidBill(U, user, b1.id, {}));
    assert.equal(noReason.body.error, "REASON_REQUIRED");
    b1 = await ap.voidBill(U, user, b1.id, { reason: "entered twice" });
    assert.equal(b1.status, "void");
    await drain(env);
    assert.equal(await apBalance(), "345.00");
    const rev = await env.q(`select status from ledger_outbox where user_id = $1 and source_type = 'supplier_bill' and source_id = $2 and event = 'reversal:approved'`, [U, b1.id]);
    assert.deepEqual(rev.map((x: any) => x.status), ["posted"]);
    // Voids are dated today (Riyadh): as of today they are out; as of the earlier AS_OF they still count.
    const r: any = await ap.apAging(U, { asOf: riyadhToday() });
    assert.deepEqual([r.totals.open, r.reconciliation.balanced], ["345.00", true]);
    // The same supplier invoice number can be entered again once the first is void.
    const re = await ap.createBill(U, user, { supplierId: s1.id, supplierInvoiceNo: "INV-77", billDate: "2026-08-05", lines: [{ description: "صيانة", amount: "1000" }] });
    assert.equal(re.number, "BILL-000004");
    await ap.deleteBill(U, user, re.id);
    // The supplier statement keeps the history: bill, payment, and both voids.
    const st: any = await ap.supplierStatement(U, s1.id, { from: "2026-08-01", to: riyadhToday() });
    assert.deepEqual(st.lines.map((l: any) => l.type), ["bill", "bill", "payment", "payment_void", "bill_void"]);
    assert.equal(st.closing, "230.00");
    const del: any = await attempt(() => ap.deleteSupplier(U, user, s1.id));
    assert.equal(del.body.error, "SUPPLIER_IN_USE");
  });

  it("backfill / catch-up extracts every AP key with its live key, and each is already in the ledger", async () => {
    const st = await loadSettings(sqlOf(env.t.pool as any), U);
    const { events } = await extractEvents(sqlOf(env.t.pool as any), U, st!, { today: riyadhToday() });
    const apKeys = events.filter((e) => e.sourceType === "supplier_bill" || e.sourceType === "supplier_payment").map(keyOf).sort();
    assert.deepEqual(apKeys, [
      `supplier_bill|${b1.id}|approved`, `supplier_bill|${b1.id}|reversal:approved`, `supplier_bill|${b2.id}|approved`, `supplier_bill|${b3.id}|approved`,
      `supplier_payment|${p1.id}|paid`, `supplier_payment|${p1.id}|reversal:paid`,
    ].sort());
    const posted = new Set((await env.q(`select source_type, source_id, event from journal_entries where user_id = $1`, [U]))
      .map((r: any) => keyOf({ sourceType: r.source_type, sourceId: Number(r.source_id), event: r.event })));
    assert.deepEqual(apKeys.filter((k) => !posted.has(k)), []);
  });

  it("journal export: the documented CSV (BOM, header, CRLF), balanced totals, CSV-injection guard, account-scoped", async () => {
    const inj = await ap.createBill(U, user, { supplierId: s2.id, billDate: "2026-08-25", lines: [{ description: "=HYPERLINK(\"http://x\")", amount: "10", vatCategory: "O" }] });
    await ap.approveBill(U, user, inj.id);
    await drain(env);
    const f = await exp.csv(U, { from: "2026-08-01", to: "2026-08-31" });
    assert.ok(f.body.startsWith(BOM));
    const rows = f.body.slice(1).split("\r\n").filter(Boolean);
    const n = (await env.q(`select count(*)::int as n from journal_lines l join journal_entries e on e.id = l.entry_id
                             where e.user_id = $1 and e.entry_date between '2026-08-01' and '2026-08-31'`, [U]))[0].n;
    assert.equal(rows.length, n + 1);
    assert.equal(f.rows, n);
    assert.equal(f.debit, f.credit);
    assert.ok(rows.some((r) => r.includes(`"'=HYPERLINK(""http://x"")"`)), "the formula is neutralised and quoted");
    const bill1 = rows.filter((r) => r.includes(",supplier_bill,BILL-000001,"));
    assert.equal(bill1.length, 4, "one row per journal line of B1's entry");
    assert.ok(bill1[0].split(",")[3] === "5290");
    const vatRow = bill1.find((r) => r.split(",")[3] === "1151")!.split(",");
    assert.deepEqual(vatRow.slice(-4), ["S", "15", "input", ""], "vat_category, vat_rate, tax_role, account_code_external (not set)");
    assert.equal(f.filename, "dara-journal_2026-08-01_2026-08-31.csv");
    const simple = await exp.csv(U, { from: "2026-08-01", to: "2026-08-31", preset: "simple", dateFormat: "dmy", lang: "en", excludeReversed: "true" });
    const srows = simple.body.slice(1).split("\r\n").filter(Boolean);
    assert.equal(srows[0], "date,entry_no,account_code,account_name,debit,credit,memo");
    assert.ok(srows.slice(1).every((r) => /^\d{2}\/08\/2026,JV-2026-\d{6},/.test(r)));
    assert.ok(!simple.body.includes("BILL-000001"), "B1 (reversed) is left out with excludeReversed");
    const prev: any = await exp.preview(U, { from: "2026-08-01", to: "2026-08-31", format: "json" });
    assert.deepEqual([prev.count, prev.totals.balanced, prev.truncated], [n, true, false]);
    const other = await exp.csv(OTHER, { from: "2026-08-01", to: "2026-08-31" });
    assert.equal(other.rows, 0);
    const bad: any = await attempt(async () => exp.params({ from: "2026-09-01", to: "2026-08-01" }));
    assert.equal(bad.body.error, "BAD_RANGE");
  });

  it("two concurrent payments on one bill cannot overpay it (AP lock): exactly one succeeds", async () => {
    const pay = () => attempt(() => ap.createPayment(U, user, { supplierId: s2.id, paidOn: "2026-09-01", amount: "100", allocations: [{ billId: b2.id, amount: "100" }] }));
    const [a, b]: any[] = await Promise.all([pay(), pay()]);
    const ok = [a, b].filter((x) => x?.number);
    const refused = [a, b].filter((x) => x?.status === 409);
    assert.equal(ok.length, 1);
    assert.deepEqual([refused.length, refused[0].body.error, refused[0].body.open], [1, "FINANCE_V2_EXCEEDS_BILL", "15.00"]);
    const numbers = (await env.q(`select number from supplier_payments where user_id = $1 order by id`, [U])).map((r: any) => r.number);
    assert.deepEqual(numbers, ["PV-000001", "PV-000002"], "one PV series, no gaps from the refused one");
  });

  it("the controller streams the CSV with its headers", async () => {
    const ctl = new FinanceV2Tier3Controller(ap, exp);
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
    const body = await ctl.journalExport({ user } as any, { from: "2026-08-01", to: "2026-08-31" }, res);
    assert.equal(typeof body, "string");
    assert.equal(headers["Content-Type"], "text/csv; charset=utf-8");
    assert.match(headers["Content-Disposition"], /attachment; filename="dara-journal_2026-08-01_2026-08-31\.csv"/);
    assert.equal(headers["X-Export-Debit"], headers["X-Export-Credit"]);
  });
});
