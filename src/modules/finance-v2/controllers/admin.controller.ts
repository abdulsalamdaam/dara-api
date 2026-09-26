import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../../common/guards/roles.guard";
import { FinanceV2AdminService } from "../admin.service";
import { PostingErrorsService } from "../posting-errors.service";
import type { Fv2Request } from "../finance-v2.guard";
import { BackfillService } from "../backfill/backfill.service";

/** The switch and its support views (DESIGN §1.5, §10.2). Super admin only. */
@Controller("admin/finance-v2")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class FinanceV2AdminController {
  constructor(
    private readonly admin: FinanceV2AdminService,
    private readonly postingErrors: PostingErrorsService,
    private readonly backfill: BackfillService,
  ) {}

  /**
   * The backfill (DESIGN §6). Body: { mode: full|cutover|catchup, cutover?: YYYY-MM-DD,
   * dryRun?: boolean (default TRUE), allowLate?: boolean, accountingMode? (dry run only) }.
   * A dry run is allowed while the flag is off.
   */
  @Post(":accountUserId/backfill")
  @HttpCode(200)
  runBackfill(@Req() req: Fv2Request, @Param("accountUserId", ParseIntPipe) id: number, @Body() body: any) {
    return this.backfill.run(BackfillService.parseRequest(id, req.user!.id, body));
  }

  @Get(":accountUserId/backfill-runs")
  backfillRuns(@Param("accountUserId", ParseIntPipe) id: number) {
    return this.backfill.runs(id);
  }

  @Get("accounts")
  accounts() {
    return this.admin.listAccounts();
  }

  @Get(":accountUserId/suggested-mode")
  async suggestedMode(@Param("accountUserId", ParseIntPipe) id: number) {
    return { mode: await this.admin.suggestMode(id) };
  }

  @Get(":accountUserId/events")
  events(@Param("accountUserId", ParseIntPipe) id: number) {
    return this.admin.events(id);
  }

  /** Support view of an account's posting errors (same shape as the account's own list). */
  @Get(":accountUserId/posting-errors")
  accountPostingErrors(@Param("accountUserId", ParseIntPipe) id: number, @Query() q: any) {
    return this.postingErrors.list(id, q);
  }

  /** Body: { enabled: boolean, accountingMode?: 'owner'|'manager', reason: string (5–500) }. */
  @Patch(":accountUserId")
  toggle(@Req() req: Fv2Request, @Param("accountUserId", ParseIntPipe) id: number, @Body() body: any) {
    return this.admin.toggle(req.user!.id, id, body);
  }
}
