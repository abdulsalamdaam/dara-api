import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { accountLimitEventsTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { effectiveLimit, type LimitKey } from "../../common/limits";
import { setLimitRefusedHandler } from "./limits-signals";

/** Without a usable period start, "this period" for the dedupe is the last 30 days. */
const FALLBACK_PERIOD_MS = 30 * 86_400_000;

export type LimitReachedOutcome = "recorded" | "not_account" | "already_recorded";

/**
 * When the seat gate or the Ejar quota gate refuses an account, record a
 * `limit_reached` event in the audit log so the admin sees which accounts
 * keep hitting their limits and can grant / invoice / offer an add-on.
 *
 * Add-ons come ONLY from the admin: this never creates an offer and never
 * emails the customer. At most one event per account and key per paid period
 * (deduped under the account row lock). Fire-and-forget from the gate via
 * signalLimitRefused — never on the gate's request path.
 */
@Injectable()
export class LimitsReachedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("LimitsReached");

  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  onModuleInit(): void {
    setLimitRefusedHandler((accountId, key) => {
      void this.recordLimitReached(accountId, key).catch((err) => this.log.warn(`limit_reached failed: ${err?.message ?? err}`));
    });
  }

  onModuleDestroy(): void {
    setLimitRefusedHandler(null);
  }

  async recordLimitReached(accountId: number, key: LimitKey, now = new Date()): Promise<LimitReachedOutcome> {
    return this.db.transaction(async (raw) => {
      const tx = raw as unknown as Drizzle;
      await tx.execute(sql`select id from users where id = ${accountId} for update`);
      const [u] = await tx.select({
        ownerUserId: usersTable.ownerUserId, deletedAt: usersTable.deletedAt, subscriptionStartedAt: usersTable.subscriptionStartedAt,
      }).from(usersTable).where(eq(usersTable.id, accountId)).limit(1);
      if (!u || u.deletedAt || u.ownerUserId != null) return "not_account" as const;
      const start = u.subscriptionStartedAt && new Date(u.subscriptionStartedAt) <= now
        ? new Date(u.subscriptionStartedAt) : new Date(now.getTime() - FALLBACK_PERIOD_MS);
      const [prior] = await tx.select({ id: accountLimitEventsTable.id }).from(accountLimitEventsTable).where(and(
        eq(accountLimitEventsTable.accountId, accountId),
        eq(accountLimitEventsTable.source, "limit_reached"),
        eq(accountLimitEventsTable.limitKey, key),
        gte(accountLimitEventsTable.createdAt, start),
      )).limit(1);
      if (prior) return "already_recorded" as const;
      const l = await effectiveLimit(tx, accountId, key, now);
      await tx.insert(accountLimitEventsTable).values({
        accountId, actorUserId: null, actorKind: "system", source: "limit_reached", limitKey: key,
        oldValue: l.effective, newValue: l.effective, note: null, meta: { used: l.used },
      });
      return "recorded" as const;
    });
  }
}
