/**
 * Build and sign one of every document shape Dara can issue, so ZATCA's own
 * SDK validator can rule on them. Run by `.github/workflows/zatca-validate.yml`
 * on every push; run it by hand the same way when changing the signer.
 *
 *   tsx scripts/zatca-sample-matrix.ts --cert cert.pem --key key.pem --out ./out
 *
 * The certificate and key are whatever you want the documents signed with — in
 * CI they are the test pair the ZATCA SDK ships, which is what lets the SDK
 * verify the signature it finds inside. Nothing here talks to a database or to
 * ZATCA; it only writes files.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InvoiceBuilderService } from "../src/modules/invoice/services/invoice-builder.service";
import { InvoiceSignerService } from "../src/modules/invoice/services/invoice-signer.service";
import { ShellService } from "../src/modules/invoice/services/shell.service";
import { QrService } from "../src/modules/invoice/services/qr.service";
import type { SellerSnapshot } from "@dara/database";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v && fallback === undefined) throw new Error(`missing --${name}`);
  return v ?? (fallback as string);
}

const certPem = readFileSync(arg("cert"), "utf8");
const privateKeyPem = readFileSync(arg("key"), "utf8");
const outDir = arg("out", "./zatca-samples");

// A complete Saudi seller — every ZATCA-mandatory address field present, which
// BR-KSA-63 requires on a standard invoice.
const seller: SellerSnapshot = {
  name: "شركة دارا لإدارة الأملاك",
  nameAr: "شركة دارا لإدارة الأملاك",
  vat: "399999999900003",
  crn: "1010000000",
  idScheme: "CRN",
  street: "طريق الملك عبدالعزيز",
  buildingNo: "8228",
  district: "المروج",
  city: "الرياض",
  postalZone: "12283",
  additionalNo: "2223",
} as SellerSnapshot;

const buyer = {
  name: "شركة المستأجر التجارية",
  // Must differ from the seller's: BR-CUSTOM-VALIDATION-01 rejects a document
  // where buyer and seller carry the same VAT number, and invoice.service
  // refuses to build one for the same reason.
  vat: "311111111101113",
  street: "طريق الملك فهد",
  buildingNo: "1234",
  district: "العليا",
  city: "الرياض",
  postalZone: "12345",
  additionalNo: "0000",
};

const commercialRent = { id: "1", name: "إيجار تجاري", quantity: 1, unitPrice: 20000, vatPercent: 15, vatCategory: "S" as const };
// Residential rent is VAT-exempt and the management fee on top is not — a
// mixed document is the shape Dara issues most often, so it is in the matrix.
const residentialRent = { id: "1", name: "إيجار سكني", quantity: 1, unitPrice: 15000, vatPercent: 0, vatCategory: "E" as const };
const managementFee = { id: "2", name: "رسوم إدارة الأملاك", quantity: 1, unitPrice: 750, vatPercent: 15, vatCategory: "S" as const };

const walkIn = { name: "عميل نقدي" };

const MATRIX = [
  { file: "01-standard-invoice", profile: "standard", docType: "invoice", buyer, lines: [commercialRent] },
  { file: "02-standard-credit", profile: "standard", docType: "credit", buyer, lines: [commercialRent], ref: true },
  { file: "03-standard-debit", profile: "standard", docType: "debit", buyer, lines: [commercialRent], ref: true },
  { file: "04-simplified-invoice", profile: "simplified", docType: "invoice", buyer: walkIn, lines: [commercialRent] },
  { file: "05-simplified-credit", profile: "simplified", docType: "credit", buyer: walkIn, lines: [commercialRent], ref: true },
  { file: "06-simplified-debit", profile: "simplified", docType: "debit", buyer: walkIn, lines: [commercialRent], ref: true },
  { file: "07-standard-mixed-exempt", profile: "standard", docType: "invoice", buyer, lines: [residentialRent, managementFee] },
  { file: "08-simplified-mixed-exempt", profile: "simplified", docType: "invoice", buyer: walkIn, lines: [residentialRent, managementFee] },
  { file: "09-standard-zero-rated", profile: "standard", docType: "invoice", buyer,
    lines: [{ id: "1", name: "خدمة مصدرة", quantity: 1, unitPrice: 5000, vatPercent: 0, vatCategory: "Z" as const }] },
  { file: "10-standard-multiline", profile: "standard", docType: "invoice", buyer,
    lines: [commercialRent, managementFee, { id: "3", name: "صيانة", quantity: 3, unitPrice: 133.33, vatPercent: 15, vatCategory: "S" as const }] },
] as const;

async function main() {
  const builder = new InvoiceBuilderService();
  const signer = new InvoiceSignerService(new ShellService(), new QrService());
  // The SDK compares a document's PIH against the one in its own PIH file, so
  // the whole matrix chains off the same seed rather than off each other.
  const pih = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

  mkdirSync(outDir, { recursive: true });
  let icv = 0;
  for (const spec of MATRIX) {
    icv += 1;
    const built = builder.build({
      profile: spec.profile,
      docType: spec.docType,
      invoiceId: `VAL-${icv}`,
      icv,
      pih,
      seller,
      buyer: spec.buyer as any,
      lines: spec.lines as any,
      billingReference: "ref" in spec && spec.ref ? { id: "VAL-1" } : undefined,
      instructionNote: "ref" in spec && spec.ref ? "تصحيح قيمة الفاتورة" : undefined,
      currency: "SAR",
    });
    const signed = await signer.signInvoice({
      invoiceXml: built.xml,
      privateKeyPem,
      certPem,
      profile: spec.profile,
      qrFields: {
        sellerName: seller.name,
        vatNumber: seller.vat,
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        totalWithVat: built.totals.taxInclusive.toFixed(2),
        vatTotal: built.totals.taxAmount.toFixed(2),
      },
    });
    writeFileSync(path.join(outDir, `${spec.file}.xml`), signed.signedXml, "utf8");
    console.log(`wrote ${spec.file}.xml`);
  }
  writeFileSync(path.join(outDir, "pih.txt"), pih, "utf8");
  console.log(`\n${MATRIX.length} documents in ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
