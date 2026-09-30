import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { AutoInvoiceService } from "../auto-invoice/auto-invoice.service";

/**
 * Automatic invoicing of due installments (accountant requirement 9).
 *  GET   /finance/v2/auto-invoice/settings            view
 *  PATCH /finance/v2/auto-invoice/settings            settings   {enabled?, leadDays?, reason}
 *  GET   /finance/v2/auto-invoice/uninvoiced          view       ?limit&offset — due and not invoiced
 *  GET   /finance/v2/auto-invoice/summary             view       the badge numbers
 *  POST  /finance/v2/auto-invoice/issue               view + invoices.write   {paymentIds} — "issue now"
 *  POST  /finance/v2/auto-invoice/:paymentId/dismiss  approve    {reason}
 * 404 while the flag is off (the guard).
 */
@Controller("finance/v2/auto-invoice")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2AutoInvoiceController {
  constructor(private readonly auto: AutoInvoiceService) {}

  @Get("settings")
  @RequireCapability("view")
  settings(@Req() req: Fv2Request) {
    return this.auto.getSettings(scopeId(req.user!));
  }

  @Patch("settings")
  @RequireCapability("settings")
  patchSettings(@Req() req: Fv2Request, @Body() body: any) {
    return this.auto.patchSettings(scopeId(req.user!), req.user!.id, body);
  }

  @Get("uninvoiced")
  @RequireCapability("view")
  uninvoiced(@Req() req: Fv2Request, @Query() q: any) {
    return this.auto.uninvoiced(scopeId(req.user!), q);
  }

  @Get("summary")
  @RequireCapability("view")
  summary(@Req() req: Fv2Request) {
    return this.auto.summary(scopeId(req.user!));
  }

  @Post("issue")
  @HttpCode(200)
  @RequireCapability("view")
  issue(@Req() req: Fv2Request, @Body() body: any) {
    return this.auto.issueNow(scopeId(req.user!), req.user!, body);
  }

  @Post(":paymentId/dismiss")
  @HttpCode(200)
  @RequireCapability("approve")
  dismiss(@Req() req: Fv2Request, @Param("paymentId", ParseIntPipe) paymentId: number, @Body() body: any) {
    return this.auto.dismiss(scopeId(req.user!), req.user!.id, paymentId, body);
  }
}
