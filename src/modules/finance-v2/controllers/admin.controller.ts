import { Body, Controller, Get, Param, ParseIntPipe, Patch, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../../common/guards/roles.guard";
import { FinanceV2AdminService } from "../admin.service";
import type { Fv2Request } from "../finance-v2.guard";

/** The switch and its support views (DESIGN §1.5, §10.2). Super admin only. */
@Controller("admin/finance-v2")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class FinanceV2AdminController {
  constructor(private readonly admin: FinanceV2AdminService) {}

  @Get("accounts")
  accounts() {
    return this.admin.listAccounts();
  }

  @Get(":accountUserId/suggested-mode")
  async suggestedMode(@Param("accountUserId", ParseIntPipe) id: number) {
    return { mode: await this.admin.suggestMode(id) };
  }

  @Get(":accountUserId/events")
  events(@Param("accountUserId", ParseIntPipe) id: number) {
    return this.admin.events(id);
  }

  /** Body: { enabled: boolean, accountingMode?: 'owner'|'manager', reason: string (5–500) }. */
  @Patch(":accountUserId")
  toggle(@Req() req: Fv2Request, @Param("accountUserId", ParseIntPipe) id: number, @Body() body: any) {
    return this.admin.toggle(req.user!.id, id, body);
  }
}
