import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { ManualJournalsService } from "../manual-journals.service";
import { BackfillService } from "../backfill/backfill.service";
import { isoDate } from "../audit";

/**
 * Manual journal entries, قيد يدوي (DESIGN §8.1, §10.2). Drafting needs
 * `draft`; approve and reject need `approve` (and a different person than
 * the drafter unless the account holder approves).
 *
 * Body of create / patch: { entryDate, memo, attachmentKey?, lines: [{ accountId, debit, credit, memo?,
 * ownerId?, propertyId?, unitId?, tenantId?, contractId? }] } — amounts as decimal strings.
 */
@Controller("finance/v2/manual-journals")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2ManualJournalsController {
  constructor(private readonly mj: ManualJournalsService) {}

  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.mj.list(scopeId(req.user!), q);
  }

  @Get(":id")
  @RequireCapability("view")
  get(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.mj.get(scopeId(req.user!), id);
  }

  @Post()
  @RequireCapability("draft")
  create(@Req() req: Fv2Request, @Body() body: any) {
    return this.mj.create(scopeId(req.user!), req.user!, body, "manual");
  }

  @Patch(":id")
  @RequireCapability("draft")
  update(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.mj.update(scopeId(req.user!), req.user!, id, body);
  }

  @Post(":id/submit")
  @HttpCode(200)
  @RequireCapability("draft")
  submit(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.mj.submit(scopeId(req.user!), req.user!, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequireCapability("approve")
  approve(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.mj.approve(scopeId(req.user!), req.user!, id);
  }

  /** Body: { reason: string (5–500) } */
  @Post(":id/reject")
  @HttpCode(200)
  @RequireCapability("approve")
  reject(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.mj.reject(scopeId(req.user!), req.user!, id, body);
  }

  @Post(":id/void")
  @HttpCode(200)
  @RequireCapability("draft")
  void(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    return this.mj.void(scopeId(req.user!), req.user!, id);
  }
}

/**
 * The opening-balance entry (DESIGN §6.7): a manual journal of kind
 * `opening` (lines may also carry `paymentId`), approved like any manual
 * journal; at most one posted per account. `GET proposal?date=D` returns the
 * sub-ledger proposal as of D−1 (§6.2), computed without writing anything.
 */
@Controller("finance/v2/opening-balances")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2OpeningBalancesController {
  constructor(private readonly mj: ManualJournalsService, private readonly backfill: BackfillService) {}

  @Post()
  @RequireCapability("draft")
  create(@Req() req: Fv2Request, @Body() body: any) {
    return this.mj.create(scopeId(req.user!), req.user!, body, "opening");
  }

  @Get("proposal")
  @RequireCapability("draft")
  proposal(@Req() req: Fv2Request, @Query("date") date: string) {
    return this.backfill.proposeOpening(scopeId(req.user!), isoDate(date, "date"));
  }
}
