import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional,
  type OnModuleDestroy, type OnModuleInit,
} from "@nestjs/common";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { FV2_POOL, type Fv2Pool } from "../finance-v2/db";
import { FinanceFlagService } from "../finance-v2/flag.service";
import { ModeMigrationService, auditAction } from "../finance-v2/mode-migration.service";
import { LedgerResetService, type Blocker } from "../finance-v2/ledger-reset.service";
import { ExtraChecks } from "../finance-v2/reports/control-checks";
import { riyadhToday } from "../finance-v2/dates";
import { fromHalalas, toHalalas } from "../finance-v2/money";
import { sqlOf } from "../finance-v2/hooks/sql";
import { signalFv2Entitlement } from "../finance-v2/auto-provision-signal";
import { STAFF_ROLE_KEYS } from "../../common/permissions";
import { planFeatures, planHasFeature, type PlanFeature } from "../../common/plan-features";
import { isPackagePlan, planAllowedForUserType, planUserTypeError } from "../../common/packages";
import { planLimits } from "../../common/quota";
import { commissionFrom } from "../../common/commission-start";
import {
  setOwnerModeConflictHandler, setPlanChangeHandler, setPlanGuardHandler,
  type PlanChangeSignal, type PlanChangeSource,
} from "./plan-transition-signal";
import { thirdPartyActiveLandlords } from "./owner-mode-guard";

export type Direction = "upgrade" | "downgrade" | "lateral" | "initial";
export type ChangeStatus = "pending" | "done" | "attention" | "blocked" | "failed";
export type StepStatus = "pending" | "done" | "attention" | "blocked" | "failed" | "skipped";
export type StepKey =
  | "accounting" | "mode_migration" | "commission_from" | "client_money_check" | "downgrade_snapshot" | "caches"
  | "owner_mode_guard" | "ledger_restore";

export interface Step { key: StepKey; status: StepStatus; at: string; detail: Record<string, unknown> | null }

export interface PlanChangeDto {
  id: number;
  accountUserId: number;
  fromPlan: string | null;
  toPlan: string;
  fromFeatures: string[];
  toFeatures: string[];
  direction: Direction;
  source: PlanChangeSource;
  actorUserId: number | null;
  subscriptionPaymentId: number | null;
  reason: string | null;
  commissionFrom: string | null;
  status: ChangeStatus;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  /** The Owner-mode ledger archived by this change's migration (admin restore), if any. */
  archive: { id: number; restoredAt: string | null; counts: unknown } | null;
  account?: { name: string | null; email: string | null; packagePlan: string | null };
}

export interface PlanChangePreview {
  from: string | null;
  to: string;
  direction: Direction;
  features: { gained: PlanFeature[]; lost: PlanFeature[] };
  limits: {
    landlords: { used: number; limitAfter: number | null; over: boolean };
    users: { used: number; limitAfter: number | null; over: boolean };
  };
  accounting: {
    before: "on" | "off" | "locked";
    after: "on" | "off" | "locked";
    mode: "owner" | "manager" | null;
    migration: "none" | "auto" | "blocked";
    blockers: Blocker[];
  };
  clientMoney: { trust: string; landlordPayable: string } | null;
  commissionFrom: string | null;
  openCommissionDrafts: number;
  activeOffers: number;
  /** Third-party landlords (not the account holder) with an active contract. */
  thirdPartyLandlords: number;
  allowed: boolean;
  code: "DOWNGRADE_NEEDS_SUPPORT" | null;
  /** Why it is refused (machine codes): client_money_in_trust | landlord_payable | third_party_landlords. */
  reasons: string[];
}

export interface ChecklistItem {
  key: "accounting_ready" | "review_property_landlords" | "set_commission" | "move_client_money" | "record_past_payouts";
  done: boolean;
  /** Whether the item applies to this account at all (the web hides items that do not). */
  applicable: boolean;
  href: string;
  status?: "preparing" | "ready" | "blocked";
  until?: string;
}

const STEP_ORDER: StepKey[] = ["accounting", "mode_migration", "commission_from", "client_money_check", "downgrade_snapshot", "owner_mode_guard", "ledger_restore", "caches"];
const FINAL: StepStatus[] = ["done", "skipped"];
const DEDUPE_MINUTES = 5;
const RETRY_MS = 30_000;
const RETRY_WINDOW_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
const CHECKLIST_DAYS = 30;
const REVIEW_DAYS = 14;
const STAFF_SQL = STAFF_ROLE_KEYS.map((k) => `'${k}'`).join(", ");
const DOWNGRADE_MESSAGE =
  "لا يمكن الانتقال إلى هذه الباقة ذاتياً لأن حسابك يحتفظ بأموال عملاء أو يدير مؤجرين آخرين بعقود نشطة. تواصل مع دعم دارا على info@dara-sa.com · "
  + "This plan change needs Dara support: your account holds client money or manages other landlords with active contracts. Contact info@dara-sa.com.";

export function sweepDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLAN_TRANSITION_SWEEP_DISABLED === "1";
}

