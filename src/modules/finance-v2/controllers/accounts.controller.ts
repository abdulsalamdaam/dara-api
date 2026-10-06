import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { ChartService } from "../chart.service";

/** Chart of accounts (DESIGN §10.2). Every query is scoped to scopeId(user); an id outside it is a 404. */
@Controller("finance/v2/accounts")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2AccountsController {
  constructor(private readonly chart: ChartService) {}

  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query("asOf") asOf?: string) {
    return this.chart.list(scopeId(req.user!), asOf || undefined);
  }

  @Post()
  @RequireCapability("settings")
  create(@Req() req: Fv2Request, @Body() body: any) {
    return this.chart.create(scopeId(req.user!), req.user!.id, body);
  }

  @Patch(":id")
  @RequireCapability("settings")
  update(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.chart.update(scopeId(req.user!), id, body, req.user!.id);
  }

  @Delete(":id")
  @RequireCapability("settings")
  remove(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.chart.remove(scopeId(req.user!), id);
  }
}
