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
import { checkInvoiceReadiness, readinessMessage } from "../../common/invoice-readiness";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { InvoiceService, type CreateInvoiceDto } from "./services/invoice.service";
import { PdfService } from "./services/pdf.service";

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
    // Same guard as the approval path on the plain billing side — a
    // contract-linked e-invoice must have complete tenant/landlord data and an
    // onboarded landlord, otherwise ZATCA rejects it after we have already
    // burned an ICV. Nothing is saved as a draft here, so refusing costs the
    // caller no work.
    if (body.contractId) {
      const readiness = await checkInvoiceReadiness(this.db, scopeId(user), body.contractId);
      if (!readiness.ok) {
        throw new BadRequestException({
          error: "invoice_not_ready",
          message: `لا يمكن إصدار الفاتورة — بيانات ناقصة: ${readinessMessage(readiness)}`,
          readiness,
        });
      }
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

