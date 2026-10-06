import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commissionVat, lineBase, monthLabel, monthSpan, planLandlord, previousMonth, type CollectedLine, type RateInfo } from "./commission-run";
import { CommissionRunService } from "./commission-run.service";
import { commissionZatcaDoc, isLandlordCommissionDoc } from "./overrides/documents-v2";
import { commissionZatcaDocV2 } from "./overrides/commission-approve";
import { runRule } from "./rules";
import { toHalalas } from "./money";

/**
 * The collected-basis commission arithmetic (DESIGN §9 E1; the accountant's
 * workbook, sheets "العمليات" CINV-0001…0006 and "كشف الملاك"). Pure: no DB.
 */
let nextId = 1;
const line = (ownerId: number, propertyId: number | null, gross: string, vatEnabled: boolean, extra: Partial<CollectedLine> = {}): CollectedLine => ({
  lineId: nextId++, entryId: nextId, ownerId, propertyId, contractId: 1, paymentId: 10, entryDate: "2026-01-15",
  gross: toHalalas(gross), vatEnabled, nature: "rent", source: "collection", ...extra,
});
const rates = (m: Record<string, RateInfo>, fallback: RateInfo = { pct: null, source: null }) =>
  (p: number | null): RateInfo => m[String(p)] ?? fallback;
const h = (n: number) => (n / 100).toFixed(2);

