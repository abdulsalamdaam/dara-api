import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { SellerSnapshot, BuyerSnapshot, InvoiceTotals } from "@dara/database";

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

function escapeXml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function money(n: unknown): string {
  return Number(n).toFixed(2);
}

function qty(n: unknown): string {
  return Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
}

export function todayIsoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
export function todayIsoTime(d: Date = new Date()): string {
  return d.toISOString().slice(11, 19);
}

export interface InvoiceLineInput {
  id?: string;
  name: string;
  unitCode?: string;
  quantity: number;
  unitPrice: number;
  vatPercent: number;
  vatCategory?: "S" | "Z" | "E" | "O";
}

/** Internal line shape after totals are computed. */
export interface ComputedLine extends InvoiceLineInput {
  id: string;
  unitCode: string;
  vatCategory: "S" | "Z" | "E" | "O";
  _lineNet: number;
  _lineVat: number;
  _lineTotalIncVat: number;
}

export interface BuildInvoiceInput {
  profile: "standard" | "simplified";
  docType: "invoice" | "credit" | "debit";
  invoiceId: string;
  uuid?: string;
  icv: number;
  pih: string;
  issueDate?: string;
  issueTime?: string;
  seller: SellerSnapshot;
  buyer?: BuyerSnapshot | null;
  lines: InvoiceLineInput[];
  billingReference?: { id: string };
  instructionNote?: string;
  paymentMeansCode?: string;
  currency?: string;
}

export interface BuildInvoiceResult {
  xml: string;
  uuid: string;
  totals: InvoiceTotals;
  computedLines: ComputedLine[];
}

@Injectable()
export class InvoiceBuilderService {
  /**
   * Compute invoice totals + per-line cached numbers. We round at every step
   * (line net, line VAT) to match what ZATCA expects on the wire — banker's
   * tricks here lead to fraction-of-a-halala drift that fails validation.
   */
  computeTotals(lines: InvoiceLineInput[]): { totals: InvoiceTotals; computed: ComputedLine[] } {
    let lineExtension = 0;
    let taxAmount = 0;
    const subtotalsByRate = new Map<string, { category: string; percent: number; taxable: number; tax: number }>();
    const computed: ComputedLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const qtyN = Number(line.quantity);
      const priceN = Number(line.unitPrice);
      const lineNet = +(qtyN * priceN).toFixed(2);
      const vatPct = Number(line.vatPercent || 0);
      const lineVat = +((lineNet * vatPct) / 100).toFixed(2);
      const lineTotalIncVat = +(lineNet + lineVat).toFixed(2);
      const cat = (line.vatCategory || "S") as "S" | "Z" | "E" | "O";

      computed.push({
        ...line,
        id: line.id ?? String(i + 1),
        unitCode: line.unitCode ?? "PCE",
        vatCategory: cat,
        _lineNet: lineNet,
        _lineVat: lineVat,
        _lineTotalIncVat: lineTotalIncVat,
      });

      lineExtension += lineNet;
      taxAmount += lineVat;
      const key = `${cat}|${vatPct}`;
      if (!subtotalsByRate.has(key)) {
        subtotalsByRate.set(key, { category: cat, percent: vatPct, taxable: 0, tax: 0 });
      }
      const sub = subtotalsByRate.get(key)!;
      sub.taxable += lineNet;
      sub.tax += lineVat;
    }

