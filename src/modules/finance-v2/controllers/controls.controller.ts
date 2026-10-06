import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { ControlChecksService } from "../controls.service";
import { isoDate } from "../audit";
import { riyadhToday } from "../dates";

/**
 * The accountant's control checks (controls.service.ts). 404 while the flag is
 * off; the view capability is required; owner-mobile tokens are refused.
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2ControlsController {
  constructor(private readonly controls: ControlChecksService) {}

  /** ?asOf&lang — the 21 checks (and v2's R4–R7) computed now, plus the last stored run. */
  @Get("reports/control-checks")
  @RequireCapability("view")
  report(@Req() req: Fv2Request, @Query() q: any) {
    return this.controls.report(scopeId(req.user!), q);
  }

  /** The last stored run (nightly, manual or period close), for the dashboard. `null` before the first run. */
  @Get("control-checks/latest")
  @RequireCapability("view")
  async latest(@Req() req: Fv2Request) {
    return { lastRun: await this.controls.latest(scopeId(req.user!)) };
  }

  /** Body: { asOf? } — run the checks now and store the result. */
  @Post("control-checks/run")
  @HttpCode(200)
  @RequireCapability("view")
  async run(@Req() req: Fv2Request, @Body() body: any) {
    const asOf = body?.asOf ? isoDate(body.asOf, "asOf") : riyadhToday();
    const r = await this.controls.run(scopeId(req.user!), asOf, "manual", req.user!.id);
    return { runId: r.runId, summary: r.summary, blocking: r.blocking, lastRun: await this.controls.latest(scopeId(req.user!)) };
  }
}
