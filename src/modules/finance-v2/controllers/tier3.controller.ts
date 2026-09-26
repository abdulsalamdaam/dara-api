import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { ApService } from "../tier3/ap.service";
import { JournalExportService } from "../tier3/journal-export.service";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * DESIGN §8.4 Tier 3: suppliers and bills (accounts payable) and the
 * accounting-software journal export. 404 while the flag is off (the guard);
 * every id is loaded with the account scope (a miss is 404).
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2Tier3Controller {
  constructor(
    private readonly ap: ApService,
    private readonly exporter: JournalExportService,
  ) {}

  // ── Suppliers ──

  /** ?q&includeInactive&lang */
  @Get("suppliers")
  @RequireCapability("view")
  listSuppliers(@Req() req: Fv2Request, @Query() q: any) {
    return this.ap.listSuppliers(scopeId(req.user!), q);
  }

  @Get("suppliers/:id")
  @RequireCapability("view")
  getSupplier(@Req() req: Fv2Request, @Param("id") id: string, @Query("lang") lang?: string) {
    return this.ap.getSupplier(scopeId(req.user!), idOf(id), undefined, lang === "en" ? "en" : "ar");
  }

  /** ?from&to&lang — the supplier statement (sub-ledger, running balance). */
  @Get("suppliers/:id/statement")
  @RequireCapability("view")
  statement(@Req() req: Fv2Request, @Param("id") id: string, @Query() q: any) {
    return this.ap.supplierStatement(scopeId(req.user!), idOf(id), q);
  }

  /** {nameAr, nameEn?, vatNumber?, crNumber?, iban?, phone?, email?, address?, paymentTermsDays?, defaultGlAccountId?, notes?} */
  @Post("suppliers")
  @RequireCapability("expenses")
  createSupplier(@Req() req: Fv2Request, @Body() body: any) {
    return this.ap.createSupplier(scopeId(req.user!), req.user!, body);
  }

  /** Any subset of the create fields, plus isActive. */
  @Patch("suppliers/:id")
  @RequireCapability("expenses")
  updateSupplier(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.ap.updateSupplier(scopeId(req.user!), req.user!, idOf(id), body);
  }

  @Delete("suppliers/:id")
  @RequireCapability("expenses")
  deleteSupplier(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.ap.deleteSupplier(scopeId(req.user!), req.user!, idOf(id));
  }

  // ── Bills ──

  /** ?status&supplierId&ownerId&propertyId&from&to&unpaid&page&pageSize */
  @Get("bills")
  @RequireCapability("view")
  listBills(@Req() req: Fv2Request, @Query() q: any) {
    return this.ap.listBills(scopeId(req.user!), q);
  }

  @Get("bills/:id")
  @RequireCapability("view")
  getBill(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.ap.getBill(scopeId(req.user!), idOf(id));
  }

  /**
   * {supplierId, supplierInvoiceNo?, billDate, dueDate?, ownerId?, propertyId?, chargeTo?: company|landlord, attachmentKey?, notes?,
   *  lines: [{description, amount, amountMode?: net|gross, glAccountId?, vatCategory?: S|Z|E|O, vatRate?, vat?, vatRecoverable?}]} → a draft
   */
  @Post("bills")
  @RequireCapability("expenses")
  createBill(@Req() req: Fv2Request, @Body() body: any) {
    return this.ap.createBill(scopeId(req.user!), req.user!, body);
  }

  /** A draft only; any subset of the create fields (lines replace all lines). */
  @Patch("bills/:id")
  @RequireCapability("expenses")
  updateBill(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.ap.updateBill(scopeId(req.user!), req.user!, idOf(id), body);
  }

  @Delete("bills/:id")
  @RequireCapability("expenses")
  deleteBill(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.ap.deleteBill(scopeId(req.user!), req.user!, idOf(id));
  }

  /** Draft → approved: posts E38 (Dr expense / Dr input VAT / Cr 2111). */
  @Post("bills/:id/approve")
  @RequireCapability("approve")
  approveBill(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.ap.approveBill(scopeId(req.user!), req.user!, idOf(id));
  }

  /** {reason} — refused while the bill has posted payments. */
  @Post("bills/:id/void")
  @RequireCapability("approve")
  voidBill(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.ap.voidBill(scopeId(req.user!), req.user!, idOf(id), body);
  }

  // ── Supplier payments (payment vouchers) ──

  /** ?supplierId&from&to */
  @Get("supplier-payments")
  @RequireCapability("view")
  listPayments(@Req() req: Fv2Request, @Query() q: any) {
    return this.ap.listPayments(scopeId(req.user!), q);
  }

  @Get("supplier-payments/:id")
  @RequireCapability("view")
  getPayment(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.ap.getPayment(scopeId(req.user!), idOf(id));
  }

  /** {supplierId, paidOn?, amount, bankAccountId?, method?, reference?, allocations: [{billId, amount}]} → PV-###### (E39). */
  @Post("supplier-payments")
  @RequireCapability("money")
  createPayment(@Req() req: Fv2Request, @Body() body: any) {
    return this.ap.createPayment(scopeId(req.user!), req.user!, body);
  }

  /** {reason} */
  @Post("supplier-payments/:id/void")
  @RequireCapability("approve")
  voidPayment(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.ap.voidPayment(scopeId(req.user!), req.user!, idOf(id), body);
  }

  // ── Reports ──

  /** ?asOf&supplierId&lang */
  @Get("reports/ap-aging")
  @RequireCapability("view")
  apAging(@Req() req: Fv2Request, @Query() q: any) {
    return this.ap.apAging(scopeId(req.user!), q);
  }

  /**
   * ?from&to&preset=standard|simple&lang&dateFormat=iso|dmy&excludeReversed&format=csv|json
   * CSV (default): the file (docs/finance-v2/JOURNAL-EXPORT.md). JSON: a preview and the totals.
   */
  @Get("journal-export")
  @RequireCapability("view")
  async journalExport(@Req() req: Fv2Request, @Query() q: any, @Res({ passthrough: true }) res: Response) {
    if (q?.format === "json") return this.exporter.preview(scopeId(req.user!), q);
    const f = await this.exporter.csv(scopeId(req.user!), q);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
    res.setHeader("X-Export-Rows", String(f.rows));
    res.setHeader("X-Export-Debit", f.debit);
    res.setHeader("X-Export-Credit", f.credit);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Rows, X-Export-Debit, X-Export-Credit");
    res.setHeader("Cache-Control", "no-store");
    return f.body;
  }
}
