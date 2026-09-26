import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { AllowOwnerScope, FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { capabilities } from "../capabilities";
import { VatReportService } from "../reports/vat-report.service";
import { ArAgingService } from "../reports/aging.service";
import { StatementsService } from "../reports/statements.service";
import { ReconciliationService } from "../reports/reconciliation.service";

/**
 * The sub-ledger reports (DESIGN §7.5–7.8, §7.10, §10.2). 404 while the flag
 * is off (FinanceV2Guard); the view capability is required. Owner-mobile
 * tokens are refused everywhere except the landlord statement, and there only
 * for their own landlord (§7.11). Every query is scoped to scopeId(user).
 */
@Controller("finance/v2/reports")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2SubReportsController {
  constructor(
    private readonly vat: VatReportService,
    private readonly aging: ArAgingService,
    private readonly statements: StatementsService,
    private readonly recon: ReconciliationService,
  ) {}

  /** ?period=YYYY-Qn|YYYY-MM | year&quarter|month &seller=account|owner:<id>&lang */
  @Get("vat-return")
  @RequireCapability("view")
  vatReturn(@Req() req: Fv2Request, @Query() q: any) {
    return this.vat.vatReturn(scopeId(req.user!), q);
  }

  /** ?asOf&ownerId&propertyId&tenantId&groupBy=tenant|contract&lang */
  @Get("ar-aging")
  @RequireCapability("view")
  arAging(@Req() req: Fv2Request, @Query() q: any) {
    return this.aging.arAging(scopeId(req.user!), q);
  }

  /** ?tenantId&from&to&contractId&lang */
  @Get("tenant-ledger")
  @RequireCapability("view")
  tenantLedger(@Req() req: Fv2Request, @Query() q: any) {
    return this.statements.tenantLedger(scopeId(req.user!), q);
  }

  /**
   * ?ownerId&from&to&lang. JSON for the web's PDF (§7.8). An owner-mobile
   * token passes the guard here and is limited to its own ownerId; every other
   * caller needs the view capability.
   */
  @Get("landlord-statement")
  @AllowOwnerScope()
  landlordStatement(@Req() req: Fv2Request, @Query() q: any) {
    const user = req.user!;
    if (user.ownerScopeId == null && !capabilities(user).includes("view")) throw new ForbiddenException("Missing capability: view");
    return this.statements.landlordStatement(scopeId(user), q, user.ownerScopeId ?? null);
  }

  /** ?asOf&lang */
  @Get("reconciliation")
  @RequireCapability("view")
  reconciliation(@Req() req: Fv2Request, @Query() q: any) {
    return this.recon.reconciliation(scopeId(req.user!), q);
  }
}
