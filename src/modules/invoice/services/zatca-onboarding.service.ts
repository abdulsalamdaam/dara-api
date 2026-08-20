import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, isNull } from "drizzle-orm";
import {
  zatcaCredentialsTable,
  ZATCA_INITIAL_PIH,
  type ZatcaCredentials,
  invoicesTable,
  invoiceLinesTable,
  ownersTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../../database/database.module";
import { CsrService } from "./csr.service";
import { ZatcaApiService, SANDBOX_OTP, type ZatcaEnv } from "./zatca-api.service";
import { encryptString, decryptString } from "../../../common/crypto/encryption";
import { InvoiceBuilderService } from "./invoice-builder.service";
import { InvoiceSignerService } from "./invoice-signer.service";

/** PEM helpers — base64 → PEM block. */
function wrapPem(b64: string, kind: "CERTIFICATE" | "PUBLIC KEY" | "EC PRIVATE KEY"): string {
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${kind}-----\n${lines.join("\n")}\n-----END ${kind}-----\n`;
}

/**
 * ZATCA's `binarySecurityToken` is base64 of the certificate's *inner* base64
 * body (the text between the PEM headers). Decoding it once yields that bare
 * base64 — NOT a full PEM — so it must be re-wrapped in BEGIN/END CERTIFICATE
 * lines. (Some envs return a full PEM already; handle both.) Wrapping the raw
 * token instead double-encodes the body and openssl rejects it with
 * "Unable to load certificate".
 */
export function tokenToCertPem(token: string): string {
  const decoded = Buffer.from(token, "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN CERTIFICATE")) return decoded.endsWith("\n") ? decoded : decoded + "\n";
  return wrapPem(decoded.replace(/\s+/g, ""), "CERTIFICATE");
}

export interface SellerProfileInput {
  sellerName: string;
  sellerNameAr?: string | null;
  sellerVatNumber: string;
  sellerCrn?: string | null;
  sellerIdScheme?: string | null;
  sellerStreet: string;
  sellerBuildingNo: string;
  sellerDistrict: string;
  sellerCity: string;
  sellerPostalZone: string;
  sellerAdditionalNo?: string | null;
  serialNumber: string;
  organizationIdentifier: string;
  organizationUnitName: string;
  invoiceType?: string;
  locationAddress: string;
  industryCategory: string;
  countryName?: string;
  commonName: string;
}

export interface DecryptedCreds {
  privateKeyPem: string;
  certPem: string;
  binarySecurityToken: string;
  secret: string;
  icv: number;
  pih: string;
  environment: ZatcaEnv;
}

@Injectable()
export class ZatcaOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly csr: CsrService,
    private readonly api: ZatcaApiService,
    private readonly builder: InvoiceBuilderService,
    private readonly signer: InvoiceSignerService,
  ) {}

  /* ─── Profile helpers ───────────────────────────────────────────────── */

  /** Scope to one account + landlord (ownerId null = legacy account-level seller). */
  private credsWhere(userId: number, ownerId: number | null) {
    return and(
      eq(zatcaCredentialsTable.userId, userId),
      ownerId == null ? isNull(zatcaCredentialsTable.ownerId) : eq(zatcaCredentialsTable.ownerId, ownerId),
      isNull(zatcaCredentialsTable.deletedAt),
    );
  }

  async getCredentials(userId: number, ownerId: number | null = null): Promise<ZatcaCredentials | null> {
    const [row] = await this.db.select().from(zatcaCredentialsTable).where(this.credsWhere(userId, ownerId));
    return row ?? null;
  }

  /** Every landlord's onboarding state for the account (for the integration tab). */
  async listByAccount(userId: number): Promise<ZatcaCredentials[]> {
    return this.db.select().from(zatcaCredentialsTable)
      .where(and(eq(zatcaCredentialsTable.userId, userId), isNull(zatcaCredentialsTable.deletedAt)));
  }

  /**
   * Every landlord with their ZATCA integration status — drives the settings
   * tab ("show all landlords and which one is integrated"). Reports whether the
   * landlord's VAT number + national address are ready to onboard, and the
   * onboarding state per environment.
   */
  async listLandlordStatus(userId: number) {
    const [owners, creds] = await Promise.all([
      this.db.select().from(ownersTable).where(and(eq(ownersTable.userId, userId), isNull(ownersTable.deletedAt))),
      this.listByAccount(userId),
    ]);
    const byOwner = new Map<number, ZatcaCredentials>();
    for (const c of creds) if (c.ownerId != null) byOwner.set(c.ownerId, c);
    return owners.map((o: any) => {
      const c = byOwner.get(o.id);
      // National (short) address: the code saved on the seller profile during onboarding.
      const nationalAddress = c?.locationAddress || null;
      const vatNumber = o.taxNumber || null;
      // Full national address from Settings — the source of truth for ZATCA's
      // CSR registeredAddress + the invoice XML PostalAddress.
      const address = {
        buildingNumber: o.buildingNumber || null,
        street: o.nationalAddressStreet || null,
        district: o.nationalAddressDistrict || null,
        city: o.nationalAddressCity || null,
        postalCode: o.postalCode || null,
        additionalNumber: o.additionalNumber || null,
      };
      // Ready only when every ZATCA-mandatory address field is present.
      const addressReady = !!(address.buildingNumber && address.street && address.district && address.city && address.postalCode);
      return {
        ownerId: o.id,
        name: o.name,
        type: o.type,
        vatNumber,
        vatReady: !!vatNumber,
        nationalAddress,
        address,
        addressReady,
        configured: !!c,
        activeEnvironment: c?.activeEnvironment ?? null,
        sandboxOnboarded: !!c?.sandboxCertPem,
        // "production" means a real production CSID — a simulation rehearsal
        // fills the same columns and must not be reported as live.
        productionOnboarded: !!c?.prodCertPem && c?.prodSlotEnv === "production",
        simulationOnboarded: !!c?.prodCertPem && c?.prodSlotEnv === "simulation",
        onboardedAt: c?.sandboxOnboardedAt ?? c?.prodOnboardedAt ?? null,
      };
    });
  }

  async upsertProfile(userId: number, profile: SellerProfileInput, ownerId: number | null = null): Promise<ZatcaCredentials> {
    const existing = await this.getCredentials(userId, ownerId);
    if (existing) {
      const [row] = await this.db
        .update(zatcaCredentialsTable)
        .set({
          sellerName: profile.sellerName,
          sellerNameAr: profile.sellerNameAr ?? null,
          sellerVatNumber: profile.sellerVatNumber,
          sellerCrn: profile.sellerCrn ?? null,
          sellerIdScheme: profile.sellerIdScheme ?? "CRN",
          sellerStreet: profile.sellerStreet,
          sellerBuildingNo: profile.sellerBuildingNo,
          sellerDistrict: profile.sellerDistrict,
          sellerCity: profile.sellerCity,
          sellerPostalZone: profile.sellerPostalZone,
          sellerAdditionalNo: profile.sellerAdditionalNo ?? null,
          serialNumber: profile.serialNumber,
          organizationIdentifier: profile.organizationIdentifier,
          organizationUnitName: profile.organizationUnitName,
          invoiceType: profile.invoiceType ?? "1100",
          locationAddress: profile.locationAddress,
          industryCategory: profile.industryCategory,
          countryName: profile.countryName ?? "SA",
          commonName: profile.commonName,
        })
        .where(eq(zatcaCredentialsTable.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await this.db
      .insert(zatcaCredentialsTable)
      .values({
        userId,
        ownerId: ownerId ?? null,
        activeEnvironment: "sandbox",
        sellerName: profile.sellerName,
        sellerNameAr: profile.sellerNameAr ?? null,
        sellerVatNumber: profile.sellerVatNumber,
        sellerCrn: profile.sellerCrn ?? null,
        sellerIdScheme: profile.sellerIdScheme ?? "CRN",
        sellerStreet: profile.sellerStreet,
        sellerBuildingNo: profile.sellerBuildingNo,
        sellerDistrict: profile.sellerDistrict,
        sellerCity: profile.sellerCity,
        sellerPostalZone: profile.sellerPostalZone,
        sellerAdditionalNo: profile.sellerAdditionalNo ?? null,
        serialNumber: profile.serialNumber,
        organizationIdentifier: profile.organizationIdentifier,
        organizationUnitName: profile.organizationUnitName,
        invoiceType: profile.invoiceType ?? "1100",
        locationAddress: profile.locationAddress,
        industryCategory: profile.industryCategory,
        countryName: profile.countryName ?? "SA",
        commonName: profile.commonName,
      })
      .returning();
    return row;
  }

  /* ─── Onboarding (Sandbox / Simulation / Production) ───────────────── */

  /**
   * Step 1: generate a CSR for the requested environment and POST it to the
   * ZATCA `/compliance` endpoint. Stores the EC private key (encrypted),
   * the binarySecurityToken (the cert), the shared secret (encrypted), and
   * the complianceRequestId — all per-environment.
   */
  async issueComplianceCsid(
    userId: number,
    environment: ZatcaEnv,
    otp: string = SANDBOX_OTP,
    ownerId: number | null = null,
  ): Promise<{ binarySecurityToken: string; complianceRequestId: string; certPem: string; httpStatus: number }> {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) throw new NotFoundException("Seller profile not configured");

    const csr = await this.csr.generateCsr({
      environment,
      commonName: creds.commonName,
      serialNumber: creds.serialNumber,
      organizationIdentifier: creds.organizationIdentifier,
      organizationUnitName: creds.organizationUnitName,
      organizationName: creds.sellerName,
      countryName: creds.countryName,
      invoiceType: creds.invoiceType,
      locationAddress: creds.locationAddress,
      industryCategory: creds.industryCategory,
    });

    const resp = await this.api.getComplianceCsid({ csrBase64: csr.csrBase64, otp, environment });
    if (resp.status >= 300) {
      throw new BadRequestException(`ZATCA /compliance returned ${resp.status}: ${resp.raw}`);
    }
    const j = resp.json;
    if (!j?.binarySecurityToken || !j.secret) {
      throw new BadRequestException("ZATCA response missing binarySecurityToken/secret");
    }

    // binarySecurityToken from ZATCA is base64 of an X.509 cert — wrap as PEM.
    const certPem = tokenToCertPem(j.binarySecurityToken);

    const updates: Partial<ZatcaCredentials> = {};
    if (environment === "sandbox") {
      updates.sandboxPrivateKeyEnc = encryptString(csr.privateKey);
      updates.sandboxPublicKeyPem = csr.publicKey;
      updates.sandboxCsrPem = csr.csr;
      updates.sandboxBinarySecurityToken = j.binarySecurityToken;
      updates.sandboxSecretEnc = encryptString(j.secret);
      updates.sandboxCertPem = certPem;
      updates.sandboxComplianceRequestId = j.requestID ?? null;
      updates.sandboxOnboardedAt = new Date();
    } else if (environment === "simulation") {
      // Simulation also lives on the production columns — same lifecycle, same
      // gateway prefix swap — so the slot records which of the two it holds.
      updates.prodSlotEnv = "simulation";
      updates.prodPrivateKeyEnc = encryptString(csr.privateKey);
      updates.prodPublicKeyPem = csr.publicKey;
      updates.prodCsrPem = csr.csr;
      updates.prodBinarySecurityToken = j.binarySecurityToken;
      updates.prodSecretEnc = encryptString(j.secret);
      updates.prodCertPem = certPem;
      updates.prodComplianceRequestId = j.requestID ?? null;
      updates.prodOnboardedAt = new Date();
    } else {
      updates.prodSlotEnv = "production";
      updates.prodPrivateKeyEnc = encryptString(csr.privateKey);
      updates.prodPublicKeyPem = csr.publicKey;
      updates.prodCsrPem = csr.csr;
      updates.prodBinarySecurityToken = j.binarySecurityToken;
      updates.prodSecretEnc = encryptString(j.secret);
      updates.prodCertPem = certPem;
      updates.prodComplianceRequestId = j.requestID ?? null;
      updates.prodOnboardedAt = new Date();
    }

    await this.db.update(zatcaCredentialsTable).set(updates).where(eq(zatcaCredentialsTable.id, creds.id));

    return {
      binarySecurityToken: j.binarySecurityToken,
      complianceRequestId: j.requestID ?? "",
      certPem,
      httpStatus: resp.status,
    };
  }

  /**
   * Step 2: exchange the compliance CSID for the production CSID. Required
   * before sending real invoices to the live `/core` endpoints.
   */
  async issueProductionCsid(
    userId: number,
    environment: "sandbox" | "production" = "production",
    ownerId: number | null = null,
  ): Promise<{ binarySecurityToken: string; httpStatus: number }> {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) throw new NotFoundException("Seller profile not configured");
    const targetCols = environment === "sandbox" ? "sandbox" : "prod";

    const tokenCol = `${targetCols}BinarySecurityToken` as const;
    const secretCol = `${targetCols}SecretEnc` as const;
    const reqIdCol = `${targetCols}ComplianceRequestId` as const;

    const token = (creds as any)[tokenCol] as string | null;
    const secretEnc = (creds as any)[secretCol] as string | null;
    const reqId = (creds as any)[reqIdCol] as string | null;
    if (!token || !secretEnc || !reqId) {
      throw new BadRequestException(`Run compliance onboarding for "${environment}" first`);
    }

    const resp = await this.api.getProductionCsid({
      binarySecurityToken: token,
      secret: decryptString(secretEnc),
      complianceRequestId: reqId,
      environment,
    });
    if (resp.status >= 300 || !resp.json?.binarySecurityToken) {
      throw new BadRequestException(`ZATCA /production/csids returned ${resp.status}: ${resp.raw}`);
    }
    const certPem = tokenToCertPem(resp.json.binarySecurityToken);

    await this.db
      .update(zatcaCredentialsTable)
      .set({
        prodBinarySecurityToken: resp.json.binarySecurityToken,
        prodSecretEnc: encryptString(resp.json.secret),
        prodCertPem: certPem,
        prodOnboardedAt: new Date(),
        // A real production CSID now occupies the slot, whichever compliance
        // certificate it was promoted from.
        prodSlotEnv: environment === "production" ? "production" : "simulation",
      })
      .where(eq(zatcaCredentialsTable.id, creds.id));

    return { binarySecurityToken: resp.json.binarySecurityToken, httpStatus: resp.status };
  }

  /**
   * 1-click switch to production.
   *
   * Refuses unless prod credentials and at least the prod compliance test
   * cycle (≥ 1 standard + 1 simplified + 1 credit + 1 debit invoice all
   * cleared/reported) have been completed against the prod CSID.
   */
  async switchEnvironment(userId: number, env: ZatcaEnv, ownerId: number | null = null): Promise<ZatcaCredentials> {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) throw new NotFoundException("Seller profile not configured");

    if (env === "production") {
      if (!creds.prodCertPem || !creds.prodSecretEnc) {
        throw new ConflictException(
          "Production credentials not provisioned. Run compliance + production CSID issuance first.",
        );
      }
      // Simulation fills these same columns. Without this check a seller that
      // had only rehearsed could be switched "live" holding a simulation
      // certificate — every real invoice would then be signed with a
      // certificate the /core gateway does not accept.
      if (creds.prodSlotEnv === "simulation") {
        throw new ConflictException(
          "هذه الشهادة خاصة ببيئة المحاكاة (Simulation). أعد الربط باختيار بيئة الإنتاج للحصول على شهادة إنتاج حقيقية.",
        );
      }
      // Optional belt-and-braces: ensure the seller has run the test cycle.
      const tested = await this.db
        .select({
          profile: invoicesTable.profile,
          docType: invoicesTable.docType,
          status: invoicesTable.status,
        })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.userId, userId), eq(invoicesTable.environment, "production")));
      const ok = (cond: (r: typeof tested[number]) => boolean) =>
        tested.some((r) => cond(r) && (r.status === "cleared" || r.status === "reported"));
      const missing: string[] = [];
      if (!ok((r) => r.profile === "standard" && r.docType === "invoice")) missing.push("standard invoice");
      if (!ok((r) => r.profile === "simplified" && r.docType === "invoice")) missing.push("simplified invoice");
      if (!ok((r) => r.docType === "credit")) missing.push("credit note");
      if (!ok((r) => r.docType === "debit")) missing.push("debit note");
      if (missing.length) {
        throw new ConflictException(
          `Cannot switch to production until the test cycle is complete. Missing: ${missing.join(", ")}.`,
        );
      }
    }

    const [row] = await this.db
      .update(zatcaCredentialsTable)
      .set({ activeEnvironment: env })
      .where(eq(zatcaCredentialsTable.id, creds.id))
      .returning();
    return row;
  }

  /* ─── Active credentials access (for invoice submission) ───────────── */

  /**
   * Return the active environment's decrypted credentials and the current
   * (icv, pih) pair. Caller is responsible for incrementing & writing back
   * the new PIH after a successful submission via `commitInvoiceState`.
   */
  async getActiveCredentials(userId: number, ownerId: number | null = null): Promise<{ creds: ZatcaCredentials; decrypted: DecryptedCreds }> {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) throw new NotFoundException("Seller profile not configured");
    const env = creds.activeEnvironment;
    const isSandbox = env === "sandbox";

    const certPem = isSandbox ? creds.sandboxCertPem : creds.prodCertPem;
    const privateKeyEnc = isSandbox ? creds.sandboxPrivateKeyEnc : creds.prodPrivateKeyEnc;
    const token = isSandbox ? creds.sandboxBinarySecurityToken : creds.prodBinarySecurityToken;
    const secretEnc = isSandbox ? creds.sandboxSecretEnc : creds.prodSecretEnc;

    if (!certPem || !privateKeyEnc || !token || !secretEnc) {
      throw new ConflictException(
        `No ${env} credentials yet. Run onboarding (/api/zatca/onboarding/${env}/compliance) first.`,
      );
    }

    return {
      creds,
      decrypted: {
        privateKeyPem: decryptString(privateKeyEnc),
        // Re-derive the PEM from the token (the source of truth) so rows stored
        // by the earlier double-encoding bug self-heal without a migration.
        certPem: tokenToCertPem(token),
        binarySecurityToken: token,
        secret: decryptString(secretEnc),
        icv: isSandbox ? creds.sandboxIcv : creds.prodIcv,
        pih: isSandbox ? creds.sandboxPih : creds.prodPih,
        environment: env,
      },
    };
  }

  /** Persist the new ICV + PIH after a successful (or failed) submission. */
  async commitInvoiceState(userId: number, env: ZatcaEnv, icv: number, newPih: string, ownerId: number | null = null) {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) return;
    const updates: Partial<ZatcaCredentials> =
      env === "sandbox"
        ? { sandboxIcv: icv, sandboxPih: newPih }
        : { prodIcv: icv, prodPih: newPih };
    await this.db.update(zatcaCredentialsTable).set(updates).where(eq(zatcaCredentialsTable.id, creds.id));
  }

  /** Reset PIH chain back to the initial seed. Use only when starting fresh. */
  async resetChain(userId: number, env: ZatcaEnv, ownerId: number | null = null) {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) return;
    const updates: Partial<ZatcaCredentials> =
      env === "sandbox"
        ? { sandboxIcv: 0, sandboxPih: ZATCA_INITIAL_PIH }
        : { prodIcv: 0, prodPih: ZATCA_INITIAL_PIH };
    // Also drop existing invoice rows for this env (audit-safe: soft delete).
    await this.db
      .update(invoicesTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(invoicesTable.userId, userId), eq(invoicesTable.environment, env)));
    await this.db.update(zatcaCredentialsTable).set(updates).where(eq(zatcaCredentialsTable.id, creds.id));
    // Best-effort: orphan invoice_lines via cascade — no separate cleanup needed.
    void invoiceLinesTable;
  }
}
