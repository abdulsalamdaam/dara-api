/**
 * Ledger events of the tier-3 AP records (DESIGN §8.4): supplier bills (E38)
 * and supplier payments (E39). One builder per record, used by the live path
 * AND the backfill/catch-up extraction, so both key and freeze the event
 * identically.
 *
 * Keys: `supplier_bill,<id>,approved` and `supplier_payment,<id>,paid`; a
 * voided record adds `reversal:<event>` dated its void date (never before
 * the original).
 */
import type { LedgerEvent } from "../ledger-emitter.service";
import type { Sql } from "../hooks/sql";
import { reversalEvent, type FinanceSettingsRow } from "../hooks/facts-loader";
import { resolveTreatment, SYS, type AccountRef, type BillFacts, type MoneyFacts, type VatCategory } from "../rules";
import { fromHalalas, toHalalas } from "../money";

const money = (v: unknown) => fromHalalas(toHalalas(String(v)));

export async function billEvents(q: Sql, userId: number, s: FinanceSettingsRow, billId: number): Promise<{ events: LedgerEvent[]; createdAt: string } | null> {
  const [b] = await q.rows(
    `select b.id, b.number, b.supplier_id, b.supplier_invoice_no, to_char(b.bill_date,'YYYY-MM-DD') as bill_date, b.status, b.approved_at is not null as approved,
            b.owner_id, b.property_id, b.charge_to, b.total::text as total, to_char(b.voided_on,'YYYY-MM-DD') as voided_on, b.created_at::text as created,
            s.name_ar as supplier_name, s.default_gl_account_id as supplier_gl,
            o.id as o_id, o.is_account_holder as o_holder
       from supplier_bills b join suppliers s on s.id = b.supplier_id and s.user_id = b.user_id
       left join owners o on o.id = b.owner_id and o.user_id = b.user_id
      where b.id = $1 and b.user_id = $2`,
    [billId, userId],
  );
  if (!b || !b.approved) return null;
  const lines = await q.rows(
    `select line_no, description, gl_account_id, net_amount::text as net, vat_amount::text as vat, vat_category, vat_rate::text as rate, vat_recoverable
       from supplier_bill_lines where bill_id = $1 and user_id = $2 order by line_no`,
    [billId, userId],
  );
  const t = b.o_id ? resolveTreatment(s.mode, { id: Number(b.o_id), isAccountHolder: b.o_holder === true }) : { treatment: "principal" as const, ownerId: null, warnings: [] };
  const fallback: AccountRef = { sys: b.property_id ? SYS.expensePropertyOther : SYS.expenseGeneralOther };
  const memo = `فاتورة مورد ${b.number}${b.supplier_invoice_no ? ` (${b.supplier_invoice_no})` : ""} · Supplier bill ${b.number} — ${b.supplier_name}`.slice(0, 500);
  const facts: BillFacts = {
    date: b.bill_date, treatment: t.treatment, dims: { ownerId: t.ownerId ?? b.owner_id ?? null, propertyId: b.property_id ?? null }, warnings: [...t.warnings],
    memo, billId: b.id, supplierId: b.supplier_id, chargeTo: b.charge_to === "landlord" ? "landlord" : "company", total: money(b.total),
    lines: lines.map((l: any) => ({
      account: l.gl_account_id ? { id: Number(l.gl_account_id) } : b.supplier_gl ? { id: Number(b.supplier_gl) } : fallback,
      net: money(l.net), vat: money(l.vat), category: l.vat_category as VatCategory, rate: Math.round(Number(l.rate)), recoverable: l.vat_recoverable === true,
      memo: String(l.description ?? "").slice(0, 500) || null,
    })),
  };
  const events: LedgerEvent[] = [{ sourceType: "supplier_bill", sourceId: b.id, event: "approved", occurredOn: b.bill_date, payload: { rule: "E38", facts } }];
  if (b.status === "void") {
    const date = b.voided_on && b.voided_on > b.bill_date ? b.voided_on : b.bill_date;
    events.push(reversalEvent("supplier_bill", b.id, "approved", date, { reason: "voided" }));
  }
  return { events, createdAt: b.created };
}

export async function supplierPaymentEvents(q: Sql, userId: number, _s: FinanceSettingsRow, paymentId: number): Promise<{ events: LedgerEvent[]; createdAt: string } | null> {
  const [p] = await q.rows(
    `select p.id, p.number, p.supplier_id, to_char(p.paid_on,'YYYY-MM-DD') as paid_on, p.amount::text as amount, p.bank_account_id, p.method, p.reference,
            p.status, to_char(p.voided_on,'YYYY-MM-DD') as voided_on, p.created_at::text as created, s.name_ar as supplier_name
       from supplier_payments p join suppliers s on s.id = p.supplier_id and s.user_id = p.user_id
      where p.id = $1 and p.user_id = $2`,
    [paymentId, userId],
  );
  if (!p) return null;
  const facts: MoneyFacts & { supplierId: number } = {
    date: p.paid_on, treatment: "principal", dims: {}, warnings: [],
    memo: `سند صرف ${p.number} · Payment voucher ${p.number} — ${p.supplier_name}${p.reference ? ` (${p.reference})` : ""}`.slice(0, 500),
    amount: money(p.amount), bank: { bankAccountId: p.bank_account_id ?? null, method: p.method ?? null }, supplierId: p.supplier_id,
  };
  const events: LedgerEvent[] = [{ sourceType: "supplier_payment", sourceId: p.id, event: "paid", occurredOn: p.paid_on, payload: { rule: "E39", facts } }];
  if (p.status === "void") {
    const date = p.voided_on && p.voided_on > p.paid_on ? p.voided_on : p.paid_on;
    events.push(reversalEvent("supplier_payment", p.id, "paid", date, { reason: "voided" }));
  }
  return { events, createdAt: p.created };
}
