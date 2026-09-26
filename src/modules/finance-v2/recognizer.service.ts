import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "./db";
import { LedgerEmitter, type LedgerEvent } from "./ledger-emitter.service";
import { riyadhToday, lastDayOfMonth } from "./dates";
import { sqlOf, type Sql } from "./hooks/sql";
import { contractCtx, installmentFacts, INSTALLMENT_COLS, loadSettings, type ContractCtx, type FinanceSettingsRow, type InstallmentRow } from "./hooks/facts-loader";
import { DEPOSIT_DESC, installmentNature, installmentVat } from "./hooks/classify";
import { SYS, type ReleaseFacts } from "./rules";

const CHECK_MS = 60_000;
/** Minutes after Riyadh midnight when the daily run is due (§5.6: 00:10). */
const RUN_AFTER_MIN = 10;

export interface RecognizerSummary {
  charges: number;
  settlements: number;
  releases: number;
}

/**
 * The recognizer (DESIGN §4.1, §5.6). For an account whose flag is on and
 * whose ledger has started, it enqueues:
 *  - E02 `payment,<id>,charge` (or `charge:g<n>` after an earlier charge was
 *    reversed) for every installment PAST its due date (`due_date < today`,
 *    Riyadh) that is not cancelled, deleted, a deposit row, after its ended
 *    contract's `ended_on`, before the cutover go-live date, already charged,
 *    covered by a confirmed charge document, or already queued;
 *  - E33 `payment,<id>,settled_external` for a charged `settled_external` row;
 *  - E35 `payment,<id>,release:YYYY-MM` for every passed month-end inside the
 *    coverage window of a principal rent charge with unreleased 2131.
 * Keys are the backfill's keys, so a run is idempotent and a repeat is free.
 * Runs daily at 00:10 Riyadh (`FINANCE_V2_WORKER_DISABLED=1` switches the
 * timer off, as for the worker), and on demand via `runAccount`.
 */
