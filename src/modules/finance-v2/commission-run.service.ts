import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit,
} from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Pool } from "./db";
import { LedgerEmitter } from "./ledger-emitter.service";
import { sqlOf, type Sql } from "./hooks/sql";
import { auditRow, isoDate, requireReason } from "./audit";
import { LOCK_KEYS } from "./lock-keys";
import { fromHalalas, toHalalas } from "./money";
import { riyadhToday, lastDayOfMonth, parseIsoDate } from "./dates";
import { nextDocNumber } from "./commission";
import { ownFeeCarriesVat } from "./account-seller";
import {
  collectedLines, commissionSettings, landlordInfo, lineBase, monthLabel, monthSpan, planLandlord, previewMonth, previousMonth, rateResolver,
  transferEvents, unsentCommission, type MonthPreview,
} from "./commission-run";

export { transferEvents } from "./commission-run";

/**
 * Issues (approves) a draft billing document exactly as `POST
 * /simple-invoices/:id/approve` does — the SAME handler, so the commission
 * invoice takes the one ZATCA path the product has (signer, chain, QR,
 * clearance/reporting) and posts E15/E36 through the same hook. Bound in the
 * module to the billing controller (commission-issuer.ts); the DB specs bind
 * it to their own controller instance.
 */
export const COMMISSION_ISSUER = Symbol("FV2_COMMISSION_ISSUER");
export interface CommissionIssuer {
  approve(scope: number, documentId: number): Promise<any>;
}

const bad = (error: string, message: string) => new BadRequestException({ error, message });
const conflict = (error: string, message: string) => new ConflictException({ error, message });

const BLOCKED_MESSAGES: Record<NonNullable<MonthPreview["blocked"]>, string> = {
  NOT_ENABLED: "المالية v2 غير مفعلة · Finance v2 is not enabled",
  LEDGER_NOT_STARTED: "لم يبدأ الدفتر بعد · The ledger has not started",
  NOT_MANAGER_MODE: "العمولة تخص نموذج مدير الأملاك · Commission applies in Manager mode only",
  BASIS_BILLED: "أساس العمولة «المفوتر»؛ غيّره إلى «المحصّل» من الإعدادات المالية · The commission basis is 'billed'; switch it to 'collected' in finance settings",
  MONTH_NOT_ENDED: "لم ينته الشهر بعد · The month has not ended yet",
  BEFORE_CUTOVER: "الشهر قبل بدء أساس التحصيل · The month is before the collected-basis cutover",
};

/** Scheduled run: from this Riyadh hour on the month's last day (and catch-up for the previous month any day after). */
const AUTO_RUN_HOUR = 23;
const CHECK_MS = 60_000;

export interface RunResult {
  ownerId: number;
  name: string;
  status: "issued" | "skipped" | "failed";
  reason?: string | null;
  runId?: number;
  documentId?: number;
  number?: string;
  net?: string;
  vat?: string;
  total?: string;
  zatcaStatus?: string | null;
  zatcaError?: string | null;
}

/**
 * The monthly commission run (DESIGN §9 E1 collected basis; commission-run.ts
 * has the arithmetic), its reversal, the scheduled month-end run and the
 * commission transfer (تحويل عمولات).
 *
 * Per landlord and month (idempotent: one live run per key):
 *  1. one transaction under the account's COMMISSION_RUN lock: the counted
 *     lines are recomputed, a draft COM document billed to the landlord
 *     (`client.kind = 'landlord'`, no contract) is written with the run row
 *     and the counted lines;
 *  2. the draft is approved through the billing approve handler: E15 posts
 *     (Dr 2121 gross / Cr 4210 net / Cr 2151 VAT) and, when the office is
 *     linked, the invoice is cleared (VAT-registered landlord) or reported
 *     (otherwise) under the OFFICE's ZATCA seller;
 *  3. if the approval throws, the draft, the run and its lines are removed,
 *     so the landlord-month can simply be run again.
 * Reversal: a commission credit note for the whole invoice, approved the same
 * way (E36, and a ZATCA credit note), then the run is 'reversed' and its lines
 * are free for the next run.
 */
