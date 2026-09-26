import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { PostingEngine } from "./posting.engine";
import { lastDayOfMonth } from "./dates";
import { fromHalalas, toHalalas } from "./money";
import { vatSettlement } from "./rules/money-flows";
import { auditRow, mapLedgerError, settingsEvent } from "./audit";

/** ±5,000 SAR: the corrections box limit (DESIGN §7.5 box 14). */
const BOX14_LIMIT = 500_000;

export interface VatPeriod { key: string; from: string; to: string }

/** '2026-Q1' (calendar quarter) or '2026-03' (month). */
export function parseVatPeriod(key: string): VatPeriod {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  const p = (n: number) => String(n).padStart(2, "0");
  if (q) {
    const y = Number(q[1]);
    const first = (Number(q[2]) - 1) * 3 + 1;
    return { key, from: `${y}-${p(first)}-01`, to: `${y}-${p(first + 2)}-${p(lastDayOfMonth(y, first + 2))}` };
  }
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return { key, from: `${y}-${p(mo)}-01`, to: `${y}-${p(mo)}-${p(lastDayOfMonth(y, mo))}` };
  }
  throw new BadRequestException({ error: "BAD_PERIOD", message: "period must be YYYY-Qn or YYYY-MM" });
}

function parseSeller(v: unknown): string {
  if (v == null || v === "" || v === "account") return "account";
  if (typeof v === "string" && /^owner:[1-9][0-9]*$/.test(v)) return v;
  throw new BadRequestException("seller must be 'account' or 'owner:<id>'");
}

/**
 * The VAT return draft and its lock (DESIGN §7.5, §8.1). The full box layout
 * is the VAT report (Phase 3); this service keeps what the lock needs: the
 * output VAT (box 6) and input VAT (box 12) from the ledger, boxes 14 and 15
 * as user input, and the lock itself:
 *  - sets `vat_locked_at` on every month of the return (seller `account`);
 *    VAT-bearing lines dated there are then refused, or routed late when
 *    automatic (§4.7). It does NOT set the periods to `locked`.
 *  - posts the VAT settlement E37 for seller `account` (Dr 2151 / Cr 1151 /
 *    Cr 2152, or Dr 1152), dated the last day of the return.
 *  - refuses while VAT-period events are still pending, and in a locked period.
 */
