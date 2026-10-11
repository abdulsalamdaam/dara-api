import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, type Fv2Pool } from "./db";
import { fromHalalas } from "./money";
import { riyadhToday } from "./dates";
import { h } from "./reports/common";
import { ExtraChecks } from "./reports/control-checks";
import { ManualJournalsService } from "./manual-journals.service";

export interface TrustTransferProposal {
  /** What R16 is short: client money collected outside the trust account and not moved in yet. "0.00" when none. */
  amount: string;
  /** The default trust bank account's GL account (the debit). Null when the account has none. */
  trustAccountId: number | null;
  /** The office cash/bank GL accounts the money sits in (the credits), in halalas-exact decimals. */
  from: Array<{ accountId: number; code: string; name: string; nameEn: string | null; amount: string }>;
  /** The R16 entries it covers. */
  entries: Array<{ entryId: number; entryNo: string; date: string; amount: string }>;
}

/**
 * Accountant round 4: "R16 — the trust account is at zero because the earlier collections went into the
 * cash box; we need a way to move them into trust". Client money that was collected into the office's own
 * cash/bank accounts (before trust routing was switched on, or by hand) shows in R16 as unexplained entries.
 *
 * This proposes — and on request drafts — the manual journal that moves it: Dr the trust account, Cr each
 * office account the money landed in. It is an ordinary manual-journal DRAFT, so it goes through the usual
 * submit / approve (drafter ≠ approver, attachment above 10,000) before anything posts. R16 counts a transfer
 * into trust against this shortfall first (control-checks.ts), and R4 counts manual lines on both sides.
 */
@Injectable()
export class TrustTransferService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly mj: ManualJournalsService,
  ) {}

  async proposal(scope: number, asOf = riyadhToday()): Promise<TrustTransferProposal> {
    const empty: TrustTransferProposal = { amount: "0.00", trustAccountId: null, from: [], entries: [] };
    const [st] = (await this.pool.query(`select accounting_mode as mode from finance_settings where account_user_id = $1`, [scope])).rows;
    const r16 = await new ExtraChecks(this.pool).r16(scope, asOf, st?.mode ?? null);
    const shortfall = -h(r16.difference ?? "0");
    if (r16.status !== "difference" || shortfall <= 0) return empty;

    const [trust] = (await this.pool.query(
      `select gl_account_id as id from bank_accounts
        where user_id = $1 and is_trust and is_active and kind = 'bank' and gl_account_id is not null
        order by is_default desc, id limit 1`, [scope])).rows;
    if (!trust) return empty;

    // Where each unexplained entry's money landed: its debit lines on the office's own cash/bank accounts.
    const ids = (r16.rows as Array<{ entryId: number; entryNo: string; date: string; difference: string }>)
      .filter((x) => h(x.difference) < 0);
    if (!ids.length) return empty;
    const lines = (await this.pool.query(
      `with recursive g as (select id from accounts where user_id = $1 and code = '1110'
                             union all select a.id from accounts a join g on a.parent_id = g.id where a.user_id = $1)
       select l.account_id, a.code, a.name_ar, a.name_en, sum(l.debit - l.credit)::text as amt
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_id = any($2::bigint[]) and l.account_id in (select id from g)
          and l.account_id <> all($3::int[])
        group by 1, 2, 3, 4 having sum(l.debit - l.credit) > 0 order by a.code`,
      [scope, ids.map((x) => x.entryId), await this.trustGlIds(scope)])).rows;

    // Never propose more than R16 is short, even when the entries carried more (part may already be covered).
    let left = shortfall;
    const from: TrustTransferProposal["from"] = [];
    for (const l of lines) {
      if (left <= 0) break;
      const take = Math.min(left, h(l.amt));
      from.push({ accountId: Number(l.account_id), code: l.code, name: l.name_ar, nameEn: l.name_en ?? null, amount: fromHalalas(take) });
      left -= take;
    }
    const total = shortfall - left;
    if (total <= 0) return empty;
    return {
      amount: fromHalalas(total),
      trustAccountId: Number(trust.id),
      from,
      entries: ids.map((x) => ({ entryId: x.entryId, entryNo: x.entryNo, date: x.date, amount: fromHalalas(-h(x.difference)) })),
    };
  }

  /** Body: { entryDate? } — a manual-journal draft for the proposal. 400 when there is nothing to move. */
  async createDraft(scope: number, user: AuthUser, body: any) {
    const p = await this.proposal(scope);
    if (h(p.amount) <= 0 || p.trustAccountId == null) {
      throw new BadRequestException({ error: "NOTHING_TO_MOVE", message: "لا توجد أموال عملاء خارج حساب الأمانات · No client money outside the trust account" });
    }
    const refs = p.entries.map((e) => e.entryNo).join("، ");
    return this.mj.create(scope, user, {
      entryDate: body?.entryDate || riyadhToday(),
      memo: `تحويل أموال العملاء إلى حساب الأمانات (${refs}) · Move client money into the trust account`,
      lines: [
        { accountId: p.trustAccountId, debit: p.amount, credit: "0", memo: "حساب الأمانات · Trust account" },
        ...p.from.map((f) => ({ accountId: f.accountId, debit: "0", credit: f.amount, memo: f.name })),
      ],
    });
  }

  private async trustGlIds(scope: number): Promise<number[]> {
    return (await this.pool.query(
      `select distinct gl_account_id as id from bank_accounts where user_id = $1 and is_trust and gl_account_id is not null`, [scope],
    )).rows.map((x: any) => Number(x.id));
  }
}
