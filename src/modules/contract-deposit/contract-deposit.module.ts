import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Module, NotFoundException, Param, Patch, Post, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { auditLogsTable, contractsTable, paymentsTable, simpleInvoicesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { dateOnly, money, requiredForeignKeyId, text } from "../../common/validation";
import { nextReceiptVoucherNumber } from "../../common/receipt-number";
import { riyadhToday } from "../../common/payment-status";
import { FinanceV2Hooks } from "../finance-v2/hooks/hooks.service";
import {
  DEPOSIT_DESC, DEPOSIT_KIND, amountAfterTopUp, round2, statusForTerms, termsChangeRefusal, topUpRefusal,
  type DepositFacts, type Refusal,
} from "./deposit-rules";

/** Same per-account key space the contract create/rebuild path locks on (contracts.module.ts CONTRACT_NUMBER_LOCK). */
const CONTRACT_LOCK = 11;

function raise(r: Refusal): never {
  const body = { error: r.error, message: r.message };
  if (r.status === 400) throw new BadRequestException(body);
  throw new ConflictException(body);
}

function depositAmountOf(v: unknown, label: string, required: boolean): number {
  if (required && (v === undefined || v === null || v === "")) throw new BadRequestException(`${label} مطلوب · ${label} is required`);
  const s = money(v, label);
  if (s == null) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(String(v).trim())) {
    throw new BadRequestException(`${label}: منزلتان عشريتان على الأكثر · ${label}: at most two decimal places`);
  }
  return round2(Number(s));
}

/**
 * The security deposit after the contract exists (TR-5). The contract wizard
 * locks once the contract has documents, which left no way to add a deposit
 * that was agreed later, or to record more of it. These routes work with the
 * Finance v2 flag on or off; with it on, every receipt posts E09 through the
 * same hook the contract's own "collect deposit" uses.
 *
 *   GET   /contracts/:id/deposit/receipts  terms, Σ received, every receipt
 *   PATCH /contracts/:id/deposit           set the terms — only while nothing is receipted
 *   POST  /contracts/:id/deposit/top-up    an ADDITIONAL deposit: a new receipt for the difference
 *
 * A receipt already issued is never edited. A reduction after receipt is a
 * refund and goes through the deposit settlement at contract end.
 */
