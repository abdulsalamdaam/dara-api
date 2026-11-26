import { Body, Controller, ForbiddenException, Get, HttpCode, Optional, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { capabilities } from "../capabilities";
import { PostingErrorsService } from "../posting-errors.service";
import { FinanceV2AutoProvisionService } from "../auto-provision.service";

/**
 * The posting-errors list (DESIGN §5.5, §10.2). Scoped to scopeId(user); an id
 * outside it is a 404. View: `view`. Retry: `approve` or `money`. Dismiss: `approve`.
 * Start the ledger (a ledger that never started holds every event queued): `settings`.
 */
@Controller("finance/v2/posting-errors")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2PostingErrorsController {
  constructor(private readonly errors: PostingErrorsService, @Optional() private readonly auto?: FinanceV2AutoProvisionService) {}

  /** ?tab=errors|skipped&limit&offset */
  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.errors.list(scopeId(req.user!), q);
  }

  /**
   * Start a ledger that has not started: the automatic provisioning's own path (full dry run, then the real backfill
   * only when it is clean; idempotent). Answers the outcome (auto-provision.service.ts AutoOutcome) and the list's
   * fresh ledger state. A started ledger only posts what it is missing.
   */
  @Post("start-ledger")
  @HttpCode(200)
  @RequireCapability("settings")
  async startLedger(@Req() req: Fv2Request) {
    const scope = scopeId(req.user!);
    const r = this.auto
      ? await this.auto.startNow(scope)
      : { accountUserId: scope, outcome: "not_eligible" as const, provisioned: false, detail: "automatic provisioning is not available" };
    const { ledger } = await this.errors.list(scope, { limit: 1 });
    return { outcome: r.outcome, detail: r.detail ?? null, ledger };
  }

  @Post(":id/retry")
  @HttpCode(200)
  retry(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    const caps = capabilities(req.user!);
    if (!caps.includes("approve") && !caps.includes("money")) throw new ForbiddenException("Missing capability: approve or money");
    return this.errors.retry(scopeId(req.user!), req.user!.id, id);
  }

  /** Body: { reason: string (5–500) } */
  @Post(":id/dismiss")
  @HttpCode(200)
  @RequireCapability("approve")
  dismiss(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.errors.dismiss(scopeId(req.user!), req.user!.id, id, body);
  }
}