@Injectable()
export class CommissionRunService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Commission");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly emitter: LedgerEmitter,
    @Optional() @Inject(COMMISSION_ISSUER) private readonly issuer?: CommissionIssuer,
  ) {}

  private q(): Sql {
    return sqlOf(this.pool as any);
  }

  // ─── Preview / run / list / reverse ──────────────────────────────────────

  async preview(scope: number, month: unknown): Promise<MonthPreview> {
    const span = monthSpan(month);
    if (!span) throw bad("BAD_MONTH", "month must be YYYY-MM");
    return previewMonth(this.q(), scope, span.month);
  }

  /** POST /finance/v2/commission-runs {month, ownerIds?}: issue the month's invoices (skips landlords already issued). */
  async run(scope: number, actor: { id: number } | null, body: any, origin: "manual" | "scheduled" = "manual") {
    const span = monthSpan(body?.month);
    if (!span) throw bad("BAD_MONTH", "month must be YYYY-MM");
    const only: number[] | null = Array.isArray(body?.ownerIds)
      ? body.ownerIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : null;
    const pv = await previewMonth(this.q(), scope, span.month);
    if (pv.blocked) throw conflict(`COMMISSION_${pv.blocked}`, BLOCKED_MESSAGES[pv.blocked]);
    const results: RunResult[] = [];
    for (const l of pv.landlords) {
      if (only && !only.includes(l.ownerId)) continue;
      if (l.skip) {
        results.push({ ownerId: l.ownerId, name: l.name, status: "skipped", reason: l.skip, runId: l.existingRunId ?? undefined });
        continue;
      }
      const res = await this.runLandlord(scope, span, l.ownerId, actor, origin);
      results.push({ ...res, name: res.name || l.name });
    }
    return { month: span.month, label: pv.label, results };
  }

  private async runLandlord(scope: number, span: { month: string; start: string; end: string }, ownerId: number,
    actor: { id: number } | null, origin: "manual" | "scheduled"): Promise<RunResult> {
    const label = monthLabel(span.month);
    const created = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.COMMISSION_RUN]);
      const q = sqlOf(c as any);
      const s = await commissionSettings(q, scope);
      if (!s) return { none: "not_enabled" } as const;
      const dup = await c.query(
        `select id from finance_commission_runs where user_id = $1 and owner_id = $2 and month = $3::date and status = 'issued'`, [scope, ownerId, span.start]);
      if (dup.rowCount) return { none: "already_issued", runId: Number(dup.rows[0].id) } as const;
      const lines = await collectedLines(q, scope, s.collectedFrom, span.end, ownerId);
      const info = await landlordInfo(q, scope, [ownerId]);
      const li = info.get(ownerId);
      if (!li) return { none: "landlord_not_found" } as const;
      const { rateFor, names } = await rateResolver(q, scope, lines, info);
      const vatRegistered = await ownFeeCarriesVat(q, scope);
      const plan = planLandlord(ownerId, lines, rateFor(ownerId), vatRegistered, names);
      if (plan.skip) return { none: plan.skip } as const;

      const today = riyadhToday();
      const number = await nextDocNumber(q, scope, "COM");
      const counted = plan.properties.filter((p) => !p.deferred);
      const items = counted.map((p) => {
        const amt = Number(fromHalalas(p.commission));
        return {
          description: `عمولة إدارة الأملاك — ${p.propertyName ?? li.name} — ${label.ar} (${p.pct}% × ${fromHalalas(p.base)}) · Management commission ${label.en}`,
          quantity: 1, unitPrice: amt, amount: amt, vat: vatRegistered, vatCategory: vatRegistered ? "S" : "O",
        };
      });
      const client = {
        kind: "landlord", ownerId, name: li.name,
        ...(li.taxNumber ? { vatNumber: li.taxNumber } : {}), ...(li.idNumber ? { idNumber: li.idNumber } : {}),
        ...(li.type ? { type: li.type } : {}), ...(li.email ? { email: li.email } : {}), ...(li.phone ? { phone: li.phone } : {}),
        commissionMonth: span.month,
      };
      const doc = await c.query(
        `insert into simple_invoices (user_id, number, type, kind, status, contract_id, tenant_id, tenant_name, client, items,
                                      subtotal, total, issue_date, due_date, notes)
         values ($1, $2, 'invoice', 'commission', 'draft', null, null, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $8, $9) returning id`,
        [scope, number, li.name, JSON.stringify(client), JSON.stringify(items), fromHalalas(plan.net), fromHalalas(plan.total), today,
          `عمولة إدارة الأملاك عن ${label.ar} على الإيجار المحصّل قبل الضريبة · Management commission for ${label.en} on rent collected (before VAT)`],
      );
      const documentId = Number(doc.rows[0].id);
      const detail = plan.properties.map((p) => ({
        propertyId: p.propertyId, propertyName: p.propertyName, collected: fromHalalas(p.collected), base: fromHalalas(p.base),
        pct: p.pct, source: p.source, commission: fromHalalas(p.commission), deferred: p.deferred,
      }));
      const run = await c.query(
        `insert into finance_commission_runs (user_id, owner_id, month, document_id, collected, base, net, vat, total, vat_registered, detail, origin, created_by)
         values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13) returning id`,
        [scope, ownerId, span.start, documentId,
          fromHalalas(plan.lines.reduce((x, l) => x + l.gross, 0)), fromHalalas(counted.reduce((x, p) => x + p.base, 0)),
          fromHalalas(plan.net), fromHalalas(plan.vat), fromHalalas(plan.total), vatRegistered, JSON.stringify(detail), origin, actor?.id ?? null],
      );
      const runId = Number(run.rows[0].id);
      for (const l of plan.lines) {
        await c.query(
          `insert into finance_commission_run_items (run_id, user_id, line_id, entry_id, payment_id, property_id, gross, base)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [runId, scope, l.lineId, l.entryId, l.paymentId, l.propertyId, fromHalalas(l.gross),
            fromHalalas(lineBase(l))],
        );
      }
      if (actor) await auditRow(c, scope, actor.id, "finance_v2_commission_run", runId, "/finance/v2/commission-runs");
      return { runId, documentId, number, plan, name: li.name } as const;
    });

    if ("none" in created) {
      return { ownerId, name: "", status: "skipped", reason: created.none, runId: (created as any).runId };
    }
    try {
      await this.issuerOrThrow().approve(scope, created.documentId);
    } catch (err: any) {
      await this.discardRun(scope, created.runId, created.documentId);
      const body = typeof err?.getResponse === "function" ? err.getResponse() : null;
      const msg = typeof body === "object" && body ? String((body as any).message ?? (body as any).error ?? err.message) : String(err?.message ?? err);
      this.log.warn(`commission run ${span.month} owner ${ownerId} (scope ${scope}) failed at approval: ${msg.split("\n")[0]}`);
      return { ownerId, name: created.name, status: "failed", reason: msg };
    }
    const [d] = await this.q().rows(`select status::text as status, zatca_status, zatca_error from simple_invoices where id = $1 and user_id = $2`, [created.documentId, scope]);
    return {
      ownerId, name: created.name, status: "issued", runId: created.runId, documentId: created.documentId, number: created.number,
      net: fromHalalas(created.plan.net), vat: fromHalalas(created.plan.vat), total: fromHalalas(created.plan.total),
      zatcaStatus: d?.zatca_status ?? null, zatcaError: d?.zatca_error ?? null,
    };
  }

  /** Undo step 1 when the approval refused: nothing was issued or posted. */
  private async discardRun(scope: number, runId: number, documentId: number): Promise<void> {
    await withTx(this.pool, async (c) => {
      await c.query(`delete from finance_commission_run_items where run_id = $1 and user_id = $2`, [runId, scope]);
      await c.query(`delete from finance_commission_runs where id = $1 and user_id = $2`, [runId, scope]);
      await c.query(`update simple_invoices set deleted_at = now() where id = $1 and user_id = $2 and status = 'draft'`, [documentId, scope]);
    });
  }

  /** GET /finance/v2/commission-runs?month: the runs, newest month first, with their invoices and ZATCA status. */
  async list(scope: number, q: any = {}) {
    const span = q?.month ? monthSpan(q.month) : null;
    if (q?.month && !span) throw bad("BAD_MONTH", "month must be YYYY-MM");
    const rows = await this.q().rows(
      `select r.id, r.owner_id, o.name as owner_name, to_char(r.month,'YYYY-MM') as month, r.status, r.origin,
              r.collected::text as collected, r.base::text as base, r.net::text as net, r.vat::text as vat, r.total::text as total,
              r.vat_registered, r.detail, r.created_at, r.reversed_at, r.reverse_reason,
              d.id as document_id, d.number, d.status::text as doc_status, d.zatca_status, d.zatca_error, to_char(d.issue_date,'YYYY-MM-DD') as issue_date,
              cd.id as credit_id, cd.number as credit_number, cd.zatca_status as credit_zatca_status, cd.zatca_error as credit_zatca_error
         from finance_commission_runs r
         left join owners o on o.id = r.owner_id and o.user_id = r.user_id
         left join simple_invoices d on d.id = r.document_id and d.user_id = r.user_id
         left join simple_invoices cd on cd.id = r.credit_document_id and cd.user_id = r.user_id
        where r.user_id = $1 and ($2::date is null or r.month = $2::date)
        order by r.month desc, o.name, r.id desc`,
      [scope, span?.start ?? null],
    );
    const s = await commissionSettings(this.q(), scope);
    return {
      settings: s ? { basis: s.basis, collectedFrom: s.collectedFrom, autoRun: s.autoRun, lastAutoMonth: s.lastAutoMonth, mode: s.mode } : null,
      rows: rows.map((r: any) => ({
        id: r.id, ownerId: r.owner_id, ownerName: r.owner_name ?? null, month: r.month, label: monthLabel(r.month), status: r.status, origin: r.origin,
        collected: r.collected, base: r.base, net: r.net, vat: r.vat, total: r.total, vatRegistered: r.vat_registered, detail: r.detail ?? [],
        createdAt: r.created_at, reversedAt: r.reversed_at, reverseReason: r.reverse_reason ?? null,
        document: r.document_id ? { id: r.document_id, number: r.number, status: r.doc_status, issueDate: r.issue_date, zatcaStatus: r.zatca_status ?? null, zatcaError: r.zatca_error ?? null } : null,
        creditNote: r.credit_id ? { id: r.credit_id, number: r.credit_number, zatcaStatus: r.credit_zatca_status ?? null, zatcaError: r.credit_zatca_error ?? null } : null,
      })),
    };
  }

  /** POST /finance/v2/commission-runs/:id/reverse {reason}: a commission credit note for the whole invoice; the lines return to the pool. */
  async reverse(scope: number, actor: { id: number }, runId: number, body: any) {
    const reason = requireReason(body);
    const prep = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.COMMISSION_RUN]);
      const r = (await c.query(`select * from finance_commission_runs where id = $1 and user_id = $2 for update`, [runId, scope])).rows[0];
      if (!r) throw new NotFoundException({ error: "RUN_NOT_FOUND", message: "Commission run not found" });
      if (r.status !== "issued") throw conflict("RUN_ALREADY_REVERSED", "هذه العمولة ملغاة مسبقاً · This commission is already reversed");
      const d = (await c.query(
        `select id, number, status::text as status, client, items, subtotal::text as subtotal, total::text as total from simple_invoices where id = $1 and user_id = $2`,
        [r.document_id, scope])).rows[0];
      if (!d) throw conflict("RUN_DOCUMENT_MISSING", "The commission invoice is missing");
      const existing = (await c.query(
        `select id, status::text as status from simple_invoices where user_id = $1 and type = 'credit' and kind = 'commission' and billing_reference = $2
            and deleted_at is null order by id limit 1`, [scope, d.number])).rows[0];
      if (existing) return { creditId: Number(existing.id), confirmed: existing.status === "confirmed", number: d.number };
      const q = sqlOf(c as any);
      const number = await nextDocNumber(q, scope, "CRN");
      const cr = await c.query(
        `insert into simple_invoices (user_id, number, type, kind, status, contract_id, tenant_id, tenant_name, client, items,
                                      subtotal, total, issue_date, billing_reference, notes)
         values ($1, $2, 'credit', 'commission', 'draft', null, null, (select tenant_name from simple_invoices where id = $3), $4::jsonb, $5::jsonb,
                 $6, $7, $8, $9, $10) returning id`,
        [scope, number, d.id, JSON.stringify(d.client ?? {}), JSON.stringify(d.items ?? []), d.subtotal, d.total, riyadhToday(), d.number,
          `إشعار دائن بإلغاء فاتورة العمولة ${d.number}: ${reason} · Commission invoice ${d.number} reversed: ${reason}`],
      );
      return { creditId: Number(cr.rows[0].id), confirmed: false, number: d.number };
    });
    if (!prep.confirmed) {
      try {
        await this.issuerOrThrow().approve(scope, prep.creditId);
      } catch (err) {
        await this.pool.query(`update simple_invoices set deleted_at = now() where id = $1 and user_id = $2 and status = 'draft'`, [prep.creditId, scope]);
        throw err;
      }
    }
    await withTx(this.pool, async (c) => {
      await c.query(
        `update finance_commission_runs set status = 'reversed', credit_document_id = $3, reversed_by = $4, reversed_at = now(), reverse_reason = $5
          where id = $1 and user_id = $2 and status = 'issued'`, [runId, scope, prep.creditId, actor.id, reason]);
      await c.query(`update finance_commission_run_items set live = false where run_id = $1 and user_id = $2`, [runId, scope]);
      await auditRow(c, scope, actor.id, "finance_v2_commission_run", runId, `/finance/v2/commission-runs/${runId}/reverse`);
    });
    return (await this.list(scope)).rows.find((r) => r.id === runId) ?? null;
  }

  // ─── Scheduled month-end run ──────────────────────────────────────────────

  async getSettings(scope: number) {
    const s = await commissionSettings(this.q(), scope);
    if (!s) throw new NotFoundException();
    return { basis: s.basis, collectedFrom: s.collectedFrom, autoRun: s.autoRun, lastAutoMonth: s.lastAutoMonth, mode: s.mode };
  }

  /** PATCH /finance/v2/commission-settings {autoRun, reason}. */
  async patchSettings(scope: number, actor: { id: number }, body: any) {
    const reason = requireReason(body);
    if (typeof body?.autoRun !== "boolean") throw bad("BAD_VALUE", "autoRun must be a boolean");
    await withTx(this.pool, async (c) => {
      const cur = (await c.query(`select auto_run from finance_commission_settings where account_user_id = $1`, [scope])).rows[0];
      await c.query(
        `insert into finance_commission_settings (account_user_id, auto_run, updated_by) values ($1, $2, $3)
         on conflict (account_user_id) do update set auto_run = excluded.auto_run, updated_by = excluded.updated_by, updated_at = now()`,
        [scope, body.autoRun, actor.id]);
      await c.query(
        `insert into finance_settings_events (account_user_id, actor_user_id, field, old_value, new_value, reason) values ($1, $2, 'commission_auto_run', $3::jsonb, $4::jsonb, $5)`,
        [scope, actor.id, JSON.stringify(cur ? cur.auto_run : true), JSON.stringify(body.autoRun), reason]);
      await auditRow(c, scope, actor.id, "finance_v2_settings", scope, "/finance/v2/commission-settings", "PATCH");
    });
    return this.getSettings(scope);
  }

  onModuleInit(): void {
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_COMMISSION_DISABLED === "1") return;
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The month the scheduler runs at `now`: this month from 23:00 on its last day (Riyadh), else the previous one (catch-up). */
  static dueMonth(now = new Date()): string {
    const day = now.toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
    const [h] = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    const { y, m, day: d } = parseIsoDate(day);
    const month = day.slice(0, 7);
    return d === lastDayOfMonth(y, m) && h >= AUTO_RUN_HOUR ? month : previousMonth(month);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runScheduled(CommissionRunService.dueMonth());
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`commission scheduler failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One scheduled pass for `month`: every account with the flag on, the
   * ledger started, Manager mode, the collected basis and auto-run on, that
   * has not had its scheduled run for that month. Never emails anyone.
   */
  async runScheduled(month: string): Promise<Array<{ scope: number; results: RunResult[] | null; error?: string }>> {
    const span = monthSpan(month)!;
    const r = await this.pool.query(
      `select fs.account_user_id from finance_settings fs left join finance_commission_settings cs on cs.account_user_id = fs.account_user_id
        where fs.finance_v2_enabled and fs.ledger_started_at is not null and fs.accounting_mode = 'manager' and fs.commission_basis = 'collected'
          and coalesce(cs.auto_run, true) and (cs.last_auto_month is null or cs.last_auto_month < $1::date)
        order by fs.account_user_id`,
      [span.start],
    );
    const out: Array<{ scope: number; results: RunResult[] | null; error?: string }> = [];
    for (const x of r.rows) {
      const scope = Number(x.account_user_id);
      try {
        const pv = await previewMonth(this.q(), scope, span.month);
        let results: RunResult[] | null = null;
        if (!pv.blocked) results = (await this.run(scope, null, { month: span.month }, "scheduled")).results;
        // BEFORE_CUTOVER / MONTH_NOT_ENDED mean "nothing to do for this month", recorded so the pass is not repeated.
        await this.pool.query(
          `insert into finance_commission_settings (account_user_id, last_auto_month) values ($1, $2::date)
           on conflict (account_user_id) do update set last_auto_month = excluded.last_auto_month`, [scope, span.start]);
        out.push({ scope, results });
      } catch (err: any) {
        this.log.warn(`scheduled commission run ${span.month} failed for scope ${scope}: ${err?.message ?? err}`);
        out.push({ scope, results: null, error: String(err?.message ?? err) });
      }
    }
    return out;
  }

  // ─── Commission transfer (تحويل عمولات) ──────────────────────────────────

  /** GET /finance/v2/commission-transfers: the transfers, the unsent commission and the default accounts to prefill. */
  async listTransfers(scope: number) {
    const q = this.q();
    const rows = await q.rows(
      `select t.id, t.number, to_char(t.transfer_date,'YYYY-MM-DD') as date, t.amount::text as amount, t.status, t.memo, t.void_reason,
              t.from_bank_account_id, t.to_bank_account_id, f.name_ar as from_ar, f.name_en as from_en, b.name_ar as to_ar, b.name_en as to_en,
              (select e.id from journal_entries e where e.user_id = t.user_id and e.source_type = 'commission_transfer' and e.source_id = t.id and e.event = 'posted') as entry_id,
              (select e.entry_no from journal_entries e where e.user_id = t.user_id and e.source_type = 'commission_transfer' and e.source_id = t.id and e.event = 'posted') as entry_no
         from finance_commission_transfers t
         left join bank_accounts f on f.id = t.from_bank_account_id and f.user_id = t.user_id
         left join bank_accounts b on b.id = t.to_bank_account_id and b.user_id = t.user_id
        where t.user_id = $1 order by t.transfer_date desc, t.id desc`,
      [scope],
    );
    const u = await unsentCommission(q, scope);
    const defaults = await this.defaultBoxes(q, scope);
    return {
      unsent: fromHalalas(u.unsent), booked: fromHalalas(u.booked), transferred: fromHalalas(u.transferred),
      defaults,
      rows: rows.map((r: any) => ({
        id: r.id, number: r.number, date: r.date, amount: r.amount, status: r.status, memo: r.memo ?? null, voidReason: r.void_reason ?? null,
        from: { id: r.from_bank_account_id, nameAr: r.from_ar ?? null, nameEn: r.from_en ?? null },
        to: { id: r.to_bank_account_id, nameAr: r.to_ar ?? null, nameEn: r.to_en ?? null },
        entryId: r.entry_id == null ? null : Number(r.entry_id), entryNo: r.entry_no ?? null,
      })),
    };
  }

  private async defaultBoxes(q: Sql, scope: number) {
    const [t] = await q.rows(`select id from bank_accounts where user_id = $1 and kind = 'bank' and is_trust and is_default and is_active order by id limit 1`, [scope]);
    const [o] = await q.rows(
      `select b.id from finance_settings fs join bank_accounts b on b.id = fs.default_bank_account_id and b.user_id = fs.account_user_id
        where fs.account_user_id = $1 and b.is_active and not b.is_trust and b.kind = 'bank'`, [scope]);
    return { fromBankAccountId: t ? Number(t.id) : null, toBankAccountId: o ? Number(o.id) : null };
  }

  /** POST /finance/v2/commission-transfers {amount?, date?, fromBankAccountId?, toBankAccountId?, memo?}. Amount defaults to the unsent commission. */
  async createTransfer(scope: number, actor: { id: number }, body: any) {
    const date = body?.date ? isoDate(body.date, "date") : riyadhToday();
    if (date > riyadhToday()) throw bad("FUTURE_DATE", "The transfer date cannot be in the future");
    const memo = typeof body?.memo === "string" && body.memo.trim() ? body.memo.trim().slice(0, 500) : null;
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.COMMISSION_TRANSFER]);
      const q = sqlOf(c as any);
      const s = await commissionSettings(q, scope);
      if (!s?.enabled || !s.ledgerStarted) throw conflict("COMMISSION_LEDGER_NOT_STARTED", BLOCKED_MESSAGES.LEDGER_NOT_STARTED);
      if (s.mode !== "manager") throw conflict("COMMISSION_NOT_MANAGER_MODE", BLOCKED_MESSAGES.NOT_MANAGER_MODE);
      const defaults = await this.defaultBoxes(q, scope);
      const fromId = body?.fromBankAccountId != null ? Number(body.fromBankAccountId) : defaults.fromBankAccountId;
      const toId = body?.toBankAccountId != null ? Number(body.toBankAccountId) : defaults.toBankAccountId;
      if (!fromId) throw bad("TRUST_ACCOUNT_REQUIRED", "أضف حساب أمانات العملاء أولاً · Add a client-money (trust) bank account first");
      if (!toId) throw bad("OPERATING_ACCOUNT_REQUIRED", "حدد الحساب التشغيلي · Choose the operating bank account");
      const box = async (id: number) => (await c.query(`select id, kind, is_trust, is_active from bank_accounts where id = $1 and user_id = $2`, [id, scope])).rows[0];
      const f = await box(fromId);
      const t = await box(toId);
      if (!f || !t) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
      if (!f.is_trust || !f.is_active || f.kind !== "bank") throw bad("BAD_BANK_ACCOUNT", "The transfer comes FROM an active client-money (trust) bank account");
      if (t.is_trust || !t.is_active || t.kind !== "bank") throw bad("BAD_BANK_ACCOUNT", "The transfer goes TO an active operating (non-trust) bank account");
      const u = await unsentCommission(q, scope);
      const amount = body?.amount != null && body.amount !== "" ? toHalalas(String(body.amount)) : u.unsent;
      if (!(amount > 0)) throw bad("NOTHING_TO_TRANSFER", "لا توجد عمولة غير محوّلة · There is no untransferred commission");
      if (amount > u.unsent) {
        throw conflict("OVER_UNSENT_COMMISSION", `المبلغ أكبر من العمولة غير المحوّلة (${fromHalalas(u.unsent)}) · The amount is more than the untransferred commission (${fromHalalas(u.unsent)})`);
      }
      const p = (await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [scope, date])).rows[0];
      if (p?.status === "locked") throw conflict("PERIOD_LOCKED", `الفترة مقفلة نهائياً · The period of ${date} is locked`);
      const [n] = (await c.query(
        `select coalesce(max(cast(substring(number from '[0-9]+$') as integer)), 0) as m from finance_commission_transfers where user_id = $1`, [scope])).rows;
      const number = `TRF-${String(Number(n?.m ?? 0) + 1).padStart(6, "0")}`;
      const ins = await c.query(
        `insert into finance_commission_transfers (user_id, number, transfer_date, amount, from_bank_account_id, to_bank_account_id, memo, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [scope, number, date, fromHalalas(amount), fromId, toId, memo, actor.id]);
      const id = Number(ins.rows[0].id);
      for (const e of await transferEvents(q, scope, id)) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
      await auditRow(c, scope, actor.id, "finance_v2_commission_transfer", id, "/finance/v2/commission-transfers");
      return id;
    });
    this.emitter.kick(scope);
    return (await this.listTransfers(scope)).rows.find((r) => r.id === out) ?? null;
  }

  /** POST /finance/v2/commission-transfers/:id/void {reason}: the reversal of its entry. */
  async voidTransfer(scope: number, actor: { id: number }, id: number, body: any) {
    const reason = requireReason(body);
    await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.COMMISSION_TRANSFER]);
      const t = (await c.query(`select id, status from finance_commission_transfers where id = $1 and user_id = $2 for update`, [id, scope])).rows[0];
      if (!t) throw new NotFoundException({ error: "TRANSFER_NOT_FOUND", message: "Transfer not found" });
      if (t.status !== "posted") throw conflict("TRANSFER_ALREADY_VOID", "The transfer is already void");
      await c.query(`update finance_commission_transfers set status = 'void', voided_by = $3, voided_at = now(), void_reason = $4 where id = $1 and user_id = $2`,
        [id, scope, actor.id, reason]);
      for (const e of await transferEvents(sqlOf(c as any), scope, id)) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
      await auditRow(c, scope, actor.id, "finance_v2_commission_transfer", id, `/finance/v2/commission-transfers/${id}/void`);
    });
    this.emitter.kick(scope);
    return (await this.listTransfers(scope)).rows.find((r) => r.id === id) ?? null;
  }

  private issuerOrThrow(): CommissionIssuer {
    if (!this.issuer) throw new Error("fv2: no commission issuer bound");
    return this.issuer;
  }
}
