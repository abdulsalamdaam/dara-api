import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { FinanceFlagService } from "./flag.service";
import { fv2PlanEntitledSql } from "./flag.service";
import { FinanceSetupService } from "./setup.service";
import { BackfillService, type BackfillSummary } from "./backfill/backfill.service";
import { LOCK_KEYS } from "./lock-keys";
import { settingsEvent } from "./audit";
import { riyadhToday } from "./dates";
import { toHalalas } from "./money";
import { STAFF_ROLE_KEYS } from "../../common/permissions";
import { setFv2EntitlementHandler } from "./auto-provision-signal";

/** 02:30 Riyadh: after the recognizer (00:10), before the nightly pg_dump (03:00) and the repair sweep (03:30). */
const SWEEP_AT_MIN = 2 * 60 + 30;
/** The sweep retries an auto-enabled account whose dry run was not clean at most once a day. */
const SWEEP_RETRY_HOURS = 20;
/** A trigger (or /status) retries such an account at most this often. */
const TRIGGER_RETRY_MINUTES = 10;
/** The actor recorded for automatic changes (the repair sweep's backfill runs use 0 too). */
export const AUTO_ACTOR = 0;
/**
 * Triggers that do NOT catch up an already-started ledger: the daily sweep (the
 * 03:30 repair sweep does that for every started account) and /status (only
 * signals accounts whose stored flag is off).
 */
const NO_CATCH_UP_TRIGGERS = new Set(["sweep", "status"]);
/** How many missing events a catch-up lists (the count is always exact). */
const CATCH_UP_LIST_CAP = 500;

export type CatchUpOutcome =
  | "would_post"            // dry run: `planned` would be posted
  | "up_to_date"            // nothing is missing (nothing written)
  | "caught_up"             // the missing events were posted
  | "caught_up_with_errors" // posted, but some rows failed or are pending (posting-errors list)
  | "not_eligible"          // the stored flag is off, the ledger has not started, or (automatic) the plan is not entitled
  | "busy"                  // another provisioning / catch-up holds this account right now
  | "error";                // the real catch-up run threw

export interface CatchUpResult {
  accountUserId: number;
  outcome: CatchUpOutcome;
  dryRun: boolean;
  /** Events issued before activation (or while the plan locked it) that are not in the ledger or the outbox. */
  missing: number;
  /** The first CATCH_UP_LIST_CAP of them, in posting order. */
  planned: Array<{ sourceType: string; sourceId: number; event: string; date: string; rule: string }>;
  runId?: number;
  entries?: number;
  detail?: string;
}

export type AutoAction = "provision" | "backfill";

export type AutoOutcome =
  | "started"              // enabled (now or before), dry run clean, real backfill ran: ledger_started_at set
  | "started_with_errors"  // as above, but the real run left failed/pending rows (posting-errors list)
  | "dry_run_not_clean"    // enabled, ledger NOT started: the dry run was unbalanced or had failures
  | "dry_run_error"        // enabled, ledger NOT started: the dry run threw
  | "not_eligible"         // not entitled / not a live customer account / admin turned it off / already started
  | "busy"                 // another trigger holds this account right now
  | "throttled"            // auto-enabled but not started, and retried too recently
  | "caught_up"            // already started: the documents issued while it was off were posted (catch-up)
  | "up_to_date";          // already started: nothing was missing

export interface AutoResult {
  accountUserId: number;
  outcome: AutoOutcome;
  provisioned: boolean;
  dryRunId?: number;
  realRunId?: number;
  detail?: string;
}

interface Candidate {
  id: number;
  action: AutoAction;
  lastAutoAt: Date | null;
}

export function fv2AutoProvisionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FINANCE_V2_AUTO_PROVISION_DISABLED === "1" || env.FINANCE_V2_WORKER_DISABLED === "1";
}

