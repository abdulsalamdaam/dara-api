import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
import { ZatcaApiService } from "./zatca-api.service";
import { ZatcaOnboardingService, type DecryptedCreds } from "./zatca-onboarding.service";

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
   */
  async issue(userId: number, dto: CreateInvoiceDto): Promise<IssueResult> {
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
    // getActiveCredentials throws clean HTTP errors (404/409) if not onboarded —
    // let those bubble. Everything else is wrapped so a tooling/signing failure
    // becomes a readable verdict, never a 500.
    const { creds, decrypted } = await this.onboarding.getActiveCredentials(userId, ownerId);
    try {
      const r = await this.submitComplianceDoc(
        decrypted, this.sellerSnapshotFrom(creds),
        { profile: "standard", docType: "invoice" }, decrypted.icv + 1, decrypted.pih,
      );
      return { ok: r.ok, httpStatus: r.httpStatus, status: r.status, warnings: r.warnings, errors: r.errors };
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
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
  async complianceSuite(userId: number, ownerId: number | null): Promise<{
    ok: boolean; passed: number; total: number;
    results: { doc: string; ok: boolean; status: string; warnings: string[]; errors: string[] }[];
  }> {
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
    const reportStatus = j.reportingStatus || j.clearanceStatus || vr.status || (resp.status >= 200 && resp.status < 300 ? "PASS" : `HTTP ${resp.status}`);
    const ok = resp.status >= 200 && resp.status < 300 && errors.length === 0;
    return { ok, httpStatus: resp.status, status: String(reportStatus), warnings, errors, hash: signed.invoiceHashBase64 };
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
    const { decrypted } = await this.onboarding.getActiveCredentials(userId);
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
