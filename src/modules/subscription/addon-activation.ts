import { Logger } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import { accountLimitAddonsTable, accountLimitEventsTable, subscriptionPaymentsTable, usersTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { effectiveLimit, isLimitKey } from "../../common/limits";
import { signalLimitAddonPaid } from "../limits/limits-signals";
import type { SubscriptionInvoiceService } from "./subscription-invoice.service";

type SubscriptionPaymentRow = typeof subscriptionPaymentsTable.$inferSelect;

const log = new Logger("AddonActivation");

/**
 * The kind='addon' branch of `activateFromPaidRow`: a verified payment for an
 * account-limit add-on.
 *
 * Claims the row paid with the same conditional UPDATE the subscription path
 * uses (so the webhook, /sync, the pay self-heal and housekeeping can race and
 * exactly one wins), then activates the add-on and logs an `addon_purchase`
 * event with the effective limit before/after.
 *
 * It NEVER touches `users.package_plan`, the billing cycle or the subscription
 * period — an add-on payment is not a subscription payment.
 *
 * The add-on runs from now to its explicit end, or to the end of the current
 * subscription period (seats and Ejar packs alike are valid to period end).
 * A payment that lands for an add-on that was meanwhile cancelled (an expired
 * offer whose invoice was paid in the same minute) still activates it: the
 * money moved, so the customer gets what they paid for.
 */
export async function activateAddonFromPaidRow(
  db: Drizzle,
  row: SubscriptionPaymentRow,
  paid: { moyasarPaymentId?: string | null; paidAt?: Date | null } = {},
  invoices?: SubscriptionInvoiceService,
): Promise<boolean> {
  if (row.status === "paid") return false;
  const [claimed] = await db.update(subscriptionPaymentsTable)
    .set({ status: "paid", paidAt: paid.paidAt ?? new Date(), moyasarPaymentId: paid.moyasarPaymentId ?? row.moyasarPaymentId ?? null })
    .where(and(eq(subscriptionPaymentsTable.id, row.id), ne(subscriptionPaymentsTable.status, "paid")))
    .returning({ id: subscriptionPaymentsTable.id });
  if (!claimed) return false;

  const now = new Date();
  let periodEnd: Date | null = null;
  let addonId: number | null = row.addonId ?? null;
  try {
    const res = await db.transaction(async (raw) => {
      const tx = raw as unknown as Drizzle;
      await tx.execute(sql`select id from users where id = ${row.userId} for update`);
      const [addon] = row.addonId == null ? [] : await tx.select().from(accountLimitAddonsTable)
        .where(and(eq(accountLimitAddonsTable.id, row.addonId), eq(accountLimitAddonsTable.accountId, row.userId))).limit(1);
      if (!addon || !isLimitKey(addon.limitKey)) return null;
      const [acct] = await tx.select({ subscriptionEndsAt: usersTable.subscriptionEndsAt })
        .from(usersTable).where(eq(usersTable.id, row.userId)).limit(1);
      const before = (await effectiveLimit(tx, row.userId, addon.limitKey)).effective;
      const explicitEnd = addon.endsAt && new Date(addon.endsAt) > now ? new Date(addon.endsAt) : null;
      const endsAt = addon.status === "active"
        ? (addon.endsAt ? new Date(addon.endsAt) : null)
        : explicitEnd ?? (acct?.subscriptionEndsAt ? new Date(acct.subscriptionEndsAt) : null);
      if (addon.status !== "active") {
        await tx.update(accountLimitAddonsTable)
          .set({ status: "active", startsAt: now, endsAt, paymentId: row.id })
          .where(eq(accountLimitAddonsTable.id, addon.id));
      }
      const after = (await effectiveLimit(tx, row.userId, addon.limitKey)).effective;
      await tx.insert(accountLimitEventsTable).values({
        accountId: row.userId, actorUserId: null, actorKind: "system", source: "addon_purchase", limitKey: addon.limitKey,
        oldValue: before, newValue: after, addonId: addon.id, paymentId: row.id,
        note: row.description ?? null,
        meta: { paid: true, from: addon.status, quantity: addon.quantity, amount: row.amount },
      });
      return { addonId: addon.id, endsAt };
    });
    if (!res) {
      log.error(`add-on payment ${row.id} is paid but its add-on ${row.addonId} was not found for account ${row.userId}`);
    } else {
      addonId = res.addonId;
      periodEnd = res.endsAt;
    }
  } catch (err: any) {
    // The row is paid either way; the admin console shows the add-on and can activate it.
    log.error(`add-on payment ${row.id}: activating add-on ${row.addonId} failed: ${err?.message || err}`);
  }

  // The invoice (SUB- numbering, add-on description), fire-and-forget like the subscription path.
  if (invoices) {
    void invoices.issueAndEmail(db, row.id, { start: now, end: periodEnd ?? now });
  }
  signalLimitAddonPaid(addonId);
  return true;
}