/** Clean = balanced, nothing failed, nothing left pending. Only then does a real backfill run. */
export function dryRunIsClean(s: Pick<BackfillSummary, "failed" | "pending" | "totals">): { clean: boolean; why: string } {
  const why: string[] = [];
  if (s.failed.length > 0) why.push(`${s.failed.length} failed`);
  if (s.pending > 0) why.push(`${s.pending} pending`);
  if (toHalalas(s.totals.debit) !== toHalalas(s.totals.credit)) why.push(`unbalanced (debit ${s.totals.debit} / credit ${s.totals.credit})`);
  return { clean: why.length === 0, why: why.join(", ") };
}

const STAFF_SQL = STAFF_ROLE_KEYS.map((k) => `'${k}'`).join(", ");

/**
 * Finance v2 is ON by default for plan-entitled accounts (CONTRACT2 item 3).
 * Effective = plan includes `accounting` AND not explicitly switched off by an
 * admin. This service turns an entitled account on with no admin step:
 *
 *  1. PROVISION — exactly what the admin first enable does (FinanceSetupService:
 *     chart, two fiscal years of periods, cash + bank + trust, collected
 *     commission basis), in MANAGER mode. Owner mode is never chosen
 *     automatically: DESIGN §4.2 makes it a suggestion an admin confirms, and
 *     the mode is frozen at the first posting.
 *  2. BACKFILL — a full dry run; only if it is balanced with 0 failed and 0
 *     pending does the real run follow (it sets `ledger_started_at`).
 *     Otherwise the account stays enabled-but-not-started (reports say "ledger
 *     not started"; nothing posts) and an `auto_provision` settings event plus
 *     the dry run's `finance_backfill_runs` row tell the admin why. Never an
 *     unbalanced ledger.
 *
 * Who is a candidate: a live customer account (no owner above it, not staff,
 * active, not deleted) whose plan is entitled, that is either
 *   - off, and the latest `finance_v2_enabled` event is not an explicit OFF
 *     (an admin's OFF is sticky; an admin's ON re-enables as before), or
 *   - auto-enabled (latest `finance_v2_enabled` event by actor 0) but not
 *     started — the backfill is retried (the sweep: once a day).
 * An account an admin enabled and has not backfilled yet is left to the admin.
 *
 * Triggers: `signalFv2Entitlement()` from the plan/activation paths and
 * `/finance/v2/status`, plus a daily sweep at 02:30 Riyadh (catch-up on boot).
 * All work runs on one in-process serial queue, after the caller has returned;
 * a SESSION advisory try-lock per account (LOCK_KEYS.AUTO_PROVISION) and the
 * SETUP xact lock + re-check make two triggers at once seed and backfill once.
 * Kill switch: FINANCE_V2_AUTO_PROVISION_DISABLED=1 (or the worker switch).
 */
