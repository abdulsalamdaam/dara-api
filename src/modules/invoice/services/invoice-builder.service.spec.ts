import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InvoiceBuilderService } from "./invoice-builder.service";
import type { SellerSnapshot } from "@dara/database";

const seller: SellerSnapshot = {
  name: "Test Seller Co.",
  vat: "399999999900003",
  crn: "1010000000",
  street: "King Fahd Rd",
  buildingNo: "1234",
  district: "Al Olaya",
  city: "Riyadh",
  postalZone: "12345",
  additionalNo: "0000",
};

describe("InvoiceBuilderService", () => {
  const builder = new InvoiceBuilderService();

  describe("computeTotals", () => {
    it("rounds line numbers to halalas (2dp)", () => {
      const { totals, computed } = builder.computeTotals([
        { name: "Foo", quantity: 3, unitPrice: 10.123, vatPercent: 15 },
      ]);
      // 3 * 10.123 = 30.369 -> 30.37 (banker's? no, .toFixed(2) = "30.37")
      assert.equal(computed[0]._lineNet, 30.37);
      assert.equal(computed[0]._lineVat, 4.56); // 30.37 * 0.15 = 4.5555 -> 4.56
      assert.equal(totals.payable, 34.93);
    });

    it("groups subtotals by category and rate", () => {
      const { totals } = builder.computeTotals([
        { name: "A", quantity: 1, unitPrice: 100, vatPercent: 15 },
        { name: "B", quantity: 1, unitPrice: 200, vatPercent: 15 },
        { name: "C", quantity: 1, unitPrice: 50, vatPercent: 0, vatCategory: "Z" },
      ]);
      assert.equal(totals.subtotals.length, 2);
      const standard = totals.subtotals.find((s) => s.category === "S")!;
      const zero = totals.subtotals.find((s) => s.category === "Z")!;
      assert.equal(standard.taxable, 300);
      assert.equal(standard.tax, 45);
      assert.equal(zero.taxable, 50);
      assert.equal(zero.tax, 0);
    });

    it("totals match across the API surface", () => {
      const { totals } = builder.computeTotals([
        { name: "X", quantity: 2, unitPrice: 50, vatPercent: 15 },
      ]);
      assert.equal(totals.lineExtension, 100);
      assert.equal(totals.taxExclusive, 100);
      assert.equal(totals.taxAmount, 15);
      assert.equal(totals.taxInclusive, 115);
      assert.equal(totals.payable, 115);
    });
  });

  describe("build", () => {
    it("emits well-formed UBL with required elements", () => {
      const r = builder.build({
        profile: "standard",
        docType: "invoice",
        invoiceId: "INV-T-001",
        icv: 1,
        pih: "AAAA",
        seller,
        buyer: { name: "Buyer Co.", vat: "311111111100003" },
        lines: [{ name: "Service", quantity: 1, unitPrice: 100, vatPercent: 15 }],
      });
      assert.match(r.xml, /<\?xml version="1\.0"/);
      assert.match(r.xml, /<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/);
      assert.match(r.xml, /<cbc:ID>INV-T-001<\/cbc:ID>/);
      assert.match(r.xml, /<cbc:UUID>[0-9a-f-]{36}<\/cbc:UUID>/);
      assert.match(r.xml, /<cbc:InvoiceTypeCode name="0100000">388<\/cbc:InvoiceTypeCode>/);
      assert.match(r.xml, /<cac:AccountingSupplierParty>/);
      assert.match(r.xml, /<cac:AccountingCustomerParty>/);
      assert.match(r.xml, /Test Seller Co\./);
      assert.match(r.xml, /Buyer Co\./);
      assert.match(r.xml, /<cbc:ProfileID>reporting:1\.0<\/cbc:ProfileID>/);
      assert.match(r.xml, /<cbc:DocumentCurrencyCode>SAR<\/cbc:DocumentCurrencyCode>/);
    });

    it("uses 0200000 invoiceTypeName for simplified profile", () => {
      const r = builder.build({
        profile: "simplified", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z", seller, lines: [
          { name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 },
        ],
      });
      assert.match(r.xml, /name="0200000"/);
    });

    it("uses 381 for credit notes and emits BillingReference", () => {
      const r = builder.build({
        profile: "standard", docType: "credit", invoiceId: "C-1", icv: 1, pih: "Z",
        seller,
        billingReference: { id: "INV-001" },
        instructionNote: "Refund — wrong line",
        lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      assert.match(r.xml, />381</);
      assert.match(r.xml, /<cac:BillingReference>/);
      assert.match(r.xml, /INV-001/);
      assert.match(r.xml, /Refund — wrong line/);
    });

    it("emits a minimal customer block when buyer is null (B2C)", () => {
      const r = builder.build({
        profile: "simplified", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z",
        seller, lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      assert.match(r.xml, /<cac:AccountingCustomerParty>/);
      assert.match(r.xml, /Anonymous/);
    });

    it("identifies the buyer on a standard invoice (BT-46), with the scheme it was given", () => {
      const r = builder.build({
        profile: "standard", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z", seller,
        buyer: { name: "Buyer Co.", vat: "311111111100003", id: "4030000001", idScheme: "CRN" },
        lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      assert.match(r.xml, /<cac:AccountingCustomerParty>[\s\S]*?<cac:PartyIdentification><cbc:ID schemeID="CRN">4030000001<\/cbc:ID>/);
    });

    it("does NOT identify the buyer on a simplified invoice", () => {
      const r = builder.build({
        profile: "simplified", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z", seller,
        buyer: { name: "Walk-in", id: "1000000003", idScheme: "OTH" },
        lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      // A B2C document goes to a consumer who has no identifier to state, and
      // ZATCA does not ask for one — an invented or empty element is worse than
      // no element.
      const customer = r.xml.slice(r.xml.indexOf("<cac:AccountingCustomerParty>"));
      assert.ok(!customer.includes("<cac:PartyIdentification>"), "no buyer identification on simplified");
    });

    it("omits the buyer identification when there is no id to state", () => {
      const r = builder.build({
        profile: "standard", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z", seller,
        buyer: { name: "Buyer Co.", vat: "311111111100003" },
        lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      const customer = r.xml.slice(r.xml.indexOf("<cac:AccountingCustomerParty>"));
      assert.ok(!customer.includes("<cac:PartyIdentification>"));
    });

    it("escapes XML metacharacters in seller/buyer/line names", () => {
      const r = builder.build({
        profile: "standard", docType: "invoice", invoiceId: "X", icv: 1, pih: "Z",
        seller: { ...seller, name: 'A & "B" <C>' },
        buyer: { name: "Q'Uote" },
        lines: [{ name: "Tom & Jerry's <show>", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      assert.ok(!r.xml.includes("A & \""), "raw ampersand not escaped");
      assert.match(r.xml, /A &amp; &quot;B&quot;/);
      assert.match(r.xml, /Q&apos;Uote/);
      assert.match(r.xml, /Tom &amp; Jerry&apos;s/);
    });

    it("includes ICV and PIH AdditionalDocumentReference blocks", () => {
      const r = builder.build({
        profile: "standard", docType: "invoice", invoiceId: "X", icv: 42, pih: "PIH-VAL",
        seller, lines: [{ name: "S", quantity: 1, unitPrice: 1, vatPercent: 15 }],
      });
      assert.match(r.xml, /<cbc:ID>ICV<\/cbc:ID>\s*<cbc:UUID>42<\/cbc:UUID>/);
      assert.match(r.xml, /<cbc:ID>PIH<\/cbc:ID>[\s\S]*?PIH-VAL/);
    });
  });
});
