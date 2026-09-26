import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { FinanceFlagService, FlagUnavailableError, type FlagState } from "./flag.service";
import { capabilities, type Capability } from "./capabilities";

const CAP_META = "fv2:capability";
const OWNER_SCOPE_META = "fv2:allowOwnerScope";

/** Require a derived capability (§10.1) on a `/finance/v2/*` route. */
export const RequireCapability = (cap: Capability) => SetMetadata(CAP_META, cap);
/** Let an owner-mobile token through (only the landlord statement, §10.2). */
export const AllowOwnerScope = () => SetMetadata(OWNER_SCOPE_META, true);

export type Fv2Request = Request & { user?: AuthUser; fv2?: FlagState };

/**
 * Guards every `/api/finance/v2/*` route except `/status` (DESIGN §1.2, §10.2).
 * Runs after JwtAuthGuard: `@UseGuards(JwtAuthGuard, FinanceV2Guard)`.
 *  - flag off                → 404 (the beta surface does not exist for other accounts)
 *  - flag unreadable, uncached → 503 (never guess)
 *  - owner-mobile token      → 403 unless the route allows it
 *  - missing capability      → 403
 * The resolved flag state is left on `req.fv2` so the handler need not read it again.
 */
@Injectable()
export class FinanceV2Guard implements CanActivate {
  constructor(private readonly flag: FinanceFlagService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Fv2Request>();
    const user = req.user;
    if (!user) throw new NotFoundException();
    let state: FlagState;
    try {
      state = await this.flag.stateStrict(scopeId(user));
    } catch (err) {
      if (err instanceof FlagUnavailableError) throw new ServiceUnavailableException("Finance v2 is temporarily unavailable");
      throw err;
    }
    if (!state.on) throw new NotFoundException();
    req.fv2 = state;

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (user.ownerScopeId != null && !this.reflector.getAllAndOverride<boolean>(OWNER_SCOPE_META, targets)) {
      throw new ForbiddenException("Forbidden");
    }
    const cap = this.reflector.getAllAndOverride<Capability>(CAP_META, targets);
    if (cap && !capabilities(user).includes(cap)) throw new ForbiddenException(`Missing capability: ${cap}`);
    return true;
  }
}
