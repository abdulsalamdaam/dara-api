import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { ShellService } from "./shell.service";
import { QrService, type Phase1Fields } from "./qr.service";
import { pemBody } from "./csr.service";
import { ZATCA_HASH_XSL } from "./zatca-assets";

function escapeXml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface InspectedCert {
  issuer: string;
  serial: string;
  publicKeyDer: Buffer;
  certSignatureDer: Buffer;
}

export interface SignInvoiceArgs {
  invoiceXml: string;
  privateKeyPem: string;
  certPem: string;
  profile: "standard" | "simplified";
  qrFields: Phase1Fields;
}

export interface SignInvoiceResult {
  signedXml: string;
  invoiceHashBase64: string;
  qrBase64: string;
  signatureValueBase64: string;
}

@Injectable()
export class InvoiceSignerService {
  constructor(
    private readonly shell: ShellService,
    private readonly qr: QrService,
  ) {}

  /**
   * Apply ZATCA's hash transform XSL (which strips UBLExtensions, cac:Signature,
   * AdditionalDocumentReference[QR]), then C14N 1.1 canonicalize, then SHA-256.
   * The base64 of the digest is what goes into:
   *   - the QR (TLV tag 6)
   *   - the request body of /invoices/{compliance,clearance,reporting}
   *   - the SignedInfo's first <ds:DigestValue>
   */
  async computeInvoiceHash(invoiceXmlString: string): Promise<{
    hashBase64: string; hashHex: string; canonicalXml: string;
  }> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-hash-"));
    const inXml = path.join(tmp, "invoice.xml");
    const xslPath = path.join(tmp, "hash.xsl");
    const transformed = path.join(tmp, "transformed.xml");
    try {
      await fs.writeFile(inXml, invoiceXmlString, "utf8");
      await fs.writeFile(xslPath, ZATCA_HASH_XSL, "utf8");
      const xslt = await this.shell.mustRun("xsltproc", [xslPath, inXml]);
      await fs.writeFile(transformed, xslt.stdout as string, "utf8");
      const c14n = await this.shell.mustRun("xmllint", ["--c14n11", transformed]);
      const canonical = c14n.stdout as string;
      const digest = createHash("sha256").update(canonical, "utf8").digest();
      return {
        hashBase64: digest.toString("base64"),
        hashHex: digest.toString("hex"),
        canonicalXml: canonical,
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  async signWithEcKey(privateKeyPem: string, dataToSign: Buffer): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-sign-"));
    const keyPath = path.join(tmp, "key.pem");
    const dataPath = path.join(tmp, "data.bin");
    const sigPath = path.join(tmp, "sig.bin");
    try {
      await fs.writeFile(keyPath, privateKeyPem, "utf8");
      await fs.writeFile(dataPath, dataToSign);
      await this.shell.mustRun("openssl", ["dgst", "-sha256", "-sign", keyPath, "-out", sigPath, dataPath]);
      const sig = await fs.readFile(sigPath);
      return sig.toString("base64");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * ZATCA cert-hash recipe:
   *   sha256(certPemBodyAsString) → hex(64) → base64
   * Note the base64 is over the *hex string*, not the raw digest bytes.
   */
  computeCertHash(certPem: string): string {
    const body = pemBody(certPem);
    const hex = createHash("sha256").update(body, "utf8").digest("hex");
    return Buffer.from(hex, "utf8").toString("base64");
  }

  async inspectCert(certPem: string): Promise<InspectedCert> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-cert-"));
    const certPath = path.join(tmp, "cert.pem");
    try {
      await fs.writeFile(certPath, certPem, "utf8");
      const issuerR = await this.shell.mustRun("openssl", [
        "x509", "-in", certPath, "-noout", "-issuer", "-nameopt", "RFC2253",
      ]);
      const issuer = (issuerR.stdout as string).replace(/^issuer=\s*/i, "").trim();
      const serialR = await this.shell.mustRun("openssl", ["x509", "-in", certPath, "-noout", "-serial"]);
      const serialHex = (serialR.stdout as string).replace(/^serial=\s*/i, "").trim();
      const serial = BigInt("0x" + serialHex).toString(10);

      const pubR = await this.shell.mustRun("openssl", ["x509", "-in", certPath, "-pubkey", "-noout"]);
      const pubPem = pubR.stdout as string;
      const publicKeyDer = Buffer.from(pemBody(pubPem), "base64");

      const certDer = Buffer.from(pemBody(certPem), "base64");
      const certSignatureDer = this.extractCertSignature(certDer);
      return { issuer, serial, publicKeyDer, certSignatureDer };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Walk the outer X.509 SEQUENCE and extract the trailing signatureValue
   * BIT STRING. Minimal hand-rolled DER parser — sufficient for the X.509
   * Certificate top-level structure (we never need to peer further in).
   */
  private extractCertSignature(certDer: Buffer): Buffer {
    if (certDer[0] !== 0x30) throw new Error("not a DER SEQUENCE");
    let pos = 1;
    pos += this.derLengthByteCount(certDer, pos);
    pos = this.skipTLV(certDer, pos);
    pos = this.skipTLV(certDer, pos);
    if (certDer[pos] !== 0x03) throw new Error("expected BIT STRING for signatureValue");
    pos += 1;
    const lenBytes = this.derLengthByteCount(certDer, pos);
    let len: number;
    if (certDer[pos] < 0x80) {
      len = certDer[pos];
    } else {
      const n = certDer[pos] & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | certDer[pos + 1 + i];
    }
    pos += lenBytes;
    return certDer.subarray(pos + 1, pos + len);
  }
  private derLengthByteCount(buf: Buffer, pos: number): number {
    if (buf[pos] < 0x80) return 1;
    return 1 + (buf[pos] & 0x7f);
  }
  private skipTLV(buf: Buffer, pos: number): number {
    pos += 1;
    const lenBytes = this.derLengthByteCount(buf, pos);
    let len: number;
    if (buf[pos] < 0x80) {
      len = buf[pos];
    } else {
      const n = buf[pos] & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[pos + 1 + i];
    }
    return pos + lenBytes + len;
  }

  /* -----------------------------------------------------------
   * XAdES SignedProperties / SignedInfo / UBLExtensions templates
   *
   * The whitespace and namespace declarations below are deliberate —
   * SignedProperties is hashed *as serialized here* (not re-canonicalized),
   * so even indentation differences will break verification on ZATCA's side.
   * --------------------------------------------------------- */

  buildSignedPropertiesXml(args: {
    signingTime: string; certHashBase64: string; certIssuer: string; certSerial: string;
  }): string {
    // Attribute order is load-bearing: xmlns:xades MUST precede Id. ZATCA's
    // reporting endpoint (simplified/B2C) recomputes the digest over the
    // canonical form, which orders the namespace declaration first; hashing the
    // Id-first form produced "Invalid signed properties hashing". Clearance
    // (standard/B2B) was lenient, which is why only simplified failed. Matches
    // the ZATCA reference SignedProperties template byte-for-byte.
    return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${args.signingTime}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${args.certHashBase64}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(args.certIssuer)}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${args.certSerial}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
  }

  buildSignedInfoXml(args: { invoiceHashBase64: string; signedPropsHashBase64: string }): string {
    return `<ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${args.invoiceHashBase64}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${args.signedPropsHashBase64}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>`;
  }

  buildUblExtension(args: {
    signedInfoXml: string; signatureValueBase64: string;
    certBodyBase64: string; signedPropertiesXml: string;
  }): string {
    return `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
                        ${args.signedInfoXml}
                        <ds:SignatureValue>${args.signatureValueBase64}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${args.certBodyBase64}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties Target="signature" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
                                ${args.signedPropertiesXml}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>`;
  }

  buildSignatureBlock(): string {
    return `<cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>`;
  }

  buildQrAdditionalRef(qrBase64: string): string {
    return `<cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrBase64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`;
  }

  /** SHA-256 of the SignedProperties string. ZATCA hashes it as serialized, so
   *  the template's attribute order and indentation are what matter — see
   *  buildSignedPropertiesXml (xmlns:xades before Id). */
  hashSignedProperties(signedPropertiesXml: string): string {
    return createHash("sha256").update(signedPropertiesXml, "utf8").digest("base64");
  }

  /** Wrap SignedInfo in a host doc and run xmllint --c14n11 to canonicalize. */
  async hashSignedInfo(signedInfoXml: string): Promise<Buffer> {
    const wrapped = `<root xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">${signedInfoXml}</root>`;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-sinfo-"));
    const f = path.join(tmp, "si.xml");
    try {
      await fs.writeFile(f, wrapped, "utf8");
      const c14n = await this.shell.mustRun("xmllint", [
        "--c14n11", "--xpath", "/*/*[local-name()=\"SignedInfo\"]", f,
      ]);
      return Buffer.from(c14n.stdout as string, "utf8");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * End-to-end XAdES signing:
   *   1. hash unsigned invoice (via XSL strip + C14N + SHA-256)
   *   2. compute cert hash + cert details
   *   3. assemble SignedProperties, hash it (literal-string SHA-256)
   *   4. assemble SignedInfo, canonicalize, sign with the EC private key
   *   5. assemble UBLExtensions + Signature block + QR AdditionalDocumentReference
   *   6. inject all three into the invoice XML — careful: any whitespace we
   *      add survives the strip transform downstream and re-hashes don't match.
   */
  async signInvoice(args: SignInvoiceArgs): Promise<SignInvoiceResult> {
    const { invoiceXml, privateKeyPem, certPem, profile, qrFields } = args;

    const { hashBase64: invoiceHashBase64 } = await this.computeInvoiceHash(invoiceXml);

    const certHashBase64 = this.computeCertHash(certPem);
    const { issuer: certIssuer, serial: certSerial, publicKeyDer, certSignatureDer } = await this.inspectCert(certPem);
    const certBodyBase64 = pemBody(certPem);

    const signingTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace("Z", "");
    const signedPropertiesXml = this.buildSignedPropertiesXml({
      signingTime, certHashBase64, certIssuer, certSerial,
    });
    const signedPropsHashBase64 = this.hashSignedProperties(signedPropertiesXml);

    const signedInfoXml = this.buildSignedInfoXml({ invoiceHashBase64, signedPropsHashBase64 });
    const canonicalSignedInfo = await this.hashSignedInfo(signedInfoXml);
    const signatureValueBase64 = await this.signWithEcKey(privateKeyPem, canonicalSignedInfo);

    const ublExtensionsXml = this.buildUblExtension({
      signedInfoXml, signatureValueBase64, certBodyBase64, signedPropertiesXml,
    });

    const qrBase64 =
      profile === "simplified"
        ? this.qr.buildPhase2Qr({
            ...qrFields,
            invoiceHashBase64,
            signatureBase64: signatureValueBase64,
            publicKeyDer,
            certSignatureDer,
          })
        : this.qr.buildPhase1Qr(qrFields);

    let signedXml = invoiceXml;
    signedXml = signedXml.replace(/(<Invoice[^>]*>)/, `$1${ublExtensionsXml}`);
    const qrRefXml = this.buildQrAdditionalRef(qrBase64);
    const sigBlockXml = this.buildSignatureBlock();
    signedXml = signedXml.replace(
      /(<cac:AccountingSupplierParty)/,
      `${qrRefXml}${sigBlockXml}$1`,
    );

    return { signedXml, invoiceHashBase64, qrBase64, signatureValueBase64 };
  }
}
