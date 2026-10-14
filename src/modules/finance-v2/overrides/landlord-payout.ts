import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";
import { withTx, type Fv2Pool } from "../db";
import type { LedgerEmitter } from "../ledger-emitter.service";
import { LOCK_KEYS } from "../lock-keys";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { nextPvNumber } from "../pv-number";
import { transferAmount } from "../tier1/account-transfer.service";
import { sqlOf } from "../hooks/sql";
import { loadSettings, payoutEvent } from "../hooks/facts-loader";
import { assertPayoutWithinDue } from "./landlord-dues";

/**
 * POST /reports/landlord-payouts under Finance v2 (accountant, 15 Oct 2026:
 * «تحويل للمؤجر» from the landlords screen, paid from trust, with a سند صرف).
 *
 * The legacy handler validates the landlord (scope) and the amount, then
 * forks here. Everything after that happens in ONE transaction under the
 * account's payout lock, so two clicks — or two tabs — cannot both pass the
 * net-due check and both pay:
 *
 *  - `requestId` (the form's per-open id, 8–64 of [A-Za-z0-9_-]): a repeat
 *    returns the first payout (`replayed: true`), nothing new is written;
 *  - amount: positive, at most 2 decimals, at most 999,999,999.99;
 *  - `transferDate`: YYYY-MM-DD, default today (Riyadh), never in the future;
 *  - `bankAccountId` ("paid from"): an ACTIVE account of this scope, else
 *    400/404. Omitted → the posting engine's default, which for an agent
 *    landlord in Manager mode with trust routing is the default trust account
 *    (1114), so the entry is Dr 2121 / Cr 1114 (E19);
 *  - the net-due check (409 PAYOUT_EXCEEDS_DUE unless `allowAdvance: true`);
 *  - the landlord_payouts row (the same columns the legacy insert writes),
 *    its finance_payout_meta (paid on, paid from), a PV-###### number in the
 *    account's one payment-voucher series, and the E19 outbox event.
 *
 * The response is the legacy row plus `voucherNumber`, `requestId`, `replayed`.
 */
export interface PayoutV2Result {
  id: number;
  userId: number;
  ownerId: number;
  amount: string;
  transferDate: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  bankAccountId: number | null;
  voucherNumber: string;
  requestId: string | null;
  replayed: boolean;
}

const bad = (error: string, message: string, field?: string) => new BadRequestException({ error, message, ...(field ? { field } : {}) });

const optText = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("BAD_INPUT", `${field} must be a string`, field);
  const s = v.trim();
  if (s.length > max) throw bad("BAD_INPUT", `${field} is too long (at most ${max} characters)`, field);
  return s || null;
};

const ROW = `lp.id, lp.user_id, lp.owner_id, lp.amount::text as amount, lp.transfer_date, lp.method, lp.reference, lp.notes, lp.created_at, lp.deleted_at`;

const shape = (r: any, extra: { bankAccountId: number | null; voucherNumber: string; requestId: string | null; replayed: boolean }): PayoutV2Result => ({
  id: Number(r.id), userId: Number(r.user_id), ownerId: Number(r.owner_id), amount: r.amount,
  transferDate: r.transfer_date ?? null, method: r.method ?? null, reference: r.reference ?? null, notes: r.notes ?? null,
  createdAt: r.created_at, deletedAt: r.deleted_at ?? null, ...extra,
});

