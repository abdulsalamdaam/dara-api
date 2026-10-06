import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../../common/permissions.decorator";
import { PERMISSIONS } from "../../../common/permissions";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, type Fv2Request } from "../finance-v2.guard";
import { InstallmentDocsService } from "../installment-docs.service";

/**
 * The installments screen under Finance v2 (accountant test #3, #6, #7).
 *  GET  /finance/v2/installments/document-routes?contractIds=  payments.view    which document "create invoice" issues per contract
 *  POST /finance/v2/installments/rent-receipt                   invoices.write   {paymentIds, issueDate?} — create + approve an RR-
 *  GET  /finance/v2/installments/:paymentId/collect-context     payments.view    trust account / residential hints for the collect dialog
 * 404 while the flag is off (the guard), so a flag-off web never changes path.
 */
@Controller("finance/v2/installments")
@UseGuards(JwtAuthGuard, FinanceV2Guard, PermissionsGuard)
export class FinanceV2InstallmentsController {
  constructor(private readonly svc: InstallmentDocsService) {}

  @Get("document-routes")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  routes(@Req() req: Fv2Request, @Query("contractIds") contractIds?: string) {
    return this.svc.routes(scopeId(req.user!), contractIds);
  }

  @Post("rent-receipt")
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  rentReceipt(@Req() req: Fv2Request, @Body() body: any) {
    return this.svc.issueRentReceipt(scopeId(req.user!), req.user!, body);
  }

  @Get(":paymentId/collect-context")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  collectContext(@Req() req: Fv2Request, @Param("paymentId", ParseIntPipe) paymentId: number) {
    return this.svc.collectContext(scopeId(req.user!), paymentId);
  }
}
