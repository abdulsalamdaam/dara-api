import { Inject, Injectable, Logger } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "./db";
import { appLog } from "../../common/logging/app-log.service";
import { currentRequestContext, type RequestContext } from "../../common/request-context";
import { planHasFeature, planKeysWithout } from "../../common/plan-features";

export type AccountingMode = "owner" | "manager";

export interface FlagState {
  /** EFFECTIVE: the stored flag AND the account plan includes `accounting`. What every consumer acts on. */
  on: boolean;
  mode: AccountingMode | null;
  ledgerStartedAt: Date | null;
  /** The stored `finance_settings.finance_v2_enabled`, untouched by plan changes (admin views only). */
  flagOn: boolean;
  /** The account owner's plan does not include `accounting` (common/plan-features.ts). */
  planLocked: boolean;
}

const OFF: FlagState = Object.freeze({ on: false, mode: null, ledgerStartedAt: null, flagOn: false, planLocked: false }) as FlagState;

/** Locked plan keys as a SQL literal list — fixed constants from packages.ts, never user input. */
const LOCKED_PLAN_SQL = planKeysWithout("accounting").map((k) => `'${k.replace(/'/g, "''")}'`).join(", ");

/**
 * SQL predicate: the account in column `accountCol` is ENTITLED to Finance v2
 * by its plan (`users.package_plan` of the account holder). For the
 * background jobs that pick accounts straight from `finance_settings`: add
 * `and ${fv2PlanEntitledSql("s.account_user_id")}` next to
 * `finance_v2_enabled`, so they skip exactly the accounts `FinanceFlagService`
 * reads as off. A null/unknown plan stays entitled (DEFAULT_PACKAGE).
 */
export function fv2PlanEntitledSql(accountCol: string): string {
  if (!LOCKED_PLAN_SQL) return "true";
  return `coalesce((select pu.package_plan from users pu where pu.id = ${accountCol}), '') not in (${LOCKED_PLAN_SQL})`;
}
const TTL_MS = 15_000;
const LOG_EVERY_MS = 60_000;

/** Thrown by `stateStrict` when the flag cannot be read and nothing is cached (v2 routes answer 503). */
export class FlagUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`finance_v2 flag unavailable: ${(cause as Error)?.message ?? cause}`);
  }
}

/**
 * Reads the per-account `finance_v2` flag (DESIGN §1.2) — the single choke
 * point every consumer asks (the `/finance/v2/*` guard, `/status`, the legacy
 * forks via FinanceV2Hooks.resolve, reminders). `on` is EFFECTIVE:
 * `finance_v2_enabled && planHasFeature(ownerPlan, "accounting")`. The stored
 * flag is never written by a plan change; a downgrade reads off, an upgrade
 * reads the stored value again (the nightly catch-up fills the gap).
 * Background jobs that list accounts in SQL use `fv2PlanEntitledSql`.
 *
 *  - Reads through the POOL, never a caller's transaction: a failing read
 *    (say the table is missing) inside a transaction would abort it, and a
 *    broken flag table must never abort a legacy write.
 *  - In-process cache, 15 s TTL; the admin toggle invalidates its entry.
 *  - Stale-if-error: on a read error it returns the last cached state however
 *    old. A scope never read successfully reads OFF (fail-closed). A missing
 *    `finance_settings` table (0066 failed at boot) is not an error: it IS off.
 *  - Per-request memo: within one request (the AsyncLocalStorage request
 *    context) the first answer is reused, so a handler that asks twice can
 *    never see the flag flip mid-request. Handlers still resolve once at entry
 *    and pass the boolean down (`ctx.fv2`).
 */
@Injectable()
export class FinanceFlagService {
  private readonly log = new Logger("FinanceFlag");
  private readonly cache = new Map<number, { state: FlagState; at: number }>();
  private readonly perRequest = new WeakMap<RequestContext, Map<number, FlagState>>();
  private lastErrorLogAt = 0;
  /** Injectable clock, for the TTL spec. */
  now: () => number = () => Date.now();

  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  /** Is finance_v2 on for this account scope? Never throws. */
  async isOn(scopeUserId: number): Promise<boolean> {
    return (await this.state(scopeUserId)).on;
  }