@Injectable()
export class VatReturnsService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly periods: PeriodsService,
    private readonly journal: JournalRepository,
    private readonly engine: PostingEngine,
  ) {}

  async get(scope: number, periodKey: string, sellerRaw?: unknown) {
    const period = parseVatPeriod(periodKey);
    const seller = parseSeller(sellerRaw);
    return this.view(this.pool, scope, period, seller);
  }

  async put(scope: number, user: AuthUser, periodKey: string, body: any) {
    const period = parseVatPeriod(periodKey);
    const seller = parseSeller(body?.seller);
    const box = (v: unknown, name: string) => {
      if (v == null || v === "") return null;
      try {
        return toHalalas(String(v));
      } catch {
        throw new BadRequestException(`${name} must be a decimal with at most 2 places`);
      }
    };
    const b14 = box(body?.box14, "box14");
    const b15 = box(body?.box15, "box15");
    if (b14 != null && Math.abs(b14) > BOX14_LIMIT) throw new BadRequestException({ error: "BOX14_LIMIT", message: "Corrections are limited to ±5,000 SAR; use a voluntary disclosure" });
    if (b15 != null && b15 < 0) throw new BadRequestException("box15 cannot be negative");
    const lock = body?.lock === true;

    if (lock) {
      const pend = await this.pool.query(
        `select count(*)::int as n from ledger_outbox where user_id = $1 and status in ('pending','failed') and occurred_on between $2 and $3`,
        [scope, period.from, period.to]);
      if (pend.rows[0].n > 0) throw new ConflictException({ error: "PENDING_POSTINGS", message: `${pend.rows[0].n} event(s) in this VAT period are pending or failed` });
    }
    try {
      return await withTx(this.pool, async (c) => {
        const d = (await c.query(
          `insert into finance_vat_return_drafts (user_id, seller_key, period_start, period_end) values ($1, $2, $3, $4)
           on conflict (user_id, seller_key, period_start) do update set period_end = excluded.period_end
           returning id, locked_at`, [scope, seller, period.from, period.to])).rows[0];
        await c.query(`select 1 from finance_vat_return_drafts where id = $1 for update`, [d.id]);
        const locked = (await c.query(`select locked_at from finance_vat_return_drafts where id = $1`, [d.id])).rows[0].locked_at;
        if (locked) throw new ConflictException({ error: "VAT_RETURN_LOCKED", message: "This VAT return is locked" });
        if (b14 != null || b15 != null) {
          await c.query(`update finance_vat_return_drafts set box14 = coalesce($2, box14), box15 = coalesce($3, box15) where id = $1`,
            [d.id, b14 == null ? null : fromHalalas(b14), b15 == null ? null : fromHalalas(b15)]);
        }
        if (lock) {
          for (let m = period.from; m <= period.to; m = nextMonth(m)) await this.periods.ensurePeriod(c, scope, m);
          const lockedPeriods = await c.query(
            `select 1 from fiscal_periods where user_id = $1 and starts_on between $2 and $3 and status = 'locked' limit 1`, [scope, period.from, period.to]);
          if (lockedPeriods.rowCount) throw new ConflictException({ error: "PERIOD_LOCKED", message: "A month of this return is locked" });
          const v = await this.totals(c, scope, period, seller);
          let settlement: { id: number; entryNo: string } | null = null;
          if (seller === "account") {
            const out = vatSettlement({ date: period.to, outputVat: fromHalalas(v.output), inputVat: fromHalalas(v.input) });
            if (!out.skip && out.lines.length >= 2) {
              const { lines } = await this.engine.resolveLines(c, scope, out.lines);
              const res = await this.journal.post(c, {
                userId: scope, entryDate: period.to, origin: "manual", sourceType: "vat_return", sourceId: Number(d.id), event: "settled",
                memo: `تسوية ضريبة القيمة المضافة ${period.key} / VAT settlement ${period.key}`,
                payload: { rule: "E37", period: period.key, outputVat: fromHalalas(v.output), inputVat: fromHalalas(v.input) },
                createdBy: user.id, lines,
              });
              settlement = { id: res.id, entryNo: res.entryNo };
            }
            await c.query(`update fiscal_periods set vat_locked_at = now() where user_id = $1 and starts_on between $2 and $3 and vat_locked_at is null`,
              [scope, period.from, period.to]);
          }
          await c.query(`update finance_vat_return_drafts set locked_at = now(), locked_by = $2 where id = $1`, [d.id, user.id]);
          await settingsEvent(c, scope, user.id, "vat_return_lock", null,
            { period: period.key, seller, outputVat: fromHalalas(v.output), inputVat: fromHalalas(v.input), settlementEntryId: settlement?.id ?? null },
            `VAT return ${period.key} locked`);
          await auditRow(c, scope, user.id, "finance_v2_vat_return", d.id, `/finance/v2/vat-returns/${period.key}`, "PUT");
        }
        return this.view(c, scope, period, seller);
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /** Σ output VAT (S lines, `tax_role='output'`) and Σ recoverable input VAT, signed, for the seller and dates. */
  private async totals(q: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, p: VatPeriod, seller: string) {
    const r = await q.query(
      `select coalesce(sum(case when tax_role = 'output' and vat_category = 'S' then credit - debit end), 0)::text as output,
              coalesce(sum(case when tax_role = 'input' then debit - credit end), 0)::text as input
         from journal_lines where user_id = $1 and coalesce(seller_key, 'account') = $2 and entry_date between $3 and $4`,
      [scope, seller, p.from, p.to]);
    return { output: toHalalas(r.rows[0].output), input: toHalalas(r.rows[0].input) };
  }

  private async view(q: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, p: VatPeriod, seller: string) {
    const t = await this.totals(q, scope, p, seller);
    const d = (await q.query(
      `select id, box14::text as box14, box15::text as box15, locked_at as "lockedAt", locked_by as "lockedBy"
         from finance_vat_return_drafts where user_id = $1 and seller_key = $2 and period_start = $3`, [scope, seller, p.from])).rows[0];
    const b14 = toHalalas(d?.box14 ?? "0");
    const b15 = toHalalas(d?.box15 ?? "0");
    const box13 = t.output - t.input;
    return {
      period: p, seller, draftId: d?.id ?? null,
      box6Vat: fromHalalas(t.output), box12Vat: fromHalalas(t.input), box13: fromHalalas(box13),
      box14: fromHalalas(b14), box15: fromHalalas(b15), box16: fromHalalas(box13 + b14 - b15),
      locked: !!d?.lockedAt, lockedAt: d?.lockedAt ?? null, lockedBy: d?.lockedBy ?? null,
    };
  }
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
