import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
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
import { withSellerChainLock } from "./chain-lock";

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

/**
 * The next generation of an EGS serial.
 *
 * ZATCA identifies a device by the serial in its CSR, and ours was fixed per
 * landlord (`1-Dara|2-PMS|3-<ownerId>`). So a seller who deleted their device in
 * the Fatoora portal and came back to re-link presented ZATCA the SAME unit —
 * and ZATCA, which issues one production CSID per unit and does not hand the
 * existing one back, answered "Already-Generated" forever. From the portal the
 * device looked gone; from the CSR it never was.
 *
 * Appending a generation makes a re-onboard a genuinely new unit, which is the
 * thing ZATCA will actually issue against. `…|3-264` → `…|3-264-2` → `-3`.
 */
export function nextEgsSerial(current: string): string {
  const v = (current ?? "").trim();
  if (!v) throw new BadRequestException("EGS serial is empty — cannot derive the next generation");
  // Anchored to the serial WE mint: `1-…|2-…|3-<digits>`, with an optional
  // `-<digits>` generation after it. A looser match renumbered the DEVICE
  // instead of versioning it — `3-BR-01` became `3-BR-2`, a different unit a
  // second branch would then collide with. ZATCA allows free text in that third
  // segment, so anything outside our shape gets a plain suffix rather than a
  // reinterpreted one.
  const m = /^(.*\|3-\d+)(?:-(\d+))?$/.exec(v);
  if (!m) return `${v}-2`;
  const gen = m[2] ? Number(m[2]) + 1 : 2;
  return `${m[1]}-${gen}`;
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
        // ZATCA refused these credentials — the device was most likely removed
        // in Fatoora. The row still holds a certificate, so without this the
        // landlord would keep reading as perfectly integrated.
        linkInvalidAt: c?.linkInvalidAt ?? null,
        linkInvalidReason: c?.linkInvalidReason ?? null,
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

    /* Is this a RE-onboarding? Then present ZATCA a new EGS unit.
     *
     * The serial is what ZATCA identifies a device by, and ours was fixed per
     * landlord — so a seller who deleted their device in Fatoora and came back
     * handed ZATCA the same unit, which already had a production CSID and could
     * never be issued another. Bumping the generation is what makes the second
     * attempt a device ZATCA has not seen.
     *
     * Only when material for this slot already exists: a first onboarding, and
     * a retry of one that never got as far as a certificate, keep the clean
     * serial. */
    const slotHasMaterial = environment === "sandbox"
      ? !!creds.sandboxCertPem
      : !!creds.prodCertPem;
    const serialNumber = slotHasMaterial ? nextEgsSerial(creds.serialNumber) : creds.serialNumber;

    const csr = await this.csr.generateCsr({
      environment,
      commonName: creds.commonName,
      serialNumber,
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
    // Point the record at the slot this CSID lands in, so the compliance suite
    // that must run next reads THESE credentials and not an empty slot.
    updates.activeEnvironment = environment;
    // A fresh CSID is a working link by definition — drop any earlier "ZATCA
    // stopped accepting this" flag rather than leaving the seller blocked by
    // the very state they have just fixed.
    updates.linkInvalidAt = null;
    updates.linkInvalidReason = null;
    // Store the serial we actually put in the CSR. Leaving the old one would
    // make the row describe a device ZATCA does not have, and the next
    // re-onboard would bump from the wrong generation.
    updates.serialNumber = serialNumber;
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
      //
      // "compliance-*" because that is what this certificate IS. Marking the
      // slot with the final environment here made a row that had only completed
      // step 2 of 4 indistinguishable from a fully-onboarded seller: same
      // columns filled, same prodSlotEnv, same prodOnboardedAt. When
      // issueProductionCsid then failed — "Already-Generated", say — the seller
      // was left reading as LIVE while holding a compliance certificate, and
      // every real invoice they issued was signed with it and refused by /core
      // with a 401 that named nothing. `issueProductionCsid` is what earns the
      // final value.
      updates.prodSlotEnv = "compliance-simulation";
      updates.prodPrivateKeyEnc = encryptString(csr.privateKey);
      updates.prodPublicKeyPem = csr.publicKey;
      updates.prodCsrPem = csr.csr;
      updates.prodBinarySecurityToken = j.binarySecurityToken;
      updates.prodSecretEnc = encryptString(j.secret);
      updates.prodCertPem = certPem;
      updates.prodComplianceRequestId = j.requestID ?? null;
      updates.prodOnboardedAt = new Date();
    } else {
      // See above: a compliance CSID is not a production one, and the record
      // must not claim otherwise until it has been promoted.
      updates.prodSlotEnv = "compliance-production";
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
    // Widened from "sandbox" | "production": a seller sitting on a SIMULATION
    // compliance CSID had no way to ask for the promotion it needs. Asking for
    // "production" presented the simulation token to the live /core gateway and,
    // on success, marked the seller live; asking for "sandbox" promoted the
    // developer-portal CSID into the prod slot instead. Neither is the
    // simulation lifecycle, and before the compliance-slot fix it appeared to
    // work only because the compliance CSID itself read as onboarded.
    environment: ZatcaEnv = "production",
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

    /* Already promoted? Say so instead of asking ZATCA again — a production
     * CSID is issued once per compliance CSID, and asking twice returns
     * "Already-Generated", which read as a failure on an onboarding that had
     * finished.
     *
     * The proof of promotion is the ABSENCE of a compliance request id: only
     * `issueComplianceCsid` writes it, and the promotion below clears it. That
     * matters because the obvious test — slot, certificate and onboardedAt —
     * is byte-for-byte what the OLD compliance step used to write, so it would
     * hand a green "promoted" to precisely the half-onboarded rows that need
     * this endpoint to repair them, without calling ZATCA at all.
     *
     * Placed before the token/secret checks so a promoted row, whose reqId is
     * now null, short-circuits rather than being told to run onboarding again. */
    const promotedSlot = environment === "production" ? "production"
      : environment === "simulation" ? "simulation"
      : "sandbox";
    if (creds.prodSlotEnv === promotedSlot && creds.prodCertPem && creds.prodOnboardedAt && !reqId) {
      if (!creds.prodBinarySecurityToken) {
        throw new ConflictException("سجل الربط غير مكتمل — أعد الربط مع هيئة الزكاة والضريبة");
      }
      return { binarySecurityToken: creds.prodBinarySecurityToken, httpStatus: 200 };
    }

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
      // "Already-Generated" without a certificate in the reply is the one
      // refusal that must never be softened into success. ZATCA is saying it
      // has issued a production CSID for this EGS and will not issue another —
      // and it does NOT hand the existing one back. We are therefore still
      // holding the compliance certificate, and calling that "live" is how a
      // seller ends up signing real invoices with it.
      //
      // The device has to be released on ZATCA's side, or the seller onboarded
      // as a NEW EGS unit — the serial is what ZATCA recognises, and ours is
      // fixed per landlord (`1-Dara|2-PMS|3-<ownerId>`), so re-onboarding after
      // deleting the device in Fatoora presents the same unit again.
      if (/already[- ]generated/i.test(resp.raw ?? "")) {
        throw new ConflictException({
          error: "zatca_production_csid_exists",
          message:
            "هيئة الزكاة أصدرت شهادة إنتاج لهذا الجهاز مسبقاً ولا تُصدرها مرة أخرى، ولم تُعِد الشهادة الحالية. "
            + "الربط لم يكتمل — ما زال لدينا شهادة فحص التوافق فقط. "
            + "احذف الجهاز (EGS) من بوابة فاتورة نهائياً ثم أعد الربط برمز تحقق جديد، أو تواصل مع دعم الهيئة لتحرير الجهاز.",
          zatcaRaw: (resp.raw ?? "").slice(0, 300),
        });
      }
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
        // Spent. Its absence is what distinguishes a promoted slot from one the
        // compliance step merely filled — see the short-circuit above.
        prodComplianceRequestId: null,
        // A real production CSID now occupies the slot, whichever compliance
        // certificate it was promoted from.
        prodSlotEnv: promotedSlot,
        // ...and the record has to POINT at that slot.
        //
        // `saveProfile` creates every row with activeEnvironment "sandbox" and
        // nothing here used to move it, so a seller who onboarded straight to
        // production kept reading the EMPTY sandbox columns: isOnboarded() saw
        // no certificate, the readiness gate refused every invoice they tried
        // to issue, and submitZatca skipped as "not_onboarded" — all while a
        // valid production certificate sat unused in the next column.
        //
        // It was a dead end, not a detour: switchEnvironment() is the only
        // other writer, it is absent from the production UI entirely, and it
        // refuses to flip to production until a test cycle that the blocked
        // seller cannot run. Issuing a production CSID IS the go-live step, so
        // it is what moves the pointer.
        //
        // Production only. Simulation fills these very same columns, and
        // marking a record live while it holds a simulation certificate is the
        // exact failure the prodSlotEnv guard in switchEnvironment() exists to
        // prevent — every real invoice would be signed with a certificate the
        // /core gateway rejects. A simulation seller can still switch by hand;
        // that path is not gated.
        ...(environment === "production" ? { activeEnvironment: "production" as const } : {}),
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
      // A compliance certificate is not a live one either — same trap, one step
      // earlier in the sequence.
      if (creds.prodSlotEnv?.startsWith("compliance")) {
        throw new ConflictException(
          "لم يكتمل الربط بعد — الشهادة الحالية للفحص فقط. أكمل إصدار شهادة الإنتاج قبل التفعيل.",
        );
      }
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
        // Scoped to this landlord. Filtering on the account alone meant one
        // landlord's completed test cycle satisfied the gate for every other
        // landlord on the account — including ones that had never submitted
        // anything.
        .where(and(
          eq(invoicesTable.userId, userId),
          ownerId == null ? isNull(invoicesTable.ownerId) : eq(invoicesTable.ownerId, ownerId),
          eq(invoicesTable.environment, "production"),
          isNull(invoicesTable.deletedAt),
        ));
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

  /* ─── Link health ───────────────────────────────────────────────────── */

  /**
   * Record that ZATCA has stopped accepting this landlord's credentials.
   *
   * The link can be broken from the far side: the taxpayer removes our EGS
   * device in the Fatoora portal, or ZATCA revokes the CSID. Nothing notifies
   * us, and our row still looks complete — certificate, key, token, secret all
   * present — so `isOnboarded()` keeps returning true and every invoice is
   * signed and posted into a void. Writing the failure down is what turns an
   * invisible, repeating error into a state the app can reason about: the
   * readiness gate refuses approval, and the settings tab can say "re-link".
   *
   * Deliberately does NOT erase the credentials. They may yet be valid — a 403
   * can also be a gateway or IP problem — and destroying key material on the
   * strength of one HTTP status is not a decision to make automatically. This
   * only flags; `unlink` remains the only thing that deletes.
   */
  async markLinkInvalid(userId: number, ownerId: number | null, reason: string): Promise<void> {
    await this.db
      .update(zatcaCredentialsTable)
      .set({ linkInvalidAt: new Date(), linkInvalidReason: reason.slice(0, 500) })
      .where(this.credsWhere(userId, ownerId));
  }

  /**
   * Clear the flag — ZATCA accepted something, so the link works after all.
   *
   * Called on every successful submission rather than only on re-onboarding,
   * because the flag can be raised by a transient 403 (a gateway hiccup, an IP
   * block) and a seller who is in fact fine should not have to re-onboard to
   * clear it. One accepted document is proof enough.
   */
  async clearLinkInvalid(userId: number, ownerId: number | null): Promise<void> {
    await this.db
      .update(zatcaCredentialsTable)
      .set({ linkInvalidAt: null, linkInvalidReason: null })
      .where(and(this.credsWhere(userId, ownerId), isNotNull(zatcaCredentialsTable.linkInvalidAt)));
  }

  /* ─── Unlink ────────────────────────────────────────────────────────── */

  /**
   * Disconnect a landlord from ZATCA — the reverse of onboarding.
   *
   * A seller who linked the wrong VAT number, rehearsed on simulation and
   * wants a clean production run, moved to another provider, or simply stopped
   * being VAT-registered has to be able to undo the link from the portal. Until
   * now there was no way back: onboarding only ever wrote forward.
   *
   * What it does — and, just as importantly, what it does NOT:
   *
   *  · Every piece of ZATCA-issued material is wiped: both the sandbox and the
   *    prod/simulation slots lose their private key, public key, CSR,
   *    certificate, binary security token, shared secret, compliance request id
   *    and onboarding timestamp. The encrypted key material is genuinely gone
   *    from our database, not merely hidden behind a flag — soft-deleting the
   *    row would leave the seller's private key sitting on disk.
   *  · `activeEnvironment` goes back to the `sandbox` default, so nothing
   *    SELECTS a slot that no longer holds a certificate. (That mismatch is the
   *    exact failure §2b of DARA-NOTES describes: a pointer naming an empty
   *    slot blocks every invoice while a valid certificate sits unused in the
   *    next column.)
   *  · The ICV counter and the PIH chain head are KEPT. They are not
   *    credentials; they are the position this landlord has reached in a
   *    sequence ZATCA requires to be monotonic, and `invoices` enforces the
   *    same thing locally with a unique index on
   *    (user, owner, environment, icv) that has no `deleted_at` predicate.
   *    Zeroing them would make the very first invoice after a re-link collide
   *    with one already submitted.
   *  · `prodSlotEnv` is KEPT too, which looks odd next to an emptied slot but
   *    is deliberate: it is the only record of WHICH chain the retained
   *    `prodIcv`/`prodPih` belong to, since simulation and production share
   *    those two columns. Erase it and nobody — code or human — can ever tell
   *    afterwards whether that counter came from a rehearsal or from real
   *    filings. It is safe to leave: every reader of it (`listLandlordStatus`,
   *    `switchEnvironment`, the compliance-check guard in `InvoiceService`)
   *    gates on `prodCertPem` or `activeEnvironment` first, and this method
   *    clears both.
   *  · The row itself SURVIVES (no `deletedAt`), for the counters above and
   *    because `upsertProfile` updates an existing row but inserts when it
   *    finds none — and the insert would hit the (user, owner) unique index,
   *    which has no `deleted_at` predicate. Keeping the row is what makes
   *    re-linking work at all.
   *  · Invoices already submitted to ZATCA are untouched. They are filed legal
   *    documents; the seller party is snapshotted on each one, so they keep
   *    printing correctly with no credentials row to join against.
   *
   * After this the landlord reads as "profile saved, not integrated" — exactly
   * the state they were in between saving a profile and issuing a CSID — so the
   * settings tab offers "Onboard" again and nothing special has to be taught to
   * the rest of the app. Invoice readiness starts reporting the ZATCA blocker
   * again, which means drafts for this landlord can still be written but not
   * approved until they link again. Submission degrades to `not_onboarded`
   * rather than throwing.
   *
   * We do NOT tell ZATCA. There is no revoke call in its API, so the CSID stays
   * valid on their side; this is a local disconnection, and a seller who wants
   * the device gone from Fatoora has to remove it there.
   */
  async unlink(userId: number, ownerId: number | null = null): Promise<ZatcaCredentials> {
    const creds = await this.getCredentials(userId, ownerId);
    if (!creds) throw new NotFoundException("لا يوجد ربط مع هيئة الزكاة والضريبة لهذا المؤجر");
    // `getCredentials` falls back to the account-level row (ownerId null) only
    // when asked for it, but be explicit: unlinking landlord X must never wipe
    // the account-level seller that X happens to have been inheriting.
    if ((creds.ownerId ?? null) !== ownerId) {
      throw new NotFoundException("لا يوجد ربط مع هيئة الزكاة والضريبة لهذا المؤجر");
    }
    const [row] = await this.db
      .update(zatcaCredentialsTable)
      .set({
        activeEnvironment: "sandbox",
        // Retire the EGS serial along with the credentials.
        //
        // Unlinking is local — the docstring above says so: ZATCA has no revoke
        // call, so the device stays registered there holding its production
        // CSID. Our certificate columns go empty, and those are exactly what
        // `issueComplianceCsid` reads to decide whether a re-link presents a NEW
        // unit — so without this, unlink → re-link handed ZATCA the same serial
        // it already refuses to issue against, and the generation never fired on
        // the one path the product offers as the remedy.
        //
        // Bumped here, while we still know a device was presented, rather than
        // inferred later from columns this statement is about to clear.
        serialNumber: (creds.prodCertPem || creds.sandboxCertPem)
          ? nextEgsSerial(creds.serialNumber)
          : creds.serialNumber,
        // The flag described credentials that no longer exist — left set, it is
        // a stale complaint about a link the user has now deliberately removed.
        linkInvalidAt: null,
        linkInvalidReason: null,
        sandboxPrivateKeyEnc: null,
        sandboxPublicKeyPem: null,
        sandboxCsrPem: null,
        sandboxBinarySecurityToken: null,
        sandboxSecretEnc: null,
        sandboxCertPem: null,
        sandboxComplianceRequestId: null,
        sandboxOnboardedAt: null,
        prodPrivateKeyEnc: null,
        prodPublicKeyPem: null,
        prodCsrPem: null,
        prodBinarySecurityToken: null,
        prodSecretEnc: null,
        prodCertPem: null,
        prodComplianceRequestId: null,
        prodOnboardedAt: null,
      })
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

  /**
   * Reset PIH chain back to the initial seed. Use only when starting fresh.
   *
   * Under the seller's chain lock, because this is the other writer of the same
   * counter: a reset landing mid-submission is overwritten moments later when
   * that submission commits its own ICV, leaving the chain head pointing past
   * invoices this call has just soft-deleted.
   */
  async resetChain(userId: number, env: ZatcaEnv, ownerId: number | null = null) {
    return withSellerChainLock(userId, ownerId, () => this.resetChainUnderLock(userId, env, ownerId));
  }

  private async resetChainUnderLock(userId: number, env: ZatcaEnv, ownerId: number | null) {
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
