import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUYER_ID_SCHEMES,
  EXEMPTION_REASONS,
  SELLER_ID_SCHEMES,
  buyerIdScheme,
  exemptionReasonFor,
  idFormatError,
  inferSellerIdScheme,
  isExemptionReasonFor,
  unexplainedExemptLines,
} from "./vat-exemption";

describe("EXEMPTION_REASONS — the BR-KSA-CL-04 list", () => {
  it("has exactly ZATCA's E codes, and nothing lease-specific", () => {
    const e = Object.entries(EXEMPTION_REASONS).filter(([, r]) => r.category === "E").map(([c]) => c).sort();
    assert.deepEqual(e, ["VATEX-SA-29", "VATEX-SA-29-7", "VATEX-SA-30"]);
  });

  it("has the three Z codes the SDK added after the 2023 PDF", () => {
    for (const c of ["VATEX-SA-DUTYFREE", "VATEX-SA-ROYALDECREE", "VATEX-SA-32(bis)"]) {
      assert.equal(EXEMPTION_REASONS[c]?.category, "Z", c);
    }
  });

  it("binds each code to its category — a real-estate code is not a zero-rated one", () => {
    assert.equal(isExemptionReasonFor("E", "VATEX-SA-30"), true);
    assert.equal(isExemptionReasonFor("Z", "VATEX-SA-30"), false);
    assert.equal(isExemptionReasonFor("E", "VATEX-SA-29"), true);   // financial services — valid, just not rent
    assert.equal(isExemptionReasonFor("O", "VATEX-SA-OOS"), true);
    assert.equal(isExemptionReasonFor("S", "VATEX-SA-30"), false);
    assert.equal(isExemptionReasonFor("E", "NID"), false);
  });

  it("defaults only the out-of-scope code, never an exempt or zero-rated one", () => {
    assert.equal(exemptionReasonFor("O", undefined), "VATEX-SA-OOS");
    assert.equal(exemptionReasonFor("E", undefined), null);
    assert.equal(exemptionReasonFor("Z", ""), null);
    assert.equal(exemptionReasonFor("S", "VATEX-SA-30"), null);
    assert.equal(exemptionReasonFor("E", "VATEX-SA-32"), null, "wrong category is no reason at all");
  });
});

describe("unexplainedExemptLines", () => {
  it("names the non-standard lines that carry no valid reason", () => {
    const names = unexplainedExemptLines([
      { name: "الإيجار", vatCategory: "S" },
      { name: "إيجار سكني", vatCategory: "E", exemptionReasonCode: "VATEX-SA-30" },
      { name: "المياه", vatCategory: "E" },
      { name: "خدمة مصدرة", vatCategory: "Z", exemptionReasonCode: "VATEX-SA-30" },
      { name: "خارج النطاق", vatCategory: "O" },
    ]);
    assert.deepEqual(names, ["المياه", "خدمة مصدرة"]);
  });
});

describe("party identification schemes", () => {
  it("the seller list has no national-ID scheme; the buyer list does", () => {
    assert.deepEqual([...SELLER_ID_SCHEMES].sort(), ["700", "CRN", "MLS", "MOM", "OTH", "SAG"]);
    assert.ok(BUYER_ID_SCHEMES.includes("NAT") && BUYER_ID_SCHEMES.includes("IQA"));
    assert.ok(!(SELLER_ID_SCHEMES as readonly string[]).includes("NAT"));
    assert.ok(!(SELLER_ID_SCHEMES as readonly string[]).includes("NID"));
  });

  it("infers the seller scheme from the number's shape, not from a CRN default", () => {
    assert.equal(inferSellerIdScheme("1037898051".replace(/\d/g, (d, i) => (i === 0 ? "1" : "0"))), "OTH"); // 1000000000-shaped national ID
    assert.equal(inferSellerIdScheme("2000000001"), "OTH"); // iqama
    assert.equal(inferSellerIdScheme("7000000001"), "700");
    assert.equal(inferSellerIdScheme("1010000000"), "OTH", "a 1-prefixed 10-digit number is a national ID, not a CR");
    assert.equal(inferSellerIdScheme("4030000001"), "CRN");
    assert.equal(inferSellerIdScheme(null), "CRN");
  });

  it("picks the buyer scheme by shape first, type second", () => {
    assert.equal(buyerIdScheme("7000000001", "company"), "700", "a unified number is 700 even on a company");
    assert.equal(buyerIdScheme("4030000001", "company"), "CRN");
    assert.equal(buyerIdScheme("1000000001", "individual"), "NAT");
    assert.equal(buyerIdScheme("2000000001", "individual"), "IQA");
    assert.equal(buyerIdScheme("AB123", "individual"), "OTH");
    assert.equal(buyerIdScheme("", "company"), null);
    assert.equal(buyerIdScheme(null, null), null);
  });

  it("checks the per-scheme formats the SDK warns on (F-08…F-11)", () => {
    assert.equal(idFormatError("CRN", "4030000001"), null);
    assert.match(idFormatError("CRN", "403000000")!, /10 digits/);
    assert.equal(idFormatError("700", "7000000001"), null);
    assert.match(idFormatError("700", "1000000001")!, /starting with 7/);
    assert.equal(idFormatError("NAT", "1000000001"), null);
    assert.match(idFormatError("IQA", "1000000001")!, /starting with 2/);
    assert.equal(idFormatError("OTH", "AB-123"), null);
    assert.match(idFormatError("OTH", "AB 123")!, /spaces/);
    assert.equal(idFormatError("OTH", ""), "empty");
  });
});
