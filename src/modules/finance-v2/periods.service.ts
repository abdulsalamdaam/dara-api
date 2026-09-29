import { Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Client, type Fv2Pool } from "./db";
import { periodFor, periodsOfFiscalYear, type PeriodSpan } from "./dates";

export interface PeriodRow {
  id: number;
  fiscalYear: number;
  periodNo: number;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed" | "locked";
  vatLocked: boolean;
}

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

const COLS = `id, fiscal_year as "fiscalYear", period_no as "periodNo", to_char(starts_on,'YYYY-MM-DD') as "startsOn",
  to_char(ends_on,'YYYY-MM-DD') as "endsOn", status, (vat_locked_at is not null) as "vatLocked"`;

/**
 * Monthly fiscal periods, created on demand (DESIGN §2.3.3). `ensurePeriod` is
 * insert-on-conflict-do-nothing then select, so two concurrent first postings
 * into a month cannot collide.
 */
@Injectable()
export class PeriodsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  async fiscalStartMonth(q: Q, userId: number): Promise<number> {
    const r = await q.query(`select fiscal_year_start_month as m from finance_settings where account_user_id = $1`, [userId]);
    return Number(r.rows[0]?.m ?? 1);
  }

  /** The period containing `date` (YYYY-MM-DD, Riyadh), created if missing. */
  async ensurePeriod(q: Q, userId: number, date: string): Promise<PeriodRow> {
    const span = periodFor(date, await this.fiscalStartMonth(q, userId));
    await this.insertSpans(q, userId, [span]);
    const r = await q.query(`select ${COLS} from fiscal_periods where user_id = $1 and starts_on = $2`, [userId, span.startsOn]);
    if (!r.rows[0]) throw new Error(`fv2: period for ${date} could not be created`);
    return r.rows[0];
  }

  /** All twelve periods of a fiscal year, created if missing. */
  async ensureFiscalYear(q: Q, userId: number, fiscalYear: number): Promise<void> {
    await this.insertSpans(q, userId, periodsOfFiscalYear(fiscalYear, await this.fiscalStartMonth(q, userId)));
  }

  async list(userId: number, q: Q = this.pool): Promise<PeriodRow[]> {
    const r = await q.query(`select ${COLS} from fiscal_periods where user_id = $1 order by starts_on`, [userId]);
    return r.rows;
  }

  private async insertSpans(q: Q, userId: number, spans: PeriodSpan[]): Promise<void> {
    await q.query(
      `insert into fiscal_periods (user_id, fiscal_year, period_no, starts_on, ends_on)
       select $1, fy, pn, s::date, e::date
         from unnest($2::int[], $3::int[], $4::text[], $5::text[]) as t(fy, pn, s, e)
       on conflict do nothing`,
      [userId, spans.map((s) => s.fiscalYear), spans.map((s) => s.periodNo), spans.map((s) => s.startsOn), spans.map((s) => s.endsOn)],
    );
  }
}
