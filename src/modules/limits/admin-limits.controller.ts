import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ParseInt4Pipe } from "../../common/int4.pipe";
import { isLimitKey } from "../../common/limits";
import { AddonCatalogService } from "./addon-catalog.service";
import { LimitsService, parseCreateAddon, parseLimitValue, requireNote } from "./limits.service";
import type { AdminLimitsView, LimitsActor } from "./limits.types";

const admin = (user: AuthUser): LimitsActor => ({ userId: user.id, kind: "admin" });

/**
 * Admin console: one customer account's limits — overrides, add-ons, the
 * Ejar switch and the audit trail. Platform staff only. Every write answers
 * with the same view as GET so the screen re-renders from one response.
 */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminLimitsController {
  constructor(
    private readonly limits: LimitsService,
    private readonly catalog: AddonCatalogService,
  ) {}

  @Get("customers/:userId/limits")
  view(@Param("userId", ParseInt4Pipe) userId: number): Promise<AdminLimitsView> {
    return this.limits.adminView(userId);
  }

  /** `{ value: number|null, clear?: boolean, note, notify? }` — value null = unlimited; clear removes the override. */
  @Put("customers/:userId/limits/:key")
  async setOverride(
    @CurrentUser() user: AuthUser, @Param("userId", ParseInt4Pipe) userId: number, @Param("key") key: string, @Body() body: any,
  ): Promise<AdminLimitsView> {
    if (!isLimitKey(key)) throw new BadRequestException("key must be users | landlords | ejar_lookups");
    const note = requireNote(body?.note);
    const clear = body?.clear === true;
    const value = clear ? null : parseLimitValue(body?.value);
    const notify = typeof body?.notify === "boolean" ? body.notify : undefined;
    await this.limits.setOverride(userId, key, { value, clear, note, notify }, admin(user));
    return this.limits.adminView(userId);
  }

  /** `{ mode: "default"|"enabled"|"disabled", note }`. */
  @Put("customers/:userId/ejar-access")
  async setEjarAccess(
    @CurrentUser() user: AuthUser, @Param("userId", ParseInt4Pipe) userId: number, @Body() body: any,
  ): Promise<AdminLimitsView> {
    const mode = body?.mode;
    if (mode !== "default" && mode !== "enabled" && mode !== "disabled") {
      throw new BadRequestException("mode must be default | enabled | disabled");
    }
    await this.limits.setEjarAccess(userId, mode, requireNote(body?.note), admin(user));
    return this.limits.adminView(userId);
  }

  /** `{ limitKey, quantity, mode: free|invoice|offer, catalogKey?, priceSar?, period, endsAt?, activation, note, notify }`. */
  @Post("customers/:userId/addons")
  async createAddon(
    @CurrentUser() user: AuthUser, @Param("userId", ParseInt4Pipe) userId: number, @Body() body: any,
  ): Promise<AdminLimitsView> {
    const input = parseCreateAddon(body);
    input.note = requireNote(body?.note);
    await this.limits.createAddon(userId, input, admin(user));
    return this.limits.adminView(userId);
  }

  /** Body `{ note }`. */
  @Delete("customers/:userId/addons/:id")
  async cancelAddon(
    @CurrentUser() user: AuthUser, @Param("userId", ParseInt4Pipe) userId: number,
    @Param("id", ParseInt4Pipe) id: number, @Body() body: any,
  ): Promise<AdminLimitsView> {
    await this.limits.cancelAddon(userId, id, requireNote(body?.note), admin(user));
    return this.limits.adminView(userId);
  }

  @Get("customers/:userId/limit-events")
  async events(
    @Param("userId", ParseInt4Pipe) userId: number, @Query("page") page?: string, @Query("pageSize") pageSize?: string,
  ) {
    await this.limits.assertAccount(userId);
    return this.limits.events(userId, Number(page) || 1, Number(pageSize) || 50);
  }

  @Get("settings/addon-catalog")
  getCatalog() {
    return this.catalog.get();
  }

  /** `{ items: [{ key, limitKey, quantity, priceSar|null, period, labelAr, labelEn, active }] }` — prices before VAT. */
  @Put("settings/addon-catalog")
  setCatalog(@Body() body: any) {
    return this.catalog.set(body);
  }
}
