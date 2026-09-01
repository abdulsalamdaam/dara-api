import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ShellService } from "./shell.service";
import { QrService } from "./qr.service";
import { CsrService } from "./csr.service";
import { InvoiceBuilderService } from "./invoice-builder.service";
import { InvoiceSignerService } from "./invoice-signer.service";
import type { SellerSnapshot } from "@dara/database";

/** Skip signing tests in environments without openssl/xmllint/xsltproc. */
function hasCliTools(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    execFileSync("xmllint", ["--version"], { stdio: "ignore" });
    execFileSync("xsltproc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const shouldRun = hasCliTools();

describe("InvoiceSignerService (integration)", { skip: !shouldRun && "openssl/xmllint/xsltproc unavailable" }, () => {
  const shell = new ShellService();
  const qr = new QrService();
  const csr = new CsrService(shell);
  const builder = new InvoiceBuilderService();
  const signer = new InvoiceSignerService(shell, qr);

  let privateKeyPem: string;
  let certPem: string;

  before(async () => {
    if (!shouldRun) return;
    // Generate an EC keypair + self-signed cert via openssl. ZATCA's pipeline
    // doesn't actually verify the chain locally — the cert just needs to parse
    // and have an extractable public key + signature, which a self-signed one does.
    const out = await csr.generateCsr({
      environment: "sandbox",
      commonName: "TST-Test",
      serialNumber: "1-EGS|2-MODEL|3-aaaaaaaa",
      organizationIdentifier: "399999999900003",
      organizationUnitName: "Riyadh Branch",
      organizationName: "Test Co",
      countryName: "SA",
      invoiceType: "1100",
      locationAddress: "Riyadh",
      industryCategory: "Retail",
    });
    privateKeyPem = out.privateKey;

    // Build a self-signed cert from the same key.
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-cert-test-"));
    const keyPath = path.join(tmp, "key.pem");
    const certPath = path.join(tmp, "cert.pem");
    await fs.writeFile(keyPath, privateKeyPem, "utf8");
    const r = spawnSync("openssl", [
      "req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/C=SA/O=Test Co/OU=Riyadh Branch/CN=TST-Test",
    ]);
    if (r.status !== 0) throw new Error("self-sign failed: " + r.stderr.toString());
    certPem = await fs.readFile(certPath, "utf8");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("computes a deterministic invoice hash for the same XML", async () => {
    const seller: SellerSnapshot = {
      name: "Test Co", vat: "399999999900003", crn: "1010000000",
      street: "King Fahd", buildingNo: "1", district: "Olaya",
      city: "Riyadh", postalZone: "12345", additionalNo: "0000",
    };
    const built = builder.build({
      profile: "standard", docType: "invoice", invoiceId: "T-1",
      icv: 1, pih: "AAAA", seller, lines: [{ name: "X", quantity: 1, unitPrice: 1, vatPercent: 15 }],
    });
    const a = await signer.computeInvoiceHash(built.xml);
    const b = await signer.computeInvoiceHash(built.xml);
    assert.equal(a.hashBase64, b.hashBase64);
    assert.match(a.hashBase64, /^[A-Za-z0-9+/=]{40,}/);
  });

  it("signs a simplified invoice and embeds UBLExtensions/Signature/QR", async () => {
    const seller: SellerSnapshot = {
      name: "Test Co", vat: "399999999900003", crn: "1010000000",
      street: "King Fahd", buildingNo: "1", district: "Olaya",
      city: "Riyadh", postalZone: "12345", additionalNo: "0000",
    };
    const built = builder.build({
      profile: "simplified", docType: "invoice", invoiceId: "T-2",
      icv: 1, pih: "AAAA", seller,
      lines: [{ name: "Burger", quantity: 2, unitPrice: 25, vatPercent: 15 }],
    });
    const r = await signer.signInvoice({
      invoiceXml: built.xml,
      privateKeyPem,
      certPem,
      profile: "simplified",
      qrFields: {
        sellerName: seller.name,
        vatNumber: seller.vat,
        timestamp: "2026-05-08T10:00:00",
        totalWithVat: "57.50",
        vatTotal: "7.50",
      },
    });
    assert.ok(r.signedXml.includes("<ext:UBLExtensions"), "missing UBLExtensions");
    assert.ok(r.signedXml.includes("<cac:Signature>"), "missing Signature block");
    assert.ok(r.signedXml.includes("<cbc:ID>QR</cbc:ID>"), "missing QR ref");
    assert.ok(r.qrBase64.length > 0, "qrBase64 empty");
    assert.ok(r.invoiceHashBase64.length > 0, "invoiceHash empty");
    assert.ok(r.signatureValueBase64.length > 0, "signature empty");
  });
});

/**
 * The seller's name reaches ZATCA through the CSR's subject, and Fatoora
 * displays that subject verbatim. Without `utf8 = yes` in the openssl config,
 * Arabic went in double-encoded and the portal showed "Ø§Ø¨Ø±Ø§Ù‡ÙŠÙ…".
 */
describe("CsrService — Arabic in the certificate subject", { skip: !shouldRun && "openssl unavailable" }, () => {
  const csr = new CsrService(new ShellService());

  it("puts Arabic into the CSR subject as Arabic", async () => {
    const arabicName = "ابراهيم العقيل";
    const out = await csr.generateCsr({
      environment: "sandbox",
      commonName: arabicName,
      serialNumber: "1-Dara|2-PMS|3-1",
      organizationIdentifier: "310404305800003",
      organizationUnitName: "الرياض",
      organizationName: arabicName,
      countryName: "SA",
      invoiceType: "1100",
      // ASCII, because these two land in the subjectAltName rather than the
      // subject. `utf8 = yes` does not reach that section — openssl parses it
      // as Latin-1 regardless — so Arabic there is double-encoded and then
      // silently truncated away along with every attribute after it. The
      // subject fields above are the ones this test is actually about.
      locationAddress: "6802 32272 SA",
      industryCategory: "Real estate",
    });

    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "csr-utf8-"));
    const file = path.join(dir, "req.csr");
    await fs.writeFile(file, out.csr, "utf8");
    const subject = execFileSync("openssl",
      ["req", "-in", file, "-noout", "-subject", "-nameopt", "utf8,sep_comma_plus_space"],
      { encoding: "utf8" });
    await fs.rm(dir, { recursive: true, force: true });

    assert.ok(subject.includes(arabicName), `Arabic was mangled in the subject: ${subject}`);
    // The signature of double encoding: every Arabic byte rendered as two
    // Latin-1 characters.
    assert.ok(!subject.includes("Ø"), `subject is double-encoded: ${subject}`);
  });
});
