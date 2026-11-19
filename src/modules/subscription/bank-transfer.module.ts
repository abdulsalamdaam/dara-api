/// <reference types="multer" />
/**
 * Pay by bank transfer (migration 0099).
 *
 * The customer transfers to Dara's account (DARA_BANK below), uploads the bank
 * receipt and the payment row waits as status `review`. A platform admin checks
 * the receipt against the bank statement, then:
 *   - approves → `activateFromPaidRow` (the same activation as a card payment:
 *     subscription window, tax invoice email, admin paid-notice; for an add-on,
 *     the add-on), or
 *   - rejects  → `rejected` with a reason the customer sees (an add-on row goes
 *     back to `pending`, so its card link still works).
 *
 * Works for every payment the customer makes: the first subscription payment,
 * a renewal or plan change (same selection rules as the card checkout,
 * `resolvePaySelection`), and an admin-offered add-on.
 *
 * Nothing is trusted from the receipt itself — it is a picture. Only an admin
 * approval moves money-state.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Logger, Module, NotFoundException,
  Optional, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, inArray } from "drizzle-orm";
import { accountLimitAddonsTable, subscriptionPaymentsTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { CYCLE_LABEL_AR, parseCycle, resolvePackage } from "../../common/packages";
import { UploadsService } from "../uploads/uploads.service";
import { EmailService } from "../email/email.service";
import { AppLogService } from "../../common/logging/app-log.service";
import { SubscriptionModule, activateFromPaidRow, resolvePaySelection } from "./subscription.module";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { LimitsModule } from "../limits/limits.module";
import { AddonCatalogService } from "../limits/addon-catalog.service";
import { addonCharge, addonDescription } from "../limits/limits-billing.service";
import { RECEIPT_MAX_BYTES, bankTransferEnabled, receiptProblem } from "../../common/bank-transfer";

type Row = typeof subscriptionPaymentsTable.$inferSelect;
type ReceiptFile = { buffer: Buffer; originalname: string; mimetype: string; size: number };

const EMAIL_ALLOWLIST = () => String(process.env.BILLING_EMAIL_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

@Injectable()
export class BankTransferService {
  private readonly log = new Logger("BankTransfer");

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly uploads: UploadsService,
    private readonly invoices: SubscriptionInvoiceService,
    private readonly catalog: AddonCatalogService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly appLog?: AppLogService,
  ) {}

  /* ── Customer ──────────────────────────────────────────────────────── */

  /**
   * Upload a receipt for `{ plan?, cycle? }` (the subscription — first payment,
   * renewal or plan change) or for `{ addonId }` (an admin-offered add-on).
   * A subscription receipt already under review is replaced by the new one.
   */
  async submit(user: AuthUser, file: ReceiptFile | undefined, body: any) {
    if (!bankTransferEnabled()) throw new BadRequestException("التحويل البنكي غير متاح حالياً · Bank transfer is not available");
    if (user.ownerUserId) throw new ForbiddenException("صلاحية الدفع لصاحب الحساب فقط · Only the account holder can pay");
    const problem = receiptProblem(file);
    if (problem) throw new BadRequestException(problem);
    const addonId = body?.addonId != null && body.addonId !== "" ? Number(body.addonId) : null;
    const row = addonId != null ? await this.addonRow(user.id, addonId) : await this.subscriptionRow(user, body);

    let up: Awaited<ReturnType<UploadsService["upload"]>>;
    try {
      up = await this.uploads.upload(file!, { scopeId: user.id, folder: "subscription-receipts", metadata: { payment: String(row.id) } });
    } catch (err) {
      // No receipt → a row we just opened for it can never be reviewed: close it.
      if (row.kind === "subscription" && row.status === "pending" && !row.receiptKey) {
        await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" }).where(eq(subscriptionPaymentsTable.id, row.id));
      }
      throw err;
    }
    const [saved] = await this.db.update(subscriptionPaymentsTable).set({
      status: "review", chargeType: "bank_transfer",
      receiptKey: up.key, receiptName: String(file!.originalname || "receipt").slice(0, 200), receiptType: up.contentType,
      receiptUploadedAt: new Date(), reviewNote: null, reviewedAt: null, reviewedBy: null,
    }).where(eq(subscriptionPaymentsTable.id, row.id)).returning();
    void this.notifyAdmins(saved!);
    return publicRow(saved!);
  }

  /** The subscription row this receipt pays for — a fresh one, replacing a receipt still under review. */
  private async subscriptionRow(user: AuthUser, body: any): Promise<Row> {
    const { ownerId, plan, cycle, amount, shared } = await resolvePaySelection(this.db, user, body);
    // One subscription receipt under review at a time: a new upload replaces it.
    await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" }).where(and(
      eq(subscriptionPaymentsTable.userId, ownerId), eq(subscriptionPaymentsTable.kind, "subscription"),
      eq(subscriptionPaymentsTable.chargeType, "bank_transfer"), eq(subscriptionPaymentsTable.status, "review"),
    ));
    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: ownerId, plan, billingCycle: cycle, amount: amount.toFixed(2), currency: "SAR",
      status: "pending", chargeType: "bank_transfer", kind: "subscription",
      description: shared && shared.extras > 0
        ? `اشتراك باقة «${resolvePackage(plan).labelAr}» الموحدة — ${CYCLE_LABEL_AR[cycle]} — تشمل ${shared.extras + 1} حسابات مرتبطة`
        : null,
    }).returning();
    return row!;
  }

  /** The add-on's payment row: its open one, or a new one at the add-on's price. */
  private async addonRow(accountId: number, addonId: number): Promise<Row> {
    if (!Number.isInteger(addonId) || addonId <= 0) throw new BadRequestException("invalid add-on id");
    const [addon] = await this.db.select().from(accountLimitAddonsTable)
      .where(and(eq(accountLimitAddonsTable.id, addonId), eq(accountLimitAddonsTable.accountId, accountId))).limit(1);
    if (!addon || addon.source === "self_serve") throw new NotFoundException("Add-on not found");
    if (addon.status !== "offered" && addon.status !== "pending_payment") {
      throw new BadRequestException(`هذه الإضافة ليست بانتظار الدفع · Add-on is ${addon.status}`);
    }
    if (addon.offerExpiresAt && new Date(addon.offerExpiresAt) <= new Date()) {
      throw new BadRequestException("انتهت مدة العرض · This offer has expired");
    }
    if (addon.paymentId != null) {
      const [open] = await this.db.select().from(subscriptionPaymentsTable)
        .where(and(eq(subscriptionPaymentsTable.id, addon.paymentId), eq(subscriptionPaymentsTable.userId, accountId))).limit(1);
      if (open?.status === "paid") throw new BadRequestException("هذه الإضافة مدفوعة · This add-on is already paid");
      if (open && (open.status === "pending" || open.status === "review" || open.status === "rejected")) return open;
    }
    const [acct] = await this.db.select({ packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle, subscriptionEndsAt: usersTable.subscriptionEndsAt })
      .from(usersTable).where(eq(usersTable.id, accountId)).limit(1);
    const charge = addonCharge(addon, addon.endsAt ?? acct?.subscriptionEndsAt ?? null);
    if (!charge || charge.total <= 0) throw new BadRequestException("لا يمكن تحديد قيمة الإضافة · The add-on has no price");
    const item = addon.catalogKey ? await this.catalog.find(addon.catalogKey) : null;
    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: accountId, plan: acct?.packagePlan ?? "basic", billingCycle: acct?.billingCycle ?? "yearly",
      amount: charge.total.toFixed(2), currency: "SAR", status: "pending", kind: "addon", addonId: addon.id,
      chargeType: "bank_transfer", description: addonDescription(addon, item, charge.months),
    }).returning();
    await this.db.update(accountLimitAddonsTable)
      .set({ paymentId: row!.id, ...(addon.status === "offered" ? { status: "pending_payment" as const } : {}) })
      .where(eq(accountLimitAddonsTable.id, addon.id));
    return row!;
  }

  /** A short-lived link to the customer's own receipt. */
  async ownReceiptUrl(user: AuthUser, id: number) {
    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.id, id), eq(subscriptionPaymentsTable.userId, scopeId(user)))).limit(1);
    if (!row?.receiptKey) throw new NotFoundException("لا يوجد إيصال · No receipt");
    return { url: await this.uploads.presignGet(row.receiptKey), name: row.receiptName, type: row.receiptType };
  }

  /* ── Admin ─────────────────────────────────────────────────────────── */

  async list(status: string | undefined) {
    const statuses = status === "all" ? ["review", "paid", "rejected", "cancelled"] : status && ["review", "paid", "rejected"].includes(status) ? [status] : ["review"];
    const rows = await this.db.select({ p: subscriptionPaymentsTable, u: { id: usersTable.id, name: usersTable.name, email: usersTable.email, phone: usersTable.phone } })
      .from(subscriptionPaymentsTable)
      .innerJoin(usersTable, eq(usersTable.id, subscriptionPaymentsTable.userId))
      .where(and(eq(subscriptionPaymentsTable.chargeType, "bank_transfer"), inArray(subscriptionPaymentsTable.status, statuses)))
      .orderBy(desc(subscriptionPaymentsTable.receiptUploadedAt), desc(subscriptionPaymentsTable.id))
      .limit(200);
    // The review queue counts every receipt waiting, whatever is listed.
    const waiting = status === "review" || !status ? rows.length : (await this.db.select({ id: subscriptionPaymentsTable.id }).from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.chargeType, "bank_transfer"), eq(subscriptionPaymentsTable.status, "review")))).length;
    return {
      waiting,
      items: rows.filter((r) => r.p.receiptKey).map((r) => ({ ...publicRow(r.p), account: r.u })),
    };
  }

  async adminReceiptUrl(id: number) {
    const [row] = await this.db.select().from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, id)).limit(1);
    if (!row?.receiptKey) throw new NotFoundException("No receipt");
    return { url: await this.uploads.presignGet(row.receiptKey), name: row.receiptName, type: row.receiptType };
  }

  /** The receipt matches the bank statement: activate exactly as a paid card payment would. */
  async approve(admin: AuthUser, id: number) {
    const row = await this.reviewRow(id);
    const won = await activateFromPaidRow(this.db, row, { paidAt: new Date(), moyasarPaymentId: null }, this.invoices);
    if (!won) throw new BadRequestException("الدفعة مُعتمدة مسبقاً · Already approved");
    await this.db.update(subscriptionPaymentsTable).set({ reviewedBy: admin.id, reviewedAt: new Date(), reviewNote: null })
      .where(eq(subscriptionPaymentsTable.id, row.id));
    if (row.kind !== "addon") await this.rescheduleRenewal(row.userId);
    this.appLog?.record({ level: "log", event: "bank_transfer_approved", context: "BankTransfer", userId: row.userId, message: `bank transfer ${row.id} approved by admin ${admin.id}`, meta: { paymentId: row.id, amount: row.amount } });
    const [after] = await this.db.select().from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, row.id));
    return publicRow(after!);
  }

  async reject(admin: AuthUser, id: number, reason: string) {
    const why = String(reason || "").trim();
    if (why.length < 3) throw new BadRequestException("اكتب سبب الرفض · Write the reason");
    const row = await this.reviewRow(id);
    // An add-on goes back to waiting for payment (its card link still works);
    // a subscription receipt is closed — the customer uploads a new one or pays by card.
    const [after] = await this.db.update(subscriptionPaymentsTable).set({
      status: row.kind === "addon" ? "pending" : "rejected",
      reviewNote: why.slice(0, 500), reviewedBy: admin.id, reviewedAt: new Date(),
    }).where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "review"))).returning();
    if (!after) throw new BadRequestException("تمت مراجعة هذا الإيصال · Already reviewed");
    this.appLog?.record({ level: "log", event: "bank_transfer_rejected", context: "BankTransfer", userId: row.userId, message: `bank transfer ${row.id} rejected by admin ${admin.id}`, meta: { paymentId: row.id, reason: why } });
    void this.notifyRejected(after, why);
    return publicRow(after);
  }

  private async reviewRow(id: number): Promise<Row> {
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException("invalid id");
    const [row] = await this.db.select().from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, id)).limit(1);
    if (!row || row.chargeType !== "bank_transfer") throw new NotFoundException("Bank transfer not found");
    if (row.status !== "review") throw new BadRequestException("تمت مراجعة هذا الإيصال · Already reviewed");
    return row;
  }

  /**
   * A saved card still renews this account: move the renewal to the new end,
   * or the job would charge the card for the period just paid by transfer.
   */
  private async rescheduleRenewal(userId: number) {
    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!u || u.nextBillingAt == null) return;
    await this.db.update(usersTable).set({
      nextBillingAt: u.autoRenew && u.billingState !== "canceled" && u.subscriptionEndsAt ? u.subscriptionEndsAt : null,
      billingFailedAttempts: 0,
      billingState: u.billingState === "canceled" ? "canceled" : "ok",
    }).where(eq(usersTable.id, userId));
  }

  /* ── Notices ───────────────────────────────────────────────────────── */

  private async notifyAdmins(row: Row) {
    if (!this.email) return;
    try {
      const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, row.userId));
      const { company } = await this.invoices.loadBuyer(this.db, row.userId);
      await this.email.sendAdminBankTransferSubmitted({
        paymentId: row.id, kind: row.kind === "addon" ? "addon" : "subscription", plan: row.plan, billingCycle: row.billingCycle,
        amount: row.amount, description: row.description, accountId: row.userId,
        name: u?.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null, companyName: company?.name ?? null,
      });
    } catch (err: any) {
      this.log.error(`admin bank-transfer notice for payment ${row.id} failed: ${err?.message || err}`);
    }
  }

  private async notifyRejected(row: Row, reason: string) {
    if (!this.email) return;
    try {
      const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, row.userId));
      if (!u?.email) return;
      // Staging is a copy of production: customer emails only to the allowlist there.
      const allow = EMAIL_ALLOWLIST();
      if (allow.length && !allow.includes(u.email.toLowerCase())) {
        this.appLog?.record({ level: "warn", event: "bank_transfer_email_suppressed", context: "BankTransfer", userId: u.id, message: "rejection email not sent: address not on BILLING_EMAIL_ALLOWLIST" });
        return;
      }
      const label = row.kind === "addon" ? (row.description || "إضافة") : `${resolvePackage(row.plan).labelAr} — ${CYCLE_LABEL_AR[parseCycle(row.billingCycle)]}`;
      await this.email.sendBankTransferRejected(u.email, u.name || "", { amount: row.amount, label, reason });
    } catch (err: any) {
      this.log.error(`bank-transfer rejection email for payment ${row.id} failed: ${err?.message || err}`);
    }
  }
}

