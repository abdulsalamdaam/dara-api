import { Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { JournalRepository, assertBalanced, type LineInput } from "./journal.repository";
import { PeriodsService, type PeriodRow } from "./periods.service";
import { fromHalalas, toHalalas } from "./money";
import { CHARGE_STATE_RULES, runRule, SYS, RuleError, type OutboxPayload, type PostState, type RuleLine, type RuleOutput, type Effect } from "./rules";

export type Outcome = "posted" | "skipped" | "blocked" | "retry" | "failed" | "noop";

/** After this many attempts a row stops retrying and shows as failed (§5.3). */
export const MAX_ATTEMPTS = 8;

/** Backoff after the n-th failed attempt: min(2^n × 30 s, 6 h). */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 30_000, 6 * 3600_000);
}

/** Map an error to the posting-errors code (§5.3). */
export function errorCode(err: any): { code: string; permanent: boolean } {
  if (err instanceof RuleError) return { code: err.code, permanent: err.permanent };
  const msg = String(err?.message ?? "");
  if (/period closed/.test(msg)) return { code: "PERIOD_LOCKED", permanent: false };
  if (/VAT period locked/.test(msg)) return { code: "VAT_LOCKED", permanent: false };
  if (/is inactive/.test(msg)) return { code: "ACCOUNT_INACTIVE", permanent: false };
  if (/group account/.test(msg)) return { code: "ACCOUNT_GROUP", permanent: false };
  if (/unbalanced|line\(s\)|at least 2 lines/.test(msg)) return { code: "UNBALANCED", permanent: false };
  return { code: "POST_ERROR", permanent: false };
}

interface OutboxRow {
  id: number;
  user_id: number;
  source_type: string;
  source_id: number;
  event: string;
  occurred_on: string;
  origin: string;
  payload: OutboxPayload;
  attempts: number;
}

const REVERSAL = "reversal:";

/**
 * The posting engine (DESIGN §5.3, §5.4, §4.7). Processes ONE outbox row per
 * transaction:
 *   dependency check → post-time state → pure rule → reverse-and-replace →
 *   account resolution → period routing (late events go to the next open
 *   period, flagged) → JournalRepository.post (idempotent on the key) →
 *   state effects (charge markers, VAT points) → outbox `posted`.
 * A failure rolls the row's transaction back and is recorded with backoff,
 * outside it. Nothing here ever runs inside a user's request (§5.7).
 */
