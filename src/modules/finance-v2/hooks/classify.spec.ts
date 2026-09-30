import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { documentGroups, installmentNature, installmentVat, mapEjarStatusV2, parseBusinessDate, usageOf, DEPOSIT_DESC } from "./classify";
import { pgArray, toDrizzleSql } from "./sql";
import { monthsBetween } from "../recognizer.service";
import { toHalalas } from "../money";

describe("finance v2 hooks: pure classification", () => {
  it("installment nature: rent (null or the Ejar rent stamp), deposit, fee", () => {
    assert.equal(installmentNature(null), "rent");
    assert.equal(installmentNature("  "), "rent");
    assert.equal(installmentNature("فاتورة إيجار رقم 123 — تاريخ الإصدار 2026-01-01"), "rent");
    assert.equal(installmentNature(DEPOSIT_DESC), "deposit");
    assert.equal(installmentNature("رسوم خدمات"), "fee");
  });

  it("usage from the usage keys (usage-vat.ts)", () => {
    assert.equal(usageOf("families"), "residential");
    assert.equal(usageOf("commercial_shops"), "commercial");
    assert.equal(usageOf("mixed", "individuals"), "residential");
    assert.equal(usageOf("mixed", null), null);
    assert.equal(usageOf(null), null);
  });

  it("installment VAT category (§4.1)", () => {
    assert.deepEqual(installmentVat({ vatEnabled: true, usage: "commercial", sellerRegistered: true }), { category: "S", rate: 15, warnings: [] });
    assert.deepEqual(installmentVat({ vatEnabled: true, usage: null, sellerRegistered: false }).warnings, ["vat_unregistered_seller"]);
    assert.equal(installmentVat({ vatEnabled: false, usage: "residential", sellerRegistered: true }).category, "E");
    assert.equal(installmentVat({ vatEnabled: false, usage: "residential", sellerRegistered: false }).category, "O");
    assert.deepEqual(installmentVat({ vatEnabled: false, usage: "commercial", sellerRegistered: true }), { category: "O", rate: 0, warnings: ["commercial_without_vat"] });
    assert.deepEqual(installmentVat({ vatEnabled: false, usage: null, sellerRegistered: false }).warnings, []);
  });

  it("document groups: categories per item, VAT = total − subtotal on S, fee lines by covered fee names", () => {
    const r = documentGroups(
      { items: [
        { description: "إيجار", amount: 6000, vat: true },
        { description: "رسوم خدمات", amount: 400, vat: true },
        { description: "موقف", amount: 100, vatCategory: "O" },
      ], subtotal: "6500.00", total: "7460.00" },
      { feeNames: new Set(["رسوم خدمات"]), usage: "commercial" },
    );
    assert.deepEqual(r.warnings, []);
    const by = (c: string, n: string) => r.groups.find((g) => g.category === c && g.nature === n)!;
    assert.equal(by("S", "rent").net, "6000.00");
    assert.equal(by("S", "fee").net, "400.00");
    assert.equal(by("O", "rent").net, "100.00");
    const vat = r.groups.reduce((s, g) => s + toHalalas(g.vat), 0);
    assert.equal(vat, 96000); // 960.00 exactly, split over the two S groups
    assert.equal(by("O", "rent").vat, "0.00");
  });

  it("document groups: a fee line whose description carries a period suffix is still a fee (E2E: 4,500 stuck in 2131)", () => {
    // Invoices built per installment read "<fee name> — <month>"; the covered
    // fee installment's description is the bare fee name. Classifying the line
    // as rent credits 2131, and the recognizer never releases a fee installment.
    const fees = new Set(["رسوم خدمات"]);
    const r = documentGroups(
      { items: [{ description: "رسوم خدمات — يناير ٢٠٢٦", amount: 1500, vat: true, vatCategory: "S" }], subtotal: "1500.00", total: "1725.00" },
      { feeNames: fees, usage: "commercial" },
    );
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].nature, "fee");
    for (const d of ["رسوم خدمات - Q1", "رسوم خدمات (يناير)", "رسوم خدمات"]) {
      const g = documentGroups({ items: [{ description: d, amount: 100, vat: false }], subtotal: "100.00", total: "100.00" }, { feeNames: fees });
      assert.equal(g.groups[0].nature, "fee", d);
    }
    // A longer word that merely starts with the fee name is not that fee.
    const other = documentGroups({ items: [{ description: "رسوم خدماتية", amount: 100, vat: false }], subtotal: "100.00", total: "100.00" }, { feeNames: fees });
    assert.equal(other.groups[0].nature, "rent");
    const rent = documentGroups({ items: [{ description: "إيجار — يناير ٢٠٢٦", amount: 100, vat: false }], subtotal: "100.00", total: "100.00" }, { feeNames: fees });
    assert.equal(rent.groups[0].nature, "rent");
  });

  it("document groups: a no-VAT line is what the document states (E, as filed) for a registered seller, O for an unregistered one or the account's own fee; Σ items reconciled; three-decimal jsonb flagged", () => {
    const noVat = (opts: any) => documentGroups({ items: [{ amount: 1000, vat: false }], subtotal: "1000.00", total: "1000.00" }, opts);
    assert.equal(noVat({ usage: "residential", sellerRegistered: true }).groups[0].category, "E");
    assert.equal(noVat({ usage: "residential", sellerRegistered: false }).groups[0].category, "O", "an unregistered landlord's rent is out of scope");
    // The document prints and files a `vat:false` line as exempt (billing zatcaLinesFromDoc); the ledger books what it
    // says. Commercial rent is taxable, so that exemption is flagged, not rewritten.
    const com = noVat({ usage: "commercial", sellerRegistered: true });
    assert.deepEqual([com.groups[0].category, com.warnings], ["E", ["commercial_without_vat"]]);
    assert.equal(noVat({ usage: null, sellerRegistered: false }).groups[0].category, "O");
    assert.equal(noVat({ usage: null, sellerRegistered: true, defaultNature: "other" }).groups[0].category, "E", "a free invoice's no-VAT line: exempt, as filed");
    assert.equal(noVat({ usage: null, sellerRegistered: true, defaultNature: "other" }).groups[0].nature, "other");
    assert.deepEqual(noVat({ usage: "commercial", sellerRegistered: true, defaultNature: "other" }).warnings, [], "not rent: no commercial-rent warning");
    assert.equal(noVat({ usage: "residential", sellerRegistered: true, nature: "other", ownFee: true }).groups[0].category, "O", "a fee of the account's own is not exempt");
    assert.equal(noVat({}).groups[0].category, "O", "no seller context: out of scope");
    const explicit = documentGroups({ items: [{ amount: 1000, vat: false, vatCategory: "E" }], subtotal: "1000.00", total: "1000.00" }, { usage: "commercial", sellerRegistered: true });
    assert.equal(explicit.groups[0].category, "E", "an explicit category wins");
    const b = documentGroups({ items: [{ amount: 333.334, vat: true }, { amount: 666.66, vat: true }], subtotal: "1000.00", total: "1150.00" });
    assert.ok(b.warnings.includes("jsonb_precision"));
    assert.ok(b.warnings.includes("items_subtotal_mismatch"));
    assert.equal(b.groups.reduce((s, g) => s + toHalalas(g.net), 0), 100000);
    assert.equal(b.groups.reduce((s, g) => s + toHalalas(g.vat), 0), 15000);
    const c = documentGroups({ items: [], subtotal: "100.00", total: "100.00" }, { nature: "other", ownFee: true });
    assert.deepEqual(c.groups.map((g) => [g.category, g.net, g.nature]), [["O", "100.00", "other"]]);
    assert.ok(c.warnings.includes("document_without_items"));
  });

  it("Ejar status under v2 (E7): paid → settled_external; partial stays pending with the reported amount", () => {
    assert.deepEqual(mapEjarStatusV2({ status: "paid", amount: "5000", remaining: "0" }),
      { status: "settled_external", reported: "paid", reportedAmount: "5000.00" });
    assert.deepEqual(mapEjarStatusV2({ status: "مدفوعة", amount: "5000.5", remaining: "0" }).status, "settled_external");
    assert.deepEqual(mapEjarStatusV2({ status: "late", amount: "5000", remaining: "2000" }),
      { status: null, reported: "partially_paid", reportedAmount: "3000.00" });
    assert.deepEqual(mapEjarStatusV2({ status: "unpaid", amount: "5000", remaining: "5000" }), { status: null, reported: null, reportedAmount: null });
    assert.deepEqual(mapEjarStatusV2({ status: "غير مدفوعة", amount: "5000", remaining: "5000" }).status, null);
  });

  it("business dates from legacy free text", () => {
    assert.equal(parseBusinessDate("2026-03-10"), "2026-03-10");
    assert.equal(parseBusinessDate("2026-03-10T21:00:00Z"), "2026-03-10");
    assert.equal(parseBusinessDate("2026-02-30"), null);
    assert.equal(parseBusinessDate("10/03/2026"), null);
    assert.equal(parseBusinessDate(null), null);
  });

  it("raw SQL for a Drizzle transaction: $n → bound params, arrays as literals", () => {
    const q = new PgDialect().sqlToQuery(toDrizzleSql("select * from t where a = $1 and b = any($2::int[]) and c = $1", [7, pgArray([1, 2])]));
    assert.equal(q.sql, "select * from t where a = $1 and b = any($2::int[]) and c = $3");
    assert.deepEqual(q.params, [7, "{1,2}", 7]);
    assert.throws(() => toDrizzleSql("select $2", [1]));
    assert.throws(() => pgArray([1.5]));
  });

  it("recognizer months", () => {
    assert.deepEqual(monthsBetween("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(monthsBetween("2026-03-01", "2026-03-31"), ["2026-03"]);
  });
});
