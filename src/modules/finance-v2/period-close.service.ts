import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { JournalRepository, type LineInput } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { PostingWorker } from "./posting-worker.service";
import { RecognizerService } from "./recognizer.service";
import { BackfillService } from "./backfill/backfill.service";
import { riyadhToday } from "./dates";
import { fromHalalas, toHalalas } from "./money";
import { auditRow, mapLedgerError, requireReason, settingsEvent } from "./audit";

const PCOLS = `id, fiscal_year as "fiscalYear", period_no as "periodNo", to_char(starts_on,'YYYY-MM-DD') as "startsOn",
  to_char(ends_on,'YYYY-MM-DD') as "endsOn", status, vat_locked_at as "vatLockedAt", closed_at as "closedAt", closed_by as "closedBy",
  reopened_at as "reopenedAt", reopened_by as "reopenedBy", reopen_reason as "reopenReason"`;

type Period = { id: number; fiscalYear: number; periodNo: number; startsOn: string; endsOn: string; status: "open" | "closed" | "locked" };

/**
 * Fiscal periods: close, reopen, lock and year close (DESIGN §8.1, §2.3.3).
 *
 *  - Close refuses (409) a period that has not ended, an earlier open period,
 *    postings the catch-up would still add, pending or failed outbox rows
 *    dated in it, and submitted manual journals. It first runs the recognizer
 *    and the worker for the account so charges and releases of the month are
 *    in. Drafts are only a warning. A TB snapshot hash is stored in
 *    finance_settings_events.
 *  - Reopen: a reason; refused when locked, when a later period is closed or
 *    when the year has a closing entry.
 *  - Lock: irreversible, from closed only.
 *  - Close refuses period 12 (USE_CLOSE_YEAR): December closes with the year.
 *  - Close year: the previous year closed if it has P&L (PRIOR_YEAR_OPEN);
 *    periods 1–11 closed; posts the closing entry (P&L to 3300, origin
 *    `closing`) dated the last day of period 12, then closes it (a period 12
 *    already closed as a month still takes the entry; locked is refused).
 * Every action writes an audit_logs row in its transaction.
 */
