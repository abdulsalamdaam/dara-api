import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { BankRecService } from "../tier2/bank-rec.service";
import { RemindersService } from "../tier2/reminders.service";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * DESIGN §8.3 Tier 2: bank reconciliation (CSV import, auto / manual match,
 * reconciliation statement) and scheduled rent reminders, which are BUILT
 * DISABLED (dry-run sender only). 404 while the flag is off.
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2Tier2Controller {
  constructor(private readonly rec: BankRecService, private readonly reminders: RemindersService) {}

  // ── Import profiles ──

  @Get("bank-import-profiles")
  @RequireCapability("view")
  profiles(@Req() req: Fv2Request, @Query("bankAccountId") bankAccountId?: string) {
    return this.rec.profiles(scopeId(req.user!), bankAccountId);
  }

  /** {bankAccountId, name, delimiter?, skipRows?, dateCol, dateFormat, descCol?, refCol?, amountCol? | debitCol?/creditCol?, balanceCol?} */
  @Post("bank-import-profiles")
  @RequireCapability("money")
  createProfile(@Req() req: Fv2Request, @Body() body: any) {
    return this.rec.saveProfile(scopeId(req.user!), body);
  }

  @Patch("bank-import-profiles/:id")
  @RequireCapability("money")
  updateProfile(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.rec.saveProfile(scopeId(req.user!), body, idOf(id));
  }

  @Delete("bank-import-profiles/:id")
  @RequireCapability("money")
  deleteProfile(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.deleteProfile(scopeId(req.user!), idOf(id));
  }

  // ── Statements ──

  /** {csv, profileId | profile} → the first 50 parsed lines and the errors; writes nothing. */
  @Post("bank-statements/preview")
  @RequireCapability("view")
  preview(@Req() req: Fv2Request, @Body() body: any) {
    return this.rec.preview(scopeId(req.user!), body);
  }

  /** {bankAccountId, csv, profileId | profile, periodFrom?, periodTo?, openingBalance?, closingBalance?, fileKey?} */
  @Post("bank-statements/import")
  @RequireCapability("money")
  importStatement(@Req() req: Fv2Request, @Body() body: any) {
    return this.rec.importStatement(scopeId(req.user!), req.user!, body);
  }

  /** ?bankAccountId */
  @Get("bank-statements")
  @RequireCapability("view")
  statements(@Req() req: Fv2Request, @Query("bankAccountId") bankAccountId?: string) {
    return this.rec.list(scopeId(req.user!), bankAccountId);
  }

  @Get("bank-statements/:id")
  @RequireCapability("view")
  statement(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.get(scopeId(req.user!), idOf(id));
  }

  @Post("bank-statements/:id/auto-match")
  @RequireCapability("money")
  autoMatch(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.autoMatch(scopeId(req.user!), req.user!, idOf(id));
  }

  /** {journalLineIds[]}: ledger lines before the period that the bank's opening balance already contains. */
  @Post("bank-statements/:id/clear-prior")
  @RequireCapability("money")
  clearPrior(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.rec.clearPrior(scopeId(req.user!), req.user!, idOf(id), body);
  }

  @Post("bank-statements/:id/complete")
  @RequireCapability("approve")
  complete(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.complete(scopeId(req.user!), req.user!, idOf(id));
  }

  @Delete("bank-statements/:id")
  @RequireCapability("money")
  removeStatement(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.remove(scopeId(req.user!), req.user!, idOf(id));
  }

  @Get("bank-statement-lines/:id/candidates")
  @RequireCapability("view")
  candidates(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.rec.candidatesFor(scopeId(req.user!), idOf(id));
  }

  /** {ignore: boolean} */
  @Post("bank-statement-lines/:id/ignore")
  @RequireCapability("money")
  ignore(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.rec.ignore(scopeId(req.user!), req.user!, idOf(id), body?.ignore !== false);
  }

  /** {accountId, memo?} → a DRAFT manual journal (posts only when approved). */
  @Post("bank-statement-lines/:id/create-entry")
  @RequireCapability("draft")
  createEntry(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.rec.createEntry(scopeId(req.user!), req.user!, idOf(id), body);
  }

  /** {statementLineIds[], journalLineIds[]} — 1:1, 1:n or n:1, equal signed sums. */
  @Post("bank-matches")
  @RequireCapability("money")
  match(@Req() req: Fv2Request, @Body() body: any) {
    return this.rec.match(scopeId(req.user!), req.user!, body);
  }

  @Delete("bank-matches/:groupId")
  @RequireCapability("money")
  unmatch(@Req() req: Fv2Request, @Param("groupId") groupId: string) {
    return this.rec.unmatch(scopeId(req.user!), req.user!, idOf(groupId));
  }

  // ── Rent reminders: built disabled ──

  @Get("reminders/settings")
  @RequireCapability("view")
  reminderSettings(@Req() req: Fv2Request) {
    return this.reminders.getSettings(scopeId(req.user!));
  }

  /** {enabled?, offsets?, channels?, templateAr?, templateEn?}; enabled:true is refused (400) while the server switch is off. */
  @Put("reminders/settings")
  @RequireCapability("settings")
  updateReminderSettings(@Req() req: Fv2Request, @Body() body: any) {
    return this.reminders.updateSettings(scopeId(req.user!), body);
  }

  /** ?date (default tomorrow): who WOULD be reminded. Read-only. */
  @Get("reminders/preview")
  @RequireCapability("view")
  reminderPreview(@Req() req: Fv2Request, @Query("date") date?: string) {
    return this.reminders.preview(scopeId(req.user!), date);
  }

  /** {date?}: the dry-run sender only — reminder_log rows, nothing sent. */
  @Post("reminders/dry-run")
  @RequireCapability("settings")
  reminderDryRun(@Req() req: Fv2Request, @Body() body: any) {
    return this.reminders.dryRun(scopeId(req.user!), body?.date);
  }

  @Get("reminders/log")
  @RequireCapability("view")
  reminderLog(@Req() req: Fv2Request, @Query("limit") limit?: string) {
    return this.reminders.log(scopeId(req.user!), Number(limit) || 200);
  }
}
