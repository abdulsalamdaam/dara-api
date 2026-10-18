import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceFlagService } from "../flag.service";
import { capabilities } from "../capabilities";
import { FEATURE_REQUIRED_PLAN } from "../../../common/plan-features";
import type { Fv2Request } from "../finance-v2.guard";

export const BETA_LABELS = { ar: "المالية v2 (تجريبي)", en: "Finance v2 (Beta)" } as const;
/** The pill text as one string (DESIGN §1.3), the shape the web's `useFinanceV2Status` reads. */
export const BETA_LABEL = `${BETA_LABELS.ar} · ${BETA_LABELS.en}`;

/**
 * GET /api/finance/v2/status (DESIGN §1.3). JWT only, never 404, never 503:
 * the web's `useFinanceV2()` reads anything but `enabled: true` as off. A
 * separate endpoint so `/auth/me` and `/me/package` stay byte-identical.
 *
 * `planLocked` / `requiredPlan`: whether the account owner's plan lacks the
 * `accounting` feature (common/plan-features.ts) — then `enabled` is false
 * whatever the stored flag says, and the web shows the upgrade gate.
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard)
export class FinanceV2StatusController {
  constructor(private readonly flag: FinanceFlagService) {}

  @Get("status")
  async status(@Req() req: Fv2Request) {
    const user = req.user!;
    const s = await this.flag.state(scopeId(user));
    const caps = capabilities(user);
    const planLocked = s.planLocked === true;
    const plan = { planLocked, requiredPlan: planLocked ? FEATURE_REQUIRED_PLAN : null };
    if (!s.on || user.ownerScopeId != null) return { enabled: false, ...plan };
    return {
      enabled: true,
      ...plan,
      mode: s.mode,
      capabilities: caps,
      betaLabel: BETA_LABEL,
      betaLabels: BETA_LABELS,
      ledgerStarted: s.ledgerStartedAt != null,
    };
  }
}
