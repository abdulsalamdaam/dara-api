import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit,
} from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { PostingEngine } from "../posting.engine";
import { PostingWorker } from "../posting-worker.service";
import { LedgerStartService } from "../ledger-start.service";
import { RecognizerService } from "../recognizer.service";
import { FinanceSetupService } from "../setup.service";
import { riyadhToday, parseIsoDate, lastDayOfMonth } from "../dates";
import { fromHalalas, toHalalas } from "../money";
import { sqlOf } from "../hooks/sql";
import { auditRow, settingsEvent } from "../audit";
import { loadSettings, type FinanceSettingsRow } from "../hooks/facts-loader";
import { SYS, type AccountingMode } from "../rules";
import { compareEvents, extractEvents, keyOf, rankOf, type ExtractOptions, type Note, type PlannedEvent } from "./extract";

export type BackfillMode = "full" | "cutover" | "catchup";

export interface BackfillRequest {
  userId: number;
  /** Who ran it (0 = the nightly repair sweep). */
  actorUserId: number;
  mode: BackfillMode;
  /** Cutover date D (YYYY-MM-DD): opening at D−1, events from D. */
  cutover?: string | null;
  dryRun: boolean;
  allowLate?: boolean;
  /** Dry run on an account with no mode yet (the flag may be off): the mode to simulate. */
  accountingMode?: AccountingMode | null;
  /** Riyadh today; tests pin it. */
  today?: string;
  /** Outbox origin of the rows this run adds. */
  origin?: "backfill" | "repair";
}

export interface ProposalLine {
  accountId: number;
  code: string;
  debit: string;
  credit: string;
  memo: string | null;
  ownerId: number | null;
  propertyId: number | null;
  unitId: number | null;
  tenantId: number | null;
  contractId: number | null;
  paymentId: number | null;
}

export interface OpeningProposal {
  date: string;
  lines: ProposalLine[];
  /** Installment charge markers active at D−1, re-created by a real cutover run (entry_id null). */
  charges: Array<{ paymentId: number; chargedOn: string; chargedBy: string; documentId: number | null; amount: string; vatAmount: string }>;
  vatPeriod: { from: string; to: string };
}

