import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { capabilities } from "../capabilities";
import { PostingErrorsService } from "../posting-errors.service";

/**
 * The posting-errors list (DESIGN §5.5, §10.2). Scoped to scopeId(user); an id
 * outside it is a 404. View: `view`. Retry: `approve` or `money`. Dismiss: `approve`.
 */
@Controller("finance/v2/posting-errors")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2PostingErrorsController {
  constructor(private readonly errors: PostingErrorsService) {}

  /** ?tab=errors|skipped&limit&offset */
  @Get()
  @RequireCapability("view")
  list(@Req() req: Fv2Request, @Query() q: any) {
    return this.errors.list(scopeId(req.user!), q);
  }

  @Post(":id/retry")
  @HttpCode(200)
  retry(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number) {
    const caps = capabilities(req.user!);
    if (!caps.includes("approve") && !caps.includes("money")) throw new ForbiddenException("Missing capability: approve or money");
    return this.errors.retry(scopeId(req.user!), req.user!.id, id);
  }

  /** Body: { reason: string (5–500) } */
  @Post(":id/dismiss")
  @HttpCode(200)
  @RequireCapability("approve")
  dismiss(@Req() req: Fv2Request, @Param("id", ParseIntPipe) id: number, @Body() body: any) {
    return this.errors.dismiss(scopeId(req.user!), req.user!.id, id, body);
  }
}