export async function createPayoutV2(
  deps: { pool: Fv2Pool; emitter: LedgerEmitter },
  scope: number,
  user: Pick<AuthUser, "id">,
  ownerId: number,
  body: any,
  accounting: () => Promise<any>,
): Promise<PayoutV2Result> {
  const cents = transferAmount(body?.amount);
  const amount = fromHalalas(cents);
  const today = riyadhToday();
  const date = body?.transferDate ? isoDate(body.transferDate, "transferDate") : today;
  if (date > today) throw bad("FUTURE_DATE", "لا يمكن أن يكون تاريخ التحويل في المستقبل · The transfer date cannot be in the future", "transferDate");
  const method = optText(body?.method, "method", 50);
  const reference = optText(body?.reference, "reference", 100);
  const notes = optText(body?.notes, "notes", 500);
  const requestId = body?.requestId == null || body.requestId === "" ? null : String(body.requestId);
  if (requestId != null && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw bad("BAD_INPUT", "requestId must be 8–64 letters, digits, - or _", "requestId");
  let bankAccountId: number | null = null;
  if (body?.bankAccountId !== undefined && body?.bankAccountId !== null && body?.bankAccountId !== "") {
    const n = Number(body.bankAccountId);
    if (!Number.isSafeInteger(n) || n <= 0) throw bad("BAD_BANK_ACCOUNT", "bankAccountId must be an id", "bankAccountId");
    bankAccountId = n;
  }

  // The dues report runs on the shared pool, so it is read BEFORE the transaction: run under the payout lock it
  // needs a second connection while every waiter holds one, and pool-size concurrent payouts starve the whole API.
  // Under the lock only the payouts committed since that read are re-counted (the report's `transferred` is their sum).
  const allowAdvance = body?.allowAdvance === true;
  let report: any = null;
  if (!allowAdvance) {
    const q = sqlOf(deps.pool as any);
    const [o] = (await loadSettings(q, scope))?.mode === "owner" ? [] : await q.rows(`select is_account_holder from owners where id = $1 and user_id = $2`, [ownerId, scope]);
    if (o && o.is_account_holder !== true) report = await accounting(); // the same cases assertPayoutWithinDue checks
  }
  const out = await withTx(deps.pool, async (c) => {
    await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.LANDLORD_PAYOUT]);
    if (requestId) {
      const [prev] = (await c.query(
        `select ${ROW}, v.number, m.bank_account_id from finance_payout_vouchers v
           join landlord_payouts lp on lp.id = v.payout_id and lp.user_id = v.user_id
           left join finance_payout_meta m on m.payout_id = lp.id and m.user_id = lp.user_id
          where v.user_id = $1 and v.request_id = $2`, [scope, requestId])).rows;
      if (prev) {
        return { replay: true, row: shape(prev, { bankAccountId: prev.bank_account_id ?? null, voucherNumber: prev.number, requestId, replayed: true }) };
      }
    }
    if (bankAccountId != null) {
      const [b] = (await c.query(
        `select b.is_active, a.is_active as gl_active, b.name_ar, b.name_en from bank_accounts b
           join accounts a on a.id = b.gl_account_id and a.user_id = b.user_id where b.user_id = $1 and b.id = $2`, [scope, bankAccountId])).rows;
      if (!b) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", field: "bankAccountId", message: "Bank account not found" });
      if (!b.is_active || !b.gl_active) {
        throw bad("BANK_ACCOUNT_INACTIVE", `الحساب «${b.name_ar}» موقوف · The account "${b.name_en ?? b.name_ar}" is inactive`, "bankAccountId");
      }
    }
    // Under the lock: an earlier payout of this account has committed before this check reads the dues.
    await assertPayoutWithinDue(sqlOf(c), scope, ownerId, Number(amount), allowAdvance, async () => {
      if (!report) report = await accounting(); // only if the mode or the holder flag changed since the read above
      const [p] = (await c.query(
        `select coalesce(sum(amount), 0)::text as amt from landlord_payouts where user_id = $1 and owner_id = $2 and deleted_at is null`, [scope, ownerId])).rows;
      const paidNow = toHalalas(p?.amt ?? "0");
      return {
        ...report,
        landlordDues: (report?.landlordDues ?? []).map((d: any) => {
          if (Number(d.ownerId) !== ownerId) return d;
          const since = paidNow - toHalalas(Number(d.transferred ?? 0).toFixed(2));
          return { ...d, transferred: Number(fromHalalas(paidNow)), remaining: Number(fromHalalas(toHalalas(Number(d.remaining ?? 0).toFixed(2)) - since)) };
        }),
      };
    });

    const [row] = (await c.query(
      `insert into landlord_payouts (user_id, owner_id, amount, transfer_date, method, reference, notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, user_id, owner_id, amount::text as amount, transfer_date, method, reference, notes, created_at, deleted_at`,
      [scope, ownerId, amount, date, method, reference, notes])).rows;
    const payoutId = Number(row.id);
    await c.query(
      `insert into finance_payout_meta (payout_id, user_id, paid_on, bank_account_id) values ($1, $2, $3, $4)`,
      [payoutId, scope, date, bankAccountId]);
    const number = await nextPvNumber(c, scope);
    await c.query(
      `insert into finance_payout_vouchers (payout_id, user_id, number, request_id, created_by) values ($1, $2, $3, $4, $5)`,
      [payoutId, scope, number, requestId, user.id ?? null]);
    const s = await loadSettings(sqlOf(c), scope);
    const e = s ? await payoutEvent(sqlOf(c), scope, s, payoutId) : null;
    if (e) await deps.emitter.emit({ fv2: true, userId: scope, tx: c }, e);
    return { replay: false, row: shape(row, { bankAccountId, voucherNumber: number, requestId, replayed: false }) };
  });
  if (!out.replay) deps.emitter.kick(scope);
  return out.row;
}
