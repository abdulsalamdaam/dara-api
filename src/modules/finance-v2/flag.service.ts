import { Inject, Injectable, Logger } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "./db";
import { appLog } from "../../common/logging/app-log.service";
import { currentRequestContext, type RequestContext } from "../../common/request-context";

export type AccountingMode = "owner" | "manager";

export interface FlagState {
  on: boolean;
  mode: AccountingMode | null;
  ledgerStartedAt: Date | null;
}

const OFF: FlagState = Object.freeze({ on: false, mode: null, ledgerStartedAt: null }) as FlagState;
const TTL_MS = 15_000;
const LOG_EVERY_MS = 60_000;

/** Thrown by `stateStrict` when the flag cannot be read and nothing is cached (v2 routes answer 503). */
export class FlagUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`finance_v2 flag unavailable: ${(cause as Error)?.message ?? cause}`);
  }
}

/**
 * Reads the per-account `finance_v2` flag (DESIGN §1.2).
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

  /** One primary-key lookup. A missing table means Finance v2 is not installed: off. */
  protected async read(scopeUserId: number): Promise<FlagState> {
    try {
      const r = await this.pool.query(
        `select finance_v2_enabled as on, accounting_mode as mode, ledger_started_at as started
           from finance_settings where account_user_id = $1`,
        [scopeUserId],
      );
      const row = r.rows[0];
      if (!row) return OFF;
      return { on: row.on === true, mode: row.mode ?? null, ledgerStartedAt: row.started ?? null };
    } catch (err: any) {
      if (err?.code === "42P01") return OFF; // undefined_table
      throw err;
    }
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
