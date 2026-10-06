import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { CommissionRunService } from "../commission-run.service";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * The monthly commission run on the collected basis (DESIGN §9 E1, Q6b, Q11)
 * and the commission transfer (تحويل عمولات). 404 while the flag is off (the
 * guard); every id is loaded with the account scope.
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2CommissionController {
  constructor(private readonly runs: CommissionRunService) {}

  /** ?month=YYYY-MM — per agent landlord: collected, rate, commission, VAT, total; nothing is written. */
  @Get("commission-runs/preview")
  @RequireCapability("view")
  preview(@Req() req: Fv2Request, @Query("month") month: string) {
    return this.runs.preview(scopeId(req.user!), month);
  }

  /** ?month — the runs with their invoices and ZATCA status, and the commission settings. */
  @Get("commission-runs")
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.runs.list(scopeId(req.user!), q);
  }

  /** {month, ownerIds?} — issue the month's commission invoices (idempotent per landlord and month). */
  @Post("commission-runs")
  @RequireCapability("approve")
  run(@Req() req: Fv2Request, @Body() body: any) {
    return this.runs.run(scopeId(req.user!), req.user!, body, "manual");
  }

  /** {reason} — a commission credit note for the whole invoice. */
  @Post("commission-runs/:id/reverse")
  @RequireCapability("approve")
  reverse(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.runs.reverse(scopeId(req.user!), req.user!, idOf(id), body);
  }

  @Get("commission-settings")
  @RequireCapability("view")
  settings(@Req() req: Fv2Request) {
    return this.runs.getSettings(scopeId(req.user!));
  }

  /** {autoRun, reason} — the scheduled month-end run on or off for this account. */
  @Patch("commission-settings")
  @RequireCapability("settings")
  patchSettings(@Req() req: Fv2Request, @Body() body: any) {
    return this.runs.patchSettings(scopeId(req.user!), req.user!, body);
  }

  /** The transfers, the untransferred commission and the default trust / operating accounts. */
  @Get("commission-transfers")
  @RequireCapability("view")
  transfers(@Req() req: Fv2Request) {
    return this.runs.listTransfers(scopeId(req.user!));
  }

  /** {amount?, date?, fromBankAccountId?, toBankAccountId?, memo?} — Dr operating bank / Cr trust bank. */
  @Post("commission-transfers")
  @RequireCapability("money")
  createTransfer(@Req() req: Fv2Request, @Body() body: any) {
    return this.runs.createTransfer(scopeId(req.user!), req.user!, body);
  }

  /** {reason} */
  @Post("commission-transfers/:id/void")
  @RequireCapability("money")
  voidTransfer(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.runs.voidTransfer(scopeId(req.user!), req.user!, idOf(id), body);
  }
}
