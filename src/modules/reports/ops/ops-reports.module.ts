/**
 * Operational (non-accounting) reports — `GET /reports/ops` (catalog) and
 * `GET /reports/ops/:id` (one report). Read-only.
 *
 * Same guard stack and permission as the existing `/reports/accounting`:
 * JwtAuthGuard + PermissionsGuard with `reports.view`, so a team member whose
 * role lacks it gets the same 403. Rows are scoped to `scopeId(user)` — the
 * account holder's data for a team member — exactly as the list endpoints do
 * (see ops-data.ts). Contract: OPS-REPORTS-CONTRACT.md.
 */
import { BadRequestException, Controller, Get, Inject, Module, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { DRIZZLE, type Drizzle } from "../../../database/database.module";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../../common/permissions.decorator";
import { PERMISSIONS } from "../../../common/permissions";
import { scopeId } from "../../../common/scope";
import { OpsParamError, capRows, resolveParams, riyadhToday, type OpsParams, type OpsReport, type OpsReportId, type ResolvedParams } from "./ops-core";
import { catalog, defOf } from "./ops-catalog";
import { loadDataset } from "./ops-data";
import { BUILDERS, NEEDS } from "./ops-builders";

/** The params echoed back: only the filters the report declares, after defaults. */
function echo(id: OpsReportId, p: ResolvedParams): OpsParams {
  const def = defOf(id)!;
  const out: OpsParams = {};
  for (const f of def.filters) {
    if (f === "from" && p.from) out.from = p.from;
    if (f === "to" && p.to) out.to = p.to;
    if (f === "asOf") out.asOf = p.asOf;
    if (f === "ownerId") out.ownerId = p.ownerId;
    if (f === "propertyId") out.propertyId = p.propertyId;
    if (f === "status") out.status = p.status;
    if (f === "days") out.days = p.days;
  }
  return out;
}

/** Build one report for an account. Exported for the DB spec, which drives it without HTTP. */
export async function runOpsReport(db: Drizzle, uid: number, id: string, raw: Record<string, unknown>, today = riyadhToday()): Promise<OpsReport> {
  const def = defOf(id);
  if (!def) throw new NotFoundException(`Unknown report: ${id}`);
  let p: ResolvedParams;
  try {
    p = resolveParams(raw ?? {}, { dates: def.dates, today, statuses: def.statuses });
  } catch (e) {
    if (e instanceof OpsParamError) throw new BadRequestException(e.message);
    throw e;
  }
  const ds = await loadDataset(db, uid, { ownerId: p.ownerId, propertyId: p.propertyId, today: p.today, need: NEEDS[def.id] ?? {} });
  const body = capRows(BUILDERS[def.id](ds, p));
  return { id: def.id, params: echo(def.id, p), generatedAt: new Date().toISOString(), ...body };
}

@ApiTags("reports")
@ApiBearerAuth("user-jwt")
@Controller("reports/ops")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OpsReportsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  list() {
    return catalog(riyadhToday());
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  one(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query() rawQuery: any) {
    return runOpsReport(this.db, scopeId(user), id, rawQuery ?? {});
  }
}

@Module({ controllers: [OpsReportsController] })
export class OpsReportsModule {}