export interface BackfillSummary {
  runId: number;
  account: number;
  mode: BackfillMode;
  dryRun: boolean;
  asOf: string;
  cutover: string | null;
  events: { total: number; new: number; alreadyPosted: number; alreadyQueued: number; alreadyHandled: number; byType: Record<string, number> };
  entries: { count: number; skipped: Record<string, number> };
  failed: Array<{ sourceType: string; sourceId: number; event: string; code: string | null; error: string | null }>;
  pending: number;
  trialBalance: Array<{ code: string; nameEn: string; nameAr: string; debit: string; credit: string }>;
  totals: { debit: string; credit: string };
  controls: Record<string, { ledger: string; subledger: string | null; diff: string | null }>;
  warnings: Array<{ code: string; count: number; sample: Array<{ sourceType: string; sourceId: number; date?: string }> }>;
  lateEntries: Array<{ entryNo: string; originalDate: string; entryDate: string; sourceType: string; sourceId: number; event: string }>;
  sampleEntries: Array<{ entryNo: string; date: string; sourceType: string; sourceId: number; event: string; lines: Array<{ code: string; debit: string; credit: string }> }>;
  opening: { proposal: OpeningProposal | null; manualJournalId: number | null } | null;
  recognizer: { charges: number; settlements: number; releases: number } | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const REPAIR_AT_MIN = 3 * 60 + 30; // 03:30 Riyadh (§5.1)

function addDays(iso: string, n: number): string {
  const { y, m, day } = parseIsoDate(iso);
  return new Date(Date.UTC(y, m - 1, day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The VAT return period (monthly or calendar quarter) that contains `date`. */
export function vatPeriodOf(date: string, frequency: "monthly" | "quarterly"): { from: string; to: string } {
  const { y, m } = parseIsoDate(date);
  const first = frequency === "monthly" ? m : Math.floor((m - 1) / 3) * 3 + 1;
  const last = frequency === "monthly" ? m : first + 2;
  const p = (n: number) => String(n).padStart(2, "0");
  return { from: `${y}-${p(first)}-01`, to: `${y}-${p(last)}-${p(lastDayOfMonth(y, last))}` };
}

/**
 * The backfill (DESIGN §6): posts an account's history from its existing
 * records, at the original event dates, through the SAME outbox and engine
 * as live posting.
 *
 *  - Real run: extraction and enqueue in one transaction (keys the ledger or
 *    outbox already has are skipped; on a ledger that has not started, the
 *    live events already queued are re-sequenced into the chronological
 *    order), `ledger_started_at` set in that transaction; then the rows are
 *    posted in id (= chronological) order, then the recognizer runs.
 *  - Dry run: exactly the same, in ONE transaction that is rolled back (the
 *    chart, periods and settings are created in it when the account has none
 *    yet), so the report is what a real run would post, and nothing but the
 *    `finance_backfill_runs` row is written.
 *  - Re-runnable: every key equals the live key; a second run adds nothing.
 *  - The whole run holds the account's posting lock (live posting pauses).
 *
 * The nightly repair sweep (§5.1) is a real `catchup` run per flag-on account.
 */
@Injectable()
export class BackfillService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Backfill");
  private timer: NodeJS.Timeout | null = null;
  private lastSweepDay: string | null = null;
  private sweeping = false;
  /** Called once the nightly sweep has run for every account (the control checks run next, controls.service.ts). */
  onSweepDone: ((day: string) => Promise<unknown>) | null = null;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly engine: PostingEngine,
    private readonly worker: PostingWorker,
    private readonly ledgerStart: LedgerStartService,
    private readonly recognizer: RecognizerService,
    private readonly setup: FinanceSetupService,
  ) {}

  onModuleInit(): void {
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_REPAIR_DISABLED === "1") return;
    this.timer = setInterval(() => void this.maybeSweep(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async maybeSweep(): Promise<void> {
    const day = riyadhToday();
    const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.sweeping || this.lastSweepDay === day || h * 60 + m < REPAIR_AT_MIN) return;
    this.sweeping = true;
    try {
      const r = await this.pool.query(`select account_user_id from finance_settings where finance_v2_enabled and ledger_started_at is not null order by 1`);
      for (const x of r.rows) {
        try {
          const s = await this.run({ userId: Number(x.account_user_id), actorUserId: 0, mode: "catchup", dryRun: false, allowLate: true, origin: "repair" });
          if (s.events.new > 0) this.log.warn(`finance v2 repair sweep added ${s.events.new} event(s) for scope ${x.account_user_id}`);
        } catch (err: any) {
          this.log.warn(`finance v2 repair sweep failed for scope ${x.account_user_id}: ${err?.message ?? err}`);
        }
      }
      this.lastSweepDay = day;
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`finance v2 repair sweep failed: ${err?.message ?? err}`);
    } finally {
      this.sweeping = false;
    }
    if (this.lastSweepDay === day && this.onSweepDone) {
      try {
        await this.onSweepDone(day);
      } catch (err: any) {
        this.log.warn(`finance v2 post-sweep control checks failed: ${err?.message ?? err}`);
      }
    }
  }

  static parseRequest(userId: number, actorUserId: number, body: any): BackfillRequest {
    const mode = body?.mode ?? "full";
    if (!["full", "cutover", "catchup"].includes(mode)) throw new BadRequestException("mode must be full, cutover or catchup");
    const cutover = body?.cutover ?? null;
    if (mode === "cutover" && !(typeof cutover === "string" && ISO.test(cutover))) throw new BadRequestException("cutover (YYYY-MM-DD) is required for mode cutover");
    if (mode !== "cutover" && cutover != null) throw new BadRequestException("cutover is only valid with mode cutover");
    const am = body?.accountingMode ?? null;
    if (am !== null && am !== "owner" && am !== "manager") throw new BadRequestException("accountingMode must be owner or manager");
    return {
      userId, actorUserId, mode, cutover, dryRun: body?.dryRun !== false, allowLate: body?.allowLate === true, accountingMode: am,
    };
  }

  async runs(userId: number) {
    const r = await this.pool.query(
      `select id, actor_user_id as "actorUserId", mode, dry_run as "dryRun", to_char(cutover_date,'YYYY-MM-DD') as cutover, status,
              started_at as "startedAt", finished_at as "finishedAt",
              summary->'events' as events, summary->'entries' as entries, summary->'error' as error
         from finance_backfill_runs where user_id = $1 order by id desc limit 50`,
      [userId],
    );
    return r.rows;
  }

  async run(req: BackfillRequest): Promise<BackfillSummary> {
    const today = req.today ?? riyadhToday();
    const settings = (await this.pool.query(
      `select *, to_char(ledger_go_live_date,'YYYY-MM-DD') as go_live_iso from finance_settings where account_user_id = $1`, [req.userId])).rows[0] ?? null;
    const mode: AccountingMode = (settings?.accounting_mode ?? req.accountingMode ?? "manager") as AccountingMode;

    if (!req.dryRun) {
      if (!settings?.finance_v2_enabled) throw new ConflictException({ error: "FINANCE_V2_OFF", message: "Finance v2 is off for this account" });
      if (!settings.accounting_mode) throw new ConflictException({ error: "MODE_NOT_SET", message: "The accounting mode is not set" });
      const chart = await this.pool.query(`select 1 from accounts where user_id = $1 limit 1`, [req.userId]);
      if (!chart.rowCount) throw new ConflictException({ error: "CHART_NOT_SEEDED", message: "The chart of accounts is not seeded" });
    }
    const closed = await this.pool.query(`select count(*)::int as n from fiscal_periods where user_id = $1 and status <> 'open'`, [req.userId]);
    if (closed.rows[0].n > 0 && !req.allowLate) {
      throw new ConflictException({ error: "PERIODS_CLOSED", message: "Some periods are closed or locked; pass allowLate to post their events late" });
    }
    if (req.mode === "cutover") {
      const D = req.cutover!;
      const goLive: string | null = settings?.go_live_iso ?? null;
      if (goLive && goLive !== D) throw new ConflictException({ error: "CUTOVER_MISMATCH", message: `The ledger went live on ${goLive}` });
      if (!goLive && !req.dryRun) {
        const any = await this.pool.query(`select 1 from journal_entries where user_id = $1 and origin <> 'opening' limit 1`, [req.userId]);
        if (any.rowCount) throw new ConflictException({ error: "LEDGER_NOT_EMPTY", message: "A cutover needs an empty ledger" });
      }
    }

    const runId = Number((await this.pool.query(
      `insert into finance_backfill_runs (user_id, actor_user_id, mode, dry_run, cutover_date) values ($1, $2, $3, $4, $5) returning id`,
      [req.userId, req.actorUserId, req.mode, req.dryRun, req.cutover ?? null],
    )).rows[0].id);

    try {
      const summary = await this.worker.withAccountLock(req.userId, () =>
        req.dryRun ? this.dryRun(req, runId, mode, today) : this.realRun(req, runId, today));
      await this.pool.query(
        `update finance_backfill_runs set status = 'done', finished_at = now(), summary = $2::jsonb where id = $1`,
        [runId, JSON.stringify(summary)],
      );
      return summary;
    } catch (err: any) {
      await this.pool.query(
        `update finance_backfill_runs set status = 'failed', finished_at = now(), summary = $2::jsonb where id = $1`,
        [runId, JSON.stringify({ error: String(err?.message ?? err).slice(0, 2000) })],
      ).catch(() => undefined);
      throw err;
    }
  }

  /** Everything in one transaction, rolled back. */
  private async dryRun(req: BackfillRequest, runId: number, mode: AccountingMode, today: string): Promise<BackfillSummary> {
    let proposal: OpeningProposal | null = null;
    if (req.mode === "cutover" && !(await this.hasOpening(req.userId))) proposal = await this.simulateOpening(req.userId, req.cutover!, mode);
    return this.inRollback(async (c) => {
      const s = await this.prepareSimulation(c, req.userId, mode);
      const since = await this.maxEntryId(c, req.userId);
      const plan = await this.plan(c, req.userId, s, this.extractOpts(req, today), { origin: req.origin ?? "backfill", runId });
      if (req.mode === "cutover") {
        await c.query(`update finance_settings set ledger_go_live_date = coalesce(ledger_go_live_date, $2) where account_user_id = $1`, [req.userId, req.cutover]);
        if (proposal) await this.insertMarkers(c, req.userId, proposal);
      }
      await this.drainOn(c, req.userId);
      await c.query("set constraints all immediate");
      return this.summarize(c, req, runId, today, since, plan, { proposal, manualJournalId: null }, null);
    });
  }

  private async realRun(req: BackfillRequest, runId: number, today: string): Promise<BackfillSummary> {
    let proposal: OpeningProposal | null = null;
    if (req.mode === "cutover" && !(await this.hasOpening(req.userId))) {
      const s = await loadSettings(sqlOf(this.pool as any), req.userId);
      proposal = await this.simulateOpening(req.userId, req.cutover!, s!.mode);
    }
    const since = await this.maxEntryId(this.pool, req.userId);
    let manualJournalId: number | null = null;
    const plan = await withTx(this.pool, async (c) => {
      if (req.actorUserId > 0) {
        // A person ran it (0 = the nightly repair sweep): audit it under the TARGET account, as the switch is.
        await auditRow(c, req.userId, req.actorUserId, "finance_v2_backfill", runId, `/admin/finance-v2/${req.userId}/backfill`);
        await settingsEvent(c, req.userId, req.actorUserId, "backfill_run", null, { runId, mode: req.mode, cutover: req.cutover ?? null }, `backfill ${req.mode}`);
      }
      const s = await loadSettings(sqlOf(c), req.userId);
      if (!s) throw new ConflictException({ error: "FINANCE_V2_OFF", message: "Finance v2 is off for this account" });
      if (req.mode === "cutover") {
        await c.query(`update finance_settings set ledger_go_live_date = coalesce(ledger_go_live_date, $2), updated_at = now() where account_user_id = $1`,
          [req.userId, req.cutover]);
        s.goLive = req.cutover!;
        if (proposal) {
          await this.insertMarkers(c, req.userId, proposal);
          manualJournalId = await this.insertOpeningDraft(c, req.userId, req.actorUserId, proposal);
        }
      }
      const p = await this.plan(c, req.userId, s, this.extractOpts(req, today), { origin: req.origin ?? "backfill", runId });
      await this.ledgerStart.markStarted(c, req.userId);
      return p;
    });
    this.ledgerStart.afterCommit(req.userId);
    await this.drain(req.userId);
    const rec = await this.recognizer.runAccount(req.userId, today);
    await this.drain(req.userId);
    return this.summarize(this.pool, req, runId, today, since, plan, req.mode === "cutover" ? { proposal, manualJournalId } : null, rec);
  }

  // ── planning and enqueue ────────────────────────────────────────────────

  private extractOpts(req: BackfillRequest, today: string): ExtractOptions {
    return { today, from: req.mode === "cutover" ? req.cutover : null };
  }

  /**
   * Extract, compare with the ledger and the outbox, and enqueue what is
   * missing in the §6.4 order. On a ledger that has not started, the live
   * rows already pending are re-sequenced (given new ids) into that order, so
   * the worker's id order is the chronological order.
   */
  private async plan(c: Fv2Client, userId: number, s: FinanceSettingsRow, opts: ExtractOptions, run: { origin: "backfill" | "repair"; runId: number | null }) {
    const req = { userId };
    const q = sqlOf(c);
    const { events, notes } = await extractEvents(q, userId, s, opts);
    const posted = new Set<string>(
      (await c.query(`select source_type, source_id, event from journal_entries where user_id = $1`, [req.userId]))
        .rows.map((r: any) => keyOf({ sourceType: r.source_type, sourceId: Number(r.source_id), event: r.event })),
    );
    const outbox = new Map<string, any>();
    for (const r of (await c.query(
      `select id, source_type, source_id, event, status, to_char(occurred_on,'YYYY-MM-DD') as occurred_on, payload->>'rule' as rule,
              created_at::text as created
         from ledger_outbox where user_id = $1`, [req.userId])).rows) {
      outbox.set(keyOf({ sourceType: r.source_type, sourceId: Number(r.source_id), event: r.event }), r);
    }
    const started = (await c.query(`select ledger_started_at is not null as s from finance_settings where account_user_id = $1`, [req.userId])).rows[0]?.s === true;

    const counts = { total: events.length, new: 0, alreadyPosted: 0, alreadyQueued: 0, alreadyHandled: 0, byType: {} as Record<string, number> };
    const toInsert: PlannedEvent[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      const o = outbox.get(k);
      if (posted.has(k)) counts.alreadyPosted++;
      else if (o && (o.status === "pending" || o.status === "failed")) counts.alreadyQueued++;
      else if (o) counts.alreadyHandled++;
      else {
        counts.new++;
        counts.byType[e.code] = (counts.byType[e.code] ?? 0) + 1;
        toInsert.push(e);
      }
    }

    // A ledger that has not started: the live events queued meanwhile join the chronological order.
    const moves: PlannedEvent[] = [];
    if (!started) {
      for (const [k, o] of outbox) {
        if (o.status !== "pending" || posted.has(k)) continue;
        const code = String(o.event).startsWith("reversal:") ? "reversal" : (o.rule ?? "reversal");
        moves.push({
          sourceType: o.source_type, sourceId: Number(o.source_id), event: o.event, occurredOn: o.occurred_on,
          payload: undefined as any, rank: rankOf(code), sourceCreatedAt: o.created, sub: code === "reversal" ? 9 : code === "E34" ? 1 : 0, code,
          ...({ outboxId: Number(o.id) } as any),
        });
      }
    }
    const all = [...toInsert, ...moves].sort(compareEvents);
    const origin = run.origin;
    const runId = run.runId;
    const ids: number[] = [];
    for (const e of all) {
      const outboxId = (e as any).outboxId as number | undefined;
      if (outboxId) {
        const r = await c.query(
          `update ledger_outbox set id = nextval(pg_get_serial_sequence('ledger_outbox', 'id')), blocked_on = null, next_attempt_at = now()
            where id = $1 and user_id = $2 returning id`,
          [outboxId, req.userId],
        );
        if (r.rows[0]) ids.push(Number(r.rows[0].id));
        continue;
      }
      const r = await c.query(
        `insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, origin, payload, backfill_run_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         on conflict (user_id, source_type, source_id, event) do nothing returning id`,
        [req.userId, e.sourceType, e.sourceId, e.event, e.occurredOn, origin, JSON.stringify(e.payload), runId],
      );
      if (r.rows[0]) ids.push(Number(r.rows[0].id));
    }
    return { counts, notes, ids };
  }

  // ── draining ────────────────────────────────────────────────────────────

  /** Post through the engine (per-row transactions) until nothing moves. The caller holds the account lock. */
  private async drain(userId: number): Promise<void> {
    for (let i = 0; i < 100_000; i++) {
      const r = await this.engine.processAccount(userId, 500);
      if (r.posted + r.skipped + r.failed + r.retry === 0) return;
    }
  }

  /** The dry run's drain: every row on the one rolled-back transaction. */
  private async drainOn(c: Fv2Client, userId: number): Promise<void> {
    for (let i = 0; i < 100_000; i++) {
      const ids = (await c.query(`select id from ledger_outbox where user_id = $1 and status = 'pending' order by id`, [userId])).rows;
      let moved = 0;
      for (const r of ids) {
        const o = await this.engine.processRowOn(c, userId, Number(r.id));
        if (o === "posted" || o === "skipped" || o === "failed") moved++;
      }
      if (moved === 0) return;
    }
  }

  // ── cutover: the opening proposal ───────────────────────────────────────

  private async hasOpening(userId: number): Promise<boolean> {
    const r = await this.pool.query(
      `select 1 from manual_journals where user_id = $1 and kind = 'opening' and status not in ('void','rejected') limit 1`, [userId]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * The opening entry proposal for a cutover at D (§6.2): a FULL backfill up
   * to D−1 is simulated in a rolled-back transaction with the same rules, and
   * the sub-ledger balances it leaves become the opening lines: AR (with
   * tenant credit balances), 2131 per installment, DEP, LP, 2122/1122 per
   * contract and landlord, output and input VAT of the unfiled VAT period
   * holding D−1, and 3900 for the difference. Bank and cash are never
   * inferred; the user adds them on the opening screen.
   */
  async proposeOpening(userId: number, D: string, mode?: AccountingMode | null): Promise<OpeningProposal> {
    if (!ISO.test(D)) throw new BadRequestException("date must be YYYY-MM-DD");
    // Under the account's posting lock, like a run: the simulation allocates entry numbers.
    return this.worker.withAccountLock(userId, () => this.simulateOpening(userId, D, mode));
  }

  /** The caller holds the account lock (a run does; the API route goes through proposeOpening). */
  private async simulateOpening(userId: number, D: string, mode?: AccountingMode | null): Promise<OpeningProposal> {
    const settings = (await this.pool.query(`select accounting_mode, vat_filing_frequency from finance_settings where account_user_id = $1`, [userId])).rows[0];
    const m: AccountingMode = (settings?.accounting_mode ?? mode ?? "manager") as AccountingMode;
    const dayBefore = addDays(D, -1);
    const vatPeriod = vatPeriodOf(dayBefore, settings?.vat_filing_frequency === "monthly" ? "monthly" : "quarterly");
    return this.inRollback(async (c) => {
      const s = await this.prepareSimulation(c, userId, m);
      // Live events dated on or after D are not part of the opening.
      await c.query(`update ledger_outbox set status = 'dismissed' where user_id = $1 and status in ('pending','failed') and occurred_on >= $2`, [userId, D]);
      await c.query(`update finance_settings set ledger_started_at = null where account_user_id = $1`, [userId]);
      // A previous cutover's opening markers stand for what this simulation re-derives.
      await c.query(`delete from finance_installment_charges where user_id = $1 and entry_id is null`, [userId]);
      await this.plan(c, userId, s, { today: D, upTo: D }, { origin: "backfill", runId: null });
      await this.drainOn(c, userId);

      const keys = [SYS.ar, SYS.arAgency, SYS.ur, SYS.dep, SYS.lp, SYS.lpu];
      const bal = await c.query(
        `select a.id, a.code, l.owner_id, l.property_id, l.unit_id, l.tenant_id, l.contract_id,
                case when a.system_key in ($4, $5, $6) then l.payment_id end as payment_id,
                sum(l.debit - l.credit)::text as bal
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
           join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
          where l.user_id = $1 and a.system_key = any($2::text[]) and l.entry_date < $3 and e.origin <> 'opening'
          group by 1, 2, 3, 4, 5, 6, 7, 8
         having sum(l.debit - l.credit) <> 0
          order by a.code, l.contract_id nulls first, 8 nulls first, l.tenant_id nulls first, l.owner_id nulls first`,
        [userId, keys, D, SYS.ar, SYS.arAgency, SYS.ur],
      );
      const vat = await c.query(
        `select a.id, a.code, sum(l.debit - l.credit)::text as bal
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
           join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
          where l.user_id = $1 and a.system_key = any($2::text[]) and l.entry_date between $3 and $4 and e.origin <> 'opening'
          group by 1, 2 having sum(l.debit - l.credit) <> 0 order by a.code`,
        [userId, [SYS.outputVat, SYS.inputVat], vatPeriod.from, dayBefore],
      );
      const lines: ProposalLine[] = [];
      let net = 0;
      const add = (r: any) => {
        const b = toHalalas(r.bal);
        net += b;
        lines.push({
          accountId: Number(r.id), code: r.code, debit: b > 0 ? fromHalalas(b) : "0.00", credit: b < 0 ? fromHalalas(-b) : "0.00", memo: null,
          ownerId: r.owner_id ?? null, propertyId: r.property_id ?? null, unitId: r.unit_id ?? null, tenantId: r.tenant_id ?? null,
          contractId: r.contract_id ?? null, paymentId: r.payment_id ?? null,
        });
      };
      bal.rows.forEach(add);
      vat.rows.forEach(add);
      if (net !== 0) {
        const eq = (await c.query(`select id, code from accounts where user_id = $1 and system_key = 'opening_balance_equity'`, [userId])).rows[0];
        if (!eq) throw new ConflictException({ error: "MISSING_ACCOUNT", message: "The chart has no opening balance equity account" });
        lines.push({
          accountId: Number(eq.id), code: eq.code, debit: net < 0 ? fromHalalas(-net) : "0.00", credit: net > 0 ? fromHalalas(net) : "0.00",
          memo: null, ownerId: null, propertyId: null, unitId: null, tenantId: null, contractId: null, paymentId: null,
        });
      }
      const charges = (await c.query(
        `select payment_id, to_char(charged_on,'YYYY-MM-DD') as on, charged_by, document_id, amount::text as amount, vat_amount::text as vat
           from finance_installment_charges where user_id = $1 and reversed_at is null order by payment_id`,
        [userId],
      )).rows.map((r: any) => ({ paymentId: Number(r.payment_id), chargedOn: r.on, chargedBy: r.charged_by, documentId: r.document_id ?? null, amount: r.amount, vatAmount: r.vat }));
      return { date: dayBefore, lines, charges, vatPeriod };
    });
  }

  /** The charge markers active at D−1, so post-cutover events see those installments as charged (entry_id null: charged in the opening). */
  private async insertMarkers(c: Fv2Client, userId: number, p: OpeningProposal): Promise<void> {
    for (const m of p.charges) {
      await c.query(
        `insert into finance_installment_charges (payment_id, generation, user_id, charged_on, charged_by, document_id, amount, vat_amount, entry_id)
         select $1, coalesce(max(generation), 0) + 1, $2, $3, $4, $5, $6, $7, null from finance_installment_charges where payment_id = $1
         having not exists (select 1 from finance_installment_charges where payment_id = $1 and reversed_at is null)`,
        [m.paymentId, userId, m.chargedOn, m.chargedBy, m.documentId, m.amount, m.vatAmount],
      );
    }
  }

  private async insertOpeningDraft(c: Fv2Client, userId: number, actorId: number, p: OpeningProposal): Promise<number | null> {
    if (p.lines.length < 2) return null;
    const lines = p.lines.map((l) => ({
      accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo,
      ...(l.ownerId ? { ownerId: l.ownerId } : {}), ...(l.propertyId ? { propertyId: l.propertyId } : {}), ...(l.unitId ? { unitId: l.unitId } : {}),
      ...(l.tenantId ? { tenantId: l.tenantId } : {}), ...(l.contractId ? { contractId: l.contractId } : {}), ...(l.paymentId ? { paymentId: l.paymentId } : {}),
    }));
    const r = await c.query(
      `insert into manual_journals (user_id, kind, status, entry_date, memo, lines, created_by)
       values ($1, 'opening', 'draft', $2, $3, $4::jsonb, $5) returning id`,
      [userId, p.date, "الأرصدة الافتتاحية (مقترح الترحيل) / Opening balances (cutover proposal)", JSON.stringify(lines), actorId],
    );
    return Number(r.rows[0].id);
  }

  // ── catch-up check used by the period close (§8.1) ──────────────────────

  /** Keys a catch-up would add that are dated in [from, to]; nothing is written. */
  async missingKeys(userId: number, from: string, to: string, today = riyadhToday()): Promise<Array<{ sourceType: string; sourceId: number; event: string; date: string }>> {
    return this.inRollback(async (c) => {
      const s = await loadSettings(sqlOf(c), userId);
      if (!s) return [];
      const { events } = await extractEvents(sqlOf(c), userId, s, { today, from: s.goLive });
      const known = new Set<string>();
      for (const r of (await c.query(`select source_type, source_id, event from ledger_outbox where user_id = $1
                                      union select source_type, source_id, event from journal_entries where user_id = $1`, [userId])).rows) {
        known.add(keyOf({ sourceType: r.source_type, sourceId: Number(r.source_id), event: r.event }));
      }
      return events
        .filter((e) => e.occurredOn >= from && e.occurredOn <= to && !known.has(keyOf(e)))
        .map((e) => ({ sourceType: e.sourceType, sourceId: e.sourceId, event: e.event, date: e.occurredOn }));
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async inRollback<T>(fn: (c: Fv2Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      return await fn(c);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }

  /** Inside a rolled-back transaction: make the account look enabled, with a chart, in `mode`. */
  private async prepareSimulation(c: Fv2Client, userId: number, mode: AccountingMode): Promise<FinanceSettingsRow> {
    await c.query(
      `insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, true, $2)
       on conflict (account_user_id) do update set finance_v2_enabled = true, accounting_mode = coalesce(finance_settings.accounting_mode, excluded.accounting_mode)`,
      [userId, mode],
    );
    await this.setup.firstEnable(c, userId, null);
    const s = await loadSettings(sqlOf(c), userId);
    if (!s) throw new Error("fv2: simulation settings missing");
    return s;
  }

  private async maxEntryId(q: Pick<Fv2Client, "query"> | Fv2Pool, userId: number): Promise<number> {
    return Number((await q.query(`select coalesce(max(id), 0) as m from journal_entries where user_id = $1`, [userId])).rows[0].m);
  }

  private async summarize(
    q: Pick<Fv2Client, "query"> | Fv2Pool, req: BackfillRequest, runId: number, today: string, since: number,
    plan: { counts: BackfillSummary["events"]; notes: Record<string, Note>; ids: number[] },
    opening: BackfillSummary["opening"], rec: BackfillSummary["recognizer"],
  ): Promise<BackfillSummary> {
    const u = req.userId;
    const entries = Number((await q.query(`select count(*)::int as n from journal_entries where user_id = $1 and id > $2`, [u, since])).rows[0].n);
    const rows = (await q.query(
      `select source_type, source_id::int as source_id, event, status, skip_reason, last_error_code, last_error, attempts
         from ledger_outbox where user_id = $1 and (id = any($2::bigint[]) or backfill_run_id = $3)`, [u, plan.ids, runId])).rows;
    const skipped: Record<string, number> = {};
    const failed: BackfillSummary["failed"] = [];
    let pending = 0;
    for (const r of rows) {
      if (r.status === "skipped") skipped[r.skip_reason ?? "unknown"] = (skipped[r.skip_reason ?? "unknown"] ?? 0) + 1;
      if (r.status === "failed" || (r.status === "pending" && r.attempts > 0)) {
        failed.push({ sourceType: r.source_type, sourceId: r.source_id, event: r.event, code: r.last_error_code, error: r.last_error });
      } else if (r.status === "pending") pending++;
    }
    const tb = (await q.query(
      `select a.code, a.name_en, a.name_ar, sum(l.debit)::text as d, sum(l.credit)::text as c
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 group by a.code, a.name_en, a.name_ar order by a.code`, [u])).rows;
    let td = 0;
    let tc = 0;
    const trialBalance = tb.map((r: any) => {
      td += toHalalas(r.d);
      tc += toHalalas(r.c);
      return { code: r.code, nameEn: r.name_en, nameAr: r.name_ar, debit: r.d, credit: r.c };
    });
    const ctl = (await q.query(
      `select a.system_key as k, sum(l.debit - l.credit)::text as b
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key = any($2::text[]) group by a.system_key`,
      [u, [SYS.ar, SYS.arAgency, SYS.dep, SYS.lp, SYS.lpu, SYS.ur]])).rows;
    const bal = (k: string) => toHalalas(ctl.find((r: any) => r.k === k)?.b ?? "0");
    const controls: BackfillSummary["controls"] = {
      AR: { ledger: fromHalalas(bal(SYS.ar) + bal(SYS.arAgency)), subledger: null, diff: null },
      DEP: { ledger: fromHalalas(-bal(SYS.dep)), subledger: null, diff: null },
      LP: { ledger: fromHalalas(-bal(SYS.lp)), subledger: null, diff: null },
      LPU: { ledger: fromHalalas(-bal(SYS.lpu)), subledger: null, diff: null },
      UR: { ledger: fromHalalas(-bal(SYS.ur)), subledger: null, diff: null },
    };
    const warn = (await q.query(
      `select w, count(*)::int as n, to_json((array_agg(json_build_object('sourceType', source_type, 'sourceId', source_id::int, 'date', to_char(original_date,'YYYY-MM-DD')) order by id))[1:10]) as sample
         from journal_entries, unnest(warnings) w where user_id = $1 and id > $2 group by w order by w`, [u, since])).rows;
    const warnings: BackfillSummary["warnings"] = warn.map((r: any) => ({ code: r.w, count: r.n, sample: r.sample }));
    for (const [code, n] of Object.entries(plan.notes)) {
      const w = warnings.find((x) => x.code === code);
      if (w) w.count += n.count;
      else warnings.push({ code, count: n.count, sample: n.sample });
    }
    const late = (await q.query(
      `select entry_no, to_char(original_date,'YYYY-MM-DD') as od, to_char(entry_date,'YYYY-MM-DD') as ed, source_type, source_id::int as sid, event
         from journal_entries where user_id = $1 and id > $2 and is_late order by id limit 200`, [u, since])).rows;
    const sample = (await q.query(
      `select e.id, e.entry_no, to_char(e.entry_date,'YYYY-MM-DD') as d, e.source_type, e.source_id::int as sid, e.event,
              json_agg(json_build_object('code', a.code, 'debit', l.debit::text, 'credit', l.credit::text) order by l.line_no) as lines
         from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
        where e.user_id = $1 and e.id > $2 group by e.id order by e.id limit 20`, [u, since])).rows;
    return {
      runId, account: u, mode: req.mode, dryRun: req.dryRun, asOf: today, cutover: req.cutover ?? null,
      events: plan.counts,
      entries: { count: entries, skipped },
      failed, pending,
      trialBalance, totals: { debit: fromHalalas(td), credit: fromHalalas(tc) },
      controls, warnings,
      lateEntries: late.map((r: any) => ({ entryNo: r.entry_no, originalDate: r.od, entryDate: r.ed, sourceType: r.source_type, sourceId: r.sid, event: r.event })),
      sampleEntries: sample.map((r: any) => ({ entryNo: r.entry_no, date: r.d, sourceType: r.source_type, sourceId: r.sid, event: r.event, lines: r.lines })),
      opening, recognizer: rec,
    };
  }
}

