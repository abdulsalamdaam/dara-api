import { ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { FinanceFlagService, fv2PlanEntitledSql } from "./flag.service";
import { LedgerResetService, type Blocker } from "./ledger-reset.service";
import { BackfillService, type BackfillSummary } from "./backfill/backfill.service";
import { PostingWorker } from "./posting-worker.service";
import { LOCK_KEYS } from "./lock-keys";
import { settingsEvent } from "./audit";
import { toHalalas } from "./money";
import { archiveLedger, ledgerCounts, restoreLedger, type LedgerCounts } from "./ledger-archive";
import { setModeMigrationHandler } from "../plan-transition/plan-transition-signal";

/** The actor recorded for automatic work (the auto-provisioning and repair sweeps use 0 too). */
const AUTO = 0;

export type MigrateOutcome = "not_needed" | "migrated" | "migrated_not_started" | "blocked" | "busy" | "disabled";

export interface MigrateResult {
  outcome: MigrateOutcome;
  blockers?: Blocker[];
  archiveId?: number;
  dryRunId?: number;
  realRunId?: number;
  detail?: string;
}

export interface MigrateOpts {
  /** Only migrate when the account has an open upgrade into accounting (the auto-provisioning trigger). */
  requirePlanChange?: boolean;
}

/** Same rule as auto-provision.service.ts `dryRunIsClean` (not imported: that file imports this one). */
function dryRunIsClean(s: Pick<BackfillSummary, "failed" | "pending" | "totals">): { clean: boolean; why: string } {
  const why: string[] = [];
  if (s.failed.length > 0) why.push(`${s.failed.length} failed`);
  if (s.pending > 0) why.push(`${s.pending} pending`);
  if (toHalalas(s.totals.debit) !== toHalalas(s.totals.credit)) why.push(`unbalanced (debit ${s.totals.debit} / credit ${s.totals.credit})`);
  return { clean: why.length === 0, why: why.join(", ") };
}

export function autoMigrateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLAN_TRANSITION_AUTO_MIGRATE_DISABLED === "1";
}

/**
 * The automatic Owner → Manager ledger migration (plan transitions, decision D0).
 *
 * An Owner-mode ledger posts every landlord as the account itself (principal). That is right for an account that
 * only rents out its own property, and wrong the moment it manages someone else's: the landlord's rent becomes the
 * office's income and output VAT, and commission never runs (B1/B2). When an account upgrades into a plan with
 * accounting, or links a third-party landlord to a property with an active contract while in Owner mode, the
 * ledger is rebuilt in Manager mode — automatically when nothing blocks it:
 *
 *   1. preview: `LedgerResetService.inspect(manager)`; any blocker (closed / VAT-locked periods, manual or opening
 *      journals, vouchers, commission runs, fixed assets …) → `blocked`, nothing changes, an admin decides;
 *   2. under the account's posting lock and the AUTO_PROVISION key: re-check, ARCHIVE the derived ledger
 *      (`finance_ledger_archives`, restorable), purge it, switch to Manager and ensure the trust account
 *      (`LedgerResetService.resetInTx`, the admin reset's exact steps);
 *   3. a full DRY RUN; only when it is clean (balanced, 0 failed, 0 pending) the REAL backfill, which starts the
 *      ledger again. A dirty dry run leaves it enabled-but-not-started (`migrated_not_started`) for an admin.
 *
 * The holder's own rent posts identically in both modes, and the per-contract landlord snapshot
 * (`finance_contract_dims`) is kept, so a holder-only account gets the same ledger back with trust routing on.
 * Never touches documents or ZATCA. Kill switch: PLAN_TRANSITION_AUTO_MIGRATE_DISABLED=1 (→ `disabled`).
 */
