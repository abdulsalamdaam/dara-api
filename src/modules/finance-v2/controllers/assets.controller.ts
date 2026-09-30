import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { AssetsService, monthParam } from "../assets/assets.service";
import { lastDueMonth } from "../assets/asset-events";
import { riyadhToday } from "../dates";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * DESIGN §8.5: the fixed-asset register, depreciation runs and the asset
 * schedule. 404 while the flag is off (the guard); every id is loaded with
 * the account scope (a miss is 404).
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** Categories with their default accounts and useful life. */
  @Get("asset-defaults")
  @RequireCapability("view")
  defaults(@Req() req: Fv2Request) {
    return this.assets.defaults(scopeId(req.user!));
  }

  /** ?status=active|disposed|void|all&category&propertyId&q&lang */
  @Get("assets")
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.assets.list(scopeId(req.user!), q);
  }

  @Get("assets/:id")
  @RequireCapability("view")
  get(@Req() req: Fv2Request, @Param("id") id: string, @Query("lang") lang?: string) {
    return this.assets.get(scopeId(req.user!), idOf(id), lang === "en" ? "en" : "ar");
  }

  /**
   * {nameAr, nameEn?, category, propertyId?, acquisitionDate, cost, salvageValue?, usefulLifeMonths?, depreciationStart?,
   *  openingAccumulated?, assetAccountId?, accumAccountId?, expenseAccountId?, acquisitionMode?: none|bank, acquisitionBankAccountId?, notes?}
   */
  @Post("assets")
  @RequireCapability("expenses")
  create(@Req() req: Fv2Request, @Body() body: any) {
    return this.assets.create(scopeId(req.user!), req.user!, body);
  }

  @Patch("assets/:id")
  @RequireCapability("expenses")
  update(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.assets.update(scopeId(req.user!), req.user!, idOf(id), body);
  }

  @Delete("assets/:id")
  @RequireCapability("expenses")
  remove(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.assets.remove(scopeId(req.user!), req.user!, idOf(id));
  }

  /** {date, proceeds?, bankAccountId?, note?} */
  @Post("assets/:id/dispose")
  @RequireCapability("approve")
  dispose(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.assets.dispose(scopeId(req.user!), req.user!, idOf(id), body);
  }

  /** {reason} */
  @Post("assets/:id/void")
  @RequireCapability("approve")
  void(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.assets.void(scopeId(req.user!), req.user!, idOf(id), body);
  }

  // ── Depreciation ──

  @Get("depreciation/runs")
  @RequireCapability("view")
  runs(@Req() req: Fv2Request) {
    return this.assets.runs(scopeId(req.user!));
  }

  /** ?month=YYYY-MM (default: the last month that has ended)&lang */
  @Get("depreciation/preview")
  @RequireCapability("view")
  preview(@Req() req: Fv2Request, @Query() q: any) {
    return this.assets.preview(scopeId(req.user!), q);
  }

  /** {month?: YYYY-MM} — queue every missing depreciation through that month (idempotent). */
  @Post("depreciation/run")
  @RequireCapability("approve")
  run(@Req() req: Fv2Request, @Body() body: any) {
    const month = body?.month ? monthParam(body.month) : lastDueMonth(riyadhToday());
    return this.assets.runMonth(scopeId(req.user!), req.user!.id, month, "manual");
  }

  // ── Report ──

  /** ?from&to&lang&category&propertyId */
  @Get("reports/asset-schedule")
  @RequireCapability("view")
  schedule(@Req() req: Fv2Request, @Query() q: any) {
    return this.assets.scheduleReport(scopeId(req.user!), q);
  }
}
