import type { Fv2Client } from "../db";
import { contractCtx, depositRefundedEvent, loadSettings, today, voucherUnlinked } from "../hooks/facts-loader";
import { ADVANCE_NOTE, DEPOSIT_DESC } from "../hooks/classify";
import { sqlOf } from "../hooks/sql";
import { toHalalas } from "../money";
import { assertTrustCovers, creditLines, resolveForGuard } from "../trust-guard";

/**
 * The trust guard for ending a contract (POST /contracts/:id/terminate under v2), run by
 * `terminateDispositions` BEFORE the legacy handler writes anything: the refunds the handler is about to
 * make — the security deposit (vouchers and legacy deposit-installment collections), prepaid rent and paid
 * installments — come out of trust for client money, so together they may not exceed what the trust account
 * holds unless the body says `allowTrustOverdraw: true` (policy `confirm`).
 *
 * The amounts mirror the legacy handler and the contractTerminated hook: a deposit voucher refunds its unlinked
 * amount (E10, through `depositRefundedEvent`, so the account is resolved exactly as it will be); a collection
 * refund mirrors each positive collection of its bucket (E03 of a negative collection: deposit → trust routing,
 * rent → trust for an agent landlord).
 *
 * Known limit: the legacy terminate writes in its own statements afterwards, outside this transaction, so the
 * trust lock covers the check only. A payout racing the very same second could still both pass.
 */
export async function guardTerminateTrust(c: Fv2Client, scope: number, contractId: number, body: any, actorId: number | null): Promise<void> {
  const q = sqlOf(c as any);
  const s = await loadSettings(q, scope);
  if (!s) return;
  const refundDeposit = body?.deposit === "refund";
  const refundAdvance = body?.advance === "refund";
  const refundInstallments = body?.installments === "refund";
  if (!refundDeposit && !refundAdvance && !refundInstallments) return;
  const ctx = await contractCtx(q, scope, s.mode, contractId);
  const method: string = body?.refundMethod || "bank_transfer";
  const rawBank = Number(body?.refundBankAccountId);
  let refundBank: number | null = null;
  if (Number.isInteger(rawBank) && rawBank > 0) {
    const [b] = await q.rows(`select id from bank_accounts where id = $1 and user_id = $2 and is_active`, [rawBank, scope]);
    refundBank = b ? rawBank : null;
  }
  const date = today();

  // Collections by legacy bucket: each positive one is mirrored by a refund collection.
  const [b] = await q.rows(
    `select coalesce(sum(pc.amount) filter (where p.description = $3), 0)::text as dep_total,
            coalesce(sum(pc.amount) filter (where p.description = $3 and pc.amount > 0.01), 0)::text as dep_pos,
            coalesce(sum(pc.amount) filter (where p.description is distinct from $3 and pc.notes = $4), 0)::text as adv_total,
            coalesce(sum(pc.amount) filter (where p.description is distinct from $3 and pc.notes = $4 and pc.amount > 0.01), 0)::text as adv_pos,
            coalesce(sum(pc.amount) filter (where p.description is distinct from $3 and pc.notes is distinct from $4), 0)::text as ins_total,
            coalesce(sum(pc.amount) filter (where p.description is distinct from $3 and pc.notes is distinct from $4 and pc.amount > 0.01), 0)::text as ins_pos
       from payment_collections pc join payments p on p.id = pc.payment_id
      where pc.user_id = $1 and p.contract_id = $2 and p.deleted_at is null`,
    [scope, contractId, DEPOSIT_DESC, ADVANCE_NOTE]);
  const agent = (ctx?.treatment ?? "agent") === "agent";
  const parts: Array<{ bank: { bankAccountId?: number | null; method?: string | null; agency?: boolean }; amount: number }> = [];
  const bucket = (total: string, pos: string) => (toHalalas(total) > 1 ? toHalalas(pos) : 0);
  if (refundDeposit) parts.push({ bank: { method, agency: true }, amount: bucket(b.dep_total, b.dep_pos) });
  if (refundAdvance) parts.push({ bank: { method, agency: agent }, amount: bucket(b.adv_total, b.adv_pos) });
  if (refundInstallments) parts.push({ bank: { method, agency: agent }, amount: bucket(b.ins_total, b.ins_pos) });

  const events = [];
  if (refundDeposit) {
    const vouchers = await q.rows(
      `select id from simple_invoices where user_id = $1 and contract_id = $2 and kind = 'deposit' and status = 'confirmed' and deleted_at is null`,
      [scope, contractId]);
    const unlinked = await voucherUnlinked(q, scope, vouchers.map((v: any) => Number(v.id)));
    for (const [vid, amt] of unlinked) if (amt > 0) events.push(depositRefundedEvent(vid, amt, ctx, date, method, s, refundBank));
  }
  const lines = await resolveForGuard(c, scope, creditLines(parts));
  await assertTrustCovers(c, scope, { events, lines }, { allow: body?.allowTrustOverdraw, actorId, source: `/contracts/${contractId}/terminate` });
}
