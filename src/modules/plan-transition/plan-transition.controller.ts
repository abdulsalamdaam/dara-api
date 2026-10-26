import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { PlanTransitionService } from "./plan-transition.service";

/** The customer's side: what a plan change would do, and what the last one did (post-upgrade checklist). */
@ApiTags("plan-change")
@ApiBearerAuth("user-jwt")
@Controller("me/plan-change")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanChangeController {
  constructor(private readonly svc: PlanTransitionService) {}

  /** GET /me/plan-change/preview?plan=<key> — consequences of moving to `plan` (read only). */
  @Get("preview")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  preview(@CurrentUser() user: AuthUser, @Query("plan") plan: string) {
    return this.svc.preview(scopeId(user), plan, "customer");
  }

  /** GET /me/plan-change/latest — the latest change, its steps, and the checklist after an upgrade. */
  @Get("latest")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  latest(@CurrentUser() user: AuthUser) {
    return this.svc.latest(scopeId(user));
  }
}

/** Super admin: plan history, the attention queue, the admin preview, retry and restore. */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminPlanChangesController {
  constructor(private readonly svc: PlanTransitionService) {}

  @Get("users/:id/plan-changes")
  list(@Param("id", ParseIntPipe) id: number) {
    return this.svc.list(id);
  }

  /** ?status=attention|blocked|failed (comma-separated; default all three). */
  @Get("plan-changes")
  queue(@Query("status") status?: string) {
    return this.svc.queue(status);
  }

  @Get("users/:id/package-preview")
  preview(@Param("id", ParseIntPipe) id: number, @Query("plan") plan: string) {
    return this.svc.preview(id, plan, "admin");
  }

  /** Body { reason }: re-run the steps that did not finish (a blocked migration is inspected again). */
  @Post("plan-changes/:id/retry")
  @HttpCode(200)
  retry(@CurrentUser() user: AuthUser, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.retry(id, user.id, body);
  }

  /** Body { reason, confirm: "<accountId>" }: put the archived Owner-mode ledger back. 409 RESTORE_BLOCKED. */
  @Post("plan-changes/:id/restore-ledger")
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.restoreLedger(id, user.id, body);
  }
}