/** Direction by feature set: gaining features is an upgrade, losing them a downgrade; same features = lateral. */
export function planDirection(from: string | null, to: string): Direction {
  if (from == null) return "initial";
  const f = planFeatures(from), t = planFeatures(to);
  const gained = t.filter((x) => !f.includes(x)), lost = f.filter((x) => !t.includes(x));
  if (gained.includes("accounting") && !lost.length) return "upgrade";
  if (lost.includes("accounting") && !gained.length) return "downgrade";
  if (gained.length && !lost.length) return "upgrade";
  if (lost.length && !gained.length) return "downgrade";
  return "lateral";
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function changeStatus(steps: Step[]): ChangeStatus {
  const s = steps.map((x) => x.status);
  if (s.includes("failed")) return "failed";
  if (s.includes("blocked")) return "blocked";
  if (s.includes("pending")) return "pending";
  if (s.includes("attention")) return "attention";
  return "done";
}

/**
 * Plan transitions (عقاري ⇄ المكاتب ⇄ الشركات): one orchestrator for every plan change.
 *
 * The three paths that write `users.package_plan` (admin approve, admin package change, a paid subscription)
 * call `signalPlanChanged`; this service RECORDS the change (`account_plan_changes`: from/to, source, actor,
 * payment, the commission start) and runs its steps, each idempotent and written back as `{key,status,at,detail}`:
 *
 *  upgrade into accounting   accounting (auto-provision's outcome, or Owner mode / admin OFF) → mode_migration
 *                            (Owner → Manager, automatic when nothing blocks it) → commission_from → client_money_check
 *  downgrade out of it       downgrade_snapshot (trust, landlord payables, over-cap counts, open COM drafts, forced)
 *  every change              caches (a no-op here; documents what the web refreshes)
 *
 * It never writes `users.package_plan`, never touches a document or ZATCA, and never deletes a ledger row except
 * through the migration (archived first, restorable). An hourly sweep re-runs pending/failed changes and records
 * plan changes a write path missed (`source = 'sweep'`). Kill switches: PLAN_TRANSITION_SWEEP_DISABLED=1,
 * PLAN_TRANSITION_AUTO_MIGRATE_DISABLED=1 (the migration step is left `attention`).
 */
@Injectable()
export class PlanTransitionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("PlanTransition");
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private readonly retries = new Map<number, NodeJS.Timeout>();
  private lastSweepAt = 0;
  private sweeping = false;
  private active = false;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly migration: ModeMigrationService,
    private readonly reset: LedgerResetService,
    @Optional() private readonly flag?: FinanceFlagService,
  ) {}

  onModuleInit(): void {
    this.active = true;
    setPlanChangeHandler((id, c) => this.signal(id, c));
    setPlanGuardHandler((id, to, viewer, opts) => this.guard(id, to, viewer, opts));
    setOwnerModeConflictHandler((id, detail) => this.ownerModeConflict(id, detail));
    if (sweepDisabled()) {
      this.log.log("plan transition sweep disabled (PLAN_TRANSITION_SWEEP_DISABLED)");
      return;
    }
    this.bootTimer = setTimeout(() => void this.maybeSweep(), 120_000);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => void this.maybeSweep(), 5 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.active = false;
    setPlanChangeHandler(null);
    setPlanGuardHandler(null);
    setOwnerModeConflictHandler(null);
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
  }

  // ─── Signal / queue ─────────────────────────────────────────────────────

  /** Fire-and-forget: record, then apply, on the serial queue. Never throws. */
  signal(accountUserId: number, c: PlanChangeSignal): void {
    if (!this.active) return;
    this.enqueue(async () => {
      const r = await this.record(accountUserId, c);
      await this.applyAndSchedule(r.id);
    });
  }

  private enqueue(fn: () => Promise<unknown>): Promise<unknown> {
    const p = this.chain.then(fn).catch((err: any) => {
      if (err?.code !== "42P01") this.log.warn(`plan transition failed: ${err?.message ?? err}`);
      return null;
    });
    this.chain = p;
    return p;
  }

  private async applyAndSchedule(id: number): Promise<void> {
    const r = await this.apply(id);
    if (r.status !== "pending" || !this.active) return;
    const [row] = (await this.pool.query(`select created_at from account_plan_changes where id = $1`, [id])).rows;
    if (!row || Date.now() - new Date(row.created_at).getTime() > RETRY_WINDOW_MS || this.retries.has(id)) return;
    const t = setTimeout(() => {
      this.retries.delete(id);
      void this.enqueue(() => this.applyAndSchedule(id));
    }, RETRY_MS);
    t.unref?.();
    this.retries.set(id, t);
  }

  // ─── Record ─────────────────────────────────────────────────────────────

  async record(accountUserId: number, c: PlanChangeSignal): Promise<{ id: number; direction: Direction }> {
    const from = c.from ?? null;
    const to = c.to;
    const direction = planDirection(from, to);
    const [last] = (await this.pool.query(
      `select id, direction, to_plan, subscription_payment_id from account_plan_changes
        where account_user_id = $1 and source <> 'owner_mode_guard' and created_at > now() - ($2 || ' minutes')::interval
        order by created_at desc, id desc limit 1`,
      [accountUserId, String(DEDUPE_MINUTES)],
    )).rows;
    if (last && last.to_plan === to && (c.paymentId == null || last.subscription_payment_id == null || Number(last.subscription_payment_id) === Number(c.paymentId))) {
      // The same change reported twice (a write path and the sweep, a webhook and /sync): one row.
      if (c.paymentId != null && last.subscription_payment_id == null) {
        await this.pool.query(`update account_plan_changes set subscription_payment_id = $2, updated_at = now() where id = $1`, [last.id, c.paymentId]);
      }
      return { id: Number(last.id), direction: last.direction };
    }
    const fromFeatures = from == null ? [] : planFeatures(from);
    const toFeatures = planFeatures(to);
    const gainsAccounting = direction === "upgrade" && toFeatures.includes("accounting") && !fromFeatures.includes("accounting");
    const seed: Step[] = c.forced && direction === "downgrade" ? [{ key: "downgrade_snapshot", status: "pending", at: new Date().toISOString(), detail: { forced: true } }] : [];
    const [row] = (await this.pool.query(
      `insert into account_plan_changes (account_user_id, from_plan, to_plan, from_features, to_features, direction, source,
                                         actor_user_id, subscription_payment_id, reason, commission_from, status, steps)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11::date, 'pending', $12::jsonb)
       returning id`,
      [accountUserId, from, to, JSON.stringify(fromFeatures), JSON.stringify(toFeatures), direction, c.source,
        c.actorUserId ?? null, c.paymentId ?? null, c.reason ? String(c.reason).slice(0, 500) : null,
        gainsAccounting ? riyadhToday() : null, JSON.stringify(seed)],
    )).rows;
    const id = Number(row.id);
    await auditAction(this.pool, accountUserId, c.actorUserId ?? 0, "plan_change", "plan_change", id, `/plan-changes/${id}`, "PATCH")
      .catch(() => undefined);
    return { id, direction };
  }

  // ─── Apply ──────────────────────────────────────────────────────────────

  async apply(changeId: number): Promise<{ status: ChangeStatus; steps: Step[] }> {
    const [ch] = (await this.pool.query(`select * from account_plan_changes where id = $1`, [changeId])).rows;
    if (!ch) throw new NotFoundException({ error: "PLAN_CHANGE_NOT_FOUND", message: "Plan change not found" });
    const acct = Number(ch.account_user_id);
    const steps = new Map<StepKey, Step>();
    for (const s of (ch.steps ?? []) as Step[]) steps.set(s.key, s);
    const set = (key: StepKey, status: StepStatus, detail: Record<string, unknown> | null = null) => {
      const prev = steps.get(key)?.detail ?? null;
      steps.set(key, { key, status, at: new Date().toISOString(), detail: prev && detail ? { ...prev, ...detail } : detail ?? prev });
    };
    const isFinal = (key: StepKey) => FINAL.includes(steps.get(key)?.status as StepStatus);
    const run = async (key: StepKey, fn: () => Promise<void>) => {
      if (isFinal(key)) return;
      try { await fn(); } catch (err: any) { set(key, "failed", { error: String(err?.message ?? err).slice(0, 300) }); }
    };

    const from = arr(ch.from_features), to = arr(ch.to_features);
    const gains = ch.direction === "upgrade" && to.includes("accounting") && !from.includes("accounting");
    const loses = ch.direction === "downgrade" && from.includes("accounting") && !to.includes("accounting");

    // A newer change of the same account supersedes whatever this one has not finished.
    const [newer] = (await this.pool.query(
      `select id from account_plan_changes where account_user_id = $1 and id > $2 and source <> 'owner_mode_guard' order by id desc limit 1`,
      [acct, changeId])).rows;

    if (newer && gains) {
      for (const k of ["accounting", "mode_migration", "client_money_check"] as StepKey[]) {
        if (!isFinal(k) && steps.get(k)?.status !== "blocked") set(k, "skipped", { supersededBy: Number(newer.id) });
      }
    }

    if (gains) {
      await run("accounting", () => this.stepAccounting(acct, ch, set));
      await run("mode_migration", () => this.stepModeMigration(acct, changeId, steps, set));
      await run("commission_from", async () => {
        const [r] = (await this.pool.query(
          `update account_plan_changes set commission_from = coalesce(commission_from, (created_at at time zone 'Asia/Riyadh')::date)
            where id = $1 returning to_char(commission_from, 'YYYY-MM-DD') as d`, [changeId])).rows;
        set("commission_from", "done", { commissionFrom: r?.d ?? null });
      });
      await run("client_money_check", () => this.stepClientMoney(acct, steps, set));
    }
    if (loses) await run("downgrade_snapshot", () => this.stepDowngradeSnapshot(acct, ch, set));
    if (!steps.has("caches")) {
      set("caches", "done", { web: ["me", "me/subscription", "me/package", "me/limits", "finance-v2/status", "reports/ops/catalog", "me/plan-change"] });
    }

    const list = [...steps.values()].sort((a, b) => STEP_ORDER.indexOf(a.key) - STEP_ORDER.indexOf(b.key));
    const status = changeStatus(list);
    await this.pool.query(`update account_plan_changes set steps = $2::jsonb, status = $3, updated_at = now() where id = $1`,
      [changeId, JSON.stringify(list), status]);
    return { status, steps: list };
  }

  private async settings(acct: number) {
    const [fs] = (await this.pool.query(`select * from finance_settings where account_user_id = $1`, [acct])).rows;
    const [ev] = (await this.pool.query(
      `select new_value from finance_settings_events where account_user_id = $1 and field = 'finance_v2_enabled'
        order by created_at desc, id desc limit 1`, [acct])).rows;
    const adminOff = !fs?.finance_v2_enabled && ev != null && ev.new_value === false;
    return { fs: fs ?? null, adminOff };
  }

  private async stepAccounting(acct: number, ch: any, set: (k: StepKey, s: StepStatus, d?: Record<string, unknown> | null) => void) {
    const { fs, adminOff } = await this.settings(acct);
    if (adminOff) {
      set("accounting", "attention", { outcome: "skipped_admin_off" });
      return;
    }
    if (fs?.finance_v2_enabled && fs.accounting_mode === "owner") {
      set("accounting", "done", { outcome: "owner_mode", ledgerStarted: fs.ledger_started_at != null });
      return;
    }
    if (fs?.finance_v2_enabled && fs.ledger_started_at) {
      set("accounting", "done", { outcome: "started", mode: fs.accounting_mode });
      return;
    }
    // Not provisioned / not started yet: the automatic provisioning was signalled by the same write path.
    const [ap] = (await this.pool.query(
      `select new_value from finance_settings_events where account_user_id = $1 and field = 'auto_provision'
          and created_at >= $2::timestamptz - interval '2 minutes'
        order by created_at desc, id desc limit 1`, [acct, ch.created_at])).rows;
    const outcome = ap?.new_value?.outcome as string | undefined;
    if (outcome === "dry_run_not_clean" || outcome === "dry_run_error") {
      set("accounting", "attention", { outcome, dryRunId: ap.new_value.dryRunId ?? null, detail: ap.new_value.detail ?? null });
      return;
    }
    const ageMs = Date.now() - new Date(ch.created_at).getTime();
    if (ageMs > 15 * 60_000) {
      // The trigger was lost (a restart) or never ran: nudge it, and say so.
      signalFv2Entitlement(acct, "plan_transition");
      if (fs?.finance_v2_enabled && !fs.ledger_started_at && ageMs > 60 * 60_000) {
        set("accounting", "attention", { outcome: "not_started" });
        return;
      }
    }
    set("accounting", "pending", { outcome: "waiting_auto_provision" });
  }

  private async stepModeMigration(acct: number, changeId: number, steps: Map<StepKey, Step>, set: (k: StepKey, s: StepStatus, d?: Record<string, unknown> | null) => void) {
    const acc = steps.get("accounting");
    if (acc?.detail?.outcome === "skipped_admin_off") {
      set("mode_migration", "skipped", { outcome: "not_needed", why: "accounting switched off by an admin" });
      return;
    }
    const { fs } = await this.settings(acct);
    if (fs?.accounting_mode === "owner") {
      const r = await this.migration.maybeMigrate(acct, "plan_upgrade", changeId);
      const d = { outcome: r.outcome, archiveId: r.archiveId ?? null, dryRunId: r.dryRunId ?? null, realRunId: r.realRunId ?? null, detail: r.detail ?? null };
      switch (r.outcome) {
        case "migrated": set("mode_migration", "done", d); break;
        case "migrated_not_started": set("mode_migration", "attention", d); break;
        case "blocked": set("mode_migration", "blocked", { ...d, blockers: (r.blockers ?? []).map((b) => ({ code: b.code, count: b.count, message: b.message })) }); break;
        case "busy": set("mode_migration", "pending", d); break;
        case "disabled": set("mode_migration", "attention", d); break;
        default: set("mode_migration", "attention", d); // not_needed while Owner: switched off or not entitled any more
      }
      return;
    }
    const [a] = (await this.pool.query(
      `select id from finance_ledger_archives where plan_change_id = $1 order by id desc limit 1`, [changeId])).rows;
    if (a) set("mode_migration", "done", { outcome: "migrated", archiveId: Number(a.id) });
    else set("mode_migration", "done", { outcome: "not_needed" });
  }

  private async stepClientMoney(acct: number, steps: Map<StepKey, Step>, set: (k: StepKey, s: StepStatus, d?: Record<string, unknown> | null) => void) {
    const mig = steps.get("mode_migration")?.status;
    const acc = steps.get("accounting")?.status;
    if (acc === "pending" || mig === "pending") { set("client_money_check", "pending", null); return; }
    const { fs } = await this.settings(acct);
    if (!fs?.ledger_started_at || fs.accounting_mode !== "manager") {
      set("client_money_check", "skipped", { why: "the ledger is not started in Manager mode" });
      return;
    }
    const shortfall = await this.r16Shortfall(acct);
    if (shortfall > 0) set("client_money_check", "attention", { outsideTrust: fromHalalas(shortfall) });
    else set("client_money_check", "done", { outsideTrust: "0.00" });
  }

  private async stepDowngradeSnapshot(acct: number, ch: any, set: (k: StepKey, s: StepStatus, d?: Record<string, unknown> | null) => void) {
    const money = await this.clientMoney(acct);
    const limits = await planLimits(this.db, acct, ch.to_plan);
    const [drafts] = (await this.pool.query(
      `select count(*)::int as n from simple_invoices where user_id = $1 and kind = 'commission' and status = 'draft' and deleted_at is null`, [acct])).rows;
    const third = await thirdPartyActiveLandlords(sqlOf(this.pool as any), acct);
    set("downgrade_snapshot", "done", {
      trust: money?.trust ?? null, landlordPayable: money?.landlordPayable ?? null,
      landlordsOver: limits.landlords.over ? limits.landlords.used - (limits.landlords.limit ?? 0) : 0,
      usersOver: limits.users.over ? limits.users.used - (limits.users.limit ?? 0) : 0,
      openCommissionDrafts: Number(drafts?.n ?? 0), thirdPartyLandlords: third.length,
      reason: ch.reason ?? null,
    });
  }

  // ─── Money facts ────────────────────────────────────────────────────────

  private async r16Shortfall(acct: number): Promise<number> {
    try {
      const r16 = await new ExtraChecks(this.pool).r16(acct, riyadhToday(), "manager");
      const short = -toHalalas(String(r16.difference ?? "0"));
      return r16.status === "difference" && short > 0 ? short : 0;
    } catch {
      return 0;
    }
  }

  /** Trust balance and landlord payable (2121) from the posted ledger; null when no ledger has started. */
  async clientMoney(acct: number): Promise<{ trust: string; landlordPayable: string } | null> {
    const [fs] = (await this.pool.query(`select ledger_started_at from finance_settings where account_user_id = $1`, [acct])).rows;
    if (!fs?.ledger_started_at) return null;
    const [t] = (await this.pool.query(
      `select coalesce(sum(l.debit - l.credit), 0)::numeric(16,2)::text as v from journal_lines l
        where l.user_id = $1 and l.account_id in (select gl_account_id from bank_accounts where user_id = $1 and is_trust and gl_account_id is not null)`,
      [acct])).rows;
    const [p] = (await this.pool.query(
      `select coalesce(sum(l.credit - l.debit), 0)::numeric(16,2)::text as v from journal_lines l
         join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key = 'landlord_payable'`,
      [acct])).rows;
    return { trust: fromHalalas(toHalalas(t?.v ?? "0")), landlordPayable: fromHalalas(toHalalas(p?.v ?? "0")) };
  }

  // ─── Preview / guard ────────────────────────────────────────────────────

  async preview(accountUserId: number, toPlan: unknown, viewer: "customer" | "admin"): Promise<PlanChangePreview> {
    const to = typeof toPlan === "string" ? toPlan.trim() : "";
    if (!isPackagePlan(to)) throw new BadRequestException({ statusCode: 400, code: "UNKNOWN_PLAN", error: "UNKNOWN_PLAN", message: `Unknown plan: ${to || "(none)"}` });
    const [u] = (await this.pool.query(`select id, package_plan, user_type from users where id = $1 and deleted_at is null`, [accountUserId])).rows;
    if (!u) throw new NotFoundException("Account not found");
    if (!planAllowedForUserType(to, u.user_type)) throw new BadRequestException(planUserTypeError(to));
    const from: string | null = u.package_plan ?? null;
    const f = from == null ? [] : planFeatures(from), t = planFeatures(to);
    const gained = t.filter((x) => !f.includes(x)), lost = f.filter((x) => !t.includes(x));
    const gains = gained.includes("accounting"), loses = lost.includes("accounting");

    const limits = await planLimits(this.db, accountUserId, to);
    const { fs, adminOff } = await this.settings(accountUserId);
    const enabled = fs?.finance_v2_enabled === true;
    const entitledNow = planHasFeature(from, "accounting");
    const entitledAfter = planHasFeature(to, "accounting");
    const before: "on" | "off" | "locked" = enabled ? (entitledNow ? "on" : "locked") : "off";
    const after: "on" | "off" | "locked" = entitledAfter ? (enabled || !adminOff ? "on" : "off") : enabled ? "locked" : "off";
    const mode: "owner" | "manager" | null = fs?.accounting_mode ?? (after === "on" ? "manager" : null);

    let migration: "none" | "auto" | "blocked" = "none";
    let blockers: Blocker[] = [];
    if (gains && enabled && fs?.accounting_mode === "owner") {
      blockers = (await this.reset.inspect(this.pool, accountUserId, "manager")).blockers;
      migration = blockers.length ? "blocked" : "auto";
    }

    const q = sqlOf(this.pool as any);
    const money = await this.clientMoney(accountUserId);
    const third = await thirdPartyActiveLandlords(q, accountUserId);
    const [drafts] = (await this.pool.query(
      `select count(*)::int as n from simple_invoices where user_id = $1 and kind = 'commission' and status = 'draft' and deleted_at is null`,
      [accountUserId])).rows;
    let activeOffers = 0;
    if ((await this.pool.query(`select to_regclass('rental_offers') is not null as ok`)).rows[0]?.ok === true) {
      activeOffers = Number((await this.pool.query(
        `select count(*)::int as n from rental_offers where user_id = $1 and status in ('draft','sent') and deleted_at is null`, [accountUserId])).rows[0]?.n ?? 0);
    }

    const reasons: string[] = [];
    if (loses) {
      if (money && toHalalas(money.trust) !== 0) reasons.push("client_money_in_trust");
      if (money && toHalalas(money.landlordPayable) !== 0) reasons.push("landlord_payable");
      if (third.length) reasons.push("third_party_landlords");
    }
    const allowed = reasons.length === 0;
    void viewer;
    return {
      from, to, direction: planDirection(from, to),
      features: { gained, lost },
      limits: {
        landlords: { used: limits.landlords.used, limitAfter: limits.landlords.limit, over: limits.landlords.over },
        users: { used: limits.users.used, limitAfter: limits.users.limit, over: limits.users.over },
      },
      accounting: { before, after, mode, migration, blockers },
      clientMoney: money,
      commissionFrom: gains ? riyadhToday() : entitledAfter ? await commissionFrom(q, accountUserId) : null,
      openCommissionDrafts: Number(drafts?.n ?? 0),
      activeOffers,
      thirdPartyLandlords: third.length,
      allowed,
      code: allowed ? null : "DOWNGRADE_NEEDS_SUPPORT",
      reasons,
    };
  }

  /** 409 DOWNGRADE_NEEDS_SUPPORT (with the preview) unless the change is allowed, or an admin forces it with a reason. */
  async guard(accountUserId: number, toPlan: string, viewer: "customer" | "admin", opts: { force?: boolean; reason?: string | null }): Promise<void> {
    const [u] = (await this.pool.query(`select package_plan from users where id = $1`, [accountUserId])).rows;
    if (!u || u.package_plan === toPlan) return;
    if (!isPackagePlan(toPlan)) return; // the caller's own validation answers that
    const p = await this.preview(accountUserId, toPlan, viewer);
    if (p.allowed) return;
    const reason = (opts.reason ?? "").trim();
    if (viewer === "admin" && opts.force && reason.length >= 5 && reason.length <= 500) return;
    throw new ConflictException({
      statusCode: 409, code: "DOWNGRADE_NEEDS_SUPPORT", error: "DOWNGRADE_NEEDS_SUPPORT",
      message: viewer === "admin"
        ? "This downgrade hides client money or third-party landlords; pass force: true and a reason (5–500 characters) to apply it"
        : DOWNGRADE_MESSAGE,
      preview: p,
    });
  }

  // ─── Owner-mode guard queue item ────────────────────────────────────────

  async ownerModeConflict(acct: number, detail: Record<string, unknown>): Promise<void> {
    const [u] = (await this.pool.query(`select package_plan from users where id = $1`, [acct])).rows;
    const plan = u?.package_plan ?? "broker";
    const status: StepStatus = Array.isArray(detail.blockers) && (detail.blockers as unknown[]).length ? "blocked" : "attention";
    const step: Step = { key: "owner_mode_guard", status, at: new Date().toISOString(), detail };
    const [open] = (await this.pool.query(
      `select id from account_plan_changes where account_user_id = $1 and source = 'owner_mode_guard'
          and status in ('attention','blocked') and created_at > now() - interval '24 hours' order by id desc limit 1`, [acct])).rows;
    if (open) {
      await this.pool.query(`update account_plan_changes set steps = $2::jsonb, status = $3, updated_at = now() where id = $1`,
        [open.id, JSON.stringify([step]), status]);
      return;
    }
    const features = JSON.stringify(planFeatures(plan));
    await this.pool.query(
      `insert into account_plan_changes (account_user_id, from_plan, to_plan, from_features, to_features, direction, source, status, steps, reason)
       values ($1, $2, $2, $3::jsonb, $3::jsonb, 'lateral', 'owner_mode_guard', $4, $5::jsonb, $6)`,
      [acct, plan, features, status, JSON.stringify([step]), "A third-party landlord was linked to a property with an active contract while the ledger is in Owner mode"],
    );
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  private toDto(r: any): PlanChangeDto {
    return {
      id: Number(r.id), accountUserId: Number(r.account_user_id), fromPlan: r.from_plan ?? null, toPlan: r.to_plan,
      fromFeatures: arr(r.from_features), toFeatures: arr(r.to_features), direction: r.direction, source: r.source,
      actorUserId: r.actor_user_id ?? null, subscriptionPaymentId: r.subscription_payment_id ?? null, reason: r.reason ?? null,
      commissionFrom: dateOnly(r.commission_from), status: r.status, steps: (r.steps ?? []) as Step[],
      createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
      archive: r.archive_id ? { id: Number(r.archive_id), restoredAt: iso(r.archive_restored_at), counts: r.archive_counts ?? null } : null,
      ...(r.account_email !== undefined ? { account: { name: r.account_name ?? null, email: r.account_email ?? null, packagePlan: r.account_plan ?? null } } : {}),
    };
  }

  private readonly SELECT = `
    select c.*, a.id as archive_id, a.restored_at as archive_restored_at, a.counts as archive_counts
      from account_plan_changes c
      left join lateral (select id, restored_at, counts from finance_ledger_archives x where x.plan_change_id = c.id order by x.id desc limit 1) a on true`;

  async list(accountUserId: number): Promise<{ data: PlanChangeDto[] }> {
    const rows = (await this.pool.query(`${this.SELECT} where c.account_user_id = $1 order by c.created_at desc, c.id desc limit 200`, [accountUserId])).rows;
    return { data: rows.map((r: any) => this.toDto(r)) };
  }

  async queue(rawStatus: unknown): Promise<{ data: PlanChangeDto[] }> {
    const all: ChangeStatus[] = ["attention", "blocked", "failed"];
    const wanted = typeof rawStatus === "string" && rawStatus.trim()
      ? rawStatus.split(",").map((s) => s.trim()).filter((s): s is ChangeStatus => (["pending", "done", ...all] as string[]).includes(s))
      : all;
    if (!wanted.length) throw new BadRequestException({ error: "BAD_STATUS", message: "status must be attention, blocked, failed, pending or done" });
    const rows = (await this.pool.query(
      `select x.*, u.name as account_name, u.email as account_email, u.package_plan as account_plan from (${this.SELECT}) x
         join users u on u.id = x.account_user_id
        where x.status = any($1::text[]) order by x.updated_at desc, x.id desc limit 500`,
      [wanted])).rows;
    return { data: rows.map((r: any) => this.toDto(r)) };
  }

  async get(changeId: number): Promise<PlanChangeDto> {
    const [r] = (await this.pool.query(`${this.SELECT} where c.id = $1`, [changeId])).rows;
    if (!r) throw new NotFoundException({ error: "PLAN_CHANGE_NOT_FOUND", message: "Plan change not found" });
    return this.toDto(r);
  }

  /** The customer's latest plan change and, for 30 days after an upgrade into accounting, the checklist. */
  async latest(accountUserId: number): Promise<{ change: PlanChangeDto | null; checklist: ChecklistItem[]; showUntil: string | null }> {
    const [r] = (await this.pool.query(
      `${this.SELECT} where c.account_user_id = $1 and c.source not in ('owner_mode_guard','backfill') order by c.created_at desc, c.id desc limit 1`,
      [accountUserId])).rows;
    if (!r) return { change: null, checklist: [], showUntil: null };
    const change = this.toDto(r);
    const gains = change.direction === "upgrade" && change.toFeatures.includes("accounting") && !change.fromFeatures.includes("accounting");
    const created = new Date(change.createdAt).getTime();
    const showUntil = new Date(created + CHECKLIST_DAYS * 86_400_000).toISOString();
    if (!gains || Date.now() > created + CHECKLIST_DAYS * 86_400_000) return { change, checklist: [], showUntil: gains ? showUntil : null };
    return { change, checklist: await this.checklist(accountUserId, change), showUntil };
  }

  private async checklist(acct: number, change: PlanChangeDto): Promise<ChecklistItem[]> {
    const { fs } = await this.settings(acct);
    const blocked = change.steps.some((s) => s.key === "mode_migration" && s.status === "blocked");
    const ready = fs?.finance_v2_enabled === true && fs.ledger_started_at != null && fs.accounting_mode === "manager";
    const reviewUntil = new Date(new Date(change.createdAt).getTime() + REVIEW_DAYS * 86_400_000);
    const [third] = (await this.pool.query(
      `select count(*)::int as n,
              count(*) filter (where coalesce(o.management_fee_percent, 0) > 0
                                  or exists (select 1 from properties p where p.owner_id = o.id and p.user_id = o.user_id
                                               and p.deleted_at is null and coalesce(p.management_fee_percent, 0) > 0))::int as with_fee
         from owners o where o.user_id = $1 and o.deleted_at is null and not o.is_account_holder`, [acct])).rows;
    const thirdCount = Number(third?.n ?? 0);
    const shortfall = ready ? await this.r16Shortfall(acct) : 0;
    let payable = 0;
    if (fs?.ledger_started_at) {
      const [p] = (await this.pool.query(
        `select count(*)::int as n from (
           select l.owner_id from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
             join owners o on o.id = l.owner_id and not o.is_account_holder
            where l.user_id = $1 and a.system_key = 'landlord_payable' and l.owner_id is not null
            group by l.owner_id having sum(l.credit - l.debit) > 0) x`, [acct])).rows;
      payable = Number(p?.n ?? 0);
    }
    return [
      { key: "accounting_ready", done: ready, applicable: true, href: "/dashboard/accounting", status: ready ? "ready" : blocked ? "blocked" : "preparing" },
      { key: "review_property_landlords", done: Date.now() > reviewUntil.getTime(), applicable: true, href: "/dashboard/properties", until: reviewUntil.toISOString() },
      { key: "set_commission", done: thirdCount === 0 || Number(third?.with_fee ?? 0) > 0, applicable: thirdCount > 0, href: "/dashboard/owners" },
      { key: "move_client_money", done: shortfall === 0, applicable: shortfall > 0, href: "/dashboard/accounting/control-checks" },
      { key: "record_past_payouts", done: payable === 0, applicable: payable > 0, href: "/dashboard/accounting/landlord-payouts" },
    ];
  }

  // ─── Admin actions ──────────────────────────────────────────────────────

  async retry(changeId: number, actorUserId: number, body: any): Promise<PlanChangeDto> {
    const reason = requireReason(body);
    const ch = await this.get(changeId);
    const keep = ch.steps.filter((s) => FINAL.includes(s.status) || s.key === "owner_mode_guard" || s.key === "ledger_restore");
    await this.pool.query(`update account_plan_changes set steps = $2::jsonb, status = 'pending', updated_at = now() where id = $1`,
      [changeId, JSON.stringify(keep)]);
    if (ch.source === "owner_mode_guard") {
      const r = await this.migration.maybeMigrate(ch.accountUserId, "admin_retry");
      const status: StepStatus = r.outcome === "migrated" || r.outcome === "not_needed" ? "done" : r.outcome === "blocked" ? "blocked" : "attention";
      const step: Step = { key: "mode_migration", status, at: new Date().toISOString(), detail: { outcome: r.outcome, archiveId: r.archiveId ?? null, blockers: (r.blockers ?? []).map((b) => b.code) } };
      const steps = [...keep, step];
      await this.pool.query(`update account_plan_changes set steps = $2::jsonb, status = $3, updated_at = now() where id = $1`,
        [changeId, JSON.stringify(steps), changeStatus(steps)]);
    } else {
      await this.apply(changeId);
    }
    await auditAction(this.pool, ch.accountUserId, actorUserId, "plan_change_retry", "plan_change", changeId, `/admin/plan-changes/${changeId}/retry`);
    await this.pool.query(`update account_plan_changes set reason = coalesce(reason, $2) where id = $1`, [changeId, reason]);
    return this.get(changeId);
  }

  async restoreLedger(changeId: number, actorUserId: number, body: any) {
    const reason = requireReason(body);
    const ch = await this.get(changeId);
    const confirm = body?.confirm == null ? "" : String(body.confirm).trim();
    if (confirm !== String(ch.accountUserId)) {
      throw new BadRequestException({ error: "CONFIRM_MISMATCH", message: `Type the account id (${ch.accountUserId}) in confirm to restore its ledger` });
    }
    const [a] = (await this.pool.query(
      `select id from finance_ledger_archives where plan_change_id = $1 and restored_at is null order by id desc limit 1`, [changeId])).rows;
    if (!a) {
      throw new ConflictException({ statusCode: 409, code: "RESTORE_BLOCKED", error: "RESTORE_BLOCKED", message: "This plan change has no archived ledger to restore", blockers: [] });
    }
    const res = await this.migration.restore(Number(a.id), actorUserId, reason);
    const steps: Step[] = [...ch.steps.filter((s) => s.key !== "ledger_restore"),
      { key: "ledger_restore", status: "attention", at: new Date().toISOString(), detail: { archiveId: Number(a.id), counts: res.counts, reason } }];
    await this.pool.query(`update account_plan_changes set steps = $2::jsonb, status = 'attention', updated_at = now() where id = $1`,
      [changeId, JSON.stringify(steps.sort((x, y) => STEP_ORDER.indexOf(x.key) - STEP_ORDER.indexOf(y.key)))]);
    this.flag?.invalidate(ch.accountUserId);
    return { ...res, change: await this.get(changeId) };
  }

  // ─── Sweep ──────────────────────────────────────────────────────────────

  private async maybeSweep(): Promise<void> {
    if (this.sweeping || Date.now() - this.lastSweepAt < SWEEP_EVERY_MS) return;
    this.sweeping = true;
    try {
      const r = await this.sweep();
      this.lastSweepAt = Date.now();
      if (r.recorded || r.reapplied) this.log.log(`plan transition sweep: ${r.recorded} recorded, ${r.reapplied} re-applied`);
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`plan transition sweep failed: ${err?.message ?? err}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Re-run pending/failed changes, and record plan changes no write path reported. */
  async sweep(): Promise<{ recorded: number; reapplied: number }> {
    let reapplied = 0, recorded = 0;
    const open = (await this.pool.query(
      `select id from account_plan_changes where status in ('pending','failed') and source <> 'owner_mode_guard'
          and created_at > now() - interval '30 days' order by id limit 500`)).rows;
    for (const r of open) {
      await this.apply(Number(r.id)).catch((err) => this.log.warn(`plan change #${r.id}: ${err?.message ?? err}`));
      reapplied++;
    }
    const drift = (await this.pool.query(
      `select u.id, u.package_plan, l.to_plan
         from users u
         left join roles r on r.id = u.role_id
         left join lateral (select to_plan from account_plan_changes x where x.account_user_id = u.id and x.source <> 'owner_mode_guard'
                             order by x.created_at desc, x.id desc limit 1) l on true
        where u.owner_user_id is null and u.deleted_at is null and coalesce(r.key, '') not in (${STAFF_SQL})
          and l.to_plan is distinct from u.package_plan
        order by u.id limit 500`)).rows;
    for (const d of drift) {
      const rec = await this.record(Number(d.id), { from: d.to_plan ?? null, to: d.package_plan, source: "sweep", actorUserId: 0 });
      await this.apply(rec.id).catch((err) => this.log.warn(`plan change #${rec.id}: ${err?.message ?? err}`));
      recorded++;
    }
    return { recorded, reapplied };
  }
}

function requireReason(body: any): string {
  const r = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (r.length < 5 || r.length > 500) throw new BadRequestException({ error: "REASON_REQUIRED", message: "reason is required (5–500 characters)" });
  return r;
}