@Injectable()
export class FinanceV2AutoProvisionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2AutoProvision");
  private timer: NodeJS.Timeout | null = null;
  private lastSweepDay: string | null = null;
  private sweeping = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly queued = new Set<number>();
  /** Set by onModuleInit unless a kill switch is on; `signal` is a no-op until then. */
  private active = false;
  /** Per-account memo for the cheap /status signal: don't even look again within this window. */
  private readonly recentlySignalled = new Map<number, number>();
  /** Injectable clock (specs). */
  now: () => number = () => Date.now();

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    private readonly setup: FinanceSetupService,
    private readonly backfill: BackfillService,
  ) {}

  onModuleInit(): void {
    if (fv2AutoProvisionDisabled()) {
      this.log.log("finance v2 auto-provisioning disabled (FINANCE_V2_AUTO_PROVISION_DISABLED / FINANCE_V2_WORKER_DISABLED)");
      return;
    }
    this.active = true;
    setFv2EntitlementHandler((id, trigger) => this.signal(id, trigger));
    this.timer = setInterval(() => void this.maybeSweep(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.active = false;
    setFv2EntitlementHandler(null);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire-and-forget entry point: queue `ensure` for the account. Never throws, never awaits. */
  signal(accountUserId: number, trigger: string, memoMs = 0): void {
    if (!this.active) return;
    if (memoMs > 0) {
      const at = this.recentlySignalled.get(accountUserId);
      if (at != null && this.now() - at < memoMs) return;
      this.recentlySignalled.set(accountUserId, this.now());
      if (this.recentlySignalled.size > 10_000) this.recentlySignalled.clear();
    }
    void this.enqueue(accountUserId, trigger).catch(() => undefined);
  }

  /** Queue `ensure` on the serial queue; a second request for an account already queued joins nothing. */
  enqueue(accountUserId: number, trigger: string): Promise<AutoResult | null> {
    if (this.queued.has(accountUserId)) return Promise.resolve(null);
    this.queued.add(accountUserId);
    const p = this.chain.then(async () => {
      this.queued.delete(accountUserId);
      try {
        return await this.ensure(accountUserId, trigger);
      } catch (err: any) {
        if (err?.code !== "42P01") this.log.warn(`finance v2 auto-provision failed for scope ${accountUserId}: ${err?.message ?? err}`);
        return null;
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async maybeSweep(): Promise<void> {
    const day = riyadhToday();
    const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.sweeping || this.lastSweepDay === day || h * 60 + m < SWEEP_AT_MIN) return;
    this.sweeping = true;
    try {
      const r = await this.sweep();
      this.lastSweepDay = day;
      if (r.length) this.log.log(`finance v2 auto-provision sweep: ${r.map((x) => `${x.accountUserId}=${x.outcome}`).join(", ")}`);
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`finance v2 auto-provision sweep failed: ${err?.message ?? err}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** The periodic sweep: every candidate, one at a time, through the same queue as the triggers. */
  async sweep(): Promise<AutoResult[]> {
    const out: AutoResult[] = [];
    for (const c of await this.candidates(null)) {
      if (c.action === "backfill" && c.lastAutoAt && this.now() - c.lastAutoAt.getTime() < SWEEP_RETRY_HOURS * 3_600_000) continue;
      const r = await this.enqueue(c.id, "sweep");
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Candidates (all, or one account). `action`: provision = off and never
   * explicitly switched off; backfill = auto-enabled, ledger not started.
   */
  async candidates(accountUserId: number | null, q: Pick<Fv2Client, "query"> | Fv2Pool = this.pool): Promise<Candidate[]> {
    const r = await q.query(
      `with ev as (
         select distinct on (account_user_id) account_user_id, actor_user_id, new_value
           from finance_settings_events where field = 'finance_v2_enabled' and ($1::int is null or account_user_id = $1)
          order by account_user_id, created_at desc, id desc
       ), ap as (
         select account_user_id, max(created_at) as at from finance_settings_events
          where field = 'auto_provision' and ($1::int is null or account_user_id = $1) group by account_user_id
       )
       select u.id,
              case when coalesce(fs.finance_v2_enabled, false) then 'backfill' else 'provision' end as action,
              ap.at as last_auto_at
         from users u
         left join roles r on r.id = u.role_id
         left join finance_settings fs on fs.account_user_id = u.id
         left join ev on ev.account_user_id = u.id
         left join ap on ap.account_user_id = u.id
        where ($1::int is null or u.id = $1)
          and u.owner_user_id is null and u.deleted_at is null and u.is_active
          and coalesce(u.account_status, 'active') = 'active'
          and coalesce(r.key, '') not in (${STAFF_SQL})
          and ${fv2PlanEntitledSql("u.id")}
          and (
            (not coalesce(fs.finance_v2_enabled, false) and coalesce(ev.new_value, 'null'::jsonb) <> 'false'::jsonb)
            or (fs.finance_v2_enabled and fs.ledger_started_at is null
                and ev.actor_user_id = ${AUTO_ACTOR} and ev.new_value = 'true'::jsonb)
          )
        order by u.id`,
      [accountUserId],
    );
    return r.rows.map((x: any) => ({ id: Number(x.id), action: x.action as AutoAction, lastAutoAt: x.last_auto_at ? new Date(x.last_auto_at) : null }));
  }

  /**
   * Provision and/or backfill one account if it is a candidate. Idempotent;
   * safe to call any number of times, concurrently, from any trigger.
   */
  async ensure(accountUserId: number, trigger: string, opts: { today?: string; retryMinutes?: number } = {}): Promise<AutoResult> {
    const [first] = await this.candidates(accountUserId);
    if (!first) {
      // Already provisioned and started (e.g. a ledger that sat plan-locked until this upgrade): post what it missed.
      if (NO_CATCH_UP_TRIGGERS.has(trigger)) return { accountUserId, outcome: "not_eligible", provisioned: false };
      const c = await this.catchUp(accountUserId, trigger, { automatic: true, today: opts.today });
      const outcome: AutoOutcome = c.outcome === "caught_up" || c.outcome === "caught_up_with_errors" ? "caught_up"
        : c.outcome === "up_to_date" ? "up_to_date" : c.outcome === "busy" ? "busy" : "not_eligible";
      return { accountUserId, outcome, provisioned: false, realRunId: c.runId, detail: c.detail };
    }
    const retryMs = (opts.retryMinutes ?? TRIGGER_RETRY_MINUTES) * 60_000;
    if (first.action === "backfill" && first.lastAutoAt && this.now() - first.lastAutoAt.getTime() < retryMs) {
      return { accountUserId, outcome: "throttled", provisioned: false };
    }

    const lockClient = await this.pool.connect();
    let locked = false;
    try {
      locked = (await lockClient.query(`select pg_try_advisory_lock($1, $2) as ok`, [accountUserId, LOCK_KEYS.AUTO_PROVISION])).rows[0]?.ok === true;
      if (!locked) return { accountUserId, outcome: "busy", provisioned: false };
      return await this.ensureLocked(accountUserId, trigger, opts.today);
    } finally {
      let broken = false;
      if (locked) {
        await lockClient.query(`select pg_advisory_unlock($1, $2)`, [accountUserId, LOCK_KEYS.AUTO_PROVISION]).catch(() => { broken = true; });
      }
      lockClient.release(broken || undefined);
    }
  }

  private async ensureLocked(accountUserId: number, trigger: string, today?: string): Promise<AutoResult> {
    // 1. Provision (re-checked inside the SETUP lock the admin switch takes, so an admin toggle and this serialise).
    const provisioned = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [accountUserId, LOCK_KEYS.SETUP]);
      const [cand] = await this.candidates(accountUserId, c);
      if (!cand) return null;
      if (cand.action !== "provision") return false;
      const cur = (await c.query(`select * from finance_settings where account_user_id = $1 for update`, [accountUserId])).rows[0];
      const oldMode: string | null = cur?.accounting_mode ?? null;
      const mode = oldMode ?? "manager";
      await c.query(
        `insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, enabled_by)
         values ($1, true, $2, now(), null)
         on conflict (account_user_id) do update set finance_v2_enabled = true, accounting_mode = excluded.accounting_mode,
           enabled_at = now(), enabled_by = null, updated_at = now()`,
        [accountUserId, mode],
      );
      if (!cur && mode === "manager") await this.setup.startCollectedBasis(c, accountUserId, null);
      const why = `Automatic: the plan includes accounting (${trigger})`;
      await settingsEvent(c, accountUserId, AUTO_ACTOR, "finance_v2_enabled", cur ? cur.finance_v2_enabled === true : null, true, why);
      if (mode !== oldMode) await settingsEvent(c, accountUserId, AUTO_ACTOR, "accounting_mode", oldMode, mode, why);
      await this.setup.firstEnable(c, accountUserId, null);
      return true;
    });
    if (provisioned === null) return { accountUserId, outcome: "not_eligible", provisioned: false };
    this.flag.invalidate(accountUserId);
    if (provisioned) this.log.log(`finance v2 auto-provisioned scope ${accountUserId} (${trigger})`);

    // 2. Dry run, then the real backfill only when it is clean.
    let dry: BackfillSummary;
    try {
      dry = await this.backfill.run({ userId: accountUserId, actorUserId: AUTO_ACTOR, mode: "full", dryRun: true, today });
    } catch (err: any) {
      const detail = String(err?.response?.error ?? err?.message ?? err).slice(0, 300);
      await this.record(accountUserId, { outcome: "dry_run_error", trigger, detail }, `Automatic backfill: the dry run failed (${detail}); the ledger is not started`);
      return { accountUserId, outcome: "dry_run_error", provisioned, detail };
    }
    const { clean, why } = dryRunIsClean(dry);
    if (!clean) {
      await this.record(accountUserId, { outcome: "dry_run_not_clean", trigger, dryRunId: dry.runId, failed: dry.failed.length, pending: dry.pending, totals: dry.totals },
        `Automatic backfill held: the dry run was not clean (${why}); the ledger is not started. Review dry run #${dry.runId}`);
      return { accountUserId, outcome: "dry_run_not_clean", provisioned, dryRunId: dry.runId, detail: why };
    }

    // Still a candidate (an admin may have switched it off, or the plan changed, while the dry run ran)?
    const [still] = await this.candidates(accountUserId);
    if (!still || still.action !== "backfill") {
      return { accountUserId, outcome: "not_eligible", provisioned, dryRunId: dry.runId, detail: "changed during the dry run" };
    }
    let real: BackfillSummary;
    try {
      real = await this.backfill.run({ userId: accountUserId, actorUserId: AUTO_ACTOR, mode: "full", dryRun: false, today });
    } catch (err: any) {
      const detail = String(err?.response?.error ?? err?.message ?? err).slice(0, 300);
      await this.record(accountUserId, { outcome: "dry_run_error", trigger, dryRunId: dry.runId, detail }, `Automatic backfill: the real run failed (${detail})`);
      return { accountUserId, outcome: "dry_run_error", provisioned, dryRunId: dry.runId, detail };
    }
    const after = dryRunIsClean(real);
    const outcome: AutoOutcome = after.clean ? "started" : "started_with_errors";
    await this.record(accountUserId, { outcome, trigger, dryRunId: dry.runId, realRunId: real.runId, events: real.events.new, entries: real.entries.count },
      after.clean
        ? `Automatic backfill: dry run #${dry.runId} clean, real run #${real.runId} posted ${real.entries.count} entries; ledger started`
        : `Automatic backfill: ledger started, but real run #${real.runId} left ${after.why}; see posting errors`);
    return { accountUserId, outcome, provisioned, dryRunId: dry.runId, realRunId: real.runId, detail: after.clean ? undefined : after.why };
  }

  /**
   * Catch-up for an account whose ledger has ALREADY started: everything issued
   * before activation (or while the plan kept accounting off — the hooks do not
   * enqueue then) that is neither in the ledger nor in the outbox is posted at
   * its original date, through the existing backfill in `catchup` mode — the
   * same extraction, keys and order as a full backfill on a fresh setup, so
   * running it twice posts nothing twice. External settlements of a contract
   * set to SKIP stay out (extract.ts). Closed periods get late entries, as the
   * nightly repair sweep does.
   *
   *  - `dryRun`: lists what would be posted (rolled back; nothing is written,
   *    not even a backfill-runs row).
   *  - `automatic`: also requires the plan to include accounting (a trigger);
   *    an admin can catch up a plan-locked account, as the admin backfill can.
   * Nothing missing → nothing written. Holds the AUTO_PROVISION session lock.
   */
  async catchUp(
    accountUserId: number, trigger: string,
    opts: { dryRun?: boolean; automatic?: boolean; actorUserId?: number; today?: string } = {},
  ): Promise<CatchUpResult> {
    const dryRun = opts.dryRun === true;
    const base = { accountUserId, dryRun, missing: 0, planned: [] as CatchUpResult["planned"] };
    const [st] = (await this.pool.query(
      `select coalesce(fs.finance_v2_enabled, false) and fs.ledger_started_at is not null as started,
              ${fv2PlanEntitledSql("fs.account_user_id")} as entitled
         from finance_settings fs where fs.account_user_id = $1`,
      [accountUserId],
    )).rows;
    if (!st?.started || (opts.automatic && !st.entitled)) {
      return { ...base, outcome: "not_eligible", detail: !st?.started ? "finance v2 is off or the ledger has not started" : "the plan does not include accounting" };
    }
    // The cached flag may still say off for a few seconds after an upgrade; live hooks should see it on now.
    this.flag.invalidate(accountUserId);

    const lockClient = await this.pool.connect();
    let locked = false;
    try {
      locked = (await lockClient.query(`select pg_try_advisory_lock($1, $2) as ok`, [accountUserId, LOCK_KEYS.AUTO_PROVISION])).rows[0]?.ok === true;
      if (!locked) return { ...base, outcome: "busy" };
      const missing = await this.backfill.missingKeys(accountUserId, "0001-01-01", "9999-12-31", opts.today);
      const listed = { ...base, missing: missing.length, planned: missing.slice(0, CATCH_UP_LIST_CAP) };
      if (missing.length === 0) return { ...listed, outcome: "up_to_date" };
      if (dryRun) return { ...listed, outcome: "would_post" };

      const actor = opts.actorUserId ?? AUTO_ACTOR;
      let run: BackfillSummary;
      try {
        run = await this.backfill.run({ userId: accountUserId, actorUserId: actor, mode: "catchup", dryRun: false, allowLate: true, today: opts.today });
      } catch (err: any) {
        const detail = String(err?.response?.error ?? err?.message ?? err).slice(0, 300);
        await this.recordCatchUp(accountUserId, actor, { outcome: "error", trigger, missing: missing.length, detail }, `Catch-up failed (${detail})`);
        return { ...listed, outcome: "error", detail };
      }
      const after = dryRunIsClean(run);
      const outcome: CatchUpOutcome = after.clean ? "caught_up" : "caught_up_with_errors";
      await this.recordCatchUp(accountUserId, actor, { outcome, trigger, runId: run.runId, events: run.events.new, entries: run.entries.count },
        `Catch-up (${trigger}): run #${run.runId} added ${run.events.new} event(s) issued before activation, ${run.entries.count} entries`
        + (after.clean ? "" : `; ${after.why}, see posting errors`));
      if (run.events.new > 0) this.log.log(`finance v2 catch-up for scope ${accountUserId} (${trigger}): ${run.events.new} event(s), run #${run.runId}`);
      return { ...listed, outcome, runId: run.runId, entries: run.entries.count, detail: after.clean ? undefined : after.why };
    } finally {
      let broken = false;
      if (locked) {
        await lockClient.query(`select pg_advisory_unlock($1, $2)`, [accountUserId, LOCK_KEYS.AUTO_PROVISION]).catch(() => { broken = true; });
      }
      lockClient.release(broken || undefined);
    }
  }

  private async recordCatchUp(accountUserId: number, actor: number, value: Record<string, unknown>, reason: string): Promise<void> {
    try {
      await settingsEvent(this.pool, accountUserId, actor, "catch_up", null, value, reason.slice(0, 500));
    } catch (err: any) {
      this.log.warn(`finance v2 catch-up: could not record the outcome for scope ${accountUserId}: ${err?.message ?? err}`);
    }
  }

  private async record(accountUserId: number, value: Record<string, unknown>, reason: string): Promise<void> {
    try {
      await settingsEvent(this.pool, accountUserId, AUTO_ACTOR, "auto_provision", null, value, reason.slice(0, 500));
    } catch (err: any) {
      this.log.warn(`finance v2 auto-provision: could not record the outcome for scope ${accountUserId}: ${err?.message ?? err}`);
    }
  }
}
