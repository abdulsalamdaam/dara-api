import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { ExpensesV2Service } from "../tier1/expenses-v2.service";
import { TenantCreditsService } from "../tier1/tenant-credits.service";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * DESIGN §8.2 Tier 1: bank accounts and cash boxes, expenses with input VAT,
 * and tenant credit refund / carry-forward. 404 while the flag is off (the
 * guard); every id is loaded with the account scope (a miss is 404).
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard)
export class FinanceV2Tier1Controller {
  constructor(
    private readonly banks: BankAccountsService,
    private readonly expenses: ExpensesV2Service,
    private readonly credits: TenantCreditsService,
  ) {}

  // ── Bank accounts and cash boxes (§8.2 a) ──

  /** ?includeInactive=true */
  @Get("bank-accounts")
  @RequireCapability("view")
  listBanks(@Req() req: Fv2Request, @Query("includeInactive") inactive?: string) {
    return this.banks.list(scopeId(req.user!), { includeInactive: inactive === "true" || inactive === "1" });
  }

  /** ?iban= — validity, normalised form and the bank derived from the code. */
  @Get("bank-accounts/validate-iban")
  @RequireCapability("view")
  validateIban(@Query("iban") iban?: string) {
    return this.banks.validateIban(iban);
  }

  @Get("bank-accounts/:id")
  @RequireCapability("view")
  getBank(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.banks.get(scopeId(req.user!), idOf(id));
  }

  /** {kind: bank|cash, nameAr, nameEn?, bankName?, iban?, accountNumber?, isTrust?, isDefault?, openingBalance?} */
  @Post("bank-accounts")
  @RequireCapability("settings")
  createBank(@Req() req: Fv2Request, @Body() body: any) {
    return this.banks.create(scopeId(req.user!), req.user!.id, body);
  }

  /** {nameAr?, nameEn?, bankName?, iban?, accountNumber?, isTrust?, isDefault?: true, isActive?} */
  @Patch("bank-accounts/:id")
  @RequireCapability("settings")
  updateBank(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.banks.update(scopeId(req.user!), req.user!.id, idOf(id), body);
  }

  @Delete("bank-accounts/:id")
  @RequireCapability("settings")
  deleteBank(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.banks.remove(scopeId(req.user!), req.user!.id, idOf(id));
  }

  // ── Expenses with input VAT, supplier, attachment, edit (§8.2 b) ──

  /** ?from&to&ownerId&propertyId&vatCategory&page&pageSize */
  @Get("expenses")
  @RequireCapability("view")
  listExpenses(@Req() req: Fv2Request, @Query() q: any) {
    return this.expenses.list(scopeId(req.user!), q);
  }

  /** ?ownerId&propertyId&vatCategory&chargeTo — the recoverability default the dialog shows. */
  @Get("expenses/recoverability")
  @RequireCapability("view")
  recoverability(@Req() req: Fv2Request, @Query() q: any) {
    return this.expenses.recoverability(scopeId(req.user!), q);
  }

  @Get("expenses/:id")
  @RequireCapability("view")
  getExpense(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.expenses.get(scopeId(req.user!), idOf(id));
  }

  /**
   * {expenseDate, category, amount, amountMode?: gross|net, ownerId?, propertyId?, vatCategory?: S|Z|E|O, vatRate?,
   *  vatRecoverable?, supplierName?, supplierVatNumber?, supplierInvoiceNo?, supplierInvoiceDate?, attachmentKey?,
   *  bankAccountId?, chargeTo?: company|landlord, glAccountId?, notes?}
   */
  @Post("expenses")
  @RequireCapability("expenses")
  createExpense(@Req() req: Fv2Request, @Body() body: any) {
    return this.expenses.create(scopeId(req.user!), req.user!, body);
  }

  /** Any subset of the create fields; the ledger reverses revision n and posts n+1. */
  @Patch("expenses/:id")
  @RequireCapability("expenses")
  updateExpense(@Req() req: Fv2Request, @Param("id") id: string, @Body() body: any) {
    return this.expenses.update(scopeId(req.user!), req.user!, idOf(id), body);
  }

  // ── Tenant credit balances (§8.2 c) ──

  /** ?asOf */
  @Get("tenant-credits")
  @RequireCapability("view")
  listCredits(@Req() req: Fv2Request, @Query("asOf") asOf?: string) {
    return this.credits.list(scopeId(req.user!), asOf);
  }

  /** ?tenantId&contractId */
  @Get("tenant-credits/actions")
  @RequireCapability("view")
  creditActions(@Req() req: Fv2Request, @Query() q: any) {
    return this.credits.actions(scopeId(req.user!), q);
  }

  @Get("tenant-credits/:tenantId")
  @RequireCapability("view")
  tenantCredit(@Req() req: Fv2Request, @Param("tenantId") tenantId: string) {
    return this.credits.tenant(scopeId(req.user!), idOf(tenantId));
  }

  /** {tenantId, contractId?, amount, date?, bankAccountId?, method?, reference?} → a PV-###### payment voucher (E20). */
  @Post("tenant-credits/refund")
  @RequireCapability("money")
  refund(@Req() req: Fv2Request, @Body() body: any) {
    return this.credits.refund(scopeId(req.user!), req.user!, body);
  }

  /** {tenantId, contractId?, targetDocumentId | targetPaymentId, amount, date?, sourceDocumentId?} (E21). */
  @Post("tenant-credits/apply")
  @RequireCapability("money")
  apply(@Req() req: Fv2Request, @Body() body: any) {
    return this.credits.apply(scopeId(req.user!), req.user!, body);
  }

  @Post("tenant-credits/:id/void")
  @RequireCapability("approve")
  voidCredit(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.credits.void(scopeId(req.user!), req.user!, idOf(id));
  }

  /** After a credit note is approved: the credit it left the tenant, to offer refund / apply / keep. */
  @Get("documents/:id/tenant-credit")
  @RequireCapability("view")
  documentCredit(@Req() req: Fv2Request, @Param("id") id: string) {
    return this.credits.documentCredit(scopeId(req.user!), idOf(id));
  }
}