    const totals: InvoiceTotals = {
      lineExtension: +lineExtension.toFixed(2),
      taxExclusive: +lineExtension.toFixed(2),
      taxAmount: +taxAmount.toFixed(2),
      taxInclusive: +(lineExtension + taxAmount).toFixed(2),
      payable: +(lineExtension + taxAmount).toFixed(2),
      subtotals: Array.from(subtotalsByRate.values()).map((s) => ({
        ...s,
        taxable: +s.taxable.toFixed(2),
        tax: +s.tax.toFixed(2),
      })),
    };
    return { totals, computed };
  }

  /**
   * Build the unsigned UBL 2.1 invoice XML. Same shape ZATCA expects across
   * all three doc types (invoice/credit/debit) — discriminated by the
   * <InvoiceTypeCode> code (388 / 381 / 383) and presence of BillingReference.
   *
   * Notes that survived hard-won debugging:
   *   - Whitespace inside the invoice body matters: anything we add becomes
   *     a text node that survives the strip-and-canonicalize transform later
   *     when we sign, and must not change between hash-time and submit-time.
   *   - <AccountingCustomerParty> is REQUIRED even for B2C cash sales — emit a
   *     minimal block when buyer is null.
   *   - Both <TaxTotal> blocks (with and without subtotals) are required.
   */
  build(input: BuildInvoiceInput): BuildInvoiceResult {
    const {
      profile = "standard",
      docType = "invoice",
      invoiceId,
      uuid = randomUUID(),
      icv,
      pih,
      issueDate = todayIsoDate(),
      issueTime = todayIsoTime(),
      seller,
      buyer,
      lines,
      billingReference,
      instructionNote,
      paymentMeansCode = "10",
      currency = "SAR",
    } = input;

    const { totals, computed } = this.computeTotals(lines);

    const invoiceTypeName = profile === "simplified" ? "0200000" : "0100000";
    const invoiceTypeCode = docType === "credit" ? "381" : docType === "debit" ? "383" : "388";
    const profileId = "reporting:1.0";

    const billingRefXml = billingReference
      ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(
          billingReference.id,
        )}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`
      : "";

    const noteXml = instructionNote
      ? `<cbc:Note languageID="en">${escapeXml(instructionNote)}</cbc:Note>`
      : "";

    const addressXml = (a: Record<string, unknown> | null | undefined) => {
      if (!a) return "";
      return `<cac:PostalAddress>
        ${a.street ? `<cbc:StreetName>${escapeXml(a.street)}</cbc:StreetName>` : ""}
        ${a.buildingNo ? `<cbc:BuildingNumber>${escapeXml(a.buildingNo)}</cbc:BuildingNumber>` : ""}
        ${a.additionalNo ? `<cbc:PlotIdentification>${escapeXml(a.additionalNo)}</cbc:PlotIdentification>` : ""}
        ${a.district ? `<cbc:CitySubdivisionName>${escapeXml(a.district)}</cbc:CitySubdivisionName>` : ""}
        ${a.city ? `<cbc:CityName>${escapeXml(a.city)}</cbc:CityName>` : ""}
        ${a.postalZone ? `<cbc:PostalZone>${escapeXml(a.postalZone)}</cbc:PostalZone>` : ""}
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;
    };

    const sellerXml = `<cac:AccountingSupplierParty>
    <cac:Party>
      ${
        seller.crn
          ? `<cac:PartyIdentification><cbc:ID schemeID="${escapeXml(seller.idScheme || "CRN")}">${escapeXml(seller.crn)}</cbc:ID></cac:PartyIdentification>`
          : ""
      }
      ${addressXml(seller as unknown as Record<string, unknown>)}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(seller.vat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`;

    const b = (buyer || {}) as Record<string, unknown>;
    const buyerXml = `<cac:AccountingCustomerParty>
    <cac:Party>
      ${addressXml(b)}
      ${
        b.vat
          ? `<cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(b.vat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`
          : `<cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
      }
      <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(b.name || "Anonymous")}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;

    const linesXml = computed
      .map((line) => {
        const cat = line.vatCategory;
        const pct = Number(line.vatPercent || 0);
        return `<cac:InvoiceLine>
    <cbc:ID>${escapeXml(line.id)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${escapeXml(line.unitCode)}">${qty(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${money(line._lineNet)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${money(line._lineVat)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${currency}">${money(line._lineTotalIncVat)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(line.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${cat}</cbc:ID>
        <cbc:Percent>${money(pct)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${money(line.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
      })
      .join("\n  ");

    // Non-standard categories (E/Z/O) MUST carry a tax-exemption reason or ZATCA
    // rejects the document. Map each to its KSA reason code.
    // KSA VAT exemption-reason codes. This is a property-management product, so
    // an Exempt (E) supply is residential real-estate leasing → Article 30
    // (VATEX-SA-30). Zero-rated/out-of-scope keep their general codes.
    const EXEMPTION: Record<string, { code: string; text: string }> = {
      E: { code: "VATEX-SA-30", text: "Real estate transactions exempt from VAT under Article 30 of the VAT Regulations" },
      Z: { code: "VATEX-SA-32", text: "Export of goods" },
      O: { code: "VATEX-SA-OOS", text: "Not subject to VAT" },
    };
    const taxSubtotalsXml = totals.subtotals
      .map((s) => {
        const ex = s.category !== "S" ? EXEMPTION[s.category] : null;
        return `<cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${money(s.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${money(s.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${s.category}</cbc:ID>
        <cbc:Percent>${money(s.percent)}</cbc:Percent>${ex ? `
        <cbc:TaxExemptionReasonCode>${ex.code}</cbc:TaxExemptionReasonCode>
        <cbc:TaxExemptionReason>${escapeXml(ex.text)}</cbc:TaxExemptionReason>` : ""}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
      })
      .join("\n    ");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="${NS.inv}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ext="${NS.ext}">
  <cbc:ProfileID>${profileId}</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoiceId)}</cbc:ID>
  <cbc:UUID>${escapeXml(uuid)}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeName}">${invoiceTypeCode}</cbc:InvoiceTypeCode>
  ${noteXml}
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${currency}</cbc:TaxCurrencyCode>
  ${billingRefXml}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${Number(icv)}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(pih)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  ${sellerXml}
  ${buyerXml}
  <cac:Delivery>
    <cbc:ActualDeliveryDate>${issueDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${escapeXml(paymentMeansCode)}</cbc:PaymentMeansCode>
    ${
      docType !== "invoice"
        ? `<cbc:InstructionNote>${escapeXml(instructionNote || "Correction")}</cbc:InstructionNote>`
        : ""
    }
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${money(totals.taxAmount)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${money(totals.taxAmount)}</cbc:TaxAmount>
    ${taxSubtotalsXml}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${money(totals.lineExtension)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${money(totals.taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${money(totals.taxInclusive)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${currency}">0.00</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="${currency}">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${currency}">${money(totals.payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${linesXml}
</Invoice>`;

    return { xml, uuid, totals, computedLines: computed };
  }
}
