import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission } from "./permissions";

export const PERMISSIONS_META = "dara:required-permissions";
export const ANY_PERMISSIONS_META = "dara:any-permissions";
export const OWNER_TOKEN_META = "dara:allow-owner-token";
/**
 * Finance v2's own spelling of "an owner-mobile token may call this route"
 * (`AllowOwnerScope` in finance-v2.guard.ts). JwtAuthGuard honours it too, so
 * the landlord statement keeps working without finance-v2 importing from here.
 */
export const FV2_OWNER_SCOPE_META = "fv2:allowOwnerScope";

/**
 * Mark a controller or handler as requiring one or more permission keys.
 * Use alongside JwtAuthGuard. Example:
 *
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *   @RequirePermissions("properties.write")
 *   @Post()
 *   create(...) { ... }
 *
 * Permissions come from `req.user.permissions`, populated by JwtAuthGuard
 * from the joined `roles.permissions` row. Roles are now first-class — to
 * grant a permission, edit (or assign) the user's role row.
 *
 * All listed keys are required. For "any one of" use `RequireAnyPermission`.
 */
export const RequirePermissions = (...perms: Permission[]) =>
  SetMetadata(PERMISSIONS_META, perms);

/**
 * At least ONE of the listed keys is required. For a route that serves several
 * screens owned by different permissions (e.g. adding a custom dropdown option
 * from the unit form or the contract wizard). Combines with
 * `RequirePermissions`: both must be satisfied when both are present.
 */
export const RequireAnyPermission = (...perms: Permission[]) =>
  SetMetadata(ANY_PERMISSIONS_META, perms);

/**
 * Let a landlord (owner) mobile token through JwtAuthGuard on this route.
 *
 * An owner token resolves to `id = <the managing account>` with
 * `ownerScopeId` set, so any route that keys off `user.id` / `scopeId(user)`
 * without also narrowing by `ownerScopeId` would hand a third-party landlord
 * the whole managing account — its team, audit log, company profile,
 * subscription, uploads. JwtAuthGuard therefore REFUSES owner tokens
 * everywhere except routes that carry this marker and do the narrowing
 * themselves (`/landlord/me/*`, logout, the finance-v2 landlord statement).
 *
 * On such a route PermissionsGuard does not apply the account's role
 * permissions to the owner token (it holds none): the owner is limited by
 * the data narrowing instead.
 */
export const AllowOwnerToken = () => SetMetadata(OWNER_TOKEN_META, true);

/** Does this route accept an owner-mobile token? */
export function routeAllowsOwnerToken(reflector: Reflector, ctx: ExecutionContext): boolean {
  const targets = [ctx.getHandler(), ctx.getClass()];
  return !!(reflector.getAllAndOverride<boolean>(OWNER_TOKEN_META, targets)
    || reflector.getAllAndOverride<boolean>(FV2_OWNER_SCOPE_META, targets));
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_META, targets) ?? [];
    const anyOf = this.reflector.getAllAndOverride<Permission[]>(ANY_PERMISSIONS_META, targets) ?? [];
    if (required.length === 0 && anyOf.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: { id: number; role?: string; permissions?: string[] | null; ownerScopeId?: number | null } }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Authentication required");

    // An owner-mobile token on a route built for it: narrowed by data, not by
    // the account's role. Anywhere else JwtAuthGuard has already refused it.
    if (user.ownerScopeId != null && routeAllowsOwnerToken(this.reflector, ctx)) return true;

    const granted = user.permissions ?? [];
    const missing = required.filter((p) => !granted.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permissions: ${missing.join(", ")}`);
    }
    if (anyOf.length && !anyOf.some((p) => granted.includes(p))) {
      throw new ForbiddenException(`Missing permissions: one of ${anyOf.join(", ")}`);
    }
    return true;
  }
}