describe("fv2 commission run: the collected-basis calculation", () => {
  it("the accountant's January: O01 5% of 36,000 collected before VAT = 1,800 + 270 VAT; O02 7.5% of 10,500 (Ejar) = 787.50 + 118.13", () => {
    const l1 = [line(1, 11, "34500", true), line(1, 11, "6900", true)];
    const p1 = planLandlord(1, l1, rates({ 11: { pct: "5.00", source: "landlord" } }), true);
    assert.deepEqual([h(p1.base), h(p1.net), h(p1.vat), h(p1.total)], ["36000.00", "1800.00", "270.00", "2070.00"]);
    const l2 = [line(2, 22, "10500", false, { source: "ejar" })];
    const p2 = planLandlord(2, l2, rates({ 22: { pct: "7.50", source: "landlord" } }), true);
    assert.deepEqual([h(p2.net), h(p2.vat), h(p2.total)], ["787.50", "118.13", "905.63"]);
    // TRF-0001 in the workbook: 2,070 + 905.63.
    assert.equal(h(p1.total + p2.total), "2975.63");
  });

  it("a partial payment counts its pre-VAT part: 3,000 on a VAT installment → 2,608.70 × 5% = 130.44 + 19.57 (CINV-0005)", () => {
    const p = planLandlord(1, [line(1, 11, "3000", true)], rates({ 11: { pct: "5.00", source: "property" } }), true);
    assert.deepEqual([h(p.base), h(p.net), h(p.vat), h(p.total)], ["2608.70", "130.44", "19.57", "150.01"]);
  });

  it("a refund or reversed collection in the month lowers the base; a credit note does not reach it (it moves no money)", () => {
    const p = planLandlord(1, [line(1, 11, "6900", true), line(1, 11, "-1150", true)], rates({ 11: { pct: "5.00", source: "property" } }), true);
    assert.deepEqual([h(p.collected), h(p.base), h(p.net)], ["5750.00", "5000.00", "250.00"]);
  });

  it("refunds that outweigh collections defer the property (its lines wait for a later month); nothing is invoiced", () => {
    const p = planLandlord(1, [line(1, 11, "1000", false), line(1, 11, "-1500", false)], rates({ 11: { pct: "5.00", source: "property" } }), true);
    assert.equal(p.skip, "not_positive");
    assert.equal(p.lines.length, 0);
    assert.equal(p.properties[0].deferred, "not_positive");
  });

  it("the property rate wins over the landlord's; with no property rate the landlord's applies; per property, then summed", () => {
    const ls = [line(1, 11, "10000", false), line(1, 12, "10000", false), line(1, null, "1000", false)];
    const p = planLandlord(1, ls, rates({ 11: { pct: "5.00", source: "property" }, 12: { pct: "10.00", source: "landlord" } }, { pct: "10.00", source: "landlord" }), false);
    assert.deepEqual(p.properties.map((x) => [x.propertyId, x.pct, x.source, h(x.commission)]),
      [[null, "10.00", "landlord", "100.00"], [11, "5.00", "property", "500.00"], [12, "10.00", "landlord", "1000.00"]]);
    assert.deepEqual([h(p.net), h(p.vat)], ["1600.00", "0.00"], "an office that is not VAT-registered charges no VAT");
  });

  it("a property with no agreed rate (or an explicit 0) is deferred as no_rate; only the rest is invoiced", () => {
    const ls = [line(1, 11, "10000", false), line(1, 12, "10000", false)];
    const p = planLandlord(1, ls, rates({ 11: { pct: "5.00", source: "property" }, 12: { pct: "0.00", source: "property" } }), true);
    assert.deepEqual(p.properties.map((x) => x.deferred), [null, "no_rate"]);
    assert.equal(h(p.net), "500.00");
    assert.equal(p.lines.length, 1, "the no-rate property's line is not counted");
    const none = planLandlord(1, [line(1, 12, "100", false)], rates({ 12: { pct: null, source: null } }), true);
    assert.equal(none.skip, "no_rate");
  });

  it("only rent counts: fee and deposit lines, and other landlords' lines, are ignored", () => {
    const ls = [line(1, 11, "1000", false), line(1, 11, "500", false, { nature: "fee" }), line(1, 11, "5000", false, { nature: "deposit" }), line(2, 11, "9000", false)];
    const p = planLandlord(1, ls, rates({ 11: { pct: "5.00", source: "property" } }), false);
    assert.deepEqual([h(p.base), h(p.net), p.lines.length], ["1000.00", "50.00", 1]);
    assert.equal(planLandlord(3, ls, rates({}), false).skip, "nothing_collected");
  });

  it("rounding: commission half-up on the property base, VAT half-up on the commission", () => {
    assert.equal(lineBase({ gross: toHalalas("3000"), vatEnabled: true }), 260870);
    assert.equal(lineBase({ gross: toHalalas("-3000"), vatEnabled: true }), -260870);
    assert.equal(commissionVat(26250), 3938, "262.50 → 39.375 → 39.38");
    assert.equal(commissionVat(78750), 11813);
  });

  it("months: span, previous month, labels, and the scheduler's due month (23:00 Riyadh on the last day, else catch-up)", () => {
    assert.deepEqual(monthSpan("2026-02"), { month: "2026-02", start: "2026-02-01", end: "2026-02-28" });
    assert.equal(monthSpan("2026-13"), null);
    assert.equal(monthSpan(undefined), null);
    assert.equal(previousMonth("2026-01"), "2025-12");
    assert.deepEqual(monthLabel("2026-01"), { ar: "يناير 2026", en: "January 2026" });
    assert.equal(CommissionRunService.dueMonth(new Date("2026-01-31T19:59:00Z")), "2025-12", "22:59 Riyadh on the 31st: not yet");
    assert.equal(CommissionRunService.dueMonth(new Date("2026-01-31T20:00:00Z")), "2026-01", "23:00 Riyadh on the 31st: January");
    assert.equal(CommissionRunService.dueMonth(new Date("2026-02-01T09:00:00Z")), "2026-01", "catch-up on the 1st");
  });

  it("the landlord commission document goes to ZATCA as a free invoice billed TO that landlord; a contract commission does not change", () => {
    const doc = { id: 1, kind: "commission", type: "invoice", contractId: null, client: { ownerId: 7, name: "L" } };
    assert.equal(isLandlordCommissionDoc(doc), true);
    const z = commissionZatcaDoc(doc);
    assert.deepEqual([z.kind, z.contractId, z.client.kind, z.client.ownerId], ["invoice", null, "landlord", 7]);
    assert.equal(commissionZatcaDoc({ ...doc, contractId: 5 }), null, "billed-basis commission keeps the legacy path");
    assert.equal(commissionZatcaDoc({ ...doc, kind: "invoice" }), null);
    assert.equal(commissionZatcaDoc({ ...doc, client: {} }), null);
  });

  it("finding 1: a contract-bound (billed) commission reaches ZATCA under the office only when it carries VAT; its landlord is the buyer", async () => {
    const q: any = { rows: async () => { throw new Error("no DB needed when client.ownerId is on the document"); } };
    const base = { id: 2, kind: "commission", type: "invoice", contractId: 9, client: { kind: "landlord", ownerId: 7 }, subtotal: "210.00" };
    assert.equal(await commissionZatcaDocV2(q, 1, { ...base, total: "210.00" }), null, "a non-tax commission document is never sent");
    const z = await commissionZatcaDocV2(q, 1, { ...base, total: "241.50" });
    assert.deepEqual([z.kind, z.contractId, z.client.kind, z.client.ownerId], ["invoice", null, "landlord", 7]);
    assert.equal(await commissionZatcaDocV2(q, 1, { ...base, kind: "invoice", total: "241.50" }), null);
  });

  it("E15T commission transfer: Dr operating bank / Cr trust bank, no landlord dimension; refuses a non-positive amount or one account", () => {
    const out = runRule({ rule: "E15T", facts: { date: "2026-01-31", amount: "2975.63", fromBankAccountId: 4, toBankAccountId: 3 } }, {
      charges: {}, vatBooked: {}, baseBooked: {}, unreleased: {}, writtenOff: [],
    } as any);
    assert.deepEqual(out.lines.map((l) => [(l.account as any).bank.bankAccountId, l.debit, l.credit, l.dims]), [[3, 297563, 0, {}], [4, 0, 297563, {}]]);
    assert.throws(() => runRule({ rule: "E15T", facts: { date: "2026-01-31", amount: "0", fromBankAccountId: 4, toBankAccountId: 3 } }, {} as any));
    assert.throws(() => runRule({ rule: "E15T", facts: { date: "2026-01-31", amount: "1", fromBankAccountId: 4, toBankAccountId: 4 } }, {} as any));
  });
});