@Injectable()
export class RecognizerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Recognizer");
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;
  private running = false;

  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, private readonly emitter: LedgerEmitter) {}

  onModuleInit(): void {
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_RECOGNIZER_DISABLED === "1") return;
    this.timer = setInterval(() => void this.maybeRunDaily(), CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async maybeRunDaily(): Promise<void> {
    const now = new Date();
    const day = riyadhToday();
    const [h, m] = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.lastRunDay === day || h * 60 + m < RUN_AFTER_MIN || this.running) return;
    this.running = true;
    try {
      const r = await this.pool.query(
        `select account_user_id from finance_settings where finance_v2_enabled and ledger_started_at is not null order by account_user_id`,
      );
      for (const x of r.rows) {
        try {
          await this.runAccount(Number(x.account_user_id), day);
        } catch (err: any) {
          this.log.warn(`recognizer failed for scope ${x.account_user_id}: ${err?.message ?? err}`);
        }
      }
      this.lastRunDay = day;
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`recognizer run failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /** One account, as of `today` (Riyadh). Does nothing unless the flag is on and the ledger started. */
  async runAccount(userId: number, today = riyadhToday()): Promise<RecognizerSummary> {
    const q = sqlOf(this.pool as any);
    const summary: RecognizerSummary = { charges: 0, settlements: 0, releases: 0 };
    const s = await loadSettings(q, userId);
    if (!s || !s.ledgerStarted) return summary;
    const ctxCache = new Map<number, ContractCtx | null>();
    const ctxOf = async (cid: number) => {
      if (!ctxCache.has(cid)) ctxCache.set(cid, await contractCtx(q, userId, s.mode, cid));
      return ctxCache.get(cid) ?? null;
    };
    const emit = async (e: LedgerEvent) => {
      if (await this.emitter.emit({ fv2: true, userId }, { ...e, origin: "recognizer" })) return true;
      return false;
    };

    // 1. Due-date charges (E02).
    for (const p of await this.chargeable(q, userId, s, today)) {
      const ctx = await ctxOf(p.contract_id);
      const f = installmentFacts(p, ctx, s, p.due);
      if (!f) continue;
      const event = p.gen <= 1 ? "charge" : `charge:g${p.gen}`;
      if (await emit({ sourceType: "payment", sourceId: p.id, event, occurredOn: p.due, payload: { rule: "E02", facts: f, paymentIds: [p.id] } })) summary.charges++;
    }

    // 2. Ejar/externally settled rows, once charged (E33).
    const settled = await q.rows<InstallmentRow>(
      `select ${INSTALLMENT_COLS} from payments p
        where p.user_id = $1 and p.deleted_at is null and p.status::text = 'settled_external'
          and exists (select 1 from finance_installment_charges c where c.payment_id = p.id and c.user_id = p.user_id and c.reversed_at is null)
          and not exists (select 1 from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                            and o.event = 'settled_external')
        order by p.id`,
      [userId],
    );
    for (const p of settled) {
      const f = installmentFacts(p, await ctxOf(p.contract_id), s, p.due);
      if (!f) continue;
      if (await emit({ sourceType: "payment", sourceId: p.id, event: "settled_external", occurredOn: p.due, payload: { rule: "E33", facts: f, paymentIds: [p.id] } })) summary.settlements++;
    }

    // 3. Straight-line releases (E35) for principal rent with unreleased 2131.
    if (s.deferRent) {
      for (const r of await this.releasable(q, userId)) {
        const ctx = await ctxOf(r.contract_id);
        if (!ctx || ctx.treatment !== "principal") continue;
        const window = await this.coverageWindow(q, userId, r, ctx);
        if (!window) continue;
        for (const month of monthsBetween(window.start, window.end)) {
          const [y, m] = month.split("-").map(Number);
          const monthEnd = `${month}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
          const date = monthEnd < window.end ? monthEnd : window.end;
          if (!(date < today)) break;
          const facts: ReleaseFacts = {
            date, treatment: "principal", dims: { ...dimsFor(ctx), paymentId: r.id }, warnings: ctx.warnings,
            paymentId: r.id, month, windowStart: window.start, windowEnd: window.end,
            category: installmentVat({ vatEnabled: r.vat_enabled === true, usage: ctx.usage, sellerRegistered: ctx.sellerRegistered }).category, usage: ctx.usage,
          };
          if (await emit({ sourceType: "payment", sourceId: r.id, event: `release:${month}`, occurredOn: date, payload: { rule: "E35", facts, paymentIds: [r.id] } })) summary.releases++;
        }
      }
    }
    if (summary.charges + summary.settlements + summary.releases > 0) this.emitter.kick(userId);
    return summary;
  }

  /** Installments to charge at their due date (§5.6), with the next charge generation. */
  private async chargeable(q: Sql, userId: number, s: FinanceSettingsRow, today: string): Promise<Array<InstallmentRow & { gen: number }>> {
    return q.rows(
      `select ${INSTALLMENT_COLS},
              (select count(*)::int from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                 and o.event ~ '^charge(:g[0-9]+)?$') + 1 as gen
         from payments p
         join contracts c on c.id = p.contract_id and c.user_id = p.user_id
         left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
        where p.user_id = $1 and p.deleted_at is null and c.deleted_at is null
          and p.due_date < $2::date
          and p.status::text <> 'cancelled'
          and coalesce(p.description, '') <> $3
          and ($4::date is null or p.due_date >= $4::date)
          and not (c.status::text in ('terminated','cancelled')
                   and p.due_date > coalesce(d.ended_on, (c.updated_at at time zone 'Asia/Riyadh')::date))
          and not exists (select 1 from finance_installment_charges ch where ch.payment_id = p.id and ch.user_id = p.user_id and ch.reversed_at is null)
          and not exists (select 1 from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                            and o.event ~ '^charge(:g[0-9]+)?$' and o.status in ('pending','failed'))
          and not exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                            and si.type = 'invoice' and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
                            and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id)))
        order by p.due_date, p.id`,
      [userId, today, DEPOSIT_DESC, s.goLive],
    );
  }

  /** Principal rent installments with a positive unreleased 2131 balance. */
  private async releasable(q: Sql, userId: number): Promise<InstallmentRow[]> {
    return q.rows(
      `select ${INSTALLMENT_COLS} from payments p
        where p.user_id = $1 and p.id in (
          select l.payment_id from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
           where l.user_id = $1 and a.system_key = $2 and l.payment_id is not null
           group by l.payment_id having sum(l.credit - l.debit) > 0)
        order by p.id`,
      [userId, SYS.ur],
    );
  }

  /**
   * The coverage window of an installment (§4.1): its due date to the day
   * before the contract's next RENT installment; the last one ends at the
   * contract end, or `ended_on` when the contract ended early.
   */
  private async coverageWindow(q: Sql, userId: number, p: InstallmentRow, ctx: ContractCtx): Promise<{ start: string; end: string } | null> {
    if (installmentNature(p.description) !== "rent") return null;
    const rows = await q.rows(
      `select to_char(due_date,'YYYY-MM-DD') as due, description from payments
        where user_id = $1 and contract_id = $2 and deleted_at is null and due_date > $3::date order by due_date, id`,
      [userId, p.contract_id, p.due],
    );
    const next = rows.find((r: any) => installmentNature(r.description) === "rent");
    let end = next ? dayBefore(next.due) : (ctx.endDate ?? p.due);
    if (ctx.endedOn && ctx.endedOn < end) end = ctx.endedOn;
    if (end < p.due) end = p.due;
    return { start: p.due, end };
  }
}

function dimsFor(ctx: ContractCtx) {
  return { ownerId: ctx.ownerId, propertyId: ctx.propertyId, unitId: ctx.unitId, tenantId: ctx.tenantId, contractId: ctx.contractId };
}

function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** YYYY-MM of every month from `a`'s to `b`'s, inclusive. */
export function monthsBetween(a: string, b: string): string[] {
  let [y, m] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  const out: string[] = [];
  while (y < yb || (y === yb && m <= mb)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