@Injectable()
export class PeriodCloseService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly periods: PeriodsService,
    private readonly journal: JournalRepository,
    private readonly worker: PostingWorker,
    private readonly recognizer: RecognizerService,
    private readonly backfill: BackfillService,
  ) {}

  async list(scope: number, q: { fiscalYear?: string | number } = {}) {
    const p: unknown[] = [scope];
    let where = "user_id = $1";
    if (q.fiscalYear != null && q.fiscalYear !== "") {
      const fy = Number(q.fiscalYear);
      if (!Number.isInteger(fy)) throw new BadRequestException("fiscalYear must be a year");
      p.push(fy);
      where += " and fiscal_year = $2";
    }
    return (await this.pool.query(`select ${PCOLS} from fiscal_periods where ${where} order by starts_on`, p)).rows;
  }

  async close(scope: number, user: AuthUser, id: number, body: any = {}, today = riyadhToday()) {
    const p = await this.load(this.pool, scope, id);
    if (p.periodNo === 12) {
      // Closing December as a month would shut the year out of its closing entry (reopen is refused once it is closed).
      throw new ConflictException({ error: "USE_CLOSE_YEAR", message: "Period 12 closes with the year-end close" });
    }
    const warnings = await this.closeChecks(scope, p, today);
    try {
      return await withTx(this.pool, async (c) => {
        const cur = await this.load(c, scope, id, true);
        if (cur.status !== "open") throw new ConflictException({ error: "PERIOD_NOT_OPEN", message: `The period is ${cur.status}` });
        await this.markClosed(c, scope, user, cur, typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "period close");
        return { period: await this.load(c, scope, id), warnings };
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  async reopen(scope: number, user: AuthUser, id: number, body: any) {
    const reason = requireReason(body);
    return withTx(this.pool, async (c) => {
      const p = await this.load(c, scope, id, true);
      if (p.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "A locked period cannot be reopened" });
      if (p.status === "open") throw new ConflictException({ error: "PERIOD_NOT_CLOSED", message: "The period is already open" });
      const later = await c.query(`select 1 from fiscal_periods where user_id = $1 and starts_on > $2 and status <> 'open' limit 1`, [scope, p.startsOn]);
      if (later.rowCount) throw new ConflictException({ error: "LATER_PERIOD_CLOSED", message: "Reopen the later closed periods first" });
      if (await this.yearClosed(c, scope, p.fiscalYear)) {
        throw new ConflictException({ error: "YEAR_CLOSED", message: "The fiscal year has a closing entry" });
      }
      await c.query(
        `update fiscal_periods set status = 'open', reopened_at = now(), reopened_by = $3, reopen_reason = $4 where id = $1 and user_id = $2`,
        [id, scope, user.id, reason]);
      await settingsEvent(c, scope, user.id, "period_reopen", { periodId: id, status: p.status }, { periodId: id, status: "open" }, reason);
      await auditRow(c, scope, user.id, "finance_v2_period", id, `/finance/v2/periods/${id}/reopen`);
      return this.load(c, scope, id);
    });
  }

  async lock(scope: number, user: AuthUser, id: number, body: any) {
    const reason = requireReason(body);
    return withTx(this.pool, async (c) => {
      const p = await this.load(c, scope, id, true);
      if (p.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "The period is already locked" });
      if (p.status !== "closed") throw new ConflictException({ error: "PERIOD_NOT_CLOSED", message: "Close the period before locking it" });
      await c.query(`update fiscal_periods set status = 'locked' where id = $1 and user_id = $2`, [id, scope]);
      await settingsEvent(c, scope, user.id, "period_lock", { periodId: id, status: "closed" }, { periodId: id, status: "locked" }, reason);
      await auditRow(c, scope, user.id, "finance_v2_period", id, `/finance/v2/periods/${id}/lock`);
      return this.load(c, scope, id);
    });
  }

  async closeYear(scope: number, user: AuthUser, body: any, today = riyadhToday()) {
    const fy = Number(body?.fiscalYear);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2200) throw new BadRequestException("fiscalYear is required");
    await this.periods.ensureFiscalYear(this.pool, scope, fy);
    // The previous year's P&L must be closed to retained earnings first, or it sits in "current year" forever.
    const prior = await this.pool.query(
      `select 1 from fiscal_periods fp where fp.user_id = $1 and fp.fiscal_year = $2 and fp.period_no = 1
          and exists (select 1 from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
                        join fiscal_periods p12 on p12.user_id = fp.user_id and p12.fiscal_year = fp.fiscal_year and p12.period_no = 12
                       where l.user_id = fp.user_id and a.type in ('revenue','expense') and l.entry_date between fp.starts_on and p12.ends_on)
          and not exists (select 1 from journal_entries e where e.user_id = fp.user_id and e.origin = 'closing' and e.status = 'posted' and e.source_type = 'fiscal_year'
                             and e.source_id = fp.fiscal_year and e.event = 'closing')`,
      [scope, fy - 1]);
    if (prior.rowCount) throw new ConflictException({ error: "PRIOR_YEAR_OPEN", message: `Close fiscal year ${fy - 1} first` });
    const all = (await this.pool.query(`select ${PCOLS} from fiscal_periods where user_id = $1 and fiscal_year = $2 order by period_no`, [scope, fy])).rows as Period[];
    const p12 = all.find((p) => p.periodNo === 12)!;
    if (all.some((p) => p.periodNo < 12 && p.status === "open")) {
      throw new ConflictException({ error: "EARLIER_PERIOD_OPEN", message: "Close periods 1 to 11 first" });
    }
    if (await this.yearClosed(this.pool, scope, fy)) throw new ConflictException({ error: "YEAR_CLOSED", message: "The year is already closed" });
    if (p12.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "Period 12 is locked" });
    // Period 12 may already be closed as an ordinary month (before close() refused it); the closing entry is allowed in a closed period.
    const warnings = await this.closeChecks(scope, p12, today, p12.status === "closed");
    const start = all.find((p) => p.periodNo === 1)!.startsOn;
    try {
      return await withTx(this.pool, async (c) => {
        const cur = await this.load(c, scope, p12.id, true);
        if (cur.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "Period 12 is locked" });
        const bal = await c.query(
          `select l.account_id as id, sum(l.debit - l.credit)::text as b
             from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
             join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
            where l.user_id = $1 and a.type in ('revenue','expense') and l.entry_date between $2 and $3 and e.origin <> 'closing'
            group by l.account_id having sum(l.debit - l.credit) <> 0 order by l.account_id`,
          [scope, start, p12.endsOn]);
        let entry: { id: number; entryNo: string } | null = null;
        if (bal.rows.length) {
          const re = (await c.query(`select id from accounts where user_id = $1 and system_key = 'retained_earnings'`, [scope])).rows[0];
          if (!re) throw new ConflictException({ error: "MISSING_ACCOUNT", message: "The chart has no retained earnings account" });
          const lines: LineInput[] = [];
          let net = 0;
          for (const r of bal.rows) {
            const b = toHalalas(r.b);
            net += b;
            lines.push(b > 0 ? { accountId: r.id, credit: b, memo: "closing" } : { accountId: r.id, debit: -b, memo: "closing" });
          }
          if (net !== 0) lines.push(net > 0 ? { accountId: re.id, debit: net, memo: "profit/loss" } : { accountId: re.id, credit: -net, memo: "profit/loss" });
          if (lines.length >= 2) {
            const res = await this.journal.post(c, {
              userId: scope, entryDate: p12.endsOn, origin: "closing", sourceType: "fiscal_year", sourceId: fy, event: "closing",
              memo: `إقفال السنة المالية ${fy} / Year-end close ${fy}`, payload: { fiscalYear: fy, result: fromHalalas(-net) }, createdBy: user.id, lines,
            });
            entry = { id: res.id, entryNo: res.entryNo };
          }
        }
        if (cur.status === "open") await this.markClosed(c, scope, user, cur, `year-end close ${fy}`);
        await settingsEvent(c, scope, user.id, "year_close", null, { fiscalYear: fy, closingEntryId: entry?.id ?? null }, `year-end close ${fy}`);
        await auditRow(c, scope, user.id, "finance_v2_fiscal_year", fy, `/finance/v2/periods/close-year`);
        return { fiscalYear: fy, closingEntry: entry, period: await this.load(c, scope, p12.id), warnings };
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** §8.1 close checks, outside any transaction (they run the recognizer and the worker). Returns warnings. */
  private async closeChecks(scope: number, p: Period, today: string, alreadyClosed = false): Promise<Array<{ code: string; count: number }>> {
    if (p.status !== "open" && !alreadyClosed) throw new ConflictException({ error: "PERIOD_NOT_OPEN", message: `The period is ${p.status}` });
    if (p.endsOn >= today) throw new ConflictException({ error: "PERIOD_NOT_ENDED", message: "A period cannot close before it has ended" });
    const earlier = await this.pool.query(`select 1 from fiscal_periods where user_id = $1 and starts_on < $2 and status = 'open' limit 1`, [scope, p.startsOn]);
    if (earlier.rowCount) throw new ConflictException({ error: "EARLIER_PERIOD_OPEN", message: "Close the earlier periods first" });
    const s = (await this.pool.query(`select ledger_started_at is not null as started from finance_settings where account_user_id = $1`, [scope])).rows[0];
    if (!s?.started) throw new ConflictException({ error: "LEDGER_NOT_STARTED", message: "Run the backfill before closing periods" });

    // Charges and releases of the month, then post what is due.
    await this.recognizer.runAccount(scope, today);
    for (let i = 0; i < 1000; i++) {
      const r = await this.worker.runAccount(scope, 500);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
    const missing = await this.backfill.missingKeys(scope, p.startsOn, p.endsOn, today);
    if (missing.length) {
      throw new ConflictException({ error: "MISSING_POSTINGS", message: `${missing.length} event(s) in this period are not in the ledger; run the catch-up backfill`, sample: missing.slice(0, 10) });
    }
    const pend = await this.pool.query(
      `select count(*)::int as n from ledger_outbox where user_id = $1 and status in ('pending','failed') and occurred_on between $2 and $3`,
      [scope, p.startsOn, p.endsOn]);
    if (pend.rows[0].n > 0) {
      throw new ConflictException({ error: "PENDING_POSTINGS", message: `${pend.rows[0].n} event(s) dated in this period are pending or failed; post or dismiss them first` });
    }
    const mj = await this.pool.query(
      `select count(*) filter (where status = 'submitted')::int as submitted, count(*) filter (where status = 'draft')::int as drafts
         from manual_journals where user_id = $1 and entry_date between $2 and $3`, [scope, p.startsOn, p.endsOn]);
    if (mj.rows[0].submitted > 0) {
      throw new ConflictException({ error: "MANUAL_PENDING_APPROVAL", message: `${mj.rows[0].submitted} manual journal(s) in this period await approval` });
    }
    return mj.rows[0].drafts > 0 ? [{ code: "manual_drafts", count: mj.rows[0].drafts }] : [];
  }

  private async markClosed(c: Fv2Client, scope: number, user: AuthUser, p: Period, reason: string) {
    const tb = await c.query(
      `select a.code, sum(l.debit)::text as d, sum(l.credit)::text as c
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2 group by a.code order by a.code`, [scope, p.endsOn]);
    const hash = createHash("sha256").update(tb.rows.map((r: any) => `${r.code}:${r.d}:${r.c}`).join("\n")).digest("hex");
    await c.query(`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = $3 where id = $1 and user_id = $2`, [p.id, scope, user.id]);
    await settingsEvent(c, scope, user.id, "period_close", { periodId: p.id, status: "open" },
      { periodId: p.id, status: "closed", startsOn: p.startsOn, endsOn: p.endsOn, tbHash: hash, accounts: tb.rows.length }, reason);
    await auditRow(c, scope, user.id, "finance_v2_period", p.id, `/finance/v2/periods/${p.id}/close`);
  }

  private async yearClosed(q: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, fy: number): Promise<boolean> {
    const r = await q.query(
      `select 1 from journal_entries where user_id = $1 and source_type = 'fiscal_year' and source_id = $2 and event = 'closing' and status = 'posted'`,
      [scope, fy]);
    return (r.rowCount ?? 0) > 0;
  }

  private async load(q: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, id: number, forUpdate = false): Promise<Period> {
    const r = await q.query(`select ${PCOLS} from fiscal_periods where id = $1 and user_id = $2 ${forUpdate ? "for update" : ""}`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException("Period not found");
    return r.rows[0];
  }
}
