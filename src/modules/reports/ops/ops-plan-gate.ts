/**
 * Package feature gate for the operational reports (common/plan-features.ts).
 *
 * Applied to OpsReportsController as an interceptor so the legacy controller
 * only gains marked lines (the finance-v2 additive-diff gate protects
 * src/modules/reports/):
 *
 *  - `GET /reports/ops`      every catalog entry gains `locked` and
 *                            `requiredPlan` ("professional" | null) for the
 *                            caller's account plan.
 *  - `GET /reports/ops/:id`  a locked report answers 403 PLAN_UPGRADE_REQUIRED
 *                            with a teaser of at most two of the report's own
 *                            KPIs, computed over the caller's own data. Rows
 *                            are never returned; if the report cannot be
 *                            built, `teaser` is null.
 *
 * The plan is the ACCOUNT OWNER's (`scopeId(user)`), as the seat quota uses.
 */
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { catchError, from, map, mergeMap, of, throwError, type Observable } from "rxjs";
import { DRIZZLE, type Drizzle } from "../../../database/database.module";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { accountPlan } from "../../../common/account-plan";
import {
  FEATURE_REQUIRED_PLAN, LOCKED_OPS_REPORTS, PlanUpgradeRequiredException, planHasFeature, type PlanFeature,
} from "../../../common/plan-features";
import type { OpsKpi, OpsReportMeta } from "./ops-core";

/** The feature a report needs on this plan, or null when it is open. */
export function lockedFeature(id: string, plan: string | null | undefined): PlanFeature | null {
  const f = LOCKED_OPS_REPORTS[id];
  return f && !planHasFeature(plan, f) ? f : null;
}

export type GatedMeta = OpsReportMeta & { locked: boolean; requiredPlan: typeof FEATURE_REQUIRED_PLAN | null };

/** The catalog with each entry's lock state for `plan`. */
export function gateCatalog<T extends { reports: OpsReportMeta[] }>(cat: T, plan: string | null | undefined): Omit<T, "reports"> & { reports: GatedMeta[] } {
  return {
    ...cat,
    reports: cat.reports.map((r) => {
      const locked = lockedFeature(r.id, plan) != null;
      return { ...r, locked, requiredPlan: locked ? FEATURE_REQUIRED_PLAN : null };
    }),
  };
}

/** At most two of the report's own KPI objects, unchanged. */
export function teaserOf(report: unknown): { kpis: OpsKpi[] } | null {
  const kpis = (report as { kpis?: unknown })?.kpis;
  if (!Array.isArray(kpis)) return null;
  return { kpis: (kpis as OpsKpi[]).slice(0, 2) };
}

@Injectable()
export class OpsPlanGateInterceptor implements NestInterceptor {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** The account owner's stored plan. Overridable for the spec. */
  protected planOf(ownerId: number): Promise<string | null> {
    return accountPlan(this.db, ownerId);
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser; params?: Record<string, string> }>();
    const user = req.user;
    if (!user) return next.handle();
    const id = req.params?.id;
    // A failed plan read reads as no plan → DEFAULT_PACKAGE (unlocked): never lock anyone out on an error.
    return from(this.planOf(scopeId(user))).pipe(
      catchError(() => of(null)),
      mergeMap((plan) => {
        if (id == null) return next.handle().pipe(map((body) => gateCatalog(body as { reports: OpsReportMeta[] }, plan)));
        const feature = lockedFeature(id, plan);
        if (!feature) return next.handle();
        // Locked: build the report as usual (the caller's own data), keep only the teaser KPIs.
        return next.handle().pipe(
          map((body) => teaserOf(body)),
          catchError(() => of(null)),
          mergeMap((teaser) => throwError(() => new PlanUpgradeRequiredException(feature, teaser))),
        );
      }),
    );
  }
}
