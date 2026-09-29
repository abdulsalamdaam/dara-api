import { Injectable } from "@nestjs/common";
import type { Fv2Client } from "./db";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { riyadhToday, periodFor } from "./dates";
import { LOCK_KEYS } from "./lock-keys";
import { captureDims } from "./hooks/facts-loader";
import { sqlOf } from "./hooks/sql";

export interface SetupResult {
  accountsInserted: number;
  cashBankAccountId: number;
  bankBankAccountId: number;
}

/**
 * What the first enable does (DESIGN §1.5 step 4), inside the toggle's
 * transaction. Idempotent: every step is insert-if-missing, so running it again
 * (a re-enable, or a repair) changes nothing that exists.
 *  1. Seed the chart of accounts (§3).
 *  2. Create the current and previous fiscal years' monthly periods, all open.
 *  3. Create the default cash box (-> 1111) and bank account (-> 1113), and
 *     make them the account's defaults.
 *  4. Capture `finance_contract_dims` for every contract (§4.3): terminate and
 *     DELETE hard-delete `contract_units`, so the landlord/property of an
 *     event is frozen from this side table. Best-effort, in a savepoint: a
 *     failure here never blocks the switch (the hooks capture lazily too).
 */
@Injectable()
export class FinanceSetupService {
  constructor(private readonly chart: ChartService, private readonly periods: PeriodsService) {}

  async firstEnable(c: Fv2Client, userId: number, actorId: number | null): Promise<SetupResult> {
    await c.query(`select pg_advisory_xact_lock($1, $2)`, [userId, LOCK_KEYS.SETUP]);
    const accountsInserted = await this.chart.seedChart(c, userId, actorId);

    const start = await this.periods.fiscalStartMonth(c, userId);
    const fy = periodFor(riyadhToday(), start).fiscalYear;
    await this.periods.ensureFiscalYear(c, userId, fy - 1);
    await this.periods.ensureFiscalYear(c, userId, fy);

    const cash = await this.ensureDefaultBox(c, userId, actorId, "cash", "1111", "الصندوق الرئيسي", "Main cash box");
    const bank = await this.ensureDefaultBox(c, userId, actorId, "bank", "1113", "الحساب البنكي الرئيسي", "Main bank account");
    await c.query(
      `update finance_settings set default_cash_account_id = coalesce(default_cash_account_id, $2),
                                   default_bank_account_id = coalesce(default_bank_account_id, $3), updated_at = now()
        where account_user_id = $1`,
      [userId, cash, bank],
    );
    await c.query("savepoint fv2_dims");
    try {
      await captureDims(sqlOf(c), userId, null);
      await c.query("release savepoint fv2_dims");
    } catch {
      await c.query("rollback to savepoint fv2_dims");
    }
    return { accountsInserted, cashBankAccountId: cash, bankBankAccountId: bank };
  }

  private async ensureDefaultBox(c: Fv2Client, userId: number, actorId: number | null, kind: "cash" | "bank",
    code: string, nameAr: string, nameEn: string): Promise<number> {
    const gl = await c.query(`select id from accounts where user_id = $1 and code = $2`, [userId, code]);
    const glId = gl.rows[0]?.id;
    if (!glId) throw new Error(`fv2: template account ${code} missing after seed`);
    const found = await c.query(`select id from bank_accounts where user_id = $1 and gl_account_id = $2 order by id limit 1`, [userId, glId]);
    if (found.rows[0]) return found.rows[0].id;
    const hasDefault = await c.query(
      `select 1 from bank_accounts where user_id = $1 and kind = $2 and not is_trust and is_default and is_active`, [userId, kind]);
    const ins = await c.query(
      `insert into bank_accounts (user_id, kind, name_ar, name_en, is_default, gl_account_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [userId, kind, nameAr, nameEn, !hasDefault.rowCount, glId, actorId],
    );
    const id = ins.rows[0].id;
    await c.query(`update accounts set bank_account_id = $2 where id = $1 and bank_account_id is null`, [glId, id]);
    return id;
  }
}
