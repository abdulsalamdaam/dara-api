import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { CoreReportsService } from "../reports/core-reports.service";

/**
 * The core ledger reports (DESIGN §7.1–7.4, §7.9, §10.2). 404 while the flag is
 * off (FinanceV2Guard); the view capability is required; owner-mobile tokens
 * are refused. Every query is scoped to scopeId(user).
 */
@Controller("finance/v2/reports")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2CoreReportsController {
  constructor(private readonly reports: CoreReportsService) {}

  /** ?from&to&cmpFrom&cmpTo&compare=none&ownerId&propertyId&level=leaf|group&postClosing&includeZero&lang */
  @Get("trial-balance")
  @RequireCapability("view")
  trialBalance(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.trialBalance(scopeId(req.user!), q);
  }

  /** ?accountId|accountIds&from&to&ownerId&propertyId&unitId&tenantId&contractId&page&pageSize&lang */
  @Get("general-ledger")
  @RequireCapability("view")
  generalLedger(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.generalLedger(scopeId(req.user!), q);
  }

  /** ?from&to&columns=total|property|landlord|month&cmpFrom&cmpTo&compare=previous&ownerId&propertyId&lang */
  @Get("income-statement")
  @RequireCapability("view")
  incomeStatement(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.incomeStatement(scopeId(req.user!), q);
  }

  /** ?asOf&cmpAsOf&presentation=net|gross&ownerId&propertyId&includeZero&lang */
  @Get("balance-sheet")
  @RequireCapability("view")
  balanceSheet(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.balanceSheet(scopeId(req.user!), q);
  }

  /** ?bankAccountId&from&to&lang */
  @Get("cash-book")
  @RequireCapability("view")
  cashBook(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.cashBook(scopeId(req.user!), q);
  }
}