/** A payment row as the customer / admin screens see it — never the object key. */
export function publicRow(r: Row) {
  const { receiptKey, moyasarGivenId, ...rest } = r;
  return { ...rest, amount: Number(r.amount), hasReceipt: !!receiptKey };
}

@ApiTags("subscription")
@ApiBearerAuth("user-jwt")
@Controller("me/subscription")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BankTransferController {
  constructor(private readonly bank: BankTransferService) {}

  /** Upload the bank receipt (multipart `file`, plus `plan`/`cycle` or `addonId`). */
  @Post("bank-transfer")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: RECEIPT_MAX_BYTES + 1 } }))
  submit(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: any) {
    return this.bank.submit(user, file, body);
  }

  @Get("payments/:id/receipt")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  receipt(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.bank.ownReceiptUrl(user, Number(id));
  }
}

@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/billing/bank-transfers")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class BankTransferAdminController {
  constructor(private readonly bank: BankTransferService) {}

  /** `?status=review` (default) | paid | rejected | all. */
  @Get()
  list(@Query("status") status?: string) {
    return this.bank.list(status);
  }

  @Get(":id/receipt")
  receipt(@Param("id") id: string) {
    return this.bank.adminReceiptUrl(Number(id));
  }

  @Post(":id/approve")
  approve(@CurrentUser() admin: AuthUser, @Param("id") id: string) {
    return this.bank.approve(admin, Number(id));
  }

  @Post(":id/reject")
  reject(@CurrentUser() admin: AuthUser, @Param("id") id: string, @Body() body: any) {
    return this.bank.reject(admin, Number(id), String(body?.reason || ""));
  }
}

@Module({
  imports: [SubscriptionModule, LimitsModule],
  controllers: [BankTransferController, BankTransferAdminController],
  providers: [BankTransferService],
})
export class BankTransferModule {}
