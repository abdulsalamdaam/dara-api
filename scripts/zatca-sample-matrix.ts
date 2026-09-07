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

// ---------------------------------------------------------------------------
// One REAL document, reproduced field-for-field.
//
// A standard invoice a live landlord issued was refused by ZATCA with
// `401 Invalid-Authentication-Certificate` — a problem with the certificate,
// not the document, and since fixed by re-onboarding. Before that customer is
// asked to retry we want ZATCA's own verdict on the DOCUMENT, so a second
// attempt does not fail for a second, different reason. Nothing below touches
// a database: every value is transcribed from the document itself.
//
// Note `idScheme: "OTH"` on the seller. The field is called `crn`, but this
// seller identifies with a national ID, and OTH is ZATCA's scheme for one —
// NAT and IQA are not valid values (DARA-NOTES §2b-i).
const realSeller: SellerSnapshot = {
  name: "ابراهيم العقيل",
  nameAr: "ابراهيم العقيل",
  vat: "310404305800003",
  crn: "1037898051",
  idScheme: "OTH",
  street: "19ا",
  buildingNo: "6802",
  district: "الفيصلية",
  city: "الدمام",
  postalZone: "32272",
  additionalNo: "3988",
} as SellerSnapshot;

const realBuyerAddress = {
  name: "شركة بيلا سيلك",
  vat: "311311625400003",
  street: "5ح",
  buildingNo: "7148",
  district: "الشاطئ الغربي",
  city: "الدمام",
  postalZone: "32413",
  additionalNo: "3093",
};

// The element under test. `buyerFromParty` fills the buyer's `id` from the
// tenant's `national_id` and picks the scheme from the party TYPE — so a tenant
// recorded as a company publishes that number as `schemeID="CRN"`. But
// 7037911018 is a 7-prefixed ten-digit number, which is the shape of a UNIFIED
// NATIONAL NUMBER, whose ZATCA scheme is 700 and not CRN. The element is
// optional for a VAT-registered buyer and no sample in the matrix above
// carries one at all, so nothing has ever asked ZATCA what it makes of the
// three possibilities. These do, separately.
const realBuyerNationalNumber = "7037911018";
const realBuyerCrnScheme = { ...realBuyerAddress, id: realBuyerNationalNumber, idScheme: "CRN" };
const realBuyerNoId = realBuyerAddress;
const realBuyer700Scheme = { ...realBuyerAddress, id: realBuyerNationalNumber, idScheme: "700" };

// 50,000.00 taxable + 2,500.00 exempt = net 52,500.00, VAT 7,500.00,
// gross 60,000.00 — the totals printed on the document.
const realRent = { id: "1", name: "الإيجار", quantity: 1, unitPrice: 50000, vatPercent: 15, vatCategory: "S" as const };
const realWater = { id: "2", name: "المياه", quantity: 1, unitPrice: 2500, vatPercent: 0, vatCategory: "E" as const };

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

  // The real document, three ways. Same seller, same buyer, same two lines,
  // same first-in-chain position (icv 1 against the initial PIH seed) — the
  // buyer's PartyIdentification is the ONLY thing that differs, so whatever the
  // SDK says about one and not another is about that element and nothing else.
  { file: "11-real-standard-buyerid-crn", profile: "standard", docType: "invoice",
    buyer: realBuyerCrnScheme, seller: realSeller, lines: [realRent, realWater], icv: 1 },
  { file: "12-real-standard-buyerid-omitted", profile: "standard", docType: "invoice",
    buyer: realBuyerNoId, seller: realSeller, lines: [realRent, realWater], icv: 1 },
  { file: "13-real-standard-buyerid-700", profile: "standard", docType: "invoice",
    buyer: realBuyer700Scheme, seller: realSeller, lines: [realRent, realWater], icv: 1 },
] as const;

async function main() {
  const builder = new InvoiceBuilderService();
  const signer = new InvoiceSignerService(new ShellService(), new QrService());
  // The SDK compares a document's PIH against the one in its own PIH file, so
  // the whole matrix chains off the same seed rather than off each other.
  const pih = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

  mkdirSync(outDir, { recursive: true });
  let seq = 0;
  for (const spec of MATRIX) {
    seq += 1;
    // The document number stays one-per-sample so no two files collide, but the
    // ICV is the sample's own when it declares one: a document reproducing a
    // real first-in-chain invoice has to say icv 1, because that is the only
    // value the initial PIH seed is valid against.
    const icv = "icv" in spec ? (spec.icv as number) : seq;
    const docSeller: SellerSnapshot = ("seller" in spec ? spec.seller : seller) as SellerSnapshot;
    const built = builder.build({
      profile: spec.profile,
      docType: spec.docType,
      invoiceId: `VAL-${seq}`,
      icv,
      pih,
      seller: docSeller,
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
        sellerName: docSeller.name,
        vatNumber: docSeller.vat,
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
