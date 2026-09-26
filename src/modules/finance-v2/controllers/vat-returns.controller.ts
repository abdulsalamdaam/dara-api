import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { VatReturnsService } from "../vat-returns.service";

/** VAT return draft and lock (DESIGN §7.5, §10.2). `:period` is YYYY-Qn or YYYY-MM. */
@Controller("finance/v2/vat-returns")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2VatReturnsController {
  constructor(private readonly vat: VatReturnsService) {}

  /** ?seller=account|owner:<id> */
  @Get(":period")
  @RequireCapability("view")
  get(@Req() req: Fv2Request, @Param("period") period: string, @Query("seller") seller?: string) {
    return this.vat.get(scopeId(req.user!), period, seller);
  }

  /** Body: { box14?, box15?, lock?: boolean, seller? } */
  @Put(":period")
  @RequireCapability("settings")
  put(@Req() req: Fv2Request, @Param("period") period: string, @Body() body: any) {
    return this.vat.put(scopeId(req.user!), req.user!, period, body);
  }
}
