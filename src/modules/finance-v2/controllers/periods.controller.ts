import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { PeriodCloseService } from "../period-close.service";

/** Fiscal periods (DESIGN §8.1, §10.2): list (`view`); close, reopen, lock and year close (`settings`). */
@Controller("finance/v2/periods")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2PeriodsController {
  constructor(private readonly periods: PeriodCloseService) {}

  /** ?fiscalYear */
  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.periods.list(scopeId(req.user!), q);
  }

  /** Body: { fiscalYear } */
  @Post("close-year")
  @HttpCode(200)
  @RequireCapability("settings")
  closeYear(@Req() req: Fv2Request, @Body() body: any) {
    return this.periods.closeYear(scopeId(req.user!), req.user!, body);
  }

  /** Body: { reason? } */
  @Post(":id/close")
  @HttpCode(200)
  @RequireCapability("settings")
  close(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.periods.close(scopeId(req.user!), req.user!, id, body);
  }

  /** Body: { reason: string (5–500) } */
  @Post(":id/reopen")
  @HttpCode(200)
  @RequireCapability("settings")
  reopen(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.periods.reopen(scopeId(req.user!), req.user!, id, body);
  }

  /** Body: { reason: string (5–500) }. Irreversible. */
  @Post(":id/lock")
  @HttpCode(200)
  @RequireCapability("settings")
  lock(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.periods.lock(scopeId(req.user!), req.user!, id, body);
  }
}
