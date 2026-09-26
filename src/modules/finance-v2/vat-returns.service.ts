import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { PostingEngine } from "./posting.engine";
import { fromHalalas, toHalalas } from "./money";
import { vatSettlement } from "./rules/money-flows";
import { auditRow, mapLedgerError, settingsEvent } from "./audit";
import { VatReportService, parseSeller, parseVatPeriod, type VatComputation, type VatPeriod } from "./reports/vat-report.service";

/** ±5,000 SAR: the corrections box limit (DESIGN §7.5 box 14). */
const BOX14_LIMIT = 500_000;

export { parseVatPeriod, type VatPeriod };

/**
 * The VAT return draft and its lock (DESIGN §7.5, §8.1). The figures are the
 * VAT report's own computation (reports/vat-report.service.ts), so the lock
 * settles exactly boxes 6, 12 and 13 of that report: output VAT (box 6), the
 * input VAT claimed (box 12 = standard-rated input VAT booked + the §8.2(b)
 * apportionment adjustment), boxes 14 and 15 as user input, and the lock:
 *  - sets `vat_locked_at` on every month of the return (seller `account`);
 *    VAT-bearing lines dated there are then refused, or routed late when
 *    automatic (§4.7). It does NOT set the periods to `locked`.
 *  - posts the VAT settlement E37 for seller `account` (Dr 2151 / Cr 1151 /
 *    ±5500 apportionment / Cr 1152 box 15 / Cr 2152, or Dr 1152), dated the
 *    last day of the return; box 14 is returned as a warning to journal by hand.
 *  - refuses while VAT-period events are still pending, and in a locked period.
 */
@Injectable()
export class VatReturnsService {
  private readonly report: VatReportService;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly periods: PeriodsService,
    private readonly journal: JournalRepository,
    private readonly engine: PostingEngine,
  ) {
    this.report = new VatReportService(pool);
  }

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
    const warnings: string[] = [];
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
          const v = await this.report.compute(c, scope, period, seller);
          const adj = v.apportionment.adjustment;
          let settlement: { id: number; entryNo: string } | null = null;
          if (seller === "account") {
            const out = vatSettlement({
              date: period.to, outputVat: fromHalalas(v.outputVat), inputVat: fromHalalas(v.inputVatBooked), apportionment: fromHalalas(adj),
              carriedForward: fromHalalas(v.box15), corrections: fromHalalas(v.box14),
            });
            warnings.push(...out.warnings);
            if (!out.skip && out.lines.length >= 2) {
              const { lines } = await this.engine.resolveLines(c, scope, out.lines);
              const res = await this.journal.post(c, {
                userId: scope, entryDate: period.to, origin: "manual", sourceType: "vat_return", sourceId: Number(d.id), event: "settled",
                memo: `تسوية ضريبة القيمة المضافة ${period.key} / VAT settlement ${period.key}`,
                payload: {
                  rule: "E37", period: period.key, outputVat: fromHalalas(v.outputVat), inputVat: fromHalalas(v.inputVatBooked),
                  apportionment: fromHalalas(adj), apportionmentRatio: v.apportionment.ratioPercent,
                  box14: fromHalalas(v.box14), box15: fromHalalas(v.box15),
                },
                createdBy: user.id, lines,
              });
              settlement = { id: res.id, entryNo: res.entryNo };
            }
            await c.query(`update fiscal_periods set vat_locked_at = now() where user_id = $1 and starts_on between $2 and $3 and vat_locked_at is null`,
              [scope, period.from, period.to]);
          }
          await c.query(`update finance_vat_return_drafts set locked_at = now(), locked_by = $2 where id = $1`, [d.id, user.id]);
          await settingsEvent(c, scope, user.id, "vat_return_lock", null,
            { period: period.key, seller, outputVat: fromHalalas(v.outputVat), inputVat: fromHalalas(v.inputVatClaimed), apportionment: fromHalalas(adj), settlementEntryId: settlement?.id ?? null },
            `VAT return ${period.key} locked`);
          await auditRow(c, scope, user.id, "finance_v2_vat_return", d.id, `/finance/v2/vat-returns/${period.key}`, "PUT");
        }
        const view = await this.view(c, scope, period, seller);
        return lock ? { ...view, warnings } : view;
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  private async view(q: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, p: VatPeriod, seller: string) {
    const v: VatComputation = await this.report.compute(q, scope, p, seller);
    return {
      period: p, seller, draftId: v.draft?.id ?? null,
      box6Vat: fromHalalas(v.outputVat), box12Vat: fromHalalas(v.inputVatClaimed), box13: fromHalalas(v.box13),
      box14: fromHalalas(v.box14), box15: fromHalalas(v.box15), box16: fromHalalas(v.box16),
      inputVatBooked: fromHalalas(v.inputVatBooked), apportionmentAdjustment: fromHalalas(v.apportionment.adjustment),
      locked: !!v.draft?.lockedAt, lockedAt: v.draft?.lockedAt ?? null, lockedBy: v.draft?.lockedBy ?? null,
    };
  }
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
