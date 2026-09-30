import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { AcctReportsService } from "../reports/acct-reports.service";

/**
 * The accountant's reports: cash flow (direct method), rent roll, deposits
 * register and property profitability, all read from the v2 journal. Same
 * rules as every v2 report (§7.11): 404 while the flag is off
 * (FinanceV2Guard), the view capability is required, owner-mobile tokens are
 * refused, and every query is scoped to scopeId(user).
 */
@Controller("finance/v2/reports")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2AcctReportsController {
  constructor(private readonly reports: AcctReportsService) {}

  /** ?from&to&lang */
  @Get("cash-flow")
  @RequireCapability("view")
  cashFlow(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.cashFlow(scopeId(req.user!), q);
  }

  /** ?asOf&from&ownerId&propertyId&lang */
  @Get("rent-roll")
  @RequireCapability("view")
  rentRoll(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.rentRoll(scopeId(req.user!), q);
  }

  /** ?from&to&ownerId&propertyId&lang */
  @Get("deposits-register")
  @RequireCapability("view")
  depositsRegister(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.depositsRegister(scopeId(req.user!), q);
  }

  /** ?from&to&ownerId&propertyId&lang */
  @Get("property-profitability")
  @RequireCapability("view")
  propertyProfitability(@Req() req: Fv2Request, @Query() q: any) {
    return this.reports.propertyProfitability(scopeId(req.user!), q);
  }
}