  /** Alias used by fork lines: `const fv2 = await this.fv2.resolve(scopeId(user))`. */
  resolve(scopeUserId: number): Promise<boolean> {
    return this.isOn(scopeUserId);
  }

  /** The flag state; stale-if-error, never throws. */
  async state(scopeUserId: number): Promise<FlagState> {
    try {
      return await this.stateStrict(scopeUserId);
    } catch (err) {
      if (err instanceof FlagUnavailableError) return OFF;
      throw err;
    }
  }

  /**
   * As `state`, but throws FlagUnavailableError when the read fails and there
   * is no cached value to fall back on. For `/finance/v2/*` routes, which must
   * answer 503 rather than guess.
   */
  async stateStrict(scopeUserId: number): Promise<FlagState> {
    const rc = currentRequestContext();
    const memo = rc ? this.perRequest.get(rc) : undefined;
    const hit = memo?.get(scopeUserId);
    if (hit) return hit;

    const state = await this.readCached(scopeUserId);
    if (rc) {
      let m = this.perRequest.get(rc);
      if (!m) this.perRequest.set(rc, (m = new Map()));
      m.set(scopeUserId, state);
    }
    return state;
  }

  /** Drop the cached entry (the admin toggle calls this after its commit). */
  invalidate(scopeUserId: number): void {
    this.cache.delete(scopeUserId);
  }

  private async readCached(scopeUserId: number): Promise<FlagState> {
    const c = this.cache.get(scopeUserId);
    const now = this.now();
    if (c && now - c.at < TTL_MS) return c.state;
    try {
      const state = await this.read(scopeUserId);
      this.cache.set(scopeUserId, { state, at: now });
      return state;
    } catch (err) {
      this.logError(scopeUserId, err);
      if (c) return c.state;           // stale-if-error, however old
      throw new FlagUnavailableError(err);
    }
  }

  /**
   * Primary-key lookups: the settings row and the account holder's plan. A
   * missing settings row or table means off (the plan is still read, so
   * `/status` can say whether the plan is what keeps it off).
   */
  protected async read(scopeUserId: number): Promise<FlagState> {
    let row: any;
    try {
      const r = await this.pool.query(
        `select fs.finance_v2_enabled as on, fs.accounting_mode as mode, fs.ledger_started_at as started, u.package_plan as plan
           from (select $1::int as id) k
           left join finance_settings fs on fs.account_user_id = k.id
           left join users u on u.id = k.id`,
        [scopeUserId],
      );
      row = r.rows[0] ?? {};
    } catch (err: any) {
      if (err?.code !== "42P01") throw err; // undefined_table: Finance v2 not installed
      // Off either way; the plan only feeds `planLocked`, so its read failing is not an error.
      const plan = await this.pool.query(`select package_plan as plan from users where id = $1`, [scopeUserId]).then((r) => r.rows[0]?.plan ?? null, () => null);
      row = { plan };
    }
    const flagOn = row.on === true;
    const planLocked = !planHasFeature(row.plan ?? null, "accounting");
    return { on: flagOn && !planLocked, mode: row.mode ?? null, ledgerStartedAt: row.started ?? null, flagOn, planLocked };
  }

  private logError(scopeUserId: number, err: unknown): void {
    const now = this.now();
    if (now - this.lastErrorLogAt < LOG_EVERY_MS) return;
    this.lastErrorLogAt = now;
    const message = (err as Error)?.message ?? String(err);
    this.log.warn(`finance_v2 flag read failed (scope ${scopeUserId}): ${message}`);
    try {
      appLog()?.record({ level: "warn", event: "finance_v2.flag_read_failed", ownerUserId: scopeUserId, message, error: err });
    } catch {
      /* logging must never throw */
    }
  }
}