@ApiTags("contracts")
@ApiBearerAuth("user-jwt")
@Controller("contracts")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ContractDepositController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}
  @Inject(FinanceV2Hooks) fv2h?: FinanceV2Hooks;

  /** Contract + receipts, read on `db` (a tx locks the contract row first). */
  private async facts(db: any, ownerId: number, id: number, lock: boolean) {
    const q = db.select().from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    const [contract] = lock ? await q.for("update") : await q;
    if (!contract) throw new NotFoundException("Contract not found");
    // Whole rows: the screen opens each receipt in the voucher document view.
    const receipts = await db.select().from(simpleInvoicesTable).where(and(
      eq(simpleInvoicesTable.userId, ownerId), eq(simpleInvoicesTable.contractId, id),
      eq(simpleInvoicesTable.kind, DEPOSIT_KIND), ne(simpleInvoicesTable.status, "cancelled"), isNull(simpleInvoicesTable.deletedAt),
    )).orderBy(asc(simpleInvoicesTable.id));
    const [legacy] = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(and(
      eq(paymentsTable.userId, ownerId), eq(paymentsTable.contractId, id), eq(paymentsTable.description, DEPOSIT_DESC),
      isNull(paymentsTable.deletedAt), ne(paymentsTable.status, "cancelled"),
    )).limit(1);
    const received = round2(receipts.filter((r: any) => r.status === "confirmed").reduce((s: number, r: any) => s + (Number(r.total) || 0), 0));
    const f: DepositFacts = {
      isDraft: Boolean(contract.isDraft), status: contract.status ?? null, depositStatus: contract.depositStatus ?? null,
      received, legacyDepositRow: Boolean(legacy),
    };
    return { contract, receipts, f };
  }

  private view(contract: any, receipts: any[], f: DepositFacts) {
    const amount = round2(Number(contract.depositAmount) || 0);
    return {
      amount, status: contract.depositStatus ?? null, dueDate: contract.depositDueDate ?? null, method: contract.depositMethod ?? null,
      received: f.received, outstanding: round2(Math.max(0, amount - f.received)),
      receipts,
      /** What the screen may offer. */
      canEditTerms: termsChangeRefusal(f, 0) == null,
      canTopUp: topUpRefusal(f, 1) == null,
    };
  }

  @Get(":contractId/deposit/receipts")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async receipts(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string) {
    const id = requiredForeignKeyId(contractId, "رقم العقد");
    const { contract, receipts, f } = await this.facts(this.db, scopeId(user), id, false);
    return this.view(contract, receipts, f);
  }

  /** Set (or clear) the deposit terms on a live contract. Refused once any deposit receipt exists. */
  @Patch(":contractId/deposit")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async setTerms(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = requiredForeignKeyId(contractId, "رقم العقد");
    const ownerId = scopeId(user);
    const amount = depositAmountOf(body?.amount, "مبلغ التأمين", true);
    const dueDate = dateOnly(body?.dueDate, "تاريخ استحقاق التأمين");
    const method = text(body?.method, "طريقة سداد التأمين", 40);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ownerId}, ${CONTRACT_LOCK})`);
      const { contract, f } = await this.facts(tx, ownerId, id, true);
      const refusal = termsChangeRefusal(f, amount);
      if (refusal) raise(refusal);
      const set: Record<string, unknown> = {
        depositAmount: amount > 0 ? amount.toFixed(2) : null,
        depositStatus: statusForTerms(amount),
        depositDueDate: amount > 0 ? (dueDate ?? contract.depositDueDate ?? null) : null,
        depositMethod: amount > 0 ? (method ?? contract.depositMethod ?? null) : null,
      };
      const [updated] = await tx.update(contractsTable).set(set as any)
        .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId))).returning();
      await tx.insert(auditLogsTable).values({
        ownerUserId: ownerId, actorUserId: user.id, action: "deposit_terms", entity: "contracts", entityId: String(id), method: "PATCH",
        path: `/api/contracts/${id}/deposit · ${contract.contractNumber ?? id}: ${round2(Number(contract.depositAmount) || 0).toFixed(2)} → ${amount.toFixed(2)}`,
      });
      const after = await this.facts(tx, ownerId, id, false);
      return this.view(updated, after.receipts, after.f);
    });
  }

  /**
   * An additional deposit on top of the one already receipted: a NEW deposit
   * receipt voucher (سند قبض, RV number) for exactly `amount`; the contract's
   * deposit amount grows so the receipts never exceed it. The receipt already
   * issued is untouched. Finance v2 posts E09 for the new voucher, inside this
   * transaction, with the chosen "received into" account.
   */
  @Post(":contractId/deposit/top-up")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async topUp(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = requiredForeignKeyId(contractId, "رقم العقد");
    const ownerId = scopeId(user);
    const fv2 = (await this.fv2h?.resolve(ownerId)) === true;
    const amount = depositAmountOf(body?.amount, "مبلغ التأمين الإضافي", true);
    const paidDate = dateOnly(body?.paidDate, "تاريخ الاستلام") ?? riyadhToday();
    const method = text(body?.method, "طريقة السداد", 40) ?? "bank_transfer";
    const notes = text(body?.notes, "ملاحظات", 500);
    const attachmentKey = text(body?.attachmentKey, "المرفق", 500);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ownerId}, ${CONTRACT_LOCK})`);
      const { contract, f } = await this.facts(tx, ownerId, id, true);
      const refusal = topUpRefusal(f, amount);
      if (refusal) raise(refusal);
      const number = await nextReceiptVoucherNumber(tx, ownerId);
      const desc = `${DEPOSIT_DESC} — إضافي`;
      const [voucher] = await tx.insert(simpleInvoicesTable).values({
        userId: ownerId, number, type: "invoice", kind: DEPOSIT_KIND, status: "confirmed",
        contractId: id, tenantId: contract.tenantId ?? null, tenantName: contract.tenantName ?? null,
        items: [{ description: desc, quantity: 1, unitPrice: amount, amount, vat: false }],
        subtotal: amount.toFixed(2), total: amount.toFixed(2),
        issueDate: paidDate, paidDate, confirmedAt: new Date(),
        receiptNumber: number, paymentMethod: method, notes: notes ?? desc,
        attachmentKey: attachmentKey ?? null,
      } as any).returning();
      const nextAmount = amountAfterTopUp(Number(contract.depositAmount) || 0, f.received, amount);
      const [updated] = await tx.update(contractsTable)
        .set({ depositAmount: nextAmount.toFixed(2), depositStatus: "collected" } as any)
        .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId))).returning();
      await tx.insert(auditLogsTable).values({
        ownerUserId: ownerId, actorUserId: user.id, action: "deposit_top_up", entity: "contracts", entityId: String(id), method: "POST",
        path: `/api/contracts/${id}/deposit/top-up · ${contract.contractNumber ?? id}: +${amount.toFixed(2)} (${number})`,
      });
      await this.fv2h?.depositCollected({ fv2, userId: ownerId, tx }, voucher?.id, { bankAccountId: body?.bankAccountId });
      const after = await this.facts(tx, ownerId, id, false);
      return { voucher, deposit: this.view(updated, after.receipts, after.f) };
    });
  }
}

@Module({ controllers: [ContractDepositController] })
export class ContractDepositModule {}
