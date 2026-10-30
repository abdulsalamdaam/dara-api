import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountLimitAddonsTable, accountLimitEventsTable, accountLimitOverridesTable, subscriptionPaymentsTable, usersTable,
  type AccountLimitAddon, type LimitEventSource,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { EJAR_ENABLED_KEY, effectiveLimit, effectiveLimits, isLimitKey, type LimitKey } from "../../common/limits";
import { amountInclVat } from "../../common/addon-catalog";
import { accountEjarAccessMode, accountEjarMode, ejarDenialFor, ejarEnvMode, type EjarAccountMode } from "../ejar/ejar.access";
import { AddonCatalogService } from "./addon-catalog.service";
import {
  LIMITS_BILLING_PORT, LIMITS_NOTIFIER, NoopLimitsBillingPort, NoopLimitsNotifier,
  type AddonPaymentResult, type LimitsBillingPort, type LimitsNotifier,
} from "./limits-billing.port";
import type {
  AddonMode, AddonView, AdminLimitsView, CreateAddonInput, LimitEvent, LimitsActor, OverrideView,
} from "./limits.types";

/** A transaction handle, typed as the db (every helper here takes either). */
type Tx = Drizzle;

/** Largest finite limit an admin may set. */
export const MAX_LIMIT_VALUE = 100_000;
/** How long an admin offer stays open when no date is given. */
export const DEFAULT_OFFER_DAYS = 14;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/** A required, trimmed note (every admin write carries one — it is the audit's "why"). */
export function requireNote(raw: unknown): string {
  const note = typeof raw === "string" ? raw.trim() : "";
  if (!note) throw new BadRequestException("note is required");
  return note.slice(0, 1000);
}

/** An override value: a non-negative integer, or null = unlimited. */
export function parseLimitValue(raw: unknown): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(n) || n < 0 || n > MAX_LIMIT_VALUE) {
    throw new BadRequestException(`value must be an integer 0–${MAX_LIMIT_VALUE}, or null for unlimited`);
  }
  return n;
}

/** Validate the admin add-on body. Price/catalog resolution happens in the service. */
export function parseCreateAddon(body: any): CreateAddonInput {
  if (!isLimitKey(body?.limitKey)) throw new BadRequestException("limitKey must be users | landlords | ejar_lookups");
  const quantity = Number(body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LIMIT_VALUE) {
    throw new BadRequestException(`quantity must be an integer 1–${MAX_LIMIT_VALUE}`);
  }
  const mode = body?.mode as AddonMode;
  if (mode !== "free" && mode !== "invoice" && mode !== "offer") throw new BadRequestException("mode must be free | invoice | offer");
  let priceSar: number | null = null;
  if (body?.priceSar != null && body.priceSar !== "") {
    const p = Number(body.priceSar);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000) throw new BadRequestException("priceSar must be ≥ 0");
    priceSar = Math.round(p * 100) / 100;
  }
  const period = body?.period === "one_off" ? "one_off" : body?.period === "subscription_period" || body?.period == null ? "subscription_period" : null;
  if (!period) throw new BadRequestException("period must be subscription_period | one_off");
  let endsAt: Date | null = null;
  if (body?.endsAt != null && body.endsAt !== "") {
    endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw new BadRequestException("endsAt is not a date");
    if (endsAt.getTime() <= Date.now()) throw new BadRequestException("endsAt must be in the future");
  }
  const activation = body?.activation === "immediate" ? "immediate" : body?.activation == null || body.activation === "on_payment" ? "on_payment" : null;
  if (!activation) throw new BadRequestException("activation must be on_payment | immediate");
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
  return {
    limitKey: body.limitKey, quantity, mode,
    catalogKey: typeof body?.catalogKey === "string" && body.catalogKey ? body.catalogKey : null,
    priceSar, period, endsAt,
    // A free grant is always immediate; an offer always waits for payment.
    activation: mode === "free" ? "immediate" : mode === "offer" ? "on_payment" : activation,
    note,
    notify: body?.notify === undefined ? true : body.notify === true,
  };
}

