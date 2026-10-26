import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { companiesTable, subscriptionPaymentsTable, usersTable, type AccountLimitAddon } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { amountInclVat } from "../../common/addon-catalog";
import { LIMIT_KEYS, isLimitKey } from "../../common/limits";
import { EmailService, BILLING_PAGE_URL, type LimitAddonItem } from "../email/email.service";
import { AddonCatalogService } from "./addon-catalog.service";
import type { AddonPaymentResult, LimitsChangedNotice, LimitsNotifier } from "./limits-billing.port";
import { setLimitAddonPaidHandler } from "./limits-signals";
import { EJAR_ADDON_LABEL_AR, EJAR_ADDON_LABEL_EN } from "./limits-billing.service";

/**
 * LIMITS_NOTIFIER: the account-limit emails. Every message goes to the
 * ACCOUNT HOLDER's own address (never an employee, never a third party);
 * sending is best-effort — EmailService never throws and a failure is logged.
 */
@Injectable()
export class LimitsEmailNotifier implements LimitsNotifier, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("LimitsNotifier");

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
    private readonly catalog: AddonCatalogService,
  ) {}

  onModuleInit(): void {
    // The paid invoice email is the customer-facing message for a purchase;
    // the signal is only a breadcrumb here.
    setLimitAddonPaidHandler((addonId) => this.log.log(`add-on ${addonId} paid and active`));
  }

  onModuleDestroy(): void {
    setLimitAddonPaidHandler(null);
  }

  /** The account holder's address and the name to greet. */
  async recipient(accountId: number): Promise<{ to: string; name: string } | null> {
    const [u] = await this.db.select({
      email: usersTable.email, name: usersTable.name, companyId: usersTable.companyId, ownerUserId: usersTable.ownerUserId,
    }).from(usersTable).where(eq(usersTable.id, accountId)).limit(1);
    if (!u?.email || u.ownerUserId != null) return null;
    let name = u.name ?? "";
    if (u.companyId) {
      const [c] = await this.db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, u.companyId)).limit(1);
      name = c?.name || name;
    }
    return { to: u.email, name };
  }

  /** How an add-on reads in an email: the catalog item's label, else the limit's. */
  async item(addon: Pick<AccountLimitAddon, "limitKey" | "quantity" | "catalogKey">): Promise<LimitAddonItem> {
    // No lookup count for an Ejar pack: customers are never told the number.
    if (addon.limitKey === "ejar_lookups") return { labelAr: EJAR_ADDON_LABEL_AR, labelEn: EJAR_ADDON_LABEL_EN, quantity: null };
    const entry = addon.catalogKey ? await this.catalog.find(addon.catalogKey) : null;
    if (entry && entry.quantity > 0 && addon.quantity % entry.quantity === 0) {
      return { labelAr: entry.labelAr, labelEn: entry.labelEn, quantity: addon.quantity / entry.quantity };
    }
    const def = isLimitKey(addon.limitKey) ? LIMIT_KEYS[addon.limitKey] : null;
    return { labelAr: def?.labelAr ?? addon.limitKey, labelEn: def?.labelEn ?? addon.limitKey, quantity: addon.quantity };
  }

  async limitsChanged(n: LimitsChangedNotice): Promise<void> {
    const r = await this.recipient(n.accountId);
    if (!r) return;
    const def = isLimitKey(n.limitKey) ? LIMIT_KEYS[n.limitKey] : null;
    if (!def) return;
    const ok = await this.email.sendLimitsChanged(r.to, r.name, {
      // The Ejar allowance is never shown to a customer: say it changed, not to what.
      changes: [{
        labelAr: def.labelAr, labelEn: def.labelEn, oldValue: n.oldValue, newValue: n.newValue,
        ...(n.limitKey === "ejar_lookups" ? { hideValues: true } : {}),
      }],
      note: n.note,
    });
    if (!ok) this.log.warn(`limits-changed email to account ${n.accountId} not sent`);
  }

  async addonOffered(addon: AccountLimitAddon, payment: AddonPaymentResult): Promise<void> {
    const r = await this.recipient(addon.accountId);
    if (!r) return;
    let amount: number | null = null;
    if (payment.paymentId != null) {
      const [row] = await this.db.select({ amount: subscriptionPaymentsTable.amount })
        .from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.id, payment.paymentId)).limit(1);
      amount = row ? Number(row.amount) : null;
    }
    if (amount == null) amount = amountInclVat(addon.priceSar == null ? null : Number(addon.priceSar));
    const ok = await this.email.sendLimitAddonOffer(r.to, r.name, {
      items: [await this.item(addon)],
      amountInclVat: amount,
      payUrl: BILLING_PAGE_URL,
      expiresAt: addon.offerExpiresAt ? new Date(addon.offerExpiresAt) : null,
      note: addon.source === "self_serve" ? null : addon.note,
    });
    if (!ok) this.log.warn(`add-on offer email for add-on ${addon.id} not sent`);
  }

  /** Housekeeping: an add-on ran out. */
  async addonExpired(addon: AccountLimitAddon): Promise<void> {
    const r = await this.recipient(addon.accountId);
    if (!r) return;
    const ok = await this.email.sendLimitAddonExpired(r.to, r.name, {
      items: [await this.item(addon)],
      endedAt: addon.endsAt ? new Date(addon.endsAt) : new Date(),
    });
    if (!ok) this.log.warn(`add-on expiry email for add-on ${addon.id} not sent`);
  }
}
