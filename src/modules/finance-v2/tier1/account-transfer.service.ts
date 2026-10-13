import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";
import { FV2_POOL, withTx, type Fv2Pool } from "../db";
import { JournalRepository } from "../journal.repository";
import { PeriodsService } from "../periods.service";
import { capabilities } from "../capabilities";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { auditRow, isoDate, mapLedgerError } from "../audit";
import { LOCK_KEYS } from "../lock-keys";

export interface AccountTransferOut {
  manualJournalId: number;
  entryId: number;
  entryNo: string;
  date: string;
  amount: string;
  memo: string;
  from: { bankAccountId: number; glCode: string; nameAr: string; nameEn: string | null; balance: string };
  to: { bankAccountId: number; glCode: string; nameAr: string; nameEn: string | null; balance: string };
  /** Non-blocking: e.g. SOURCE_BALANCE_NEGATIVE when the source account's book balance goes below zero. */
  warnings: string[];
}

const bad = (error: string, message: string) => new BadRequestException({ error, message });

const idOf = (v: unknown, field: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw bad("BAD_BANK_ACCOUNT", `${field} must be an id`);
  return n;
};

const optText = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("BAD_INPUT", `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad("BAD_INPUT", `${field} is too long (at most ${max} characters)`);
  return s || null;
};

/** A positive amount with at most 2 decimals, in halalas. */
export function transferAmount(v: unknown): number {
  if (v === undefined || v === null || v === "" || (typeof v !== "string" && typeof v !== "number")) {
    throw bad("BAD_AMOUNT", "amount is required");
  }
  let x: number;
  try {
    x = toHalalas(typeof v === "number" ? v : v.trim());
  } catch {
    throw bad("BAD_AMOUNT", "المبلغ رقم موجب بخانتين عشريتين على الأكثر · amount must be a positive decimal with at most 2 places");
  }
  if (!(x > 0)) throw bad("BAD_AMOUNT", "المبلغ يجب أن يكون أكبر من صفر · amount must be greater than zero");
  return x;
}

/**
 * Transfer between accounts (تحويل بين الحسابات), accountant round 5: move money between two of the account's
 * own bank accounts / cash boxes — cash deposited in the bank, client money collected into the cash box moved
 * into trust, earned commission moved from trust to the office account. One balanced journal entry,
 * Dr destination / Cr source (the Arabic «من حـ/ الوجهة إلى حـ/ المصدر»), each line carrying its bank account.
 *
 * It is recorded as a manual journal that posts at once (kind `manual`, status `posted`, drafter = approver):
 * the entry is `manual_journal,<id>,posted` with origin `manual`, so it is listed with the manual journals,
 * links back from the journal, and is undone by the existing manual reversal (`POST /journal/:id/reverse`),
 * which also voids the manual journal. No new table or mechanism. It needs `money` (like the commission
 * transfer, E15T) rather than the draft → approve flow: it moves money between two boxes the office holds and
 * touches no revenue, expense, VAT or client liability.
 *
 *  - both accounts belong to the scope (another account's id is a 404), are active, and differ (also by GL);
 *  - amount > 0 with at most 2 decimals; date defaults to today (Riyadh), never in the future;
 *  - period: open, or closed only for a `settings` holder (as a manual journal's approval); never locked;
 *  - the ledger must have started (ledger_started_at), otherwise nothing posts anywhere yet;
 *  - the source balance may go negative (as every v2 payment allows; the books may lag the bank): the response
 *    and the entry carry the SOURCE_BALANCE_NEGATIVE warning instead of a refusal.
 *
 * The cash-flow report classifies an entry whose every line is a cash account as an internal transfer (no inflow
 * or outflow); R16 counts a cash ↔ trust transfer as money moved into / out of trust (control-checks.ts).
 */
@Injectable()
export class AccountTransferService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly journal: JournalRepository,
    private readonly periods: PeriodsService,
  ) {}

  /** Body: { fromBankAccountId, toBankAccountId, amount, date?, note?, reference? } */
  async create(scope: number, user: AuthUser, body: any): Promise<AccountTransferOut> {
    const fromId = idOf(body?.fromBankAccountId, "fromBankAccountId");
    const toId = idOf(body?.toBankAccountId, "toBankAccountId");
    if (fromId === toId) throw bad("SAME_ACCOUNT", "اختر حسابين مختلفين · Choose two different accounts");
    const amount = transferAmount(body?.amount);
    const today = riyadhToday();
    const date = body?.date ? isoDate(body.date, "date") : today;
    if (date > today) throw bad("FUTURE_DATE", "لا يمكن أن يكون تاريخ التحويل في المستقبل · The transfer date cannot be in the future");
    const note = optText(body?.note, "note", 500);
    const reference = optText(body?.reference, "reference", 100);

    try {
      return await withTx(this.pool, async (c) => {
        await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.ACCOUNT_TRANSFER]);
        const [st] = (await c.query(
          `select finance_v2_enabled as enabled, ledger_started_at is not null as started from finance_settings where account_user_id = $1`, [scope])).rows;
        if (!st?.enabled || !st.started) {
          throw new ConflictException({ error: "LEDGER_NOT_STARTED", message: "لم يبدأ دفتر الأستاذ بعد · The ledger has not started yet" });
        }

        const boxes = (await c.query(
          `select b.id, b.kind, b.is_trust, b.is_active, b.name_ar, b.name_en, b.gl_account_id, a.code, a.is_active as gl_active
             from bank_accounts b join accounts a on a.id = b.gl_account_id and a.user_id = b.user_id
            where b.user_id = $1 and b.id = any($2::int[])`, [scope, [fromId, toId]])).rows;
        const from = boxes.find((b: any) => Number(b.id) === fromId);
        const to = boxes.find((b: any) => Number(b.id) === toId);
        if (!from || !to) {
          throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", field: !from ? "fromBankAccountId" : "toBankAccountId", message: "Bank account not found" });
        }
        for (const [b, field] of [[from, "fromBankAccountId"], [to, "toBankAccountId"]] as const) {
          if (!b.is_active || !b.gl_active) {
            throw new BadRequestException({ error: "BANK_ACCOUNT_INACTIVE", field, message: `الحساب «${b.name_ar}» موقوف · The account "${b.name_en ?? b.name_ar}" is inactive` });
          }
        }
        if (Number(from.gl_account_id) === Number(to.gl_account_id)) throw bad("SAME_ACCOUNT", "اختر حسابين مختلفين · Choose two different accounts");

        const period = await this.periods.ensurePeriod(c, scope, date);
        if (period.status === "locked") {
          throw new ConflictException({ error: "PERIOD_LOCKED", message: `الفترة مقفلة نهائياً؛ اختر تاريخاً آخر · The period of ${date} is locked; choose another date` });
        }
        if (period.status === "closed" && !capabilities(user).includes("settings")) {
          throw new ConflictException({ error: "PERIOD_CLOSED", message: `الفترة مغلقة · The period of ${date} is closed; only a finance settings holder can post into it` });
        }

        const warnings: string[] = [];
        // The source's book balance after the transfer, at its date and today (a later outflow may already be booked).
        const [sb] = (await c.query(
          `select coalesce(sum(debit - credit) filter (where entry_date <= $3::date), 0)::text as at_date, coalesce(sum(debit - credit), 0)::text as at_today
             from journal_lines where user_id = $1 and account_id = $2 and entry_date <= $4::date`,
          [scope, from.gl_account_id, date, today])).rows;
        if (Math.min(toHalalas(sb.at_date), toHalalas(sb.at_today)) - amount < 0) warnings.push("SOURCE_BALANCE_NEGATIVE");

        const label = (b: any, lang: "ar" | "en") => `${lang === "ar" ? b.name_ar : b.name_en ?? b.name_ar} (${b.code})`;
        const memo = [
          `تحويل من ${label(from, "ar")} إلى ${label(to, "ar")} · Transfer from ${label(from, "en")} to ${label(to, "en")}`,
          reference ? `مرجع · Ref ${reference}` : null,
          note,
        ].filter(Boolean).join(" — ").slice(0, 500);
        const lines = [
          { accountId: Number(to.gl_account_id), debit: fromHalalas(amount), credit: "0.00", memo: to.name_ar },
          { accountId: Number(from.gl_account_id), debit: "0.00", credit: fromHalalas(amount), memo: from.name_ar },
        ];
        const ins = await c.query(
          `insert into manual_journals (user_id, kind, status, entry_date, memo, lines, created_by, submitted_at, approved_by, approved_at)
           values ($1, 'manual', 'approved', $2, $3, $4::jsonb, $5, now(), $5, now()) returning id`,
          [scope, date, memo, JSON.stringify(lines), user.id]);
        const mjId = Number(ins.rows[0].id);
        const res = await this.journal.post(c, {
          userId: scope, entryDate: date, origin: "manual", sourceType: "manual_journal", sourceId: mjId, event: "posted", memo,
          payload: { manualJournalId: mjId, draftedBy: user.id, transfer: { fromBankAccountId: fromId, toBankAccountId: toId, reference, note } },
          warnings, createdBy: user.id,
          lines: [
            { accountId: Number(to.gl_account_id), debit: amount, credit: 0, memo: to.name_ar, bankAccountId: toId },
            { accountId: Number(from.gl_account_id), debit: 0, credit: amount, memo: from.name_ar, bankAccountId: fromId },
          ],
        });
        await c.query(`update manual_journals set status = 'posted', posted_entry_id = $3, updated_at = now() where id = $1 and user_id = $2`, [mjId, scope, res.id]);
        await auditRow(c, scope, user.id, "finance_v2_account_transfer", mjId, "/finance/v2/bank-accounts/transfer");

        const bal = async (gl: number) => fromHalalas(toHalalas((await c.query(
          `select coalesce(sum(debit - credit), 0)::text as v from journal_lines where user_id = $1 and account_id = $2 and entry_date <= $3::date`,
          [scope, gl, today])).rows[0].v));
        const side = async (b: any) => ({
          bankAccountId: Number(b.id), glCode: b.code, nameAr: b.name_ar, nameEn: b.name_en ?? null, balance: await bal(Number(b.gl_account_id)),
        });
        return {
          manualJournalId: mjId, entryId: res.id, entryNo: res.entryNo, date, amount: fromHalalas(amount), memo,
          from: await side(from), to: await side(to), warnings,
        };
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }
}
