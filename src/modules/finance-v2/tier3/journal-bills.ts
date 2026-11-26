import { ConflictException } from "@nestjs/common";
import type { Fv2Client, Fv2Pool } from "../db";
import { LOCK_KEYS } from "../lock-keys";
import { auditRow } from "../audit";

/**
 * A supplier's balance from a journal line (accountant, 27 Nov 2026, note 14; migration 0101).
 *
 * The AP sub-ledger (aging, supplier statement, supplier payments, R12) is made of supplier bills and payments. A manual
 * or opening journal line that CREDITS 2111 with a supplier («المورد») therefore becomes, when the journal is approved, a
 * bill of that supplier: approved, dated the entry date, out of VAT scope, and with NO ledger entry of its own — the
 * journal already credited 2111, so billEvents posts nothing for it (finance_journal_bills marks it). Supplier payments
 * then settle it like any bill (E39 Dr 2111 / Cr bank), and R12 ties.
 *
 * Such a bill is never voided by itself: reversing the journal entry voids it (POST /journal/:id/reverse), and that is
 * refused while a posted supplier payment settles it (void the payment first) — otherwise the payment would be left
 * debiting 2111 for a balance that no longer exists.
 */

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export interface JournalBillLine {
  /** 1-based position of the line in the journal. */
  lineNo: number;
  supplierId: number;
  /** Credit in halalas (> 0). */
  amount: number;
  memo: string | null;
  propertyId?: number | null;
}

const sar = (h: number) => (h / 100).toFixed(2);

/** Creates the bills of a just-posted journal. Runs in the approval transaction. Returns the bill ids. */
export async function insertJournalBills(
  c: Fv2Client, scope: number, actorId: number,
  j: { manualJournalId: number; entryId: number; entryNo: string; entryDate: string; kind: "manual" | "opening" },
  lines: JournalBillLine[],
): Promise<number[]> {
  if (!lines.length) return [];
  await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BILL]);
  const ids: number[] = [];
  for (const l of lines) {
    const [n] = (await c.query(
      `select coalesce(max(cast(substring(number from '^BILL-([0-9]+)$') as integer)), 0) + 1 as n from supplier_bills where user_id = $1 and number ~ '^BILL-[0-9]+$'`,
      [scope])).rows;
    const number = `BILL-${String(n.n).padStart(6, "0")}`;
    const label = j.kind === "opening" ? "رصيد افتتاحي للمورد" : "رصيد مورد من قيد يدوي";
    const labelEn = j.kind === "opening" ? "Supplier opening balance" : "Supplier balance from a manual journal";
    const notes = `${label} — ${j.entryNo} · ${labelEn} — ${j.entryNo}`;
    const r = await c.query(
      `insert into supplier_bills (user_id, number, supplier_id, supplier_invoice_no, bill_date, due_date, status, property_id, charge_to,
                                   notes, subtotal, vat_total, total, created_by, approved_by, approved_at)
       values ($1, $2, $3, null, $4, $4, 'approved', $5, 'company', $6, $7, 0, $7, $8, $8, now()) returning id`,
      [scope, number, l.supplierId, j.entryDate, l.propertyId ?? null, notes, sar(l.amount), actorId]);
    const id = Number(r.rows[0].id);
    await c.query(
      `insert into supplier_bill_lines (bill_id, user_id, line_no, description, gl_account_id, net_amount, vat_category, vat_rate, vat_amount, vat_recoverable)
       values ($1, $2, 1, $3, null, $4, 'O', 0, 0, false)`,
      [id, scope, (l.memo || label).slice(0, 500), sar(l.amount)]);
    await c.query(
      `insert into finance_journal_bills (bill_id, user_id, manual_journal_id, entry_id, line_no) values ($1, $2, $3, $4, $5)`,
      [id, scope, j.manualJournalId, j.entryId, l.lineNo]);
    await auditRow(c, scope, actorId, "finance_v2_bill", id, `/finance/v2/manual-journals/${j.manualJournalId}/approve`);
    ids.push(id);
  }
  return ids;
}

/** The journal a bill came from, or null for an ordinary bill. */
export async function journalOfBill(q: Q, scope: number, billId: number): Promise<{ manualJournalId: number; entryId: number } | null> {
  const r = (await q.query(
    `select manual_journal_id, entry_id from finance_journal_bills where bill_id = $1 and user_id = $2`, [billId, scope])).rows[0];
  return r ? { manualJournalId: Number(r.manual_journal_id), entryId: Number(r.entry_id) } : null;
}

/**
 * A journal entry is being reversed: void the bills it created (dated the reversal date). 409 JOURNAL_BILL_HAS_PAYMENTS
 * when a posted supplier payment settles one of them. A no-op for an entry with no such bill.
 */
export async function voidJournalBills(c: Fv2Client, scope: number, actorId: number, entryId: number, date: string): Promise<number[]> {
  const bills = (await c.query(
    `select b.id, b.number, b.status from finance_journal_bills j join supplier_bills b on b.id = j.bill_id and b.user_id = j.user_id
      where j.user_id = $1 and j.entry_id = $2 order by b.id for update of b`, [scope, entryId])).rows;
  if (!bills.length) return [];
  const paid = (await c.query(
    `select distinct b.number from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
       join supplier_bills b on b.id = a.bill_id and b.user_id = a.user_id
      where a.user_id = $1 and a.bill_id = any($2::int[]) and p.status = 'posted' order by 1`, [scope, bills.map((b: any) => Number(b.id))])).rows;
  if (paid.length) {
    const list = paid.map((x: any) => x.number).join(", ");
    throw new ConflictException({
      error: "JOURNAL_BILL_HAS_PAYMENTS",
      message: `رصيد المورد في هذا القيد مسدد بسندات صرف (${list})؛ ألغِ سندات الصرف أولاً · The supplier balance of this entry is settled by supplier payments (${list}); void them first`,
      bills: paid.map((x: any) => x.number),
    });
  }
  const ids: number[] = [];
  for (const b of bills) {
    if (b.status === "void") continue;
    await c.query(
      `update supplier_bills set status = 'void', voided_by = $3, voided_at = now(), voided_on = greatest($4::date, bill_date), void_reason = $5, updated_at = now()
        where id = $1 and user_id = $2`, [b.id, scope, actorId, date, "عكس القيد · journal entry reversed"]);
    await auditRow(c, scope, actorId, "finance_v2_bill", Number(b.id), `/finance/v2/journal/${entryId}/reverse`);
    ids.push(Number(b.id));
  }
  return ids;
}