@Injectable()
export class PostingEngine {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly journal: JournalRepository,
    private readonly periods: PeriodsService,
  ) {}

  /**
   * Process up to `limit` due rows of one account in id order. The caller holds the account lock.
   * A row already found blocked is left out while its blocker cannot post in this batch (failed, or pending
   * and backing off): otherwise a few hundred rows blocked behind one failed charge fill every batch and the
   * rows after them (other installments too) are never reached. A blocker that is due is in the same batch,
   * before the row (lower id), so the row still posts right after it.
   */
  async processAccount(userId: number, limit = 200): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { posted: 0, skipped: 0, blocked: 0, retry: 0, failed: 0, noop: 0 };
    const ids = await this.pool.query(
      `select o.id from ledger_outbox o
        where o.user_id = $1 and o.status = 'pending' and o.next_attempt_at <= now()
          and not exists (select 1 from ledger_outbox b where b.id = o.blocked_on and b.user_id = o.user_id
                            and (b.status = 'failed' or (b.status = 'pending' and b.next_attempt_at > now())))
        order by o.id limit $2`,
      [userId, limit],
    );
    for (const r of ids.rows) counts[await this.processRow(userId, Number(r.id))]++;
    return counts;
  }

  async processRow(userId: number, outboxId: number): Promise<Outcome> {
    try {
      return await withTx(this.pool, (c) => this.processInTx(c, userId, outboxId));
    } catch (err) {
      return this.recordFailure(userId, outboxId, err);
    }
  }

  /**
   * Process one row on the CALLER's transaction, inside a savepoint (the
   * backfill dry run: everything is rolled back at the end). A failure rolls
   * back only the savepoint and marks the row `failed` in that same
   * transaction, with its code, so the dry run can report it; no retry.
   */
  async processRowOn(c: Fv2Client, userId: number, outboxId: number): Promise<Outcome> {
    await c.query("savepoint fv2_row");
    try {
      const out = await this.processInTx(c, userId, outboxId);
      await c.query("release savepoint fv2_row");
      return out;
    } catch (err) {
      await c.query("rollback to savepoint fv2_row");
      const { code } = errorCode(err);
      await c.query(
        `update ledger_outbox set status = 'failed', attempts = attempts + 1, last_error = $3, last_error_code = $4
          where id = $1 and user_id = $2`,
        [outboxId, userId, String((err as any)?.message ?? err).slice(0, 2000), code],
      );
      return "failed";
    }
  }

  private async processInTx(c: Fv2Client, userId: number, outboxId: number): Promise<Outcome> {
    const r = await c.query(
      `select id, user_id, source_type, source_id, event, to_char(occurred_on,'YYYY-MM-DD') as occurred_on, origin, payload, attempts
         from ledger_outbox where id = $1 and user_id = $2 and status = 'pending' for update skip locked`,
      [outboxId, userId],
    );
    const row: OutboxRow | undefined = r.rows[0];
    if (!row) return "noop";
    row.source_id = Number(row.source_id);

    // Idempotency: the key already posted (a replay, or another writer). Same payload → posted; else KEY_COLLISION.
    const existing = await c.query(
      `select id, (payload - 'late') = ($5::jsonb - 'late') as same from journal_entries
        where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`,
      [userId, row.source_type, row.source_id, row.event, JSON.stringify(row.payload)],
    );
    if (existing.rows[0]) {
      // A reversal is fully determined by its original, so an existing reversal (e.g. made by
      // reverse-and-replace) satisfies a later reversal event with the same key.
      if (!existing.rows[0].same && !row.event.startsWith(REVERSAL)) {
        throw new RuleError("KEY_COLLISION", "an entry with this key exists with a different payload", true);
      }
      await this.markPosted(c, row.id, Number(existing.rows[0].id));
      return "posted";
    }

    if (row.event.startsWith(REVERSAL)) return this.processReversal(c, row);

    const payload = row.payload;
    const pids = (payload.paymentIds ?? []).map(Number).filter((n) => Number.isInteger(n));
    if (CHARGE_STATE_RULES.has(payload.rule) && pids.length) {
      const blocker = await c.query(
        `select id from ledger_outbox o
          where o.user_id = $1 and o.id < $2 and o.status in ('pending','failed')
            and exists (select 1 from jsonb_array_elements_text(coalesce(o.payload->'paymentIds','[]'::jsonb)) e where e::int = any($3::int[]))
          order by o.id limit 1`,
        [userId, row.id, pids],
      );
      if (blocker.rows[0]) return this.block(c, row.id, Number(blocker.rows[0].id));
    }

    const state = await this.loadState(c, userId, pids);
    const out = runRule(payload, state);
    if (out.skip) {
      await c.query(
        `update ledger_outbox set status = 'skipped', skip_reason = $2, processed_at = now(), blocked_on = null, last_error = null, last_error_code = null where id = $1`,
        [row.id, out.skip],
      );
      return "skipped";
    }

    // Reverse-and-replace (§4.1): the document replaces an active due-date charge.
    for (const p of out.replaceDueCharges ?? []) {
      const ch = state.charges[p];
      if (ch?.entryId) await this.reverseEntry(c, userId, ch.entryId, out.date, { reason: "replaced_by_document" });
      await c.query(
        `update finance_installment_charges set reversed_at = now(), reversed_reason = 'replaced_by_document'
          where user_id = $1 and payment_id = $2 and reversed_at is null`,
        [userId, p],
      );
    }

    const origin = payload.entryOrigin ?? (row.origin === "backfill" || row.origin === "repair" ? "backfill" : "auto");
    const posted = await this.postLines(c, userId, row, out, origin);
    await this.applyEffects(c, userId, out.effects, posted.id);
    await this.markPosted(c, row.id, posted.id, posted.late);
    return "posted";
  }

  /** Resolve, route and post a rule's lines as the row's entry. */
  private async postLines(c: Fv2Client, userId: number, row: OutboxRow, out: RuleOutput, origin: "auto" | "backfill" | "manual" | "opening") {
    const { lines, warnings: resolveWarnings } = await this.resolveLines(c, userId, out.lines);
    assertBalanced(lines);
    const hasVat = lines.some((l) => l.taxRole || l.vatCategory);
    const route = await this.route(c, userId, out.date, hasVat, origin === "manual" || origin === "opening");
    const warnings = [...out.warnings, ...resolveWarnings, ...(route.isLate ? ["late_posting"] : [])];
    const res = await this.journal.post(c, {
      userId,
      entryDate: route.entryDate,
      originalDate: out.date,
      isLate: route.isLate,
      origin,
      sourceType: row.source_type,
      sourceId: row.source_id,
      event: row.event,
      memo: out.memo ?? null,
      payload: row.payload,
      warnings: [...new Set(warnings)],
      lines,
    });
    if (!res.created) throw new RuleError("KEY_RACE", "the key was posted concurrently; retrying");
    return { id: res.id, late: route.isLate ? { closedPeriodId: route.closedPeriodId, originalDate: out.date } : null };
  }

  /**
   * `reversal:<event>` (§5.4): mirror the original entry. Original still
   * pending/failed → blocked on it; skipped/dismissed/never queued → skipped
   * `nothing_to_reverse`; already reversed by another path → skipped.
   */
  private async processReversal(c: Fv2Client, row: OutboxRow): Promise<Outcome> {
    const origEvent = row.event.slice(REVERSAL.length);
    const orig = await c.query(
      `select id, status from journal_entries where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`,
      [row.user_id, row.source_type, row.source_id, origEvent],
    );
    const skip = async (reason: string): Promise<Outcome> => {
      await c.query(`update ledger_outbox set status = 'skipped', skip_reason = $2, processed_at = now(), blocked_on = null where id = $1`, [row.id, reason]);
      return "skipped";
    };
    if (!orig.rows[0]) {
      const ob = await c.query(
        `select id, status from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`,
        [row.user_id, row.source_type, row.source_id, origEvent],
      );
      const o = ob.rows[0];
      if (o && (o.status === "pending" || o.status === "failed")) return this.block(c, row.id, Number(o.id));
      return skip("nothing_to_reverse");
    }
    if (orig.rows[0].status !== "posted") return skip("already_reversed");
    const date = row.payload?.facts?.date ?? row.occurred_on;
    const res = await this.reverseEntry(c, row.user_id, Number(orig.rows[0].id), date, { payload: row.payload });
    // State owned by the reversed event.
    if (/^charge(:g\d+)?$/.test(origEvent) && row.source_type === "payment") {
      await c.query(
        `update finance_installment_charges set reversed_at = now(), reversed_reason = 'reversed'
          where user_id = $1 and payment_id = $2 and entry_id = $3 and reversed_at is null`,
        [row.user_id, row.source_id, Number(orig.rows[0].id)],
      );
    }
    if (origEvent === "confirmed" && row.source_type === "simple_invoice") {
      await c.query(
        `update finance_installment_charges set reversed_at = now(), reversed_reason = 'document_reversed'
          where user_id = $1 and document_id = $2 and charged_by = 'document' and reversed_at is null`,
        [row.user_id, row.source_id],
      );
    }
    if (origEvent === "advance_vat" && row.source_type === "payment_collection") {
      await c.query(`delete from finance_installment_vat_points where user_id = $1 and collection_id = $2`, [row.user_id, row.source_id]);
    }
    await this.markPosted(c, row.id, res.id, res.late);
    return "posted";
  }

  /** Post the mirror of an entry, routed like any event (§4.7), and mark the original reversed. */
  async reverseEntry(c: Fv2Client, userId: number, entryId: number, date: string, opts: { reason?: string; payload?: unknown; createdBy?: number | null } = {}) {
    const v = await c.query(
      `select exists (select 1 from journal_lines where entry_id = $1 and (tax_role is not null or vat_category is not null)) as has_vat`,
      [entryId],
    );
    const route = await this.route(c, userId, date, v.rows[0]?.has_vat === true, false);
    const res = await this.journal.reverse(c, userId, entryId, {
      entryDate: route.entryDate,
      originalDate: date,
      isLate: route.isLate,
      warnings: route.isLate ? ["late_posting"] : [],
      payload: opts.payload ?? { reason: opts.reason ?? null },
      createdBy: opts.createdBy ?? null,
    });
    return { id: res.id, late: route.isLate ? { closedPeriodId: route.closedPeriodId, originalDate: date } : null };
  }

  /**
   * §4.7: the entry date for an event dated `date`. Open (and, for VAT lines,
   * not VAT-locked) → that date. Otherwise the first day of the earliest such
   * period after it, created on demand; `isLate`. Manual journals are never
   * moved: they get PERIOD_CLOSED (the manual approval path returns 409).
   */
  async route(c: Fv2Client, userId: number, date: string, hasVat: boolean, noLate: boolean):
    Promise<{ entryDate: string; isLate: boolean; closedPeriodId: number | null }> {
    const ok = (p: PeriodRow) => p.status === "open" && !(hasVat && p.vatLocked);
    let p = await this.periods.ensurePeriod(c, userId, date);
    if (ok(p)) return { entryDate: date, isLate: false, closedPeriodId: null };
    if (noLate) throw new RuleError("PERIOD_CLOSED", `the period of ${date} is ${p.status}`, true);
    const closedPeriodId = p.id;
    for (let i = 0; i < 240; i++) {
      const next = nextDay(p.endsOn);
      const later = await c.query(
        `select to_char(starts_on,'YYYY-MM-DD') as s from fiscal_periods
          where user_id = $1 and starts_on >= $2 and status = 'open' ${hasVat ? "and vat_locked_at is null" : ""}
          order by starts_on limit 1`,
        [userId, next],
      );
      if (later.rows[0]) return { entryDate: later.rows[0].s, isLate: true, closedPeriodId };
      p = await this.periods.ensurePeriod(c, userId, next);
      if (ok(p)) return { entryDate: p.startsOn, isLate: true, closedPeriodId };
    }
    throw new RuleError("NO_OPEN_PERIOD", `no open period after ${date}`);
  }

  /** Ledger state the rules need, read inside the row's transaction (§5.3 step 2). */
  async loadState(c: Fv2Client, userId: number, paymentIds: number[]): Promise<PostState> {
    const state: PostState = { charges: {}, vatBooked: {}, baseBooked: {}, unreleased: {}, writtenOff: [] };
    if (!paymentIds.length) return state;
    const ch = await c.query(
      `select c.payment_id, c.generation, c.charged_by, c.document_id, c.amount::text as amount, c.vat_amount::text as vat, c.entry_id,
              (select l.vat_base::text from journal_lines l
                where l.entry_id = c.entry_id and l.tax_role = 'output' and l.vat_category = 'S' and l.payment_id = c.payment_id
                order by l.line_no limit 1) as vat_base,
              (select l.vat_category from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
                where l.entry_id = c.entry_id and l.payment_id = c.payment_id and l.credit > 0 and a.system_key = '${SYS.ur}'
                order by l.line_no limit 1) as category
         from finance_installment_charges c
        where c.user_id = $1 and c.payment_id = any($2::int[]) and c.reversed_at is null`,
      [userId, paymentIds],
    );
    for (const r of ch.rows) {
      state.charges[r.payment_id] = {
        generation: r.generation, chargedBy: r.charged_by, documentId: r.document_id,
        amount: toHalalas(r.amount), vatAmount: toHalalas(r.vat), vatBase: r.vat_base == null ? null : toHalalas(r.vat_base),
        entryId: r.entry_id == null ? null : Number(r.entry_id), category: r.category ?? null,
      };
    }
    const adv = await c.query(
      `select payment_id, coalesce(sum(credit - debit), 0)::text as vat, coalesce(sum(vat_base), 0)::text as base
         from journal_lines where user_id = $1 and payment_id = any($2::int[]) and doc_class = 'advance' and tax_role = 'output'
        group by payment_id`,
      [userId, paymentIds],
    );
    for (const r of adv.rows) {
      state.vatBooked[r.payment_id] = toHalalas(r.vat);
      state.baseBooked[r.payment_id] = toHalalas(r.base);
    }
    const ur = await c.query(
      `select l.payment_id, coalesce(sum(l.credit - l.debit), 0)::text as bal
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key = $3 and l.payment_id = any($2::int[])
        group by l.payment_id`,
      [userId, paymentIds, SYS.ur],
    );
    for (const r of ur.rows) state.unreleased[r.payment_id] = toHalalas(r.bal);
    const wo = await c.query(
      `select distinct unnest(payment_ids) as p from finance_write_offs where user_id = $1 and payment_ids && $2::int[]`,
      [userId, paymentIds],
    );
    state.writtenOff = wo.rows.map((r: any) => Number(r.p)).filter((p: number) => paymentIds.includes(p));
    return state;
  }

  /** Account refs → chart ids; bank refs → the cash/bank GL account and `bank_account_id` (§3). */
  async resolveLines(c: Fv2Client, userId: number, lines: RuleLine[]): Promise<{ lines: LineInput[]; warnings: string[] }> {
    const warnings: string[] = [];
    const keys = [...new Set(lines.flatMap((l) => ("sys" in l.account ? [l.account.sys] : [])))];
    const sysIds = new Map<string, number>();
    if (keys.length || lines.some((l) => "bank" in l.account)) {
      const r = await c.query(`select system_key, id from accounts where user_id = $1 and system_key = any($2::text[])`,
        [userId, [...keys, SYS.cash, SYS.bank]]);
      for (const x of r.rows) sysIds.set(x.system_key, x.id);
    }
    let settings: any = null;
    const bankCache = new Map<string, { accountId: number; bankAccountId: number | null }>();
    const bankFor = async (ref: { bankAccountId?: number | null; method?: string | null; agency?: boolean }) => {
      const k = JSON.stringify(ref);
      const hit = bankCache.get(k);
      if (hit) return hit;
      settings ??= (await c.query(
        `select default_cash_account_id, default_bank_account_id, agency_collections_to_trust from finance_settings where account_user_id = $1`,
        [userId],
      )).rows[0] ?? {};
      const byId = async (id: number | null | undefined, extra = "") => {
        if (!id) return null;
        const b = await c.query(`select id, gl_account_id from bank_accounts where user_id = $1 and id = $2 and is_active ${extra}`, [userId, id]);
        return b.rows[0] ? { accountId: b.rows[0].gl_account_id as number, bankAccountId: b.rows[0].id as number } : null;
      };
      let res = await byId(ref.bankAccountId);
      if (!res && ref.bankAccountId) warnings.push("bank_account_fallback");
      if (!res && ref.agency && settings.agency_collections_to_trust) {
        const t = await c.query(
          `select id, gl_account_id from bank_accounts where user_id = $1 and is_trust and is_default and is_active and kind = 'bank' order by id limit 1`, [userId]);
        if (t.rows[0]) res = { accountId: t.rows[0].gl_account_id, bankAccountId: t.rows[0].id };
      }
      const cash = String(ref.method ?? "").toLowerCase() === "cash";
      if (!res) res = await byId(cash ? settings.default_cash_account_id : settings.default_bank_account_id);
      if (!res) {
        const id = sysIds.get(cash ? SYS.cash : SYS.bank);
        if (!id) throw new RuleError("MISSING_ACCOUNT", `no ${cash ? "cash" : "bank"} account in the chart`);
        res = { accountId: id, bankAccountId: null };
      }
      bankCache.set(k, res);
      return res;
    };
    const out: LineInput[] = [];
    for (const l of lines) {
      let accountId: number;
      let bankAccountId: number | null = null;
      if ("sys" in l.account) {
        const id = sysIds.get(l.account.sys);
        if (!id) throw new RuleError("MISSING_ACCOUNT", `the chart has no account with system key ${l.account.sys}`);
        accountId = id;
      } else if ("bank" in l.account) {
        const b = await bankFor(l.account.bank);
        accountId = b.accountId;
        bankAccountId = b.bankAccountId;
      } else {
        accountId = l.account.id;
      }
      out.push({
        accountId, debit: l.debit, credit: l.credit, memo: l.memo ?? null,
        ownerId: l.dims.ownerId ?? null, propertyId: l.dims.propertyId ?? null, unitId: l.dims.unitId ?? null,
        tenantId: l.dims.tenantId ?? null, contractId: l.dims.contractId ?? null, paymentId: l.dims.paymentId ?? null,
        documentId: l.dims.documentId ?? null, bankAccountId,
        vatCategory: l.vatCategory ?? null, vatRate: l.vatRate ?? null, vatBase: l.vatBase ?? null,
        taxRole: l.taxRole ?? null, sellerKey: l.sellerKey ?? null, docClass: l.docClass ?? null,
      });
    }
    return { lines: out, warnings };
  }

  private async applyEffects(c: Fv2Client, userId: number, effects: Effect[], entryId: number): Promise<void> {
    for (const e of effects) {
      if (e.kind === "charge") {
        await c.query(
          `insert into finance_installment_charges (payment_id, generation, user_id, charged_on, charged_by, document_id, amount, vat_amount, entry_id)
           select $1, coalesce(max(generation), 0) + 1, $2, $3, $4, $5, $6, $7, $8
             from finance_installment_charges where payment_id = $1`,
          [e.paymentId, userId, e.chargedOn, e.chargedBy, e.documentId, fromHalalas(e.amount), fromHalalas(e.vatAmount), entryId],
        );
      } else if (e.kind === "uncharge") {
        await c.query(
          `update finance_installment_charges set reversed_at = now(), reversed_reason = $3
            where user_id = $1 and payment_id = $2 and reversed_at is null`,
          [userId, e.paymentId, e.reason],
        );
      } else if (e.kind === "vatPoint") {
        await c.query(
          `insert into finance_installment_vat_points (collection_id, payment_id, user_id, vat_booked, booked_on, entry_id)
           values ($1, $2, $3, $4, $5, $6) on conflict (collection_id) do nothing`,
          [e.collectionId, e.paymentId, userId, fromHalalas(e.vat), e.bookedOn, entryId],
        );
      } else if (e.kind === "vatUnpoint") {
        let left = e.vat;
        const pts = await c.query(
          `select collection_id, vat_booked::text as v from finance_installment_vat_points
            where user_id = $1 and payment_id = $2 order by booked_on desc, collection_id desc for update`,
          [userId, e.paymentId],
        );
        for (const r of pts.rows) {
          if (left <= 0) break;
          const v = toHalalas(r.v);
          if (v <= left) {
            await c.query(`delete from finance_installment_vat_points where user_id = $1 and collection_id = $2`, [userId, r.collection_id]);
            left -= v;
          } else {
            await c.query(`update finance_installment_vat_points set vat_booked = $3 where user_id = $1 and collection_id = $2`, [userId, r.collection_id, fromHalalas(v - left)]);
            left = 0;
          }
        }
      }
    }
  }

  private async markPosted(c: Fv2Client, outboxId: number, entryId: number, late: unknown = null): Promise<void> {
    await c.query(
      `update ledger_outbox set status = 'posted', entry_id = $2, processed_at = now(), blocked_on = null, last_error = null, last_error_code = null,
              payload = case when $3::jsonb is null then payload else payload || jsonb_build_object('late', $3::jsonb) end
        where id = $1`,
      [outboxId, entryId, late ? JSON.stringify(late) : null],
    );
  }

  private async block(c: Fv2Client, outboxId: number, blockerId: number): Promise<Outcome> {
    await c.query(`update ledger_outbox set blocked_on = $2 where id = $1`, [outboxId, blockerId]);
    return "blocked";
  }

  /** Outside the row's (rolled back) transaction: attempts, backoff, or failed (§5.3). */
  private async recordFailure(userId: number, outboxId: number, err: unknown): Promise<Outcome> {
    const { code, permanent } = errorCode(err);
    const msg = String((err as any)?.message ?? err).slice(0, 2000);
    const r = await this.pool.query(
      `update ledger_outbox
          set attempts = attempts + 1,
              last_error = $3, last_error_code = $4,
              status = case when $5 or attempts + 1 >= $6 then 'failed' else 'pending' end,
              next_attempt_at = now() + make_interval(secs => least(power(2, attempts + 1) * 30, 21600))
        where id = $1 and user_id = $2 and status = 'pending'
        returning status`,
      [outboxId, userId, msg, code, permanent, MAX_ATTEMPTS],
    );
    return r.rows[0]?.status === "failed" ? "failed" : "retry";
  }
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}
