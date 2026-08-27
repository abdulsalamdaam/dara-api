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

  it("re-hashes the signed document to the hash it stamped", async () => {
    // ZATCA recomputes the invoice hash from the document we send, stripping
    // UBLExtensions/Signature/QR again. Injecting those three must therefore
    // leave no whitespace behind, or its hash and ours diverge.
    const seller: SellerSnapshot = {
      name: "Test Co", vat: "399999999900003", crn: "1010000000",
      street: "King Fahd", buildingNo: "1", district: "Olaya",
      city: "Riyadh", postalZone: "12345", additionalNo: "0000",
    };
    const built = builder.build({
      profile: "simplified", docType: "invoice", invoiceId: "T-4",
      icv: 1, pih: "AAAA", seller,
      lines: [{ name: "Burger", quantity: 1, unitPrice: 10, vatPercent: 15 }],
    });
    const r = await signer.signInvoice({
      invoiceXml: built.xml, privateKeyPem, certPem, profile: "simplified",
      qrFields: {
        sellerName: seller.name, vatNumber: seller.vat,
        timestamp: "2026-05-08T10:00:00", totalWithVat: "11.50", vatTotal: "1.50",
      },
    });
    const rehash = await signer.computeInvoiceHash(r.signedXml);
    assert.equal(rehash.hashBase64, r.invoiceHashBase64);
  });

  it("formats the issuer the way ZATCA's sample does", async () => {
    const { issuer } = await signer.inspectCert(certPem);
    // Most-specific RDN first, ", " between them — e.g. ZATCA's own
    // "CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local".
    assert.match(issuer, /^CN=/);
    if (issuer.includes(",")) assert.match(issuer, /, /);
    assert.ok(!/,[^ ]/.test(issuer), `issuer RDNs must be separated by ", ": ${issuer}`);
  });

  it("stamps the invoice hash itself, not the canonicalized SignedInfo", async () => {
    const seller: SellerSnapshot = {
      name: "Test Co", vat: "399999999900003", crn: "1010000000",
      street: "King Fahd", buildingNo: "1", district: "Olaya",
      city: "Riyadh", postalZone: "12345", additionalNo: "0000",
    };
    const built = builder.build({
      profile: "simplified", docType: "invoice", invoiceId: "T-3",
      icv: 1, pih: "AAAA", seller,
      lines: [{ name: "Burger", quantity: 1, unitPrice: 10, vatPercent: 15 }],
    });
    const r = await signer.signInvoice({
      invoiceXml: built.xml, privateKeyPem, certPem, profile: "simplified",
      qrFields: {
        sellerName: seller.name, vatNumber: seller.vat,
        timestamp: "2026-05-08T10:00:00", totalWithVat: "11.50", vatTotal: "1.50",
      },
    });
    // ZATCA's cryptographic stamp is ECDSA-SHA256 over the decoded invoice
    // hash. This is what its published sample verifies against, and signing
    // the canonicalized SignedInfo instead — as plain XMLDSig would — is what
    // the B2C reporting endpoint refused.
    const { createVerify, X509Certificate } = await import("node:crypto");
    const publicKey = new X509Certificate(certPem).publicKey;
    const verify = createVerify("sha256");
    verify.update(Buffer.from(r.invoiceHashBase64, "base64"));
    assert.ok(
      verify.verify(publicKey, Buffer.from(r.signatureValueBase64, "base64")),
      "SignatureValue does not verify against the invoice hash",
    );
    // ...and the same value is what the QR carries as tag 7.
    const embedded = r.signedXml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)?.[1];
    assert.equal(embedded, r.signatureValueBase64);
  });
});

/**
 * Pinned to ZATCA's own published signed sample — the e-invoicing SDK's
 * Data/Samples/Simplified/Invoice/Simplified_Invoice.xml. Those numbers are
 * the only external oracle we have for the two recipes ZATCA does not spell
 * out (how SignedProperties is serialized before hashing, and how the digest
 * is encoded), so they are asserted here rather than trusted to a comment.
 */
describe("InvoiceSignerService — ZATCA sample vectors", () => {
  const signer = new InvoiceSignerService(new ShellService(), new QrService());

  const sample = {
    signingTime: "2023-01-24T11:16:44Z",
    certHashBase64: "YTJkM2JhYTcwZTBhZTAxOGYwODMyNzY3NTdkZDM3YzhjY2IxOTIyZDZhM2RlZGJiMGY0NDUzZWJhYWI4MDhmYg==",
    certIssuer: "CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local",
    certSerial: "2475382886904809774818644480820936050208702411",
  };
  const sampleDigest =
    "N2MxMGJkZWM4MDdlYWY0ODY1ZDk0YTk3NGZhYmE4NjI5ZDM2ODYxMjg3ZDAwZDQzMmRjOTNjZTkxYjU0OWJmNw==";

  it("reproduces the sample's SignedProperties digest", () => {
    const forHashing = signer.buildSignedPropertiesForHashing(sample);
    assert.equal(signer.hashSignedProperties(forHashing), sampleDigest);
  });

  it("emits the digest as base64 of the hex, not of the raw bytes", () => {
    // 88 characters, not 44 — a plain base64 digest is what ZATCA's reporting
    // endpoint rejected as "Invalid signed properties hashing".
    assert.equal(sampleDigest.length, 88);
    assert.equal(
      Buffer.from(signer.hashSignedProperties(signer.buildSignedPropertiesForHashing(sample)), "base64").length,
      64,
    );
  });

  it("embeds SignedProperties exactly as the sample document carries it", () => {
    // Copied out of the sample invoice: no xmlns declarations (both prefixes
    // are already in scope) and this indentation.
    const expected = [
      '<xades:SignedProperties Id="xadesSignedProperties">',
      "                                    <xades:SignedSignatureProperties>",
      "                                        <xades:SigningTime>2023-01-24T11:16:44Z</xades:SigningTime>",
      "                                        <xades:SigningCertificate>",
      "                                            <xades:Cert>",
      "                                                <xades:CertDigest>",
      '                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
      `                                                    <ds:DigestValue>${sample.certHashBase64}</ds:DigestValue>`,
      "                                                </xades:CertDigest>",
      "                                                <xades:IssuerSerial>",
      `                                                    <ds:X509IssuerName>${sample.certIssuer}</ds:X509IssuerName>`,
      `                                                    <ds:X509SerialNumber>${sample.certSerial}</ds:X509SerialNumber>`,
      "                                                </xades:IssuerSerial>",
      "                                            </xades:Cert>",
      "                                        </xades:SigningCertificate>",
      "                                    </xades:SignedSignatureProperties>",
      "                                </xades:SignedProperties>",
    ].join("\n");
    assert.equal(signer.buildSignedPropertiesXml(sample), expected);
  });

  it("declares the namespaces only in the form it hashes", () => {
    const embedded = signer.buildSignedPropertiesXml(sample);
    const forHashing = signer.buildSignedPropertiesForHashing(sample);
    assert.ok(!embedded.includes("xmlns:"), "embedded form must not redeclare namespaces");
    assert.ok(forHashing.includes('<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id='));
    // Every ds: child carries its own declaration — the exclusive-C14N form.
    assert.equal((forHashing.match(/xmlns:ds=/g) ?? []).length, 4);
  });
});
