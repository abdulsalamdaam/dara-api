import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Inject, Optional, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { JwtService } from "@nestjs/jwt";
import { and, eq, isNull } from "drizzle-orm";
import { ownersTable, rolesTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { routeAllowsOwnerToken } from "../permissions.decorator";
import { STAFF_ROLE_KEYS } from "../permissions";

/**
 * `role` is the role *key* string (e.g. "super_admin", "admin", "user",
 * "demo", "accountant") sourced from the joined `roles` row. The four
 * system role keys still appear here, but custom company-scoped roles can
 * use any string key — RolesGuard / SuperAdminGuard / AdminGuard only
 * recognize the system tier keys.
 *
 * `permissions` is sourced from `roles.permissions` at request time so a
 * permission change to a role takes effect on the next request, no
 * re-login required.
 */
export type AuthUser = {
  id: number;
  email: string;
  role: string;
  kind?: "user";
  tv?: number;
  permissions?: string[] | null;
  ownerUserId?: number | null;
  companyId?: number | null;
  roleId?: number | null;
  /**
   * Set ONLY for owner (landlord) mobile logins (kind "owner"). When present,
   * the request is additionally narrowed to this single owner's data inside
   * the account scope. Null/undefined for normal user/employee logins.
   */
  ownerScopeId?: number | null;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(DRIZZLE) private readonly db: Drizzle,
    @Optional() private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Unauthorized");
    const token = header.slice(7);
    type DecodedToken = Omit<AuthUser, "kind"> & { kind?: string; ownerId?: number };
    let decoded: DecodedToken;
    try {
      decoded = this.jwt.verify<DecodedToken>(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
    }

    // Owner (landlord) mobile login — no usersTable tokenVersion check; the
    // request is scoped to the managing account (owner.userId) AND narrowed to
    // this single owner via ownerScopeId.
    if (decoded.kind === "owner") {
      const ownerId = decoded.ownerId;
      if (ownerId == null) throw new UnauthorizedException("Invalid token");
      // An owner token resolves to the MANAGING account's id. Only routes that
      // narrow by `ownerScopeId` themselves may see it; everywhere else it
      // would act as the account holder (team, audit, company, uploads...).
      if (!routeAllowsOwnerToken(this.reflector, ctx)) throw new ForbiddenException("Forbidden");
      const [owner] = await this.db
        .select({ id: ownersTable.id, userId: ownersTable.userId })
        .from(ownersTable)
        .where(and(eq(ownersTable.id, ownerId), eq(ownersTable.status, "active"), isNull(ownersTable.deletedAt)));
      if (!owner) throw new UnauthorizedException("Unauthorized");
      req.user = {
        id: owner.userId,
        email: "",
        role: "owner",
        kind: "user", // so downstream scopeId / guards treat it as a user-scoped request
        ownerUserId: null,
        ownerScopeId: owner.id,
        permissions: [],
        companyId: null,
        roleId: null,
      };
      return true;
    }

    if (decoded.kind && decoded.kind !== "user") throw new UnauthorizedException("Invalid token kind");

    // Single round-trip: user row + linked role row. Role key + permissions
    // come exclusively from the roles table — there is no longer a per-user
    // permission override.
    const [row] = await this.db
      .select({
        id: usersTable.id,
        tokenVersion: usersTable.tokenVersion,
        isActive: usersTable.isActive,
        ownerUserId: usersTable.ownerUserId,
        companyId: usersTable.companyId,
        roleId: usersTable.roleId,
        roleKey: rolesTable.key,
        roleCompanyId: rolesTable.companyId,
        rolePermissions: rolesTable.permissions,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(eq(usersTable.id, decoded.id), isNull(usersTable.deletedAt)));
    if (!row) throw new UnauthorizedException("User not found");
    if (!row.isActive) throw new UnauthorizedException("Account disabled");
    if ((decoded.tv ?? 0) !== (row.tokenVersion ?? 0)) {
      throw new UnauthorizedException("Session revoked. Please log in again.");
    }
    // A platform-staff role key is only real on the SYSTEM role row held by a
    // top-level account. A company-scoped role may carry any key string, and
    // the team endpoints used to link an employee to any system role by key —
    // `super_admin` included. Every staff check downstream (SuperAdminGuard,
    // support's isAdmin, login) trusts the key alone, so it is pinned here.
    if ((STAFF_ROLE_KEYS as readonly string[]).includes(row.roleKey ?? "")
        && (row.roleCompanyId != null || row.ownerUserId != null)) {
      throw new ForbiddenException("Invalid role assignment");
    }
    req.user = {
      ...decoded,
      kind: "user",
      role: row.roleKey ?? "user",
      permissions: row.rolePermissions ?? [],
      ownerUserId: row.ownerUserId ?? null,
      companyId: row.companyId ?? null,
      roleId: row.roleId ?? null,
      /**
       * Pinned, not merged. `ownerScopeId` narrows a request to ONE landlord
       * inside the account and is only ever legitimate on an owner-kind token,
       * where the branch above reads it from the `owners` row rather than from
       * the token. Here it would have come from `...decoded` — i.e. from a
       * claim the client presented.
       *
       * Nothing currently signs a user token carrying that claim, so this is
       * not a live hole; it is the assumption that makes it not one, written
       * down and enforced. Every reader of `ownerScopeId` treats it as
       * server-derived, so the day some other code path adds a claim to a user
       * token, that must not silently become a scope.
       */
      ownerScopeId: null,
    };
    return true;
  }
}
