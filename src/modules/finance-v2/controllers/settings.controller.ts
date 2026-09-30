import { Body, Controller, Get, Patch, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { FinanceSettingsService } from "../settings.service";

/**
 * GET / PATCH /api/finance/v2/settings (DESIGN §10.2): default bank and cash,
 * VAT filing frequency, commission basis, deposit-forfeit VAT and trust
 * routing. The accounting mode is read-only here (the admin toggle sets it).
 * 404 while the flag is off (the guard).
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2SettingsController {
  constructor(private readonly settings: FinanceSettingsService) {}

  @Get("settings")
  @RequireCapability("view")
  get(@Req() req: Fv2Request) {
    return this.settings.get(scopeId(req.user!));
  }

  /** {reason, defaultBankAccountId?, defaultCashAccountId?, vatFilingFrequency?, commissionBasis?, depositForfeitVat?, agencyCollectionsToTrust?} */
  @Patch("settings")
  @RequireCapability("settings")
  patch(@Req() req: Fv2Request, @Body() body: any) {
    return this.settings.patch(scopeId(req.user!), req.user!.id, body);
  }
}
