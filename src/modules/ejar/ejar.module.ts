import {
  BadRequestException, Body, Controller, Get, Inject, Module, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { propertiesTable, unitsTable, ownersTable, deedsTable, tenantsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { listQuerySchema, wantsPagination } from "../../common/pagination";
import { EjarClientService, EjarConfigError } from "./ejar.client.service";
import { EjarLogService, type EjarLogFilter } from "./ejar.log.service";
import { EjarPolicyService } from "./ejar.policy.service";
import { computeEjarLocks, isLockEntity, type EjarLockEntity } from "./ejar.locks";
import { DrizzleEjarLookupStore } from "./ejar.lookup.store";
import { EJAR_LOOKUP_STORE, EjarLookupService } from "./ejar.lookup.service";
import { EJAR_IMPORT_RUNNER, EjarImportRunner, EjarImportService } from "./ejar.import.service";

/**
 * Ejar integration — the credential-holding backend. Everything is READ-ONLY
 * against Ejar (we pull, never push).
 *
 * Ejar Import v2: a contract is fetched with exactly two Balady calls
 * (Invoices, then Details) by `POST /ejar/lookup`, under the lookup budget,
 * and saved. `POST /ejar/import` builds the local record from that saved
 * lookup plus what the user completed, and never calls Ejar. The old six-call
 * routes (`/contracts`, `/preview`, `/call`, `/logs/:id/replay`) are gone: no
 * route can reach Ejar outside the budget.
 */
@ApiTags("ejar")
@ApiBearerAuth("user-jwt")
@Controller("ejar")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EjarController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly client: EjarClientService,
    private readonly logs: EjarLogService,
    private readonly policy: EjarPolicyService,
    private readonly lookups: EjarLookupService,
    private readonly importer: EjarImportService,
  ) {}

  /** How many lookups are left in the current window (global and for this account). */
  @Get("budget")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async budget(@CurrentUser() user: AuthUser) {
    return this.lookups.budget(scopeId(user));
  }

  /**
   * Look one contract up by its number: Invoices → Details, two calls, under
   * the budget. Served from the saved lookup (no call) for
   * EJAR_LOOKUP_CACHE_HOURS unless `refresh: true`.
   */
  @Post("lookup")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async lookup(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.lookups.lookup(user, body ?? {});
  }

  /**
   * Import a looked-up contract as a full local record (Landlord, Deed,
   * Property, Unit, Tenant, Contract + schedule) from the saved lookup plus
   * the user's completion. Never calls Ejar.
   */
  @Post("import")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async import(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.importer.import(user, body ?? {});
  }

  /**
   * Whether manual record creation (Deeds / Properties / Units / Landlords /
   * Tenants / Contracts) is currently allowed, and why. Everything should come
   * through Ejar, so the default is "disabled" — but a failing gateway
   * re-enables manual entry automatically so an outage doesn't stop the
   * business, and a super-admin can force it either way.
   *
   * Read-only and cached: no user request ever waits on the Ejar gateway.
   */
  @Get("manual-add-policy")
  async manualAddPolicy() {
    return this.policy.getPolicy();
  }

  /**
   * Which fields of an imported record must stay read-only. Answered here
   * rather than widened onto each entity's GET: the field→Ejar-attribute map
   * belongs in one place, and `ejar_raw` never has to be shipped to the browser
   * just so a form can decide what to disable.
   */
  @Get("locks")
  async locks(
    @CurrentUser() user: AuthUser,
    @Query("entity") entity?: string,
    @Query("id") id?: string,
  ) {
    const rowId = Number(id);
    if (!isLockEntity(entity) || !Number.isFinite(rowId)) {
      throw new BadRequestException("entity must be one of property|unit|deed|tenant|landlord, with a numeric id");
    }
    const scope = scopeId(user);
    const row = await this.loadLockRow(entity, rowId, scope);
    return computeEjarLocks(entity, row);
  }

  /** The provenance columns for one record, scoped to the caller's account. */
  private async loadLockRow(entity: EjarLockEntity, id: number, scope: number) {
    if (entity === "unit") {
      // Units are scoped through their property.
      const [row] = await this.db
        .select({ unit: unitsTable })
        .from(unitsTable)
        .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
        .where(and(eq(unitsTable.id, id), eq(propertiesTable.userId, scope)))
        .limit(1);
      return row?.unit ?? null;
    }
    const table = entity === "property" ? propertiesTable
      : entity === "deed" ? deedsTable
      : entity === "tenant" ? tenantsTable
      : ownersTable;
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.userId, scope)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Ejar call log.
   *
   * `endpoint` and `status` were already applied in SQL. What was wrong was the
   * answer: `count` reported how many rows came back from a query capped at
   * 300, not how many matched - so the number silently stopped growing at the
   * cap. `total` is the database's real count for the filter now, and
   * `page`/`pageSize` walk the whole log instead of only its head.
   *
   * The legacy `{ count, logs }` shape is preserved for the existing admin
   * screen; sending `page`/`pageSize`/`paginated` returns the standard
   * `{ data, page, pageSize, total }` envelope like every other list.
   */
  @Get("logs")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async listLogs(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const status = typeof rawQuery?.status === "string" ? rawQuery.status : undefined;
    const filter: EjarLogFilter = {
      endpoint: typeof rawQuery?.endpoint === "string" && rawQuery.endpoint ? rawQuery.endpoint : undefined,
    };
    if (status === "ok" || status === "error") filter.status = status;
    else if (status && !Number.isNaN(Number(status))) filter.status = Number(status);

    if (paged) {
      filter.limit = q.pageSize;
      filter.offset = (q.page - 1) * q.pageSize;
      const { rows, total } = await this.logs.list(filter);
      return { data: rows, page: q.page, pageSize: q.pageSize, total };
    }
    filter.limit = rawQuery?.limit ? Number(rawQuery.limit) : undefined;
    const { rows, total } = await this.logs.list(filter);
    return { count: rows.length, total, logs: rows };
  }

  /**
   * Gateway check: a Balady OAuth token request only — no Ejar data call, so
   * it never touches the lookup budget.
   */
  @Get("health")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async health() {
    try {
      const r = await this.client.checkToken();
      return { ok: true, status: r.status, transactionId: null, detail: "token" };
    } catch (err) {
      if (err instanceof EjarConfigError) return { ok: false, status: null, transactionId: null, detail: "not-configured" };
      const e = err as { status?: number | null; message?: string };
      return { ok: false, status: e?.status ?? null, transactionId: null, detail: e?.message ?? "unreachable" };
    }
  }
}

@Module({
  controllers: [EjarController],
  providers: [
    EjarClientService, EjarLogService, EjarPolicyService,
    { provide: EJAR_LOOKUP_STORE, useClass: DrizzleEjarLookupStore },
    { provide: EJAR_IMPORT_RUNNER, useClass: EjarImportRunner },
    EjarLookupService, EjarImportService,
  ],
  exports: [EjarPolicyService],
})
export class EjarModule {}