/**
 * Account limits: admin overrides, add-ons, the Ejar switch, and the audit
 * trail. Every write is ONE transaction — lock the account row, read the
 * effective value, change, read it again, write an `account_limit_events` row
 * with old/new — so the log can never disagree with what the gates saw.
 *
 * Exported for the customer side (Agent B): `createAddon` with actor kind
 * `customer` + source `self_serve`, `recordEvent`, `addonViews`, `activeNotices`.
 */
@Injectable()
export class LimitsService {
  private readonly log = new Logger("Limits");

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly catalog: AddonCatalogService,
    @Optional() @Inject(LIMITS_BILLING_PORT) private readonly billing: LimitsBillingPort = new NoopLimitsBillingPort(),
    @Optional() @Inject(LIMITS_NOTIFIER) private readonly notifier: LimitsNotifier = new NoopLimitsNotifier(),
  ) {}

  /* ── reads ─────────────────────────────────────────────────────────── */

  /** The customer account (top-level, not staff). 404 otherwise. */
  async assertAccount(accountId: number, db: Tx = this.db): Promise<{ id: number; subscriptionEndsAt: Date | null }> {
    const [row] = await db
      .select({ id: usersTable.id, ownerUserId: usersTable.ownerUserId, subscriptionEndsAt: usersTable.subscriptionEndsAt, deletedAt: usersTable.deletedAt })
      .from(usersTable).where(eq(usersTable.id, accountId)).limit(1);
    if (!row || row.deletedAt) throw new NotFoundException("Account not found");
    if (row.ownerUserId != null) throw new BadRequestException("Limits belong to the account holder, not an employee");
    return { id: row.id, subscriptionEndsAt: row.subscriptionEndsAt ?? null };
  }

  async adminView(accountId: number): Promise<AdminLimitsView> {
    await this.assertAccount(accountId);
    const [limits, overrides, addons, mode, accessMode, events] = await Promise.all([
      effectiveLimits(this.db, accountId),
      this.overrides(accountId),
      this.addonViews(accountId),
      accountEjarMode(this.db, accountId),
      // The switch plus the subscription (paid → on, trial → off) — what the account actually gets.
      accountEjarAccessMode(this.db, accountId),
      this.events(accountId, 1, 50).then((r) => r.items),
    ]);
    return {
      limits, overrides, addons,
      ejar: { mode, envMode: ejarEnvMode(), effective: ejarDenialFor(accessMode, null) == null },
      events,
    };
  }

  async overrides(accountId: number): Promise<OverrideView[]> {
    const rows = await this.db.select().from(accountLimitOverridesTable)
      .where(eq(accountLimitOverridesTable.accountId, accountId))
      .orderBy(accountLimitOverridesTable.limitKey);
    return rows.map((r) => ({ limitKey: r.limitKey, value: r.value ?? null, note: r.note, setBy: r.setBy ?? null, updatedAt: iso(r.updatedAt)! }));
  }

  /** Every add-on of the account, newest first, with its payment's amount and URL. */
  async addonViews(accountId: number, opts: { statuses?: string[] } = {}): Promise<AddonView[]> {
    const where = opts.statuses?.length
      ? and(eq(accountLimitAddonsTable.accountId, accountId), inArray(accountLimitAddonsTable.status, opts.statuses as never))
      : eq(accountLimitAddonsTable.accountId, accountId);
    const rows = await this.db
      .select({ a: accountLimitAddonsTable, payAmount: subscriptionPaymentsTable.amount, payUrl: subscriptionPaymentsTable.paymentUrl, payStatus: subscriptionPaymentsTable.status })
      .from(accountLimitAddonsTable)
      .leftJoin(subscriptionPaymentsTable, eq(subscriptionPaymentsTable.id, accountLimitAddonsTable.paymentId))
      .where(where)
      .orderBy(desc(accountLimitAddonsTable.createdAt), desc(accountLimitAddonsTable.id));
    return rows.map(({ a, payAmount, payUrl, payStatus }) => toAddonView(a, { amount: payAmount, url: payUrl, status: payStatus }));
  }

  async events(accountId: number, page = 1, pageSize = 50): Promise<{ items: LimitEvent[]; total: number }> {
    const size = Math.min(Math.max(1, Math.floor(pageSize) || 50), 200);
    const p = Math.min(Math.max(1, Math.floor(page) || 1), 100_000);
    const [rows, [tot]] = await Promise.all([
      this.db
        .select({ e: accountLimitEventsTable, actorName: usersTable.name })
        .from(accountLimitEventsTable)
        .leftJoin(usersTable, eq(usersTable.id, accountLimitEventsTable.actorUserId))
        .where(eq(accountLimitEventsTable.accountId, accountId))
        .orderBy(desc(accountLimitEventsTable.createdAt), desc(accountLimitEventsTable.id))
        .limit(size).offset((p - 1) * size),
      this.db.select({ c: count() }).from(accountLimitEventsTable).where(eq(accountLimitEventsTable.accountId, accountId)),
    ]);
    return {
      items: rows.map(({ e, actorName }) => ({
        id: e.id, actorKind: e.actorKind, actorName: actorName ?? null, source: e.source, limitKey: e.limitKey,
        oldValue: e.oldValue ?? null, newValue: e.newValue ?? null, note: e.note ?? null, createdAt: iso(e.createdAt)!,
      })),
      total: Number(tot?.c ?? 0),
    };
  }

  /* ── writes ────────────────────────────────────────────────────────── */

  /** Serialise writes per account and confirm it is a customer account. */
  private async lockAccount(tx: Tx, accountId: number) {
    await tx.execute(sql`select id from users where id = ${accountId} for update`);
    return this.assertAccount(accountId, tx);
  }

  /** One audit row. `tx` is the write's own transaction. */
  async recordEvent(tx: Tx, e: {
    accountId: number; actor: LimitsActor; source: LimitEventSource; limitKey: string;
    oldValue: number | null; newValue: number | null; addonId?: number | null; paymentId?: number | null;
    note?: string | null; meta?: Record<string, unknown> | null;
  }): Promise<void> {
    await tx.insert(accountLimitEventsTable).values({
      accountId: e.accountId, actorUserId: e.actor.userId, actorKind: e.actor.kind, source: e.source, limitKey: e.limitKey,
      oldValue: e.oldValue, newValue: e.newValue, addonId: e.addonId ?? null, paymentId: e.paymentId ?? null,
      note: e.note ?? null, meta: e.meta ?? null,
    });
  }

  /**
   * Set (or clear) the admin override of one limit. `value` null = unlimited.
   * Survives renewals and package changes. Lowering below usage deletes
   * nothing — the gates just refuse adding.
   */
  async setOverride(
    accountId: number, key: LimitKey,
    input: { value: number | null; clear: boolean; note: string; notify?: boolean },
    actor: LimitsActor,
  ): Promise<{ oldValue: number | null; newValue: number | null }> {
    const res = await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      await this.lockAccount(tx, accountId);
      const before = (await effectiveLimit(tx, accountId, key)).effective;
      if (input.clear) {
        await tx.delete(accountLimitOverridesTable)
          .where(and(eq(accountLimitOverridesTable.accountId, accountId), eq(accountLimitOverridesTable.limitKey, key)));
      } else {
        await this.upsertOverride(tx, accountId, key, input.value, input.note, actor.userId);
      }
      const after = (await effectiveLimit(tx, accountId, key)).effective;
      await this.recordEvent(tx, {
        accountId, actor, source: "admin_override", limitKey: key, oldValue: before, newValue: after, note: input.note,
        meta: { override: input.clear ? "cleared" : input.value },
      });
      return { oldValue: before, newValue: after };
    });
    const notify = input.notify ?? isIncrease(res.oldValue, res.newValue);
    if (notify && res.oldValue !== res.newValue) {
      await this.safeNotify(() => this.notifier.limitsChanged({ accountId, limitKey: key, ...res, note: input.note, source: "admin_override" }));
    }
    return res;
  }

  /** The per-account Ejar switch: default (no row) / enabled (1) / disabled (0). */
  async setEjarAccess(accountId: number, mode: EjarAccountMode, note: string, actor: LimitsActor): Promise<void> {
    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      await this.lockAccount(tx, accountId);
      const before = await accountEjarMode(tx, accountId);
      if (mode === "default") {
        await tx.delete(accountLimitOverridesTable)
          .where(and(eq(accountLimitOverridesTable.accountId, accountId), eq(accountLimitOverridesTable.limitKey, EJAR_ENABLED_KEY)));
      } else {
        await this.upsertOverride(tx, accountId, EJAR_ENABLED_KEY, mode === "enabled" ? 1 : 0, note, actor.userId);
      }
      const val = (m: EjarAccountMode) => (m === "enabled" ? 1 : m === "disabled" ? 0 : null);
      await this.recordEvent(tx, {
        accountId, actor, source: "ejar_toggle", limitKey: EJAR_ENABLED_KEY,
        oldValue: val(before), newValue: val(mode), note, meta: { from: before, to: mode },
      });
    });
  }

  /**
   * Create an add-on.
   *  - free:    active now (immediate), source admin_free, event addon_grant.
   *  - invoice: pending_payment (or active now with activation=immediate),
   *             source admin_invoice; a payment is opened via the billing port.
   *  - offer:   offered, source admin_offer, expires after DEFAULT_OFFER_DAYS;
   *             a payment is opened via the billing port.
   * A self-serve purchase (customer side) is `mode: "invoice"` with
   * `opts.source = "self_serve"` and a customer actor.
   * Add-ons end with the current subscription period unless `endsAt` is given.
   */
  async createAddon(
    accountId: number, input: CreateAddonInput, actor: LimitsActor,
    opts: { source?: "admin_free" | "admin_invoice" | "admin_offer" | "self_serve" } = {},
  ): Promise<{ addon: AccountLimitAddon; payment: AddonPaymentResult }> {
    let priceSar = input.priceSar;
    let catalogKey = input.catalogKey;
    if (catalogKey) {
      const item = await this.catalog.find(catalogKey);
      if (!item) throw new BadRequestException(`unknown catalogKey ${catalogKey}`);
      if (item.limitKey !== input.limitKey) throw new BadRequestException(`catalog item ${catalogKey} is for ${item.limitKey}`);
      if (priceSar == null && item.priceSar != null) {
        // Catalog prices are per pack of `item.quantity`; scale to the quantity asked for.
        priceSar = Math.round((item.priceSar * input.quantity / item.quantity) * 100) / 100;
      }
    } else {
      catalogKey = null;
    }
    if (input.mode !== "free" && priceSar == null) {
      throw new BadRequestException("priceSar is required to invoice or offer an add-on (or a catalogKey with a price)");
    }
    const source = opts.source
      ?? (input.mode === "free" ? "admin_free" : input.mode === "offer" ? "admin_offer" : "admin_invoice");
    const activeNow = input.mode === "free" || (input.mode === "invoice" && input.activation === "immediate");
    const status = activeNow ? "active" : input.mode === "offer" ? "offered" : "pending_payment";

    const res = await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const acct = await this.lockAccount(tx, accountId);
      const before = (await effectiveLimit(tx, accountId, input.limitKey)).effective;
      const now = new Date();
      const endsAt = input.endsAt ?? acct.subscriptionEndsAt ?? null;
      const [addon] = await tx.insert(accountLimitAddonsTable).values({
        accountId, limitKey: input.limitKey, quantity: input.quantity, catalogKey, period: input.period,
        startsAt: activeNow ? now : null, endsAt: activeNow ? endsAt : input.endsAt,
        status, activation: input.activation, source,
        priceSar: input.mode === "free" ? null : priceSar == null ? null : String(priceSar),
        grantedBy: actor.userId, note: input.note,
        offerExpiresAt: input.mode === "offer" ? new Date(now.getTime() + DEFAULT_OFFER_DAYS * 86_400_000) : null,
      }).returning();
      const after = (await effectiveLimit(tx, accountId, input.limitKey)).effective;
      await this.recordEvent(tx, {
        accountId, actor, limitKey: input.limitKey, oldValue: before, newValue: after, addonId: addon!.id, note: input.note,
        source: input.mode === "offer" ? "addon_offer" : source === "self_serve" ? "addon_purchase" : "addon_grant",
        meta: { mode: input.mode, quantity: input.quantity, status, priceSar },
      });
      return { addon: addon!, before, after };
    });

    let payment: AddonPaymentResult = { paymentId: null, payUrl: null };
    let addon = res.addon;
    if (input.mode !== "free") {
      try {
        payment = await this.billing.createAddonPayment(addon);
        if (payment.paymentId != null) {
          [addon] = await this.db.update(accountLimitAddonsTable)
            .set({ paymentId: payment.paymentId })
            .where(eq(accountLimitAddonsTable.id, addon.id)).returning() as AccountLimitAddon[];
        }
      } catch (err: any) {
        // The add-on stays (pending, no payment); the admin can cancel and retry.
        this.log.warn(`add-on ${addon.id}: opening the payment failed: ${err?.message || err}`);
      }
    }
    if (input.notify) {
      if (res.after !== res.before) {
        await this.safeNotify(() => this.notifier.limitsChanged({
          accountId, limitKey: input.limitKey, oldValue: res.before, newValue: res.after, note: input.note, source, addonId: addon.id,
        }));
      }
      if (addon.status === "offered" || addon.status === "pending_payment") {
        await this.safeNotify(() => this.notifier.addonOffered(addon, payment));
      }
    }
    return { addon, payment };
  }

  /** Cancel an add-on that is offered, pending payment or active. Its pending payment is cancelled too. */
  async cancelAddon(accountId: number, addonId: number, note: string, actor: LimitsActor): Promise<AccountLimitAddon> {
    const res = await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      await this.lockAccount(tx, accountId);
      const [row] = await tx.select().from(accountLimitAddonsTable)
        .where(and(eq(accountLimitAddonsTable.id, addonId), eq(accountLimitAddonsTable.accountId, accountId))).limit(1);
      if (!row) throw new NotFoundException("Add-on not found");
      if (row.status === "cancelled" || row.status === "expired") throw new BadRequestException(`Add-on is already ${row.status}`);
      const before = (await effectiveLimit(tx, accountId, row.limitKey as LimitKey)).effective;
      const [updated] = await tx.update(accountLimitAddonsTable)
        .set({ status: "cancelled", note: row.note ? `${row.note}\n— ${note}` : note })
        .where(eq(accountLimitAddonsTable.id, addonId)).returning();
      const after = (await effectiveLimit(tx, accountId, row.limitKey as LimitKey)).effective;
      await this.recordEvent(tx, {
        accountId, actor, source: "addon_cancel", limitKey: row.limitKey, oldValue: before, newValue: after,
        addonId, paymentId: row.paymentId, note, meta: { from: row.status },
      });
      return { addon: updated!, prev: row, before, after };
    });
    if (res.prev.paymentId != null && res.prev.status !== "active") {
      try { await this.billing.cancelAddonPayment(res.addon); } catch (err: any) {
        this.log.warn(`add-on ${addonId}: cancelling its payment failed: ${err?.message || err}`);
      }
    }
    return res.addon;
  }

  private async upsertOverride(tx: Tx, accountId: number, key: string, value: number | null, note: string, setBy: number | null) {
    await tx.insert(accountLimitOverridesTable)
      .values({ accountId, limitKey: key, value, note, setBy })
      .onConflictDoUpdate({
        target: [accountLimitOverridesTable.accountId, accountLimitOverridesTable.limitKey],
        set: { value, note, setBy, updatedAt: sql`now()` },
      });
  }

  private async safeNotify(fn: () => Promise<void>) {
    try { await fn(); } catch (err: any) { this.log.warn(`limits notification failed: ${err?.message || err}`); }
  }
}

/** An increase (null = unlimited counts as the top). */
export function isIncrease(oldValue: number | null, newValue: number | null): boolean {
  if (newValue == null) return oldValue != null;
  if (oldValue == null) return false;
  return newValue > oldValue;
}

export function toAddonView(
  a: AccountLimitAddon, pay: { amount: string | null; url: string | null; status: string | null } = { amount: null, url: null, status: null },
): AddonView {
  const priceSar = num(a.priceSar);
  return {
    id: a.id,
    limitKey: a.limitKey as LimitKey,
    quantity: a.quantity,
    status: a.status,
    activation: a.activation,
    source: a.source,
    period: a.period,
    startsAt: iso(a.startsAt),
    endsAt: iso(a.endsAt),
    priceSar,
    amountInclVat: pay.amount != null ? Number(pay.amount) : amountInclVat(priceSar),
    paymentId: a.paymentId ?? null,
    payUrl: pay.status === "pending" ? pay.url ?? null : null,
    offerExpiresAt: iso(a.offerExpiresAt),
    note: a.note ?? null,
    createdAt: iso(a.createdAt)!,
  };
}
