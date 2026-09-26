import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { JournalQueryService } from "../journal-query.service";

/** The general journal (DESIGN §10.2). Scoped to scopeId(user); an id outside it is a 404. */
@Controller("finance/v2/journal")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2JournalController {
  constructor(private readonly journal: JournalQueryService) {}

  /** ?from&to&accountId&sourceType&sourceId&origin&status&late&ownerId&propertyId&unitId&tenantId&contractId&paymentId&limit&offset */
  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.journal.list(scopeId(req.user!), q);
  }

  @Get(":id")
  @RequireCapability("view")
  get(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.journal.get(scopeId(req.user!), id);
  }

  /** Body: { date?: YYYY-MM-DD, reason?: string }. Manual and opening entries only. */
  @Post(":id/reverse")
  @HttpCode(200)
  @RequireCapability("approve")
  reverse(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.journal.reverse(scopeId(req.user!), req.user!, id, body);
  }
}
