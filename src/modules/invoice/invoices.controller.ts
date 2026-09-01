import {
  BadRequestException, Body, Controller, Delete, Get, Header, Inject,
  NotFoundException, Param, ParseIntPipe, Post, Query, Res, UseGuards,
} from "@nestjs/common";
import { ParseInt4Pipe } from "../../common/int4.pipe";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import type { Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { usersTable, companiesTable } from "@dara/database";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import {
  checkInvoiceReadiness, checkSellerLink, draftBlockersOf, eInvoiceBuyerBlockers,
  readinessMessage, resolveStandaloneSellerId,
  type InvoiceBlocker, type InvoiceReadiness,
} from "../../common/invoice-readiness";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { InvoiceService, type CreateInvoiceDto } from "./services/invoice.service";
import { PdfService } from "./services/pdf.service";

/**
 * The values the invoice columns can actually hold.
 *
 * `CreateInvoiceDto` is a TypeScript interface, so the global
 * `ValidationPipe({ whitelist: true })` resolves its metatype to `Object` and
 * passes the body through untouched — every field below is raw client input at
 * runtime. Left unchecked, a bad `profile` is caught by the `pgEnum` on INSERT,
 * which is to say after the document has been built, signed, submitted to ZATCA
 * and an ICV consumed: the one place where a rejection costs something
 * irreversible.
 */
const PROFILES = ["standard", "simplified"] as const;
const DOC_TYPES = ["invoice", "credit", "debit"] as const;
const SUBMIT_TARGETS = ["compliance", "clearance", "reporting"] as const;

/** Name what arrived — a caller sending garbage needs to see its own value. */
function assertOneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new BadRequestException(
    `${field} must be one of ${allowed.join(" | ")} — received ${JSON.stringify(value)}`,
  );
}

/**
 * Dress a single blocker as the readiness envelope the contract path returns,
 * so a client renders one "here is what to fix" panel whatever the path was.
 */
function readinessOf(blockers: InvoiceBlocker[], ownerId: number | null): InvoiceReadiness {
  const draftBlockers = draftBlockersOf(blockers);
  return {
    ok: blockers.length === 0,
    blockers,
    draftBlockers,
    draftOk: draftBlockers.length === 0,
    confirmations: [],
    tenantId: null,
    ownerId,
  };
}