@Injectable()
export class ModeMigrationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2ModeMigration");

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    private readonly reset: LedgerResetService,
    private readonly backfill: BackfillService,
    private readonly worker: PostingWorker,
  ) {}

  onModuleInit(): void {
    setModeMigrationHandler((acct, trigger) => this.maybeMigrate(acct, trigger));
  }

  onModuleDestroy(): void {
    setModeMigrationHandler(null);
  }

  /** Is a migration needed (Owner mode, accounting on, plan entitled)? Read only. */
  async needed(acct: number, q: Pick<Fv2Client, "query"> | Fv2Pool = this.pool): Promise<{ needed: boolean; why: string }> {
    const [s] = (await q.query(
      `select fs.accounting_mode as mode, fs.finance_v2_enabled as enabled, ${fv2PlanEntitledSql("fs.account_user_id")} as entitled
         from finance_settings fs where fs.account_user_id = $1`,
      [acct],
    )).rows;
    if (!s) return { needed: false, why: "accounting has never been set up" };
    if (s.mode !== "owner") return { needed: false, why: `the ledger is already in ${s.mode ?? "no"} mode` };
    if (!s.enabled) return { needed: false, why: "accounting is switched off for this account" };
    if (!s.entitled) return { needed: false, why: "the plan does not include accounting" };
    return { needed: true, why: "" };
  }

  /** The blockers a migration would hit now (empty = it can run). */
  async blockers(acct: number): Promise<Blocker[]> {
    return (await this.reset.inspect(this.pool, acct, "manager")).blockers;
  }

  /** The open upgrade-into-accounting plan change this migration belongs to, when the caller did not name one. */
  private async openUpgradeChange(acct: number): Promise<number | null> {
    const ok = (await this.pool.query(`select to_regclass('account_plan_changes') is not null as ok`)).rows[0]?.ok === true;
    if (!ok) return null;
    const [r] = (await this.pool.query(
      `select id from account_plan_changes
        where account_user_id = $1 and direction = 'upgrade' and to_features ? 'accounting' and not (from_features ? 'accounting')
          and status in ('pending','failed') and created_at > now() - interval '7 days'
        order by created_at desc, id desc limit 1`,
      [acct],
    )).rows;
    return r ? Number(r.id) : null;
  }

  async maybeMigrate(acct: number, trigger: string, planChangeId?: number, opts: MigrateOpts = {}): Promise<MigrateResult> {
    const need = await this.needed(acct);
    if (!need.needed) return { outcome: "not_needed", detail: need.why };
    const changeId = planChangeId ?? (await this.openUpgradeChange(acct));
    if (opts.requirePlanChange && changeId == null) return { outcome: "not_needed", detail: "no open upgrade into accounting" };
    if (autoMigrateDisabled()) return { outcome: "disabled", detail: "PLAN_TRANSITION_AUTO_MIGRATE_DISABLED" };

    const pre = await this.blockers(acct);
    if (pre.length) {
      await this.record(acct, { outcome: "blocked", trigger, planChangeId: changeId, blockers: pre.map((b) => b.code) },
        `Automatic Owner→Manager migration blocked (${trigger}): ${pre.map((b) => b.code).join(", ")}`);
      return { outcome: "blocked", blockers: pre };
    }

    const lockClient = await this.pool.connect();
    let locked = false;
    try {
      locked = (await lockClient.query(`select pg_try_advisory_lock($1, $2) as ok`, [acct, LOCK_KEYS.AUTO_PROVISION])).rows[0]?.ok === true;
      if (!locked) return { outcome: "busy" };
      return await this.migrateLocked(acct, trigger, changeId);
    } finally {
      let broken = false;
      if (locked) await lockClient.query(`select pg_advisory_unlock($1, $2)`, [acct, LOCK_KEYS.AUTO_PROVISION]).catch(() => { broken = true; });
      lockClient.release(broken || undefined);
    }
  }

  private async migrateLocked(acct: number, trigger: string, changeId: number | null): Promise<MigrateResult> {
    // Re-checked under the lock: another trigger may have migrated it a moment ago.
    const need = await this.needed(acct);
    if (!need.needed) return { outcome: "not_needed", detail: need.why };
    const reason = `Automatic: rebuild the ledger in Manager mode (${trigger}${changeId ? `, plan change #${changeId}` : ""})`;
    let archiveId = 0;
    try {
      await this.worker.withAccountLock(acct, () => withTx(this.pool, async (c) => {
        await this.reset.resetInTx(c, AUTO, acct, "manager", reason, {
          beforePurge: async (tx) => { archiveId = await archiveLedger(tx, acct, changeId, reason, AUTO); },
        });
        await auditAction(c, acct, AUTO, "ledger_mode_migration", "finance_v2", acct, `/plan-changes/${changeId ?? "-"}/mode-migration`);
      }));
    } catch (err: any) {
      const body = typeof err?.getResponse === "function" ? err.getResponse() : null;
      if (err instanceof ConflictException && body?.error === "RESET_BLOCKED") {
        await this.record(acct, { outcome: "blocked", trigger, planChangeId: changeId, blockers: (body.blockers ?? []).map((b: Blocker) => b.code) },
          `Automatic Owner→Manager migration blocked (${trigger})`);
        return { outcome: "blocked", blockers: body.blockers ?? [] };
      }
      throw err;
    }
    this.flag.invalidate(acct);

    let dry: BackfillSummary;
    try {
      dry = await this.backfill.run({ userId: acct, actorUserId: AUTO, mode: "full", dryRun: true });
    } catch (err: any) {
      const detail = String(err?.response?.error ?? err?.message ?? err).slice(0, 300);
      await this.record(acct, { outcome: "migrated_not_started", trigger, planChangeId: changeId, archiveId, detail },
        `Ledger switched to Manager mode; the dry run failed (${detail}); the ledger is not started`);
      return { outcome: "migrated_not_started", archiveId, detail };
    }
    const d = dryRunIsClean(dry);
    if (!d.clean) {
      await this.record(acct, { outcome: "migrated_not_started", trigger, planChangeId: changeId, archiveId, dryRunId: dry.runId, detail: d.why },
        `Ledger switched to Manager mode; dry run #${dry.runId} was not clean (${d.why}); the ledger is not started`);
      return { outcome: "migrated_not_started", archiveId, dryRunId: dry.runId, detail: d.why };
    }
    let real: BackfillSummary;
    try {
      real = await this.backfill.run({ userId: acct, actorUserId: AUTO, mode: "full", dryRun: false });
    } catch (err: any) {
      const detail = String(err?.response?.error ?? err?.message ?? err).slice(0, 300);
      await this.record(acct, { outcome: "migrated_not_started", trigger, planChangeId: changeId, archiveId, dryRunId: dry.runId, detail },
        `Ledger switched to Manager mode; the real backfill failed (${detail})`);
      return { outcome: "migrated_not_started", archiveId, dryRunId: dry.runId, detail };
    }
    this.flag.invalidate(acct);
    const after = dryRunIsClean(real);
    await this.record(acct, { outcome: "migrated", trigger, planChangeId: changeId, archiveId, dryRunId: dry.runId, realRunId: real.runId, entries: real.entries.count, clean: after.clean },
      `Ledger rebuilt in Manager mode: archive #${archiveId}, dry run #${dry.runId}, real run #${real.runId} (${real.entries.count} entries)`
      + (after.clean ? "" : `; ${after.why}, see posting errors`));
    this.log.log(`finance v2: scope ${acct} migrated to Manager mode (${trigger}); archive #${archiveId}`);
    return { outcome: "migrated", archiveId, dryRunId: dry.runId, realRunId: real.runId, detail: after.clean ? undefined : after.why };
  }

  /**
   * Put an archived Owner-mode ledger back (admin, `POST /admin/plan-changes/:id/restore-ledger`). Refused with 409
   * RESTORE_BLOCKED while the current (rebuilt) ledger holds anything a rebuild cannot re-create, or Owner mode's own
   * precondition fails (a third-party landlord with an active contract, an issued commission document).
   */
  async restore(archiveId: number, actorUserId: number, reason: string): Promise<{ restored: true; accountUserId: number; counts: LedgerCounts; archived: LedgerCounts }> {
    const [a] = (await this.pool.query(`select account_user_id, counts, restored_at from finance_ledger_archives where id = $1`, [archiveId])).rows;
    if (!a) throw new ConflictException({ error: "RESTORE_BLOCKED", code: "RESTORE_BLOCKED", message: "No ledger archive to restore", blockers: [] });
    const acct = Number(a.account_user_id);
    const out = await this.worker.withAccountLock(acct, () => withTx(this.pool, async (c) => {
      const busy = (await c.query(`select pg_try_advisory_xact_lock($1, $2) as ok`, [acct, LOCK_KEYS.AUTO_PROVISION])).rows[0]?.ok !== true;
      if (busy) throw new ConflictException({ error: "LEDGER_BUSY", message: "Automatic provisioning is running for this account; try again in a minute" });
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [acct, LOCK_KEYS.SETUP]);
      const pre = await this.reset.inspect(c, acct, "owner");
      const blockers = pre.blockers.filter((b) => b.code !== "NOT_ENABLED_BEFORE");
      if (blockers.length) {
        throw new ConflictException({ error: "RESTORE_BLOCKED", code: "RESTORE_BLOCKED", message: "The previous ledger cannot be restored", blockers });
      }
      const before = await ledgerCounts(c, acct);
      const res = await restoreLedger(c, archiveId, actorUserId, reason);
      await settingsEvent(c, acct, actorUserId, "ledger_restore", { accountingMode: pre.current.accountingMode, counts: before },
        { archiveId, counts: res.counts }, reason);
      if (pre.current.accountingMode !== "owner") await settingsEvent(c, acct, actorUserId, "accounting_mode", pre.current.accountingMode, "owner", reason);
      await auditAction(c, acct, actorUserId, "ledger_restore", "finance_v2", acct, `/admin/finance-ledger-archives/${archiveId}/restore`);
      return res;
    }));
    this.flag.invalidate(acct);
    return { ...out, archived: a.counts as LedgerCounts };
  }

  private async record(acct: number, value: Record<string, unknown>, reason: string): Promise<void> {
    try {
      await settingsEvent(this.pool, acct, AUTO, "mode_migration", { accountingMode: "owner" }, value, reason.slice(0, 500));
    } catch (err: any) {
      this.log.warn(`mode migration: could not record the outcome for scope ${acct}: ${err?.message ?? err}`);
    }
  }
}

/** An audit_logs row with an explicit action (the account's activity log). */
export async function auditAction(c: Pick<Fv2Client, "query">, scope: number, actorId: number, action: string, entity: string, entityId: string | number, path: string, method = "POST") {
  await c.query(
    `insert into audit_logs (owner_user_id, actor_user_id, action, entity, entity_id, method, path) values ($1, $2, $3, $4, $5, $6, $7)`,
    [scope, actorId, action, entity, String(entityId), method, path],
  );
}
