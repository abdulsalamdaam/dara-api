import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission } from "./permissions";

const PERMISSIONS_META = "dara:required-permissions";

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
 */
export const RequirePermissions = (...perms: Permission[]) =>
  SetMetadata(PERMISSIONS_META, perms);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: { id: number; role?: string; permissions?: string[] | null } }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Authentication required");

    const granted = user.permissions ?? [];
    const missing = required.filter((p) => !granted.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permissions: ${missing.join(", ")}`);
    }
    return true;
  }
}