@ApiTags("invoices")
@ApiBearerAuth("user-jwt")
@Controller("invoices")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoicesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly invoices: InvoiceService,
    private readonly pdf: PdfService,
  ) {}

  /** GET /invoices — paginated (page/pageSize/search) or legacy (limit/offset). */
  @Get()
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async list(
    @CurrentUser() user: AuthUser,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("search") search?: string,
  ) {
    if (page != null || pageSize != null || search != null) {
      return this.invoices.listPaged(scopeId(user), {
        page: Math.max(1, parseInt(page ?? "1", 10) || 1),
        // 25 to match every other list in the product; cap raised to the shared 200.
        pageSize: Math.min(200, Math.max(1, parseInt(pageSize ?? "25", 10) || 25)),
        search: search?.trim() || undefined,
      });
    }
    return this.invoices.list(scopeId(user), {
      limit: limit ? Math.min(500, parseInt(limit, 10) || 100) : 100,
      offset: offset ? parseInt(offset, 10) || 0 : 0,
    });
  }

  /** GET /invoices/:id */
  @Get(":id")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async get(@CurrentUser() user: AuthUser, @Param("id", ParseInt4Pipe) id: number) {
    return this.invoices.getOneWithLines(scopeId(user), id);
  }

  /**
   * POST /invoices
   * Build, sign, submit, and persist an invoice in a single call.
   * Body matches CreateInvoiceDto.
   *
   * Despite the name, this is NOT a draft-creating endpoint: there is no draft
   * state on this side — the call signs the document and sends it to ZATCA
   * before it returns. So the readiness gate below is a SUBMISSION gate, the
   * counterpart of the one on POST /simple-invoices/:id/approve, and it stays.
   * Saving a billing DRAFT (POST /simple-invoices) applies only the half of the
   * same gate the drafter can act on — `draftBlockers`, i.e. everything except
   * the landlord's ZATCA link. Here there is no draft to save, so the full
   * check applies.
   */
  @Post()
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateInvoiceDto) {
    if (!body?.invoiceNumber) throw new BadRequestException("invoiceNumber required");
    if (!body.profile) throw new BadRequestException("profile required");
    if (!Array.isArray(body.lines) || body.lines.length === 0)
      throw new BadRequestException("at least one line required");

    // Presence was the only thing ever asked of these — see PROFILES above for
    // why that is not enough.
    const profile = assertOneOf("profile", body.profile, PROFILES);
    if (body.docType != null) assertOneOf("docType", body.docType, DOC_TYPES);
    const submitTo = body.submitTo == null
      ? null
      : assertOneOf("submitTo", body.submitTo, SUBMIT_TARGETS);
    // Same reasoning, one field further: an unchecked ownerId reaches the driver
    // as a query parameter and comes back as `invalid input syntax for type
    // integer` — a 500 on what is plainly a bad request.
    if (body.ownerId != null && !Number.isInteger(body.ownerId)) {
      throw new BadRequestException(`ownerId must be an integer — received ${JSON.stringify(body.ownerId)}`);
    }
    // The compliance endpoint is the ONBOARDING one. The service already routes
    // there by itself for sandbox and simulation, so a client never needs to ask
    // — and a live seller asking would spend a real ICV on a document ZATCA
    // files nowhere.
    if (submitTo === "compliance") {
      throw new BadRequestException("submitTo=compliance is chosen automatically during onboarding and cannot be requested");
    }

    // `submitTo` overrides the profile→endpoint derivation in the service, so a
    // client could file a simplified document at clearance (or a standard one
    // at reporting) and leave the stored profile describing a document that
    // went somewhere else. Clearance is for B2B and reporting for B2C; the two
    // are not interchangeable, and the row must keep saying where it went.
    if (submitTo === "clearance" && profile === "simplified")
      throw new BadRequestException("submitTo=clearance is for standard (B2B) invoices — a simplified invoice is reported, not cleared");
    if (submitTo === "reporting" && profile === "standard")
      throw new BadRequestException("submitTo=reporting is for simplified (B2C) invoices — a standard invoice must be cleared");

    // Same guard as the approval path on the plain billing side — a
    // contract-linked e-invoice must have complete tenant/landlord data and an
    // onboarded landlord, otherwise ZATCA rejects it after we have already
    // burned an ICV. Nothing is saved as a draft here, so refusing costs the
    // caller no work.
    const scoped = scopeId(user);
    if (body.contractId) {
      const readiness = await checkInvoiceReadiness(this.db, scoped, body.contractId);
      if (!readiness.ok) {
        throw new BadRequestException({
          error: "invoice_not_ready",
          message: `لا يمكن إصدار الفاتورة — بيانات ناقصة: ${readinessMessage(readiness)}`,
          readiness,
        });
      }
    } else {
      // No contract is not "no parties". The seller still has to be linked to
      // ZATCA before anything can be signed on their behalf, and this used to
      // be skipped entirely: `if (body.contractId)` around the whole gate meant
      // a contract-less call was checked for nothing at all.
      const sellerId = body.ownerId ?? await resolveStandaloneSellerId(this.db, scoped);
      // Notes are NOT exempt here any more, and the exemption that used to sit
      // on this line was doing nothing but changing the error text.
      //
      // It was written on the premise that a note corrects an invoice that
      // already went out, so it must stay issuable even if the link was revoked
      // afterwards. But `issue()` now refuses anything the seller cannot
      // actually sign, `linkInvalidAt` included — and it is right to: with a
      // revoked link there is no certificate ZATCA will accept, so a note
      // "issued" then is a document that cannot be filed. Two doors that both
      // close is fine; a comment claiming one is open is not.
      const sellerBlocker = await checkSellerLink(this.db, scoped, sellerId);
      if (sellerBlocker) {
        const readiness = readinessOf([sellerBlocker], sellerId);
        throw new BadRequestException({
          error: "invoice_not_ready",
          message: `لا يمكن إصدار الفاتورة — بيانات ناقصة: ${readinessMessage(readiness)}`,
          readiness,
        });
      }
    }

    // The buyer, on every path. `assertAddressComplete` inside the service
    // covers the address and only for standard, which leaves a standard invoice
    // with no buyer VAT number to be built with an empty PartyTaxScheme, signed,
    // and POSTed to clearance — a document we already knew ZATCA would reject,
    // for an ICV that cannot be reclaimed. So it is refused here, before
    // `issue()` touches anything.
    const buyerMissing = eInvoiceBuyerBlockers(body.buyer, profile);
    if (buyerMissing.length) {
      const readiness = readinessOf(
        [{
          entity: "buyer", id: null, name: body.buyer?.name ?? null,
          missing: buyerMissing, action: "edit_document",
        }],
        body.ownerId ?? null,
      );
      throw new BadRequestException({
        error: "invoice_not_ready",
        message: `لا يمكن إصدار الفاتورة — بيانات المشتري ناقصة: ${buyerMissing.join("، ")}`,
        readiness,
      });
    }
    return this.invoices.issue(scopeId(user), body);
  }

  /**
   * POST /invoices/:id/resubmit
   * Resend the existing signed XML to ZATCA — useful after a transient outage.
   */
  @Post(":id/resubmit")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async resubmit(@CurrentUser() user: AuthUser, @Param("id", ParseInt4Pipe) id: number) {
    return this.invoices.resubmit(scopeId(user), id);
  }

  /** DELETE /invoices/:id  (soft-delete) */
  @Delete(":id")
  @RequirePermissions(PERMISSIONS.INVOICES_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id", ParseInt4Pipe) id: number) {
    return this.invoices.softDelete(scopeId(user), id);
  }

  /** GET /invoices/:id/xml — raw signed XML (or unsigned if not yet signed) */
  @Get(":id/xml")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  @Header("Content-Type", "application/xml; charset=utf-8")
  async getXml(@CurrentUser() user: AuthUser, @Param("id", ParseInt4Pipe) id: number) {
    const { invoice } = await this.invoices.getOneWithLines(scopeId(user), id);
    return invoice.signedXml ?? invoice.unsignedXml;
  }

  /** GET /invoices/:id/html — bilingual print template */
  @Get(":id/html")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  @Header("Content-Type", "text/html; charset=utf-8")
  async getHtml(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseInt4Pipe) id: number,
    @Query("lang") lang?: "ar" | "en",
  ) {
    const ctx = await this.buildRenderContext(user, id, lang);
    return this.pdf.renderHtml(ctx);
  }

  /** GET /invoices/:id/pdf — bilingual PDF (Chrome headless) */
  @Get(":id/pdf")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async getPdf(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseInt4Pipe) id: number,
    @Query("lang") lang: "ar" | "en" | undefined,
    @Res() res: Response,
  ) {
    const ctx = await this.buildRenderContext(user, id, lang);
    const pdf = await this.pdf.renderPdf(ctx);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${ctx.invoice.invoiceNumber}.pdf"`);
    res.send(pdf);
  }

  /* ─── helpers ───────────────────────────────────────────────────────── */

  private async buildRenderContext(user: AuthUser, id: number, lang?: "ar" | "en") {
    const { invoice, lines } = await this.invoices.getOneWithLines(scopeId(user), id);
    const [row] = await this.db
      .select({
        companyLogoKey: companiesTable.logoKey,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .where(and(eq(usersTable.id, scopeId(user)), isNull(usersTable.deletedAt)));
    return {
      invoice,
      lines,
      language: lang ?? invoice.language ?? "ar",
      brand: { logoUrl: row?.companyLogoKey ?? null },
    } as const;
  }
}

