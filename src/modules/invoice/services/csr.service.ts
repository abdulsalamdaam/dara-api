import { BadRequestException, Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ShellService } from "./shell.service";
import { ZATCA_CSR_TEMPLATE } from "./zatca-assets";

const TEMPLATE_NAMES: Record<string, string> = {
  sandbox: "TSTZATCA-Code-Signing",
  simulation: "PREZATCA-Code-Signing",
  production: "ZATCA-Code-Signing",
};

export interface CsrConfig {
  commonName: string;
  serialNumber: string;
  organizationIdentifier: string;
  organizationUnitName: string;
  organizationName: string;
  countryName?: string;
  invoiceType?: string;
  locationAddress: string;
  industryCategory: string;
  environment: "sandbox" | "simulation" | "production";
}

export interface CsrResult {
  privateKey: string;
  csr: string;
  csrBase64: string;
  publicKey: string;
}

/**
 * Strip BEGIN/END lines + whitespace from a PEM block, leaving the raw base64
 * body. Used to derive cert hashes / pull DER bytes back out.
 */
export function pemBody(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

/** X.520 bounds these at 64 CHARACTERS (a UTF8String counts code points, not bytes). */
const CSR_FIELD_MAX = 64;

/**
 * Fields that land in the `subjectAltName` dirName rather than the subject.
 *
 * These must be ASCII, and that is openssl's constraint rather than ZATCA's.
 * `utf8 = yes` lives in `[ req ]` and governs `distinguished_name` only; the
 * `dirName:alt_names` path is parsed with `MBSTRING_ASC` whatever the config
 * says, so every byte of an Arabic value is read as Latin-1 and re-encoded —
 * the same double-encoding the subject was fixed for, still live here.
 *
 * And it fails SILENTLY in the worst way: past roughly forty doubled bytes
 * openssl abandons the attribute, drops it AND every attribute after it, and
 * still exits 0. A real Riyadh address therefore produced a CSR with no
 * `registeredAddress` and no `businessCategory` — both ZATCA-mandated — with
 * nothing raised anywhere in our stack. Refusing loudly is strictly better
 * than shipping a certificate that quietly lost half its identity.
 */
const SAN_FIELDS = new Set([
  "serialNumber", "organizationIdentifier", "invoiceType",
  "locationAddress", "industryCategory",
]);

/**
 * Sanitise one value on its way into the openssl CSR config.
 *
 * These strings are not literals — they are lines of an openssl `.cnf`, and
 * openssl reads that file as configuration. Three things follow, all verified
 * against a real openssl:
 *
 *  · A newline ends the value and starts a new directive, so
 *    `"…\nemailAddress = x@y"` adds a field to the subject, and
 *    `"…\n[ req_ext ]\nsubjectAltName = …"` replaces the whole SAN — the block
 *    that identifies the EGS unit to ZATCA.
 *  · `$ENV::NAME` is expanded by openssl, so a value of `$ENV::APP_ENCRYPTION_KEY`
 *    writes this process's secrets into a certificate subject that the
 *    onboarding endpoint hands straight back, and that is then embedded in the
 *    signature of every invoice. That is the one that makes this a
 *    confidentiality bug and not merely self-corruption.
 *  · `$` also introduces openssl's own variable references, so it is refused
 *    wherever it appears rather than only in the `$ENV::` form.
 *
 * The seven required fields are checked for presence at the controller; nothing
 * checked their CONTENT, and `CreateInvoiceDto`-style interfaces mean the
 * ValidationPipe strips nothing. So the guard belongs here, at the single point
 * every caller must pass through, rather than at any one route.
 */
export function csrField(field: string, raw: string): string {
  const v = (raw ?? "").toString().trim();
  if (!v) throw new BadRequestException(`قيمة ${field} مطلوبة لإصدار الشهادة`);
  if (/[\r\n]/.test(v)) {
    throw new BadRequestException(`قيمة ${field} تحتوي على سطر جديد وهو غير مسموح في بيانات الشهادة`);
  }
  if (v.includes("$")) {
    throw new BadRequestException(`قيمة ${field} تحتوي على الرمز $ وهو غير مسموح في بيانات الشهادة`);
  }
  // Code points, not UTF-16 units: an X.520 bound counts characters, and
  // `.length` would charge a surrogate pair twice.
  if ([...v].length > CSR_FIELD_MAX) {
    throw new BadRequestException(`قيمة ${field} أطول من ${CSR_FIELD_MAX} حرفاً`);
  }
  // eslint-disable-next-line no-control-regex
  if (SAN_FIELDS.has(field) && /[^\x20-\x7E]/.test(v)) {
    throw new BadRequestException(
      `قيمة ${field} يجب أن تكون بأحرف لاتينية وأرقام فقط — لا تدعم شهادة هيئة الزكاة الأحرف العربية في هذا الحقل`,
    );
  }
  return v;
}

@Injectable()
export class CsrService {
  constructor(private readonly shell: ShellService) {}

  /**
   * Generate an EC secp256k1 keypair and a ZATCA-formatted CSR. ZATCA wants
   * `secp256k1` (not P-256) and a specific OID layout in the SAN to identify
   * the EGS unit. The template (assets/zatca/openssl-csr-template.cnf) carries
   * those fixed bits; this function fills the per-seller variables.
   */
  async generateCsr(config: CsrConfig): Promise<CsrResult> {
    const env = config.environment || "sandbox";
    const templateName = TEMPLATE_NAMES[env];
    if (!templateName) throw new Error(`unknown environment: ${env}`);

    // Every value below is substituted into an openssl CONFIG FILE, so it is
    // config syntax, not a string literal. See `csrField`.
    const put = (field: string, raw: string) => csrField(field, raw);
    const filled = ZATCA_CSR_TEMPLATE
      .replace("{TEMPLATE_NAME}", () => templateName)
      .replace("{SERIAL_NUMBER}", () => put("serialNumber", config.serialNumber))
      .replace("{ORG_IDENTIFIER}", () => put("organizationIdentifier", config.organizationIdentifier))
      .replace("{INVOICE_TYPE}", () => put("invoiceType", config.invoiceType || "1100"))
      .replace("{LOCATION_ADDRESS}", () => put("locationAddress", config.locationAddress))
      .replace("{INDUSTRY_CATEGORY}", () => put("industryCategory", config.industryCategory))
      .replace("{COUNTRY}", () => put("countryName", config.countryName || "SA"))
      .replace("{ORG_UNIT}", () => put("organizationUnitName", config.organizationUnitName))
      .replace("{ORG_NAME}", () => put("organizationName", config.organizationName))
      .replace("{COMMON_NAME}", () => put("commonName", config.commonName));

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zatca-csr-"));
    const cnfPath = path.join(tmp, "csr.cnf");
    const keyPath = path.join(tmp, "key.pem");
    const csrPath = path.join(tmp, "csr.pem");

    try {
      await fs.writeFile(cnfPath, filled, "utf8");

      await this.shell.mustRun("openssl", ["ecparam", "-name", "secp256k1", "-genkey", "-noout", "-out", keyPath]);
      const privateKey = await fs.readFile(keyPath, "utf8");

      await this.shell.mustRun("openssl", ["req", "-new", "-sha256", "-key", keyPath, "-config", cnfPath, "-out", csrPath]);
      const csr = await fs.readFile(csrPath, "utf8");

      const pub = await this.shell.mustRun("openssl", ["ec", "-in", keyPath, "-pubout"]);
      const publicKey = pub.stdout as string;

      // ZATCA wants base64 of the **whole PEM** (BEGIN/END lines included), not just the inner body.
      const csrBase64 = Buffer.from(csr, "utf8").toString("base64");

      return { privateKey, csr, csrBase64, publicKey };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}
