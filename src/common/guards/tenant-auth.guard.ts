import { Injectable, CanActivate, ExecutionContext, Inject, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { JwtService } from "@nestjs/jwt";
import { eq } from "drizzle-orm";
import { tenantsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { sessionIsCurrent, staleSessionException } from "../session";

export type TenantPayload = {
  id: number;
  phone: string;
  kind: "tenant";
  tv: number;
  /** ms epoch of the login that minted the token — see common/session.ts. */
  loginAt?: number;
  iat?: number;
};

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(DRIZZLE) private readonly db: Drizzle,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { tenant?: TenantPayload }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Unauthorized");
    const token = header.slice(7);
    let decoded: TenantPayload;
    try {
      decoded = this.jwt.verify<TenantPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    if (decoded.kind !== "tenant") throw new UnauthorizedException("Invalid token kind");

    const [tenant] = await this.db
      .select({ id: tenantsTable.id, tokenVersion: tenantsTable.tokenVersion, lastLoginAt: tenantsTable.lastLoginAt, status: tenantsTable.status, deletedAt: tenantsTable.deletedAt })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, decoded.id));
    if (!tenant) throw new UnauthorizedException("Tenant not found");
    if (tenant.deletedAt) throw new UnauthorizedException("الحساب محذوف");
    if (tenant.status !== "active") throw new UnauthorizedException("Tenant inactive");
    // Single session per tenant, same rule as JwtAuthGuard: each tenant login
    // bumps tokenVersion, so the previous device's token goes stale.
    if (!sessionIsCurrent(decoded, tenant)) throw staleSessionException(decoded, tenant);
    req.tenant = decoded;
    return true;
  }
}
