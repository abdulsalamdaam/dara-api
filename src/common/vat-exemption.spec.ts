import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUYER_ID_SCHEMES,
  EXEMPTION_REASONS,
  SELLER_ID_SCHEMES,
  EXEMPTION_REASON_TEXT_MAX,
  buyerIdScheme,
  effectiveExemptionReasonText,
  exemptionReasonConflicts,
  exemptionReasonFor,
  normalizeExemptionReasonText,
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

describe("exemptionReasonConflicts — one reason, and one out-of-scope wording, per category", () => {
  it("refuses two different codes in one category (EN16931 BR-E-08)", () => {
    assert.deepEqual(exemptionReasonConflicts([
      { name: "rent", vatCategory: "E", exemptionReasonCode: "VATEX-SA-30" },
      { name: "loan fee", vatCategory: "E", exemptionReasonCode: "VATEX-SA-29" },
    ]), ["E: rent, loan fee"]);
  });

  it("refuses two O lines whose own wordings differ — the builder would print only the first", () => {
    assert.deepEqual(exemptionReasonConflicts([
      { name: "رسوم حكومية", vatCategory: "O", exemptionReasonText: "رسوم حكومية مستردة بالتكلفة" },
      { name: "غرامة", vatCategory: "O", exemptionReasonText: "تعويض لا يقابله توريد" },
    ]), ["O: رسوم حكومية, غرامة"]);
  });

  it("refuses own wording on one O line against the default on another — either way a statement is lost", () => {
    assert.equal(exemptionReasonConflicts([
      { name: "a", vatCategory: "O", exemptionReasonText: "رسوم حكومية مستردة" },
      { name: "b", vatCategory: "O" },
    ]).length, 1);
  });

  it("accepts O lines that agree, byte for byte after trimming", () => {
    assert.deepEqual(exemptionReasonConflicts([
      { name: "a", vatCategory: "O", exemptionReasonText: "رسوم حكومية مستردة & <بالتكلفة>" },
      { name: "b", vatCategory: "O", exemptionReasonCode: "VATEX-SA-OOS", exemptionReasonText: "  رسوم حكومية مستردة & <بالتكلفة> " },
      { name: "c", vatCategory: "S" },
    ]), []);
    assert.deepEqual(exemptionReasonConflicts([{ name: "a", vatCategory: "O" }, { name: "b", vatCategory: "O", exemptionReasonText: "  " }]), []);
  });

  it("ignores wording on E and Z lines — their text is always the official one", () => {
    assert.deepEqual(exemptionReasonConflicts([
      { name: "rent 1", vatCategory: "E", exemptionReasonCode: "VATEX-SA-30", exemptionReasonText: "anything" },
      { name: "rent 2", vatCategory: "E", exemptionReasonCode: "VATEX-SA-30" },
    ]), []);
  });
});

describe("BT-120 own wording", () => {
  it("cleans a landlord's text for a signed XML document", () => {
    assert.equal(normalizeExemptionReasonText("  رسوم\n حكومية\u0000 & <مستردة>  "), "رسوم حكومية & <مستردة>");
    assert.equal(normalizeExemptionReasonText("   "), undefined);
    assert.equal(normalizeExemptionReasonText(42), undefined);
    assert.equal(normalizeExemptionReasonText(null), undefined);
  });

  it("caps at 300 code points without splitting a character", () => {
    const long = "ع".repeat(EXEMPTION_REASON_TEXT_MAX + 50);
    assert.equal(Array.from(normalizeExemptionReasonText(long)!).length, EXEMPTION_REASON_TEXT_MAX);
    const emoji = "😀".repeat(EXEMPTION_REASON_TEXT_MAX + 1);
    assert.equal(normalizeExemptionReasonText(emoji), "😀".repeat(EXEMPTION_REASON_TEXT_MAX));
  });

  it("prints own wording only for O, the canonical text otherwise", () => {
    assert.equal(effectiveExemptionReasonText("O", "VATEX-SA-OOS", "own"), "own");
    assert.equal(effectiveExemptionReasonText("O", "VATEX-SA-OOS"), EXEMPTION_REASONS["VATEX-SA-OOS"]!.text);
    assert.equal(effectiveExemptionReasonText("E", "VATEX-SA-30", "own"), EXEMPTION_REASONS["VATEX-SA-30"]!.text);
  });

  it("the OOS canonical Arabic is grammatical («غير الخاضعة», not «الغير خاضعة»)", () => {
    assert.match(EXEMPTION_REASONS["VATEX-SA-OOS"]!.text, /التوريدات غير الخاضعة للضريبة/);
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
    assert.equal(inferSellerIdScheme("1038475612"), "OTH"); // a national ID
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
