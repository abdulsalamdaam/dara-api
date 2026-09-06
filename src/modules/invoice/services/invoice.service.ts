import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Logger } from "@nestjs/common";
import { eq, and, isNull, desc, ilike, count } from "drizzle-orm";
import {
  invoicesTable,
  invoiceLinesTable,
  type Invoice,
  type InvoiceLine,
  type SellerSnapshot,
  type BuyerSnapshot,
  type ZatcaCredentials,
  zatcaCredentialsTable,
  ZATCA_INITIAL_PIH,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../../database/database.module";
import { InvoiceBuilderService, type InvoiceLineInput, todayIsoDate, todayIsoTime } from "./invoice-builder.service";
import { InvoiceSignerService } from "./invoice-signer.service";
import { ZatcaApiService, isCredentialRejection } from "./zatca-api.service";
import { ZatcaOnboardingService, type DecryptedCreds } from "./zatca-onboarding.service";
import { withSellerChainLock } from "./chain-lock";
import { isOnboarded, resolveStandaloneSellerId } from "../../../common/invoice-readiness";

export interface CreateInvoiceDto {
  invoiceNumber: string;
  /** Per-landlord seller (matches the ZATCA credentials row); null = account-level. */
  ownerId?: number | null;
  profile: "standard" | "simplified";
  docType?: "invoice" | "credit" | "debit";
  language?: "ar" | "en";
  currency?: string;
  contractId?: number | null;
  paymentId?: number | null;
  buyer?: BuyerSnapshot | null;
  lines: InvoiceLineInput[];
  /** For credit/debit notes: original invoice ID + reason. */
  billingReferenceId?: string | null;
  instructionNote?: string | null;
  paymentMeansCode?: string;
  notes?: string | null;
  /** Submission target for first dispatch. Auto-derived from profile if absent. */
  submitTo?: "compliance" | "clearance" | "reporting";
  isDemo?: boolean;
}

export interface IssueResult {
  invoice: Invoice;
  lines: InvoiceLine[];
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly builder: InvoiceBuilderService,
    private readonly signer: InvoiceSignerService,
    private readonly api: ZatcaApiService,
    private readonly onboarding: ZatcaOnboardingService,
  ) {}

  /**
   * Issue (build → sign → submit → store) a new invoice for the given user.
   *
   * Wraps the entire flow:
   *   1. fetch active env credentials and current ICV/PIH chain head
   *   2. assemble the unsigned UBL using the seller snapshot from creds
   *   3. sign (XAdES) + compute QR
   *   4. submit to ZATCA (compliance/clearance/reporting)
   *   5. write invoice + invoice_lines rows
   *   6. update PIH chain head + ICV
   *
   * Failures at step 4 still write a row with status="error" so the caller
   * can retry submission later via `resubmit()`.
   *
   * Serialized per seller — see `withSellerChainLock`. Steps 1 and 6 are a
   * read-modify-write of a counter that ZATCA requires to be strictly
   * sequential, with a network round trip in between, so two concurrent
   * issues for one seller must not interleave.
   */
  async issue(userId: number, dto: CreateInvoiceDto): Promise<IssueResult> {
    // Resolve the seller HERE, before the lock, for two reasons. The lock is
    // keyed by seller, so a key computed from a different id than the chain the
    // body ends up touching would protect nothing. And the readiness gate
    // resolves it this way too — leaving `issue()` on a bare `dto.ownerId`
    // meant an account whose only credentials are per-landlord passed a gate
    // that had checked the account holder's link, then failed here with
    // "Seller profile not configured" about the account-level row nothing can
    // create.
    const ownerId = dto.ownerId ?? (await resolveStandaloneSellerId(this.db, userId));
    return withSellerChainLock(userId, ownerId, () =>
      this.issueUnderChainLock(userId, { ...dto, ownerId }));
  }

  private async issueUnderChainLock(userId: number, dto: CreateInvoiceDto): Promise<IssueResult> {
    if (!dto.lines?.length) throw new BadRequestException("invoice must have at least one line");
    if (!dto.invoiceNumber) throw new BadRequestException("invoiceNumber required");

    // Reject duplicate invoice number early for a clean error. NOTE: the unique
    // index is (userId, invoiceNumber) and does NOT exclude soft-deleted rows,
    // so this check must NOT filter by deletedAt — otherwise a previously-deleted
    // number passes here but collides on insert as a raw DB error.
    const [existing] = await this.db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.userId, userId),
          eq(invoicesTable.invoiceNumber, dto.invoiceNumber),
        ),
      );
    if (existing) throw new ConflictException(`Invoice number ${dto.invoiceNumber} already exists`);

    const ownerId = dto.ownerId ?? null;
    const { creds, decrypted } = await this.onboarding.getActiveCredentials(userId, ownerId);

    // The last gate, and the only one every caller must pass.
    //
    // Callers were the gate before, and one of them had a hole: credit and
    // debit notes are exempt at the controller — rightly, since a note corrects
    // an invoice that already went out — but that exemption could not tell a
    // link revoked AFTER the original was filed from a seller who was never
    // linked at all. A seller stuck at step 2 of onboarding could therefore
    // sign a real note with a COMPLIANCE certificate and post it to /core.
    //
    // `getActiveCredentials` above deliberately still serves a compliance slot,
    // because the compliance suite has to sign with it. So the distinction has
    // to be drawn here, on the path that mints a real document.
    if (!isOnboarded(creds)) {
      throw new ConflictException({
        error: "zatca_not_onboarded",
        message:
          "لا يمكن توقيع فاتورة حقيقية — لم يكتمل ربط المؤجر بهيئة الزكاة والضريبة (الشهادة الحالية للفحص فقط). أكمل الربط من الإعدادات.",
      });
    }
    const nextIcv = decrypted.icv + 1;
    const issueDate = todayIsoDate();
    const issueTime = todayIsoTime();

    const sellerSnapshot: SellerSnapshot = this.sellerSnapshotFrom(creds);

    // ZATCA: a tax invoice's buyer and seller cannot be the same taxable person.
    // A contract where the tenant (buyer) and landlord (seller) carry the SAME
    // VAT number is invalid — reject it clearly instead of letting ZATCA bounce.
    const buyerVat = (dto.buyer?.vat ?? "").trim();
    const sellerVat = (sellerSnapshot.vat ?? "").trim();
    if (dto.profile === "standard" && buyerVat && sellerVat && buyerVat === sellerVat) {
      throw new BadRequestException(
        "الرقم الضريبي للمشتري لا يمكن أن يطابق الرقم الضريبي للبائع — المستأجر والمؤجر لا يمكن أن يحملا نفس الرقم الضريبي. (Buyer and seller VAT numbers must differ.)",
      );
    }

    // ZATCA BR-KSA-63: a standard tax invoice must carry a COMPLETE national
    // postal address for both seller and buyer. We never silently drop address
    // fields — the full address (street, building no., district, city, postal
    // code) is mandatory and validated up front. Simplified (B2C) invoices have
    // no identified buyer, so only the seller address is required there.
    this.assertAddressComplete(sellerSnapshot, "Seller");
    if (dto.profile === "standard") this.assertAddressComplete(dto.buyer, "Buyer");

    const built = this.builder.build({
      profile: dto.profile,
      docType: dto.docType ?? "invoice",
      invoiceId: dto.invoiceNumber,
      icv: nextIcv,
      pih: decrypted.pih,
      issueDate,
      issueTime,
      seller: sellerSnapshot,
      buyer: dto.buyer ?? null,
      lines: dto.lines,
      billingReference: dto.billingReferenceId ? { id: dto.billingReferenceId } : undefined,
      instructionNote: dto.instructionNote ?? undefined,
      paymentMeansCode: dto.paymentMeansCode,
      currency: dto.currency,
    });

    const signed = await this.signer.signInvoice({
      invoiceXml: built.xml,
      privateKeyPem: decrypted.privateKeyPem,
      certPem: decrypted.certPem,
      profile: dto.profile,
      qrFields: {
        sellerName: sellerSnapshot.name,
        vatNumber: sellerSnapshot.vat,
        timestamp: `${issueDate}T${issueTime}`,
        totalWithVat: built.totals.taxInclusive.toFixed(2),
        vatTotal: built.totals.taxAmount.toFixed(2),
      },
    });

    // Pick endpoint
    const submitTo: "compliance" | "clearance" | "reporting" =
      dto.submitTo
        ?? (decrypted.environment === "production"
          ? dto.profile === "standard"
            ? "clearance"
            : "reporting"
          : "compliance");

    const submission =
      submitTo === "clearance"
        ? this.api.clearInvoice
        : submitTo === "reporting"
          ? this.api.reportInvoice
          : this.api.complianceInvoice;
    let resp;
    try {
      resp = await submission.call(this.api, {
        binarySecurityToken: decrypted.binarySecurityToken,
        secret: decrypted.secret,
        invoiceHash: signed.invoiceHashBase64,
        uuid: built.uuid,
        signedXml: signed.signedXml,
        environment: decrypted.environment,
      });
    } catch (e) {
      resp = { status: 0, raw: (e as Error).message, json: null, headers: {} };
    }

    // ZATCA refused the CREDENTIALS, not the document — the EGS device has been
    // removed in Fatoora, or the CSID was revoked. Bail out HERE, before the
    // `invoices` row is written and before `commitInvoiceState` below, because
    // everything past this point is irreversible in a way this case does not
    // deserve:
    //
    //   · the ICV is consumed unconditionally (see the comment further down),
    //     and `invoices_user_owner_env_icv_uniq` has no `deleted_at` predicate,
    //     so a burned counter cannot be reclaimed by deleting the row;
    //   · the row itself would make `simple_invoices.zatca_invoice_id` non-null,
    //     which `isSubmittedToZatca` reads as "this document reached ZATCA" and
    //     uses to block a contract rebuild — permanently, for a document ZATCA
    //     never saw.
    //
    // Nothing was filed, so nothing should be recorded as filed. The seller has
    // to link again; correcting the invoice cannot help.
    if (isCredentialRejection(resp)) {
      await this.onboarding.markLinkInvalid(
        userId, ownerId,
        `ZATCA رفضت بيانات الربط (${resp.status}) — يجب إعادة الربط مع هيئة الزكاة والضريبة`,
      );
      throw new ConflictException({
        error: "zatca_link_invalid",
        message:
          "انقطع الربط مع هيئة الزكاة والضريبة — لم تعد الشهادة مقبولة لدى الهيئة. أعد الربط من الإعدادات ثم أعد إرسال الفاتورة.",
        // ZATCA's status, not this response's — naming it `httpStatus` next to a
        // 409 invited exactly the confusion it sounds like.
        zatcaHttpStatus: resp.status,
      });
    }

    const status = this.deriveStatus(resp);
    const clearedXml =
      submitTo === "clearance" && (resp.json as any)?.clearedInvoice
        ? Buffer.from(String((resp.json as any).clearedInvoice), "base64").toString("utf8")
        : null;

    const [invoice] = await this.db
      .insert(invoicesTable)
      .values({
        userId,
        ownerId,
        invoiceNumber: dto.invoiceNumber,
        uuid: built.uuid,
        contractId: dto.contractId ?? null,
        paymentId: dto.paymentId ?? null,
        profile: dto.profile,
        docType: dto.docType ?? "invoice",
        language: dto.language ?? "ar",
        currency: dto.currency ?? "SAR",
        issueDate,
        issueTime,
        icv: nextIcv,
        pih: decrypted.pih,
        environment: decrypted.environment,
        billingReferenceId: dto.billingReferenceId ?? null,
        instructionNote: dto.instructionNote ?? null,
        paymentMeansCode: dto.paymentMeansCode ?? "10",
        sellerSnapshot,
        buyerSnapshot: dto.buyer ?? null,
        totals: built.totals,
        unsignedXml: built.xml,
        signedXml: signed.signedXml,
        invoiceHash: signed.invoiceHashBase64,
        qrBase64: signed.qrBase64,
        signatureValue: signed.signatureValueBase64,
        status,
        submittedTo: submitTo,
        httpStatus: resp.status || null,
        zatcaResponse: (resp.json ?? null) as any,
        submittedAt: new Date(),
        clearedXml,
        notes: dto.notes ?? null,
        isDemo: dto.isDemo ?? false,
      })
      .returning();

    const linesRows = await this.db
      .insert(invoiceLinesTable)
      .values(
        built.computedLines.map((l, i) => ({
          invoiceId: invoice.id,
          lineNumber: i + 1,
          externalId: l.id,
          name: l.name,
          unitCode: l.unitCode,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          vatCategory: l.vatCategory,
          vatPercent: String(l.vatPercent ?? 0),
          lineNet: l._lineNet.toFixed(2),
          lineVat: l._lineVat.toFixed(2),
          lineTotalIncVat: l._lineTotalIncVat.toFixed(2),
        })),
      )
      .returning();

    // Always advance PIH if we produced a valid signed hash, regardless of
    // ZATCA acceptance — the chain is local and re-submitting the same
    // invoice will use the same hash anyway.
    await this.onboarding.commitInvoiceState(
      userId,
      decrypted.environment,
      nextIcv,
      signed.invoiceHashBase64,
      ownerId,
    );

    // ZATCA accepted a document, so the link works — retire any earlier "ZATCA
    // stopped accepting this" flag. Proving it with an accepted document rather
    // than only with a fresh CSID matters because the flag can be raised by a
    // transient 403, and a seller who is in fact fine should not have to
    // re-onboard to clear it.
    if (status === "cleared" || status === "reported" || status === "submitted") {
      try { await this.onboarding.clearLinkInvalid(userId, ownerId); }
      catch { /* the invoice is filed; a stale flag must not fail the call */ }
    }

    return { invoice, lines: linesRows };
  }

  /**
   * Verify a landlord's ZATCA integration end-to-end WITHOUT persisting: build
   * a sample standard invoice with the landlord's seller data, sign it with
   * their certificate, and submit it to ZATCA's /compliance/invoices. Returns
   * ZATCA's verdict (pass / warnings / errors) — the definitive "is it working"
   * check. Nothing is written and the chain (PIH/ICV) is not advanced.
   */
  async complianceCheck(userId: number, ownerId: number | null): Promise<{
    ok: boolean; httpStatus: number; status: string; warnings: string[]; errors: string[];
  }> {
    // A compliance check is a PRE-go-live gate. Issuing the production CSID
    // overwrites the compliance CSID it was promoted from, so a live seller no
    // longer holds compliance credentials at all — running this would submit the
    // production CSID to ZATCA's /compliance endpoint, which answers "already
    // completed" for standard and rejects the simplified docs on signature
    // validation. That is not a defect in the seller or the signing; it is a
    // check that no longer applies. Refuse it in plain language rather than
    // surfacing ZATCA's confusing rejection.
    {
      const c = await this.onboarding.getCredentials(userId, ownerId);
      if (c && (c as any).prodSlotEnv === "production" && (c as any).activeEnvironment === "production") {
        throw new ConflictException(
          "هذا المؤجر مُفعّل على بيئة الإنتاج بالفعل — فحص التوافق خطوة سابقة للتفعيل ولا تنطبق بعده. الفواتير الحقيقية تُرسَل مباشرة إلى هيئة الزكاة.",
        );
      }
    }
    // getActiveCredentials throws clean HTTP errors (404/409) if not onboarded —
    // let those bubble. Everything else is wrapped so a tooling/signing failure
    // becomes a readable verdict, never a 500.
    const { creds, decrypted } = await this.onboarding.getActiveCredentials(userId, ownerId);
    /* Say what happened.
     *
     * This check deliberately persists nothing, which also meant it left no
     * trace anywhere: no row, no log line above debug, and the proxy keeps no
     * access log. Someone pressing "فحص" on production and asking afterwards
     * what ZATCA said could not be answered from the server at all — the
     * verdict existed only in the browser that received it. A support tool you
     * cannot support from is not much of one.
     */
    const who = `owner=${ownerId ?? "self"} user=${userId} env=${decrypted.environment}`;
    try {
      const r = await this.submitComplianceDoc(
        decrypted, this.sellerSnapshotFrom(creds),
        { profile: "standard", docType: "invoice" }, decrypted.icv + 1, decrypted.pih,
      );
      const detail = `${who} http=${r.httpStatus} status=${r.status}`;
      if (r.ok) this.logger.log(`compliance-check PASS ${detail} warnings=${r.warnings.length}`);
      else this.logger.warn(`compliance-check FAIL ${detail} errors=${JSON.stringify(r.errors).slice(0, 400)}`);
      // This is the way OUT of a link flagged invalid, and it has to be, because
      // the flag blocks approvals and approvals were the only other thing that
      // could clear it — a seller knocked offline by one transient 403 would
      // otherwise have no route back except a fresh Fatoora OTP. "فحص" submits a
      // throwaway document under the real credentials, so a pass is exactly the
      // proof needed; a credential rejection here is equally good evidence the
      // other way.
      try {
        if (r.ok) await this.onboarding.clearLinkInvalid(userId, ownerId);
        else if (r.httpStatus === 401 || r.httpStatus === 403) {
          await this.onboarding.markLinkInvalid(
            userId, ownerId,
            `ZATCA رفضت بيانات الربط (${r.httpStatus}) — يجب إعادة الربط مع هيئة الزكاة والضريبة`,
          );
        }
      } catch { /* the verdict is what the caller asked for — never fail on the flag */ }
      return { ok: r.ok, httpStatus: r.httpStatus, status: r.status, warnings: r.warnings, errors: r.errors };
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      this.logger.warn(`compliance-check ERROR ${who} ${msg.slice(0, 400)}`);
      return { ok: false, httpStatus: 0, status: "ERROR", warnings: [], errors: [msg.slice(0, 500)] };
    }
  }

  /**
   * Run the FULL compliance test suite required before ZATCA will issue a
   * production CSID: every document type declared in the CSR's invoiceType
   * (e.g. "1100" → standard + simplified, each as invoice/credit/debit).
   * Documents are PIH-chained in sequence. Nothing is persisted, so it is
   * safely re-runnable. Returns a per-document verdict plus an overall pass.
   */
  async complianceSuite(userId: number, ownerId: number | null, opts?: { skipLiveGuard?: boolean }): Promise<{
    ok: boolean; passed: number; total: number;
    results: { doc: string; ok: boolean; status: string; warnings: string[]; errors: string[] }[];
  }> {
    // The go-live guard is skipped when onboarding calls this: mid-onboarding the
    // record already reads prodSlotEnv/activeEnvironment=production (it holds the
    // compliance CSID in the prod slot), and this suite is exactly the step ZATCA
    // requires before it will issue the production CSID. Outside onboarding, a
    // live seller pressing "فحص كامل" is refused in plain language rather than
    // hitting ZATCA's /compliance endpoint with a production CSID.
    if (!opts?.skipLiveGuard) {
      const c = await this.onboarding.getCredentials(userId, ownerId);
      if (c && (c as any).prodSlotEnv === "production" && (c as any).activeEnvironment === "production") {
        throw new ConflictException(
          "هذا المؤجر مُفعّل على بيئة الإنتاج بالفعل — فحص التوافق خطوة سابقة للتفعيل ولا تنطبق بعده. الفواتير الحقيقية تُرسَل مباشرة إلى هيئة الزكاة.",
        );
      }
    }
    const { creds, decrypted } = await this.onboarding.getActiveCredentials(userId, ownerId);
    const seller = this.sellerSnapshotFrom(creds);
    const it = creds.invoiceType || "1100";
    const specs: { profile: "standard" | "simplified"; docType: "invoice" | "credit" | "debit"; doc: string }[] = [];
    if (it[0] === "1") specs.push(
      { profile: "standard", docType: "invoice", doc: "Standard invoice" },
      { profile: "standard", docType: "credit", doc: "Standard credit note" },
      { profile: "standard", docType: "debit", doc: "Standard debit note" },
    );
    if (it[1] === "1") specs.push(
      { profile: "simplified", docType: "invoice", doc: "Simplified invoice" },
      { profile: "simplified", docType: "credit", doc: "Simplified credit note" },
      { profile: "simplified", docType: "debit", doc: "Simplified debit note" },
    );

    const results: { doc: string; ok: boolean; status: string; warnings: string[]; errors: string[] }[] = [];
    let icv = decrypted.icv;
    let pih = decrypted.pih;
    for (const s of specs) {
      icv += 1;
      let r;
      try {
        r = await this.submitComplianceDoc(decrypted, seller, s, icv, pih);
      } catch (e) {
        r = { ok: false, httpStatus: 0, status: "ERROR", warnings: [], errors: [((e as Error)?.message || String(e)).slice(0, 500)], hash: pih };
      }
      pih = r.hash; // chain the next document onto this one's hash
      results.push({ doc: s.doc, ok: r.ok, status: r.status, warnings: r.warnings, errors: r.errors });
    }
    const passed = results.filter((r) => r.ok).length;
    return { ok: results.length > 0 && passed === results.length, passed, total: results.length, results };
  }

  private sellerSnapshotFrom(creds: ZatcaCredentials): SellerSnapshot {
    return {
      name: creds.sellerName, nameAr: creds.sellerNameAr, vat: creds.sellerVatNumber, crn: creds.sellerCrn,
      idScheme: creds.sellerIdScheme,
      street: creds.sellerStreet, buildingNo: creds.sellerBuildingNo, district: creds.sellerDistrict,
      city: creds.sellerCity, postalZone: creds.sellerPostalZone, additionalNo: creds.sellerAdditionalNo,
    };
  }

  /**
   * Reject an incomplete national address before it ever reaches ZATCA. The
   * four-line Saudi address — street, building number, district, city and
   * postal code — is mandatory; only the additional number is optional.
   */
  private assertAddressComplete(
    a: { street?: string | null; buildingNo?: string | null; district?: string | null; city?: string | null; postalZone?: string | null } | null | undefined,
    who: "Seller" | "Buyer",
  ): void {
    const required = { street: "street", buildingNo: "building number", district: "district", city: "city", postalZone: "postal code" } as const;
    const missing = (Object.keys(required) as (keyof typeof required)[]).filter((k) => !a?.[k] || !String(a[k]).trim());
    if (!a || missing.length) {
      const labels = missing.map((k) => required[k]).join(", ");
      throw new BadRequestException(
        `${who} national address is incomplete for ZATCA — missing: ${labels}. A complete address (street, building number, district, city, postal code) is required for a standard tax invoice.`,
      );
    }
  }

  /** Build → sign → submit ONE document to ZATCA's compliance endpoint. */
  private async submitComplianceDoc(
    decrypted: DecryptedCreds,
    seller: SellerSnapshot,
    spec: { profile: "standard" | "simplified"; docType: "invoice" | "credit" | "debit" },
    icv: number,
    pih: string,
  ): Promise<{ ok: boolean; httpStatus: number; status: string; warnings: string[]; errors: string[]; hash: string }> {
    const issueDate = todayIsoDate();
    const issueTime = todayIsoTime();
    const isNote = spec.docType !== "invoice";
    const tag = `${spec.profile === "simplified" ? "S" : "T"}${{ invoice: "INV", credit: "CRN", debit: "DBN" }[spec.docType]}`;
    const built = this.builder.build({
      profile: spec.profile,
      docType: spec.docType,
      invoiceId: `CHK-${tag}-${icv}`,
      icv,
      pih,
      issueDate, issueTime,
      seller,
      // Standard (B2B/clearance) needs a registered buyer; simplified (B2C) is minimal.
      buyer: spec.profile === "standard"
        ? { name: "Compliance Buyer Co", vat: "399999999900003", street: "Test St", buildingNo: "1234", district: "Test", city: "Riyadh", postalZone: "12345" }
        : { name: "Walk-in Customer" },
      lines: [{ id: "1", name: "فحص توافق ZATCA", quantity: 1, unitPrice: 1000, vatPercent: 15, vatCategory: "S" }],
      // Credit/debit notes must reference an original invoice + carry a reason.
      billingReference: isNote ? { id: `CHK-${spec.profile === "simplified" ? "S" : "T"}INV-1` } : undefined,
      instructionNote: isNote ? (spec.docType === "credit" ? "Compliance test credit note" : "Compliance test debit note") : undefined,
      currency: "SAR",
    });
    const signed = await this.signer.signInvoice({
      invoiceXml: built.xml, privateKeyPem: decrypted.privateKeyPem, certPem: decrypted.certPem, profile: spec.profile,
      qrFields: {
        sellerName: seller.name, vatNumber: seller.vat,
        timestamp: `${issueDate}T${issueTime}`,
        totalWithVat: built.totals.taxInclusive.toFixed(2), vatTotal: built.totals.taxAmount.toFixed(2),
      },
    });
    let resp;
    try {
      resp = await this.api.complianceInvoice({
        binarySecurityToken: decrypted.binarySecurityToken, secret: decrypted.secret,
        invoiceHash: signed.invoiceHashBase64, uuid: built.uuid, signedXml: signed.signedXml,
        environment: decrypted.environment,
      });
    } catch (e) {
      resp = { status: 0, raw: (e as Error).message, json: null, headers: {} } as any;
    }
    const j: any = resp.json ?? {};
    const vr = j.validationResults ?? {};
    const pick = (arr: any[]) => (Array.isArray(arr) ? arr.map((m) => m?.message || m?.code || String(m)) : []);
    const errors = pick(vr.errorMessages);
    const warnings = pick(vr.warningMessages);
    if (!errors.length && !(resp.status >= 200 && resp.status < 300)) {
      const raw = (resp as any).raw || (j && Object.keys(j).length ? JSON.stringify(j) : "");
      errors.push(raw ? `HTTP ${resp.status}: ${String(raw).slice(0, 500)}` : `HTTP ${resp.status}`);
    }
    // "Compliance check already completed for X" means ZATCA has this document
    // type on record as PASSED against this compliance CSID — re-running it is a
    // no-op, not a failure. Once a seller has passed a type, it can never be
    // resubmitted, so treating it as a failure would make onboarding impossible
    // to finish after a partial run (exactly what stranded owner 264: standard
    // passed, the run stopped on simplified, and every retry then reported
    // standard as "already completed").
    const alreadyDone = errors.length > 0 && errors.every((e) => /already completed/i.test(String(e)));
    const reportStatus = j.reportingStatus || j.clearanceStatus || vr.status
      || (alreadyDone ? "ALREADY_DONE" : (resp.status >= 200 && resp.status < 300 ? "PASS" : `HTTP ${resp.status}`));
    const ok = alreadyDone || (resp.status >= 200 && resp.status < 300 && errors.length === 0);
    return { ok, httpStatus: resp.status, status: String(reportStatus), warnings, errors: alreadyDone ? [] : errors, hash: signed.invoiceHashBase64 };
  }

  /* ─── Read APIs ─────────────────────────────────────────────────────── */

  async list(userId: number, opts: { limit?: number; offset?: number } = {}): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.userId, userId), isNull(invoicesTable.deletedAt)))
      .orderBy(desc(invoicesTable.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
  }

  /** Paginated + invoice-number search — returns rows plus the total count. */
  async listPaged(
    userId: number,
    opts: { page: number; pageSize: number; search?: string },
  ): Promise<{ data: Invoice[]; total: number }> {
    const conds = [eq(invoicesTable.userId, userId), isNull(invoicesTable.deletedAt)];
    if (opts.search) conds.push(ilike(invoicesTable.invoiceNumber, `%${opts.search}%`));
    const where = and(...conds);
    const [rows, totalRow] = await Promise.all([
      this.db.select().from(invoicesTable).where(where)
        .orderBy(desc(invoicesTable.createdAt))
        .limit(opts.pageSize).offset((opts.page - 1) * opts.pageSize),
      this.db.select({ total: count() }).from(invoicesTable).where(where),
    ]);
    return { data: rows, total: Number(totalRow[0]?.total ?? 0) };
  }

  async getOneWithLines(userId: number, id: number): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
    const [invoice] = await this.db
      .select()
      .from(invoicesTable)
      .where(
        and(eq(invoicesTable.id, id), eq(invoicesTable.userId, userId), isNull(invoicesTable.deletedAt)),
      );
    if (!invoice) throw new NotFoundException("Invoice not found");
    const lines = await this.db
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, id))
      .orderBy(invoiceLinesTable.lineNumber);
    return { invoice, lines };
  }

  async softDelete(userId: number, id: number) {
    const r = await this.db
      .update(invoicesTable)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(invoicesTable.id, id), eq(invoicesTable.userId, userId), isNull(invoicesTable.deletedAt)),
      )
      .returning({ id: invoicesTable.id });
    if (!r.length) throw new NotFoundException("Invoice not found");
    return { ok: true };
  }

  /**
   * Resubmit an invoice (e.g. after a transient ZATCA outage). The signed
   * XML is re-used as-is — re-signing would invalidate the hash chain.
   */
  async resubmit(userId: number, id: number) {
    const { invoice } = await this.getOneWithLines(userId, id);
    if (!invoice.signedXml || !invoice.invoiceHash) {
      throw new BadRequestException("Invoice has no signed XML to resubmit");
    }
    // Under the invoice's OWN seller. This read the account-level credentials
    // regardless of which landlord signed the document, which silently
    // resubmitted landlord X's signed XML under a different seller's Basic auth
    // — and now that a free invoice carries the account holder's owner_id, it
    // would simply 404 for any account with no account-level row.
    const { decrypted } = await this.onboarding.getActiveCredentials(userId, invoice.ownerId ?? null);
    const submitTo = (invoice.submittedTo ?? "compliance") as "compliance" | "clearance" | "reporting";
    const submission =
      submitTo === "clearance"
        ? this.api.clearInvoice
        : submitTo === "reporting"
          ? this.api.reportInvoice
          : this.api.complianceInvoice;
    const resp = await submission.call(this.api, {
      binarySecurityToken: decrypted.binarySecurityToken,
      secret: decrypted.secret,
      invoiceHash: invoice.invoiceHash,
      uuid: invoice.uuid,
      signedXml: invoice.signedXml,
      environment: invoice.environment,
    });
    const newStatus = this.deriveStatus(resp);
    const clearedXml =
      submitTo === "clearance" && (resp.json as any)?.clearedInvoice
        ? Buffer.from(String((resp.json as any).clearedInvoice), "base64").toString("utf8")
        : invoice.clearedXml;
    const [updated] = await this.db
      .update(invoicesTable)
      .set({
        status: newStatus,
        httpStatus: resp.status,
        zatcaResponse: (resp.json ?? null) as any,
        submittedAt: new Date(),
        clearedXml,
      })
      .where(eq(invoicesTable.id, invoice.id))
      .returning();
    return updated;
  }

  private deriveStatus(resp: { status: number; json: any | null }): Invoice["status"] {
    if (resp.status === 0) return "error";
    const j = resp.json;
    if (j?.clearanceStatus === "CLEARED") return "cleared";
    if (j?.reportingStatus === "REPORTED") return "reported";
    if (resp.status >= 400) {
      if (j?.validationResults?.errorMessages?.length) return "rejected";
      return "error";
    }
    if (resp.status >= 200 && resp.status < 300) return "submitted";
    return "submitted";
  }
}
