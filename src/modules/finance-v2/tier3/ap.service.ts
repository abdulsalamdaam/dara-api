import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { LedgerEmitter, type LedgerEvent } from "../ledger-emitter.service";
import { auditRow, isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { LOCK_KEYS } from "../lock-keys";
import { sqlOf } from "../hooks/sql";
import { loadSettings } from "../hooks/facts-loader";
import { usageOf } from "../hooks/classify";
import { accountVatRegistered } from "../commission";
import { classifyKey } from "../../uploads/key-scope";
import { asciiDigits } from "../tier1/iban";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { recoverDefault, SUPPLIER_VAT_RE, type RecoverReason } from "../tier1/expense-math";
import { nextPvNumber } from "../pv-number";
import { riyadhNow } from "../reports/core-math";
import { BUCKETS, type Bucket } from "../reports/sub-math";
import { langOf } from "../reports/common";
import { apAgingOf, billLineAmounts, dueDateOf, paymentStatusOf } from "./ap-math";
import { billEvents, supplierPaymentEvents } from "./ap-events";
import type { VatCategory } from "../rules";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;
const CATS: readonly VatCategory[] = ["S", "Z", "E", "O"];
const m = (v: unknown) => fromHalalas(toHalalas(String(v ?? "0")));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

const bad = (error: string, message: string) => new BadRequestException({ error, message });

function optStr(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("BAD_INPUT", `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad("BAD_INPUT", `${field} is too long (max ${max})`);
  return s || null;
}
function optId(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad("BAD_INPUT", `${field} must be an id`);
  return n;
}
function amountOf(v: unknown, field = "amount"): number {
  let h: number;
  try {
    h = toHalalas(asciiDigits(String(v ?? "")).trim());
  } catch {
    throw bad("BAD_AMOUNT", `المبلغ غير صالح · ${field} must be a decimal with at most 2 places`);
  }
  if (h <= 0) throw bad("BAD_AMOUNT", `المبلغ يجب أن يكون موجباً · ${field} must be positive`);
  return h;
}

export interface SupplierOut {
  id: number;
  nameAr: string;
  nameEn: string | null;
  name: string;
  vatNumber: string | null;
  crNumber: string | null;
  iban: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentTermsDays: number;
  defaultGlAccountId: number | null;
  isActive: boolean;
  notes: string | null;
  /** Open AP from the sub-ledger (approved bills less posted payments), 2-decimal string. */
  balance: string;
  createdAt: string;
}

export interface BillLineOut {
  lineNo: number;
  description: string;
  glAccountId: number | null;
  net: string;
  vatCategory: VatCategory;
  vatRate: string;
  vat: string;
  gross: string;
  vatRecoverable: boolean;
}

export interface BillOut {
  id: number;
  number: string;
  supplierId: number;
  supplierName: string;
  supplierVatNumber: string | null;
  supplierInvoiceNo: string | null;
  billDate: string;
  dueDate: string;
  status: "draft" | "approved" | "void";
  ownerId: number | null;
  propertyId: number | null;
  chargeTo: "company" | "landlord";
  attachmentKey: string | null;
  notes: string | null;
  subtotal: string;
  vatTotal: string;
  total: string;
  paid: string;
  remaining: string;
  paymentStatus: "unpaid" | "partial" | "paid" | null;
  overdue: boolean;
  approvedAt: string | null;
  approvedBy: number | null;
  voidedOn: string | null;
  voidReason: string | null;
  createdAt: string;
  lines?: BillLineOut[];
  payments?: Array<{ paymentId: number; number: string; paidOn: string; amount: string; status: string }>;
  posting: { status: string; entryId: number | null; entryNo: string | null } | null;
}

export interface SupplierPaymentOut {
  id: number;
  number: string;
  supplierId: number;
  supplierName: string;
  paidOn: string;
  amount: string;
  bankAccountId: number | null;
  method: string | null;
  reference: string | null;
  status: "posted" | "void";
  voidedOn: string | null;
  voidReason: string | null;
  allocations: Array<{ billId: number; billNumber: string; supplierInvoiceNo: string | null; amount: string }>;
  posting: { status: string; entryId: number | null; entryNo: string | null } | null;
  createdAt: string;
}

const SUPPLIER_SQL = `select s.*, (
    coalesce((select sum(b.total) from supplier_bills b where b.user_id = s.user_id and b.supplier_id = s.id and b.status = 'approved'), 0)
  - coalesce((select sum(a.amount) from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
               where p.user_id = s.user_id and p.supplier_id = s.id and p.status = 'posted'), 0))::text as balance
  from suppliers s`;

const BILL_SQL = `select b.*, to_char(b.bill_date,'YYYY-MM-DD') as bill_date_s, to_char(b.due_date,'YYYY-MM-DD') as due_date_s,
    to_char(b.voided_on,'YYYY-MM-DD') as voided_on_s, s.name_ar as supplier_name, s.vat_number as supplier_vat,
    coalesce((select sum(a.amount) from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
               where a.bill_id = b.id and a.user_id = b.user_id and p.status = 'posted'), 0)::text as paid,
    o.status as o_status, o.entry_id as o_entry, je.entry_no as o_entry_no
  from supplier_bills b join suppliers s on s.id = b.supplier_id and s.user_id = b.user_id
  left join ledger_outbox o on o.user_id = b.user_id and o.source_type = 'supplier_bill' and o.source_id = b.id and o.event = 'approved'
  left join journal_entries je on je.id = o.entry_id and je.user_id = b.user_id`;

const PAYMENT_SQL = `select p.*, to_char(p.paid_on,'YYYY-MM-DD') as paid_on_s, to_char(p.voided_on,'YYYY-MM-DD') as voided_on_s, s.name_ar as supplier_name,
    o.status as o_status, o.entry_id as o_entry, je.entry_no as o_entry_no
  from supplier_payments p join suppliers s on s.id = p.supplier_id and s.user_id = p.user_id
  left join ledger_outbox o on o.user_id = p.user_id and o.source_type = 'supplier_payment' and o.source_id = p.id and o.event = 'paid'
  left join journal_entries je on je.id = o.entry_id and je.user_id = p.user_id`;

interface NormalLine {
  description: string;
  glAccountId: number | null;
  net: number;
  vat: number;
  category: VatCategory;
  rate: number;
  recoverable: boolean;
  recoverReason: RecoverReason | "no_supplier_vat";
}

/**
 * Tier 3 accounts payable (DESIGN §8.4): the supplier master, supplier bills
 * with input VAT (draft → approved → void), supplier payments (payment
 * vouchers PV-###### allocated to bills), supplier statements and AP aging.
 *
 *  - Approving a bill enqueues E38 `supplier_bill,<id>,approved` (Dr expense /
 *    Dr input VAT / Cr 2111); a payment enqueues E39 `supplier_payment,<id>,paid`
 *    (Dr 2111 / Cr bank). Voiding enqueues the `reversal:` of either.
 *  - Allocation is serialised per account (AP lock) and never exceeds a bill's
 *    open amount; a bill with posted payments cannot be voided.
 *  - Input VAT is recoverable only with the supplier's VAT number on file
 *    (a tax invoice, VAT IR Art. 49), on top of the §8.2 b defaults.
 * Every id is loaded with the account scope (a miss is 404).
 */
@Injectable()
export class ApService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly emitter: LedgerEmitter,
    private readonly banks: BankAccountsService,
  ) {}

  // ── Suppliers ─────────────────────────────────────────────────────────────

  async listSuppliers(scope: number, q: any = {}): Promise<{ rows: SupplierOut[]; total: string }> {
    const p: unknown[] = [scope];
    const where = ["s.user_id = $1"];
    if (!(q?.includeInactive === "true" || q?.includeInactive === true || q?.includeInactive === "1")) where.push("s.is_active");
    if (typeof q?.q === "string" && q.q.trim()) {
      p.push(`%${q.q.trim().toLowerCase()}%`);
      where.push(`(lower(s.name_ar) like $${p.length} or lower(coalesce(s.name_en,'')) like $${p.length} or coalesce(s.vat_number,'') like $${p.length})`);
    }
    const rows = (await this.pool.query(`${SUPPLIER_SQL} where ${where.join(" and ")} order by s.name_ar, s.id`, p)).rows.map((r: any) => this.shapeSupplier(r, langOf(q?.lang)));
    return { rows, total: fromHalalas(rows.reduce((a, r) => a + toHalalas(r.balance), 0)) };
  }

  async getSupplier(scope: number, id: number, q: Q = this.pool, lang: "ar" | "en" = "ar"): Promise<SupplierOut> {
    const r = (await q.query(`${SUPPLIER_SQL} where s.id = $1 and s.user_id = $2`, [id, scope])).rows[0];
    if (!r) throw new NotFoundException({ error: "SUPPLIER_NOT_FOUND", message: "Supplier not found" });
    return this.shapeSupplier(r, lang);
  }

  async createSupplier(scope: number, user: { id: number }, body: any): Promise<SupplierOut> {
    return withTx(this.pool, async (c) => {
      const v = await this.normaliseSupplier(c, scope, body, null);
      try {
        const r = await c.query(
          `insert into suppliers (user_id, name_ar, name_en, vat_number, cr_number, iban, phone, email, address, payment_terms_days, default_gl_account_id, notes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [scope, v.nameAr, v.nameEn, v.vatNumber, v.crNumber, v.iban, v.phone, v.email, v.address, v.terms, v.gl, v.notes, user.id]);
        await auditRow(c, scope, user.id, "finance_v2_supplier", r.rows[0].id, "/finance/v2/suppliers");
        return this.getSupplier(scope, Number(r.rows[0].id), c);
      } catch (err: any) {
        this.mapUnique(err);
      }
    });
  }

  async updateSupplier(scope: number, user: { id: number }, id: number, body: any): Promise<SupplierOut> {
    return withTx(this.pool, async (c) => {
      const cur = (await c.query(`select * from suppliers where id = $1 and user_id = $2 for update`, [id, scope])).rows[0];
      if (!cur) throw new NotFoundException({ error: "SUPPLIER_NOT_FOUND", message: "Supplier not found" });
      const merged = {
        nameAr: cur.name_ar, nameEn: cur.name_en, vatNumber: cur.vat_number, crNumber: cur.cr_number, iban: cur.iban, phone: cur.phone,
        email: cur.email, address: cur.address, paymentTermsDays: cur.payment_terms_days, defaultGlAccountId: cur.default_gl_account_id, notes: cur.notes,
        ...Object.fromEntries(Object.entries(body ?? {}).filter(([, x]) => x !== undefined)),
      };
      const v = await this.normaliseSupplier(c, scope, merged, id);
      const active = body?.isActive === undefined ? cur.is_active : body.isActive;
      if (typeof active !== "boolean") throw bad("BAD_INPUT", "isActive must be a boolean");
      if (v.vatNumber !== cur.vat_number) {
        const used = await c.query(`select 1 from supplier_bills where user_id = $1 and supplier_id = $2 and status = 'approved' and exists (
            select 1 from supplier_bill_lines l where l.bill_id = supplier_bills.id and l.vat_recoverable) limit 1`, [scope, id]);
        if (used.rowCount && !v.vatNumber) {
          throw new ConflictException({ error: "SUPPLIER_VAT_IN_USE", message: "Approved bills claim input VAT on this supplier's VAT number; it cannot be removed" });
        }
      }
      try {
        await c.query(
          `update suppliers set name_ar = $3, name_en = $4, vat_number = $5, cr_number = $6, iban = $7, phone = $8, email = $9, address = $10,
                  payment_terms_days = $11, default_gl_account_id = $12, notes = $13, is_active = $14, updated_at = now()
            where id = $1 and user_id = $2`,
          [id, scope, v.nameAr, v.nameEn, v.vatNumber, v.crNumber, v.iban, v.phone, v.email, v.address, v.terms, v.gl, v.notes, active]);
      } catch (err: any) {
        this.mapUnique(err);
      }
      await auditRow(c, scope, user.id, "finance_v2_supplier", id, `/finance/v2/suppliers/${id}`, "PATCH");
      return this.getSupplier(scope, id, c);
    });
  }

  /** Only a supplier with no bills and no payments; otherwise deactivate it. */
  async deleteSupplier(scope: number, user: { id: number }, id: number): Promise<{ ok: true }> {
    return withTx(this.pool, async (c) => {
      const cur = (await c.query(`select id from suppliers where id = $1 and user_id = $2 for update`, [id, scope])).rows[0];
      if (!cur) throw new NotFoundException({ error: "SUPPLIER_NOT_FOUND", message: "Supplier not found" });
      const used = await c.query(`select 1 from supplier_bills where user_id = $1 and supplier_id = $2 union all
                                  select 1 from supplier_payments where user_id = $1 and supplier_id = $2 limit 1`, [scope, id]);
      if (used.rowCount) throw new ConflictException({ error: "SUPPLIER_IN_USE", message: "المورد له فواتير أو مدفوعات؛ يمكن إيقافه فقط · The supplier has bills or payments; deactivate it instead" });
      await c.query(`delete from suppliers where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "finance_v2_supplier", id, `/finance/v2/suppliers/${id}`, "DELETE");
      return { ok: true as const };
    });
  }

  /**
   * Supplier statement from the AP sub-ledger (credit-normal: + = we owe).
   * Bills credit at their bill date; payments debit at their payment date;
   * a void adds the opposite line at its void date, so history is never rewritten.
   */
  async supplierStatement(scope: number, id: number, q: any = {}) {
    const lang = langOf(q?.lang);
    const supplier = await this.getSupplier(scope, id, this.pool, lang);
    const today = riyadhToday();
    const to = q?.to ? isoDate(q.to, "to") : today;
    const from = q?.from ? isoDate(q.from, "from") : `${to.slice(0, 4)}-01-01`;
    if (from > to) throw bad("BAD_RANGE", "from must not be after to");
    const moves = (await this.pool.query(
      `select * from (
         select b.bill_date as d, 'bill' as type, b.id, b.number, b.supplier_invoice_no as ref, b.total as credit, 0::numeric as debit, b.created_at as ts
           from supplier_bills b where b.user_id = $1 and b.supplier_id = $2 and b.approved_at is not null
         union all
         select b.voided_on, 'bill_void', b.id, b.number, b.supplier_invoice_no, 0, b.total, b.voided_at
           from supplier_bills b where b.user_id = $1 and b.supplier_id = $2 and b.approved_at is not null and b.status = 'void'
         union all
         select p.paid_on, 'payment', p.id, p.number, p.reference, 0, p.amount, p.created_at
           from supplier_payments p where p.user_id = $1 and p.supplier_id = $2
         union all
         select p.voided_on, 'payment_void', p.id, p.number, p.reference, p.amount, 0, p.voided_at
           from supplier_payments p where p.user_id = $1 and p.supplier_id = $2 and p.status = 'void'
       ) x where x.d <= $3::date order by x.d, x.ts, x.id`,
      [scope, id, to])).rows;
    let opening = 0;
    let bal = 0;
    const lines: any[] = [];
    let credits = 0;
    let debits = 0;
    for (const r of moves) {
      const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
      const cr = toHalalas(String(r.credit));
      const dr = toHalalas(String(r.debit));
      if (d < from) {
        opening += cr - dr;
        bal = opening;
        continue;
      }
      bal += cr - dr;
      credits += cr;
      debits += dr;
      lines.push({ date: d, type: r.type, id: Number(r.id), number: r.number, reference: r.ref ?? null, debit: fromHalalas(dr), credit: fromHalalas(cr), balance: fromHalalas(bal) });
    }
    if (!lines.length) bal = opening;
    return {
      report: "supplier-statement", lang, generatedAt: riyadhNow(), params: { supplierId: id, from, to },
      supplier: { id: supplier.id, name: supplier.name, vatNumber: supplier.vatNumber },
      opening: fromHalalas(opening), totals: { debit: fromHalalas(debits), credit: fromHalalas(credits) }, closing: fromHalalas(bal), lines,
    };
  }

  // ── Bills ─────────────────────────────────────────────────────────────────

  async listBills(scope: number, q: any = {}) {
    const page = Math.max(1, Number(q?.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q?.pageSize) || 50));
    const p: unknown[] = [scope];
    const where = ["b.user_id = $1"];
    const add = (sql: string, v: unknown) => {
      p.push(v);
      where.push(sql.replace("?", `$${p.length}`));
    };
    if (q?.status) {
      if (!["draft", "approved", "void"].includes(q.status)) throw bad("BAD_INPUT", "status must be draft, approved or void");
      add("b.status = ?", q.status);
    }
    if (q?.supplierId) add("b.supplier_id = ?", optId(q.supplierId, "supplierId"));
    if (q?.ownerId) add("b.owner_id = ?", optId(q.ownerId, "ownerId"));
    if (q?.propertyId) add("b.property_id = ?", optId(q.propertyId, "propertyId"));
    if (q?.from) add("b.bill_date >= ?::date", isoDate(q.from, "from"));
    if (q?.to) add("b.bill_date <= ?::date", isoDate(q.to, "to"));
    const unpaid = q?.unpaid === "true" || q?.unpaid === true || q?.unpaid === "1";
    const sql = `select * from (${BILL_SQL} where ${where.join(" and ")}) z ${unpaid ? "where z.status = 'approved' and z.total > z.paid::numeric" : ""}`;
    const all = (await this.pool.query(`${sql} order by z.bill_date desc, z.id desc`, p)).rows;
    const rows = all.slice((page - 1) * pageSize, page * pageSize).map((r: any) => this.shapeBill(r));
    const live = all.filter((r: any) => r.status === "approved");
    return {
      rows, total: all.length, page, pageSize,
      totals: {
        total: fromHalalas(live.reduce((a: number, r: any) => a + toHalalas(r.total), 0)),
        paid: fromHalalas(live.reduce((a: number, r: any) => a + toHalalas(r.paid), 0)),
        remaining: fromHalalas(live.reduce((a: number, r: any) => a + toHalalas(r.total) - toHalalas(r.paid), 0)),
      },
    };
  }

  async getBill(scope: number, id: number, q: Q = this.pool): Promise<BillOut> {
    const r = (await q.query(`${BILL_SQL} where b.id = $1 and b.user_id = $2`, [id, scope])).rows[0];
    if (!r) throw new NotFoundException({ error: "BILL_NOT_FOUND", message: "Bill not found" });
    const lines = (await q.query(`select * from supplier_bill_lines where bill_id = $1 and user_id = $2 order by line_no`, [id, scope])).rows;
    const pays = (await q.query(
      `select p.id, p.number, to_char(p.paid_on,'YYYY-MM-DD') as paid_on, a.amount::text as amount, p.status
         from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
        where a.bill_id = $1 and a.user_id = $2 order by p.paid_on, p.id`, [id, scope])).rows;
    return {
      ...this.shapeBill(r),
      lines: lines.map((l: any) => ({
        lineNo: Number(l.line_no), description: l.description, glAccountId: l.gl_account_id ?? null, net: m(l.net_amount), vatCategory: l.vat_category,
        vatRate: String(Math.round(Number(l.vat_rate))), vat: m(l.vat_amount), gross: fromHalalas(toHalalas(String(l.net_amount)) + toHalalas(String(l.vat_amount))),
        vatRecoverable: l.vat_recoverable === true,
      })),
      payments: pays.map((x: any) => ({ paymentId: Number(x.id), number: x.number, paidOn: x.paid_on, amount: m(x.amount), status: x.status })),
    };
  }

  /**
   * {supplierId, supplierInvoiceNo?, billDate, dueDate?, ownerId?, propertyId?, chargeTo?, attachmentKey?, notes?,
   *  lines: [{description, amount, amountMode?: net|gross, glAccountId?, vatCategory?: S|Z|E|O, vatRate?, vat?, vatRecoverable?}]}
   * → a DRAFT bill (nothing posts until it is approved).
   */
  async createBill(scope: number, user: { id: number }, body: any): Promise<BillOut> {
    return withTx(this.pool, async (c) => {
      const v = await this.normaliseBill(c, scope, body);
      await this.assertNotLocked(c, scope, v.billDate, "bill");
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BILL]);
      await this.assertNoDuplicate(c, scope, v.supplierId, v.supplierInvoiceNo, null);
      const [n] = (await c.query(
        `select coalesce(max(cast(substring(number from '^BILL-([0-9]+)$') as integer)), 0) + 1 as n from supplier_bills where user_id = $1 and number ~ '^BILL-[0-9]+$'`,
        [scope])).rows;
      const number = `BILL-${String(n.n).padStart(6, "0")}`;
      let id: number;
      try {
        const r = await c.query(
          `insert into supplier_bills (user_id, number, supplier_id, supplier_invoice_no, bill_date, due_date, owner_id, property_id, charge_to,
                                       attachment_key, notes, subtotal, vat_total, total, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
          [scope, number, v.supplierId, v.supplierInvoiceNo, v.billDate, v.dueDate, v.ownerId, v.propertyId, v.chargeTo, v.attachmentKey, v.notes,
            fromHalalas(v.subtotal), fromHalalas(v.vatTotal), fromHalalas(v.subtotal + v.vatTotal), user.id]);
        id = Number(r.rows[0].id);
      } catch (err: any) {
        this.mapUnique(err);
      }
      await this.insertLines(c, scope, id!, v.lines);
      await auditRow(c, scope, user.id, "finance_v2_bill", id!, "/finance/v2/bills");
      return this.getBill(scope, id!, c);
    });
  }

  /** A draft only: any subset of the create fields (lines replace all lines). */
  async updateBill(scope: number, user: { id: number }, id: number, body: any): Promise<BillOut> {
    return withTx(this.pool, async (c) => {
      const cur = await this.lockBill(c, scope, id);
      if (cur.status !== "draft") throw new ConflictException({ error: "BILL_NOT_DRAFT", message: "Only a draft bill can be edited; void it and enter it again" });
      const curLines = (await c.query(`select * from supplier_bill_lines where bill_id = $1 and user_id = $2 order by line_no`, [id, scope])).rows;
      const merged = {
        supplierId: cur.supplier_id, supplierInvoiceNo: cur.supplier_invoice_no, billDate: cur.bill_date_s, ownerId: cur.owner_id,
        propertyId: cur.property_id, chargeTo: cur.charge_to, attachmentKey: cur.attachment_key, notes: cur.notes,
        dueDate: body?.billDate !== undefined && body?.dueDate === undefined ? undefined : cur.due_date_s,
        lines: curLines.map((l: any) => ({
          description: l.description, glAccountId: l.gl_account_id, amount: m(l.net_amount), amountMode: "net", vatCategory: l.vat_category,
          vatRate: Math.round(Number(l.vat_rate)), vat: l.vat_category === "S" ? m(l.vat_amount) : undefined, vatRecoverable: l.vat_recoverable,
        })),
        ...Object.fromEntries(Object.entries(body ?? {}).filter(([, x]) => x !== undefined)),
      };
      const v = await this.normaliseBill(c, scope, merged);
      await this.assertNotLocked(c, scope, v.billDate, "bill");
      await this.assertNoDuplicate(c, scope, v.supplierId, v.supplierInvoiceNo, id);
      try {
        await c.query(
          `update supplier_bills set supplier_id = $3, supplier_invoice_no = $4, bill_date = $5, due_date = $6, owner_id = $7, property_id = $8, charge_to = $9,
                  attachment_key = $10, notes = $11, subtotal = $12, vat_total = $13, total = $14, updated_at = now()
            where id = $1 and user_id = $2`,
          [id, scope, v.supplierId, v.supplierInvoiceNo, v.billDate, v.dueDate, v.ownerId, v.propertyId, v.chargeTo, v.attachmentKey, v.notes,
            fromHalalas(v.subtotal), fromHalalas(v.vatTotal), fromHalalas(v.subtotal + v.vatTotal)]);
      } catch (err: any) {
        this.mapUnique(err);
      }
      await c.query(`delete from supplier_bill_lines where bill_id = $1 and user_id = $2`, [id, scope]);
      await this.insertLines(c, scope, id, v.lines);
      await auditRow(c, scope, user.id, "finance_v2_bill", id, `/finance/v2/bills/${id}`, "PATCH");
      return this.getBill(scope, id, c);
    });
  }

  async deleteBill(scope: number, user: { id: number }, id: number): Promise<{ ok: true }> {
    return withTx(this.pool, async (c) => {
      const cur = await this.lockBill(c, scope, id);
      if (cur.status !== "draft") throw new ConflictException({ error: "BILL_NOT_DRAFT", message: "Only a draft bill can be deleted; void an approved one" });
      await c.query(`delete from supplier_bills where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "finance_v2_bill", id, `/finance/v2/bills/${id}`, "DELETE");
      return { ok: true as const };
    });
  }

  /** Draft → approved; enqueues E38. Re-validates the lines (accounts, VAT) at approval time. */
  async approveBill(scope: number, user: { id: number }, id: number): Promise<BillOut> {
    const out = await withTx(this.pool, async (c) => {
      const cur = await this.lockBill(c, scope, id);
      if (cur.status !== "draft") throw new ConflictException({ error: "BILL_NOT_DRAFT", message: `A ${cur.status} bill cannot be approved` });
      const lines = (await c.query(`select * from supplier_bill_lines where bill_id = $1 and user_id = $2 order by line_no`, [id, scope])).rows;
      if (!lines.length) throw bad("LINES_REQUIRED", "A bill needs at least one line");
      for (const l of lines) if (l.gl_account_id) await this.assertBillAccount(c, scope, Number(l.gl_account_id), "glAccountId");
      const sup = (await c.query(`select vat_number, is_active from suppliers where id = $1 and user_id = $2`, [cur.supplier_id, scope])).rows[0];
      if (!sup?.is_active) throw new ConflictException({ error: "SUPPLIER_INACTIVE", message: "The supplier is inactive" });
      if (lines.some((l: any) => l.vat_recoverable) && !sup.vat_number) {
        throw bad("SUPPLIER_VAT_REQUIRED", "استرداد ضريبة المدخلات يتطلب الرقم الضريبي للمورد · Recoverable input VAT needs the supplier's VAT number");
      }
      await this.assertNotLocked(c, scope, cur.bill_date_s, "bill");
      await c.query(`update supplier_bills set status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() where id = $1 and user_id = $2`,
        [id, scope, user.id]);
      await this.emitAll(c, scope, await billEvents(sqlOf(c as any), scope, (await loadSettings(sqlOf(c as any), scope))!, id));
      await auditRow(c, scope, user.id, "finance_v2_bill", id, `/finance/v2/bills/${id}/approve`);
      return this.getBill(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  /** Approved (no posted payments) or draft → void; an approved bill's entry is reversed at the void date. */
  async voidBill(scope: number, user: { id: number }, id: number, body: any): Promise<BillOut> {
    const reason = optStr(body?.reason, "reason", 500);
    if (!reason) throw bad("REASON_REQUIRED", "سبب الإلغاء مطلوب · reason is required");
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.AP]);
      const cur = await this.lockBill(c, scope, id);
      if (cur.status === "void") throw new ConflictException({ error: "BILL_ALREADY_VOID", message: "The bill is already void" });
      const paid = await c.query(
        `select 1 from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
          where a.bill_id = $1 and a.user_id = $2 and p.status = 'posted' limit 1`, [id, scope]);
      if (paid.rowCount) throw new ConflictException({ error: "BILL_HAS_PAYMENTS", message: "على الفاتورة مدفوعات؛ ألغِ سندات الصرف أولاً · The bill has payments; void them first" });
      const today = riyadhToday();
      const on = cur.bill_date_s > today ? cur.bill_date_s : today;
      if (cur.status === "approved") await this.assertNotLocked(c, scope, on, "void");
      await c.query(`update supplier_bills set status = 'void', voided_by = $3, voided_at = now(), voided_on = $4, void_reason = $5, updated_at = now()
                      where id = $1 and user_id = $2`, [id, scope, user.id, on, reason]);
      if (cur.status === "approved") await this.emitAll(c, scope, await billEvents(sqlOf(c as any), scope, (await loadSettings(sqlOf(c as any), scope))!, id), true);
      await auditRow(c, scope, user.id, "finance_v2_bill", id, `/finance/v2/bills/${id}/void`);
      return this.getBill(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  // ── Supplier payments ─────────────────────────────────────────────────────

  async listPayments(scope: number, q: any = {}) {
    const p: unknown[] = [scope];
    const where = ["p.user_id = $1"];
    if (q?.supplierId) {
      p.push(optId(q.supplierId, "supplierId"));
      where.push(`p.supplier_id = $${p.length}`);
    }
    if (q?.from) {
      p.push(isoDate(q.from, "from"));
      where.push(`p.paid_on >= $${p.length}::date`);
    }
    if (q?.to) {
      p.push(isoDate(q.to, "to"));
      where.push(`p.paid_on <= $${p.length}::date`);
    }
    const rows = (await this.pool.query(`${PAYMENT_SQL} where ${where.join(" and ")} order by p.paid_on desc, p.id desc limit 1000`, p)).rows;
    const allocs = await this.allocationsOf(this.pool, scope, rows.map((r: any) => Number(r.id)));
    return { rows: rows.map((r: any) => this.shapePayment(r, allocs.get(Number(r.id)) ?? [])) };
  }

  async getPayment(scope: number, id: number, q: Q = this.pool): Promise<SupplierPaymentOut> {
    const r = (await q.query(`${PAYMENT_SQL} where p.id = $1 and p.user_id = $2`, [id, scope])).rows[0];
    if (!r) throw new NotFoundException({ error: "SUPPLIER_PAYMENT_NOT_FOUND", message: "Supplier payment not found" });
    return this.shapePayment(r, (await this.allocationsOf(q, scope, [id])).get(id) ?? []);
  }

  /**
   * {supplierId, paidOn?, amount, bankAccountId?, method?, reference?, allocations: [{billId, amount}]}
   * The allocations must sum to the amount exactly; each bill is this
   * supplier's, approved, and open by at least its allocation.
   */
  async createPayment(scope: number, user: { id: number }, body: any): Promise<SupplierPaymentOut> {
    const supplierId = optId(body?.supplierId, "supplierId");
    if (supplierId == null) throw bad("BAD_INPUT", "supplierId is required");
    const paidOn = body?.paidOn ? isoDate(body.paidOn, "paidOn") : riyadhToday();
    const amount = amountOf(body?.amount);
    const method = optStr(body?.method, "method", 40);
    const reference = optStr(body?.reference, "reference", 200);
    const raw = body?.allocations;
    if (!Array.isArray(raw) || !raw.length || raw.length > 200) throw bad("ALLOCATIONS_REQUIRED", "allocations: 1 to 200 bills");
    const allocs = raw.map((a: any, i: number) => ({ billId: optId(a?.billId, `allocations[${i}].billId`), amount: amountOf(a?.amount, `allocations[${i}].amount`) }));
    if (allocs.some((a) => a.billId == null)) throw bad("BAD_INPUT", "every allocation needs a billId");
    if (new Set(allocs.map((a) => a.billId)).size !== allocs.length) throw bad("BAD_INPUT", "a bill appears twice in allocations");
    const sum = allocs.reduce((s, a) => s + a.amount, 0);
    if (sum !== amount) throw bad("ALLOCATION_MISMATCH", `التوزيع (${fromHalalas(sum)}) لا يساوي المبلغ (${fromHalalas(amount)}) · Allocations ${fromHalalas(sum)} must equal the amount ${fromHalalas(amount)}`);
    const out = await withTx(this.pool, async (c) => {
      const sup = (await c.query(`select id, is_active from suppliers where id = $1 and user_id = $2`, [supplierId, scope])).rows[0];
      if (!sup) throw new NotFoundException({ error: "SUPPLIER_NOT_FOUND", message: "Supplier not found" });
      const bankAccountId = await this.banks.assertUsable(c, scope, body?.bankAccountId);
      await this.assertNotLocked(c, scope, paidOn, "payment");
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.AP]);
      const bills = (await c.query(`${BILL_SQL} where b.user_id = $1 and b.id = any($2::int[])`, [scope, allocs.map((a) => a.billId)])).rows;
      const byId = new Map<number, any>(bills.map((b: any) => [Number(b.id), b]));
      for (const a of allocs) {
        const b = byId.get(a.billId!);
        if (!b) throw new NotFoundException({ error: "BILL_NOT_FOUND", message: `Bill ${a.billId} not found` });
        if (Number(b.supplier_id) !== supplierId) throw bad("BILL_OTHER_SUPPLIER", `${b.number} belongs to another supplier`);
        if (b.status !== "approved") throw new ConflictException({ error: "BILL_NOT_APPROVED", message: `${b.number} is ${b.status}` });
        const open = toHalalas(b.total) - toHalalas(b.paid);
        if (a.amount > open) {
          throw new ConflictException({ error: "FINANCE_V2_EXCEEDS_BILL", billId: a.billId, open: fromHalalas(open),
            message: `المبلغ يتجاوز المتبقي على ${b.number} (${fromHalalas(open)}) · The amount exceeds what is open on ${b.number} (${fromHalalas(open)})` });
        }
      }
      const number = await nextPvNumber(c, scope);
      const r = await c.query(
        `insert into supplier_payments (user_id, number, supplier_id, paid_on, amount, bank_account_id, method, reference, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [scope, number, supplierId, paidOn, fromHalalas(amount), bankAccountId, method, reference, user.id]);
      const id = Number(r.rows[0].id);
      for (const a of allocs) {
        await c.query(`insert into supplier_payment_allocations (payment_id, bill_id, user_id, amount) values ($1, $2, $3, $4)`, [id, a.billId, scope, fromHalalas(a.amount)]);
      }
      await this.emitAll(c, scope, await supplierPaymentEvents(sqlOf(c as any), scope, (await loadSettings(sqlOf(c as any), scope))!, id));
      await auditRow(c, scope, user.id, "finance_v2_supplier_payment", id, "/finance/v2/supplier-payments");
      return this.getPayment(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  async voidPayment(scope: number, user: { id: number }, id: number, body: any): Promise<SupplierPaymentOut> {
    const reason = optStr(body?.reason, "reason", 500);
    if (!reason) throw bad("REASON_REQUIRED", "سبب الإلغاء مطلوب · reason is required");
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.AP]);
      const cur = (await c.query(`select id, status, to_char(paid_on,'YYYY-MM-DD') as paid_on from supplier_payments where id = $1 and user_id = $2 for update`, [id, scope])).rows[0];
      if (!cur) throw new NotFoundException({ error: "SUPPLIER_PAYMENT_NOT_FOUND", message: "Supplier payment not found" });
      if (cur.status === "void") throw new ConflictException({ error: "FINANCE_V2_ALREADY_VOID", message: "The payment is already void" });
      const today = riyadhToday();
      const on = cur.paid_on > today ? cur.paid_on : today;
      await this.assertNotLocked(c, scope, on, "void");
      await c.query(`update supplier_payments set status = 'void', voided_by = $3, voided_at = now(), voided_on = $4, void_reason = $5 where id = $1 and user_id = $2`,
        [id, scope, user.id, on, reason]);
      await this.emitAll(c, scope, await supplierPaymentEvents(sqlOf(c as any), scope, (await loadSettings(sqlOf(c as any), scope))!, id), true);
      await auditRow(c, scope, user.id, "finance_v2_supplier_payment", id, `/finance/v2/supplier-payments/${id}/void`);
      return this.getPayment(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  // ── AP aging (DESIGN §8.4) ────────────────────────────────────────────────

  /**
   * ?asOf&supplierId&lang. Approved bills dated on or before asOf (a bill
   * voided after asOf still counts), less posted payments on or before asOf
   * (a payment voided after asOf still counts). Buckets by DUE date (the due
   * date is day 0; before it the bill is "not due"). The control check
   * compares the 2111 ledger balance with the sub-ledger; a difference is
   * shown, never hidden (pending postings and manual 2111 entries explain it).
   */
  async apAging(scope: number, q: any = {}) {
    const lang = langOf(q?.lang);
    const asOf = q?.asOf ? isoDate(q.asOf, "asOf") : riyadhToday();
    const supplierId = optId(q?.supplierId, "supplierId");
    if (supplierId != null) await this.getSupplier(scope, supplierId);
    const p: unknown[] = [scope, asOf];
    let sf = "";
    if (supplierId != null) {
      p.push(supplierId);
      sf = ` and b.supplier_id = $3`;
    }
    const bills = (await this.pool.query(
      `select b.id, b.number, b.supplier_id, b.supplier_invoice_no, to_char(b.bill_date,'YYYY-MM-DD') as bill_date, to_char(b.due_date,'YYYY-MM-DD') as due_date,
              b.total::text as total, s.name_ar, s.name_en,
              coalesce((select sum(a.amount) from supplier_payment_allocations a join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
                         where a.bill_id = b.id and a.user_id = b.user_id and p.paid_on <= $2::date
                           and (p.status = 'posted' or p.voided_on > $2::date)), 0)::text as paid
         from supplier_bills b join suppliers s on s.id = b.supplier_id and s.user_id = b.user_id
        where b.user_id = $1 and b.approved_at is not null and b.bill_date <= $2::date
          and (b.status = 'approved' or b.voided_on > $2::date)${sf}
        order by s.name_ar, b.due_date, b.id`, p)).rows;
    type Row = { supplierId: number; supplierName: string } & Record<Bucket | "pastDue" | "open", number> & { items: any[] };
    const rows = new Map<number, Row>();
    const zero = () => Object.fromEntries([...BUCKETS, "pastDue", "open"].map((k) => [k, 0])) as Record<Bucket | "pastDue" | "open", number>;
    const totals = zero();
    for (const b of bills) {
      const total = toHalalas(b.total);
      const paid = toHalalas(b.paid);
      const a = apAgingOf({ total, paid, dueDate: b.due_date }, asOf);
      if (a.remaining === 0) continue;
      const sid = Number(b.supplier_id);
      let r = rows.get(sid);
      if (!r) {
        r = { supplierId: sid, supplierName: lang === "en" && b.name_en ? b.name_en : b.name_ar, ...zero(), items: [] };
        rows.set(sid, r);
      }
      r[a.bucket] += a.remaining;
      r.open += a.remaining;
      totals[a.bucket] += a.remaining;
      totals.open += a.remaining;
      if (a.bucket !== "notDue") {
        r.pastDue += a.remaining;
        totals.pastDue += a.remaining;
      }
      r.items.push({
        billId: Number(b.id), number: b.number, supplierInvoiceNo: b.supplier_invoice_no ?? null, billDate: b.bill_date, dueDate: b.due_date,
        daysPastDue: a.daysPastDue, bucket: a.bucket, total: fromHalalas(total), paid: fromHalalas(paid), remaining: fromHalalas(a.remaining),
      });
    }
    const fmt = (x: Record<string, number>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fromHalalas(v)]));
    const [led] = (await this.pool.query(
      `select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key = 'accounts_payable' and l.entry_date <= $2::date`, [scope, asOf])).rows;
    const [pend] = (await this.pool.query(
      `select count(*)::int as n from ledger_outbox where user_id = $1 and source_type in ('supplier_bill','supplier_payment')
          and status in ('pending','failed') and occurred_on <= $2::date`, [scope, asOf])).rows;
    const ledgerAp = supplierId == null ? toHalalas(led.b) : null;
    return {
      report: "ap-aging", lang, mode: null, generatedAt: riyadhNow(), params: { asOf, supplierId: supplierId ?? undefined },
      rows: [...rows.values()].map(({ supplierId: sid, supplierName, items, ...amounts }) => ({ supplierId: sid, supplierName, ...fmt(amounts), items })),
      totals: fmt(totals),
      reconciliation: ledgerAp == null ? null : {
        ledgerAp: fromHalalas(ledgerAp), subLedger: fromHalalas(totals.open), difference: fromHalalas(ledgerAp - totals.open),
        balanced: ledgerAp === totals.open, pendingPostings: pend.n,
      },
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async emitAll(c: Fv2Client, scope: number, r: { events: LedgerEvent[] } | null, reversalsOnly = false): Promise<void> {
    for (const e of r?.events ?? []) {
      if (reversalsOnly && !e.event.startsWith("reversal:")) continue;
      await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
    }
  }

  private async lockBill(c: Fv2Client, scope: number, id: number) {
    const r = (await c.query(
      `select b.*, to_char(b.bill_date,'YYYY-MM-DD') as bill_date_s, to_char(b.due_date,'YYYY-MM-DD') as due_date_s
         from supplier_bills b where b.id = $1 and b.user_id = $2 for update`, [id, scope])).rows[0];
    if (!r) throw new NotFoundException({ error: "BILL_NOT_FOUND", message: "Bill not found" });
    return r;
  }

  private async allocationsOf(q: Q, scope: number, ids: number[]) {
    const out = new Map<number, Array<{ billId: number; billNumber: string; supplierInvoiceNo: string | null; amount: string }>>();
    if (!ids.length) return out;
    const r = await q.query(
      `select a.payment_id, a.bill_id, a.amount::text as amount, b.number, b.supplier_invoice_no
         from supplier_payment_allocations a join supplier_bills b on b.id = a.bill_id and b.user_id = a.user_id
        where a.user_id = $1 and a.payment_id = any($2::int[]) order by a.id`, [scope, ids]);
    for (const x of r.rows) {
      const k = Number(x.payment_id);
      out.set(k, [...(out.get(k) ?? []), { billId: Number(x.bill_id), billNumber: x.number, supplierInvoiceNo: x.supplier_invoice_no ?? null, amount: m(x.amount) }]);
    }
    return out;
  }

  private async assertNotLocked(c: Q, scope: number, date: string, what: string): Promise<void> {
    const r = await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [scope, date]);
    if (r.rows[0]?.status === "locked") {
      throw new ConflictException({ error: "PERIOD_LOCKED", message: `الفترة مقفلة نهائياً · The period of this ${what} (${date}) is locked` });
    }
  }

  private async assertNoDuplicate(c: Q, scope: number, supplierId: number, invoiceNo: string | null, exceptId: number | null) {
    if (!invoiceNo) return;
    const r = await c.query(
      `select number from supplier_bills where user_id = $1 and supplier_id = $2 and lower(supplier_invoice_no) = lower($3) and status <> 'void'
          and ($4::int is null or id <> $4::int) limit 1`, [scope, supplierId, invoiceNo, exceptId]);
    if (r.rows[0]) {
      throw new ConflictException({ error: "DUPLICATE_SUPPLIER_INVOICE", existing: r.rows[0].number,
        message: `فاتورة المورد مسجلة مسبقاً (${r.rows[0].number}) · This supplier invoice is already entered (${r.rows[0].number})` });
    }
  }

  private mapUnique(err: any): never {
    if (err?.code === "23505") {
      const k = String(err?.constraint ?? "");
      if (k.includes("suppliers_vat")) throw new ConflictException({ error: "SUPPLIER_VAT_EXISTS", message: "A supplier with this VAT number exists" });
      if (k.includes("supplier_invoice")) throw new ConflictException({ error: "DUPLICATE_SUPPLIER_INVOICE", message: "This supplier invoice is already entered" });
    }
    throw err;
  }

  /** An expense leaf, or a non-system asset leaf that is not a bank/cash account (equipment, prepayments…). */
  private async assertBillAccount(q: Q, scope: number, id: number, field: string): Promise<void> {
    const g = (await q.query(`select type, is_group, is_active, system_key, bank_account_id from accounts where id = $1 and user_id = $2`, [id, scope])).rows[0];
    if (!g) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: `${field}: account not found` });
    const assetOk = g.type === "asset" && (g.system_key == null || g.system_key === "supplier_advances") && g.bank_account_id == null;
    if (g.is_group || !g.is_active || !(g.type === "expense" || assetOk)) {
      throw bad("BAD_ACCOUNT", `${field} must be an active expense leaf, or a non-control asset leaf`);
    }
  }

  private async normaliseSupplier(c: Q, scope: number, body: any, _id: number | null) {
    const nameAr = optStr(body?.nameAr, "nameAr", 200);
    if (!nameAr) throw bad("BAD_INPUT", "اسم المورد مطلوب · nameAr is required");
    const vatNumber = optStr(body?.vatNumber == null ? null : asciiDigits(String(body.vatNumber)), "vatNumber", 15);
    if (vatNumber && !SUPPLIER_VAT_RE.test(vatNumber)) {
      throw bad("BAD_SUPPLIER_VAT", "الرقم الضريبي للمورد: 15 رقماً يبدأ وينتهي بـ 3 · The supplier VAT number is 15 digits starting and ending with 3");
    }
    const email = optStr(body?.email, "email", 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("BAD_INPUT", "email is not valid");
    const terms = body?.paymentTermsDays == null || body.paymentTermsDays === "" ? 30 : Number(body.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) throw bad("BAD_INPUT", "paymentTermsDays must be 0 to 365");
    const gl = optId(body?.defaultGlAccountId, "defaultGlAccountId");
    if (gl != null) await this.assertBillAccount(c, scope, gl, "defaultGlAccountId");
    const iban = optStr(body?.iban == null ? null : String(body.iban).replace(/\s+/g, "").toUpperCase(), "iban", 34);
    return {
      nameAr, nameEn: optStr(body?.nameEn, "nameEn", 200), vatNumber, crNumber: optStr(body?.crNumber == null ? null : asciiDigits(String(body.crNumber)), "crNumber", 20),
      iban, phone: optStr(body?.phone, "phone", 40), email, address: optStr(body?.address, "address", 500), terms, gl, notes: optStr(body?.notes, "notes", 2000),
    };
  }

  private async normaliseBill(c: Q, scope: number, body: any) {
    const supplierId = optId(body?.supplierId, "supplierId");
    if (supplierId == null) throw bad("BAD_INPUT", "supplierId is required");
    const sup = (await c.query(`select id, vat_number, payment_terms_days, is_active from suppliers where id = $1 and user_id = $2`, [supplierId, scope])).rows[0];
    if (!sup) throw new NotFoundException({ error: "SUPPLIER_NOT_FOUND", message: "Supplier not found" });
    if (!sup.is_active) throw new ConflictException({ error: "SUPPLIER_INACTIVE", message: "The supplier is inactive" });
    const billDate = isoDate(body?.billDate, "billDate");
    const dueDate = body?.dueDate ? isoDate(body.dueDate, "dueDate") : dueDateOf(billDate, Number(sup.payment_terms_days));
    if (dueDate < billDate) throw bad("BAD_DATE", "dueDate cannot be before billDate");
    const supplierInvoiceNo = optStr(body?.supplierInvoiceNo, "supplierInvoiceNo", 100);
    const notes = optStr(body?.notes, "notes", 2000);
    let attachmentKey: string | null = null;
    if (body?.attachmentKey != null && body.attachmentKey !== "") {
      if (typeof body.attachmentKey !== "string" || classifyKey(body.attachmentKey, scope).kind !== "own") {
        throw new ForbiddenException({ error: "ATTACHMENT_FORBIDDEN", message: "The attachment must be an upload of this account" });
      }
      attachmentKey = body.attachmentKey;
    }
    // Landlord / property (EX-3 style scope check) and the recoverability context.
    const ownerIn = optId(body?.ownerId, "ownerId");
    const propertyId = optId(body?.propertyId, "propertyId");
    let usage: ReturnType<typeof usageOf> = null;
    let propOwner: number | null = null;
    if (propertyId != null) {
      const pr = (await c.query(
        `select p.owner_id, (select l.key from lookups l where l.id = p.usage_lookup_id) as ukey from properties p where p.id = $1 and p.user_id = $2 and p.deleted_at is null`,
        [propertyId, scope])).rows[0];
      if (!pr) throw new NotFoundException({ error: "PROPERTY_NOT_FOUND", message: "Property not found" });
      usage = usageOf(pr.ukey);
      propOwner = pr.owner_id ?? null;
    }
    if (ownerIn != null && propOwner != null && ownerIn !== propOwner) {
      throw bad("OWNER_PROPERTY_MISMATCH", "العقار لا يتبع هذا المؤجر · The property does not belong to this landlord");
    }
    const ownerId = ownerIn ?? propOwner;
    let agent = false;
    if (ownerId != null) {
      const o = (await c.query(`select is_account_holder from owners where id = $1 and user_id = $2 and deleted_at is null`, [ownerId, scope])).rows[0];
      if (!o) throw new NotFoundException({ error: "OWNER_NOT_FOUND", message: "Landlord not found" });
      const s = await loadSettings(sqlOf(c as any), scope);
      agent = (s?.mode ?? "manager") === "manager" && o.is_account_holder !== true;
    }
    if (body?.chargeTo != null && body.chargeTo !== "company" && body.chargeTo !== "landlord") throw bad("BAD_INPUT", "chargeTo must be company or landlord");
    const chargeTo: "company" | "landlord" = body?.chargeTo === "landlord" ? "landlord" : "company";
    if (chargeTo === "landlord" && !agent) {
      throw bad("CHARGE_TO_NOT_ALLOWED", "التحميل على المؤجر متاح لمؤجري الوكالة في وضع المدير فقط · Charge to landlord applies only to agent landlords in Manager mode");
    }
    const accountRegistered = await accountVatRegistered(sqlOf(c as any), scope);
    const raw = body?.lines;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) throw bad("LINES_REQUIRED", "1 to 200 lines are required");
    const lines: NormalLine[] = [];
    for (const [i, l] of raw.entries()) {
      const n = i + 1;
      const description = optStr(l?.description, `lines[${n}].description`, 500);
      if (!description) throw bad("BAD_LINE", `line ${n}: description is required`);
      const category: VatCategory = l?.vatCategory == null || l.vatCategory === "" ? "S" : l.vatCategory;
      if (!CATS.includes(category)) throw bad("BAD_LINE", `line ${n}: vatCategory must be S, Z, E or O`);
      const rate = category === "S" ? (l?.vatRate == null || l.vatRate === "" ? 15 : Number(l.vatRate)) : 0;
      if (category === "S" && (!Number.isInteger(rate) || rate <= 0 || rate > 100)) throw bad("BAD_LINE", `line ${n}: vatRate must be a whole percent`);
      const mode = l?.amountMode === "gross" ? "gross" : "net";
      const amount = amountOf(l?.amount, `line ${n} amount`);
      let vatOverride: number | null = null;
      if (l?.vat != null && l.vat !== "") {
        try {
          vatOverride = toHalalas(asciiDigits(String(l.vat)).trim());
        } catch {
          throw bad("BAD_AMOUNT", `line ${n}: vat must be a decimal with at most 2 places`);
        }
      }
      let a: { net: number; vat: number; rate: number };
      try {
        a = billLineAmounts(mode, amount, category, rate, vatOverride);
      } catch (e: any) {
        const [code, ...msg] = String(e?.message ?? "BAD_LINE").split(": ");
        throw bad(/^[A-Z_]+$/.test(code) ? code : "BAD_LINE", `line ${n}: ${msg.join(": ") || code}`);
      }
      const glAccountId = optId(l?.glAccountId, `lines[${n}].glAccountId`);
      if (glAccountId != null) await this.assertBillAccount(c, scope, glAccountId, `line ${n} glAccountId`);
      const def = recoverDefault({ category, chargeTo, accountRegistered, hasProperty: propertyId != null, usage });
      let recoverable = def.recoverable && !!sup.vat_number;
      let recoverReason: NormalLine["recoverReason"] = def.recoverable && !sup.vat_number ? "no_supplier_vat" : def.reason;
      if (l?.vatRecoverable !== undefined && l.vatRecoverable !== null) {
        if (typeof l.vatRecoverable !== "boolean") throw bad("BAD_LINE", `line ${n}: vatRecoverable must be a boolean`);
        if (l.vatRecoverable && category !== "S") throw bad("BAD_LINE", `line ${n}: only standard-rated (S) VAT can be recoverable`);
        if (l.vatRecoverable && !sup.vat_number) {
          throw bad("SUPPLIER_VAT_REQUIRED", "استرداد ضريبة المدخلات يتطلب الرقم الضريبي للمورد · Recoverable input VAT needs the supplier's VAT number");
        }
        recoverable = l.vatRecoverable;
        recoverReason = l.vatRecoverable === def.recoverable ? def.reason : recoverReason;
      }
      lines.push({ description, glAccountId, net: a.net, vat: a.vat, category, rate: a.rate, recoverable, recoverReason });
    }
    const subtotal = lines.reduce((s, l) => s + l.net, 0);
    const vatTotal = lines.reduce((s, l) => s + l.vat, 0);
    return { supplierId, billDate, dueDate, supplierInvoiceNo, notes, attachmentKey, ownerId, propertyId, chargeTo, lines, subtotal, vatTotal };
  }

  private async insertLines(c: Fv2Client, scope: number, billId: number, lines: NormalLine[]): Promise<void> {
    for (const [i, l] of lines.entries()) {
      await c.query(
        `insert into supplier_bill_lines (bill_id, user_id, line_no, description, gl_account_id, net_amount, vat_category, vat_rate, vat_amount, vat_recoverable)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [billId, scope, i + 1, l.description, l.glAccountId, fromHalalas(l.net), l.category, l.rate, fromHalalas(l.vat), l.recoverable]);
    }
  }

  private shapeSupplier(r: any, lang: "ar" | "en" = "ar"): SupplierOut {
    return {
      id: Number(r.id), nameAr: r.name_ar, nameEn: r.name_en ?? null, name: lang === "en" && r.name_en ? r.name_en : r.name_ar,
      vatNumber: r.vat_number ?? null, crNumber: r.cr_number ?? null, iban: r.iban ?? null, phone: r.phone ?? null, email: r.email ?? null,
      address: r.address ?? null, paymentTermsDays: Number(r.payment_terms_days), defaultGlAccountId: r.default_gl_account_id ?? null,
      isActive: r.is_active === true, notes: r.notes ?? null, balance: m(r.balance), createdAt: iso(r.created_at)!,
    };
  }

  private shapeBill(r: any): BillOut {
    const total = toHalalas(String(r.total));
    const paid = toHalalas(String(r.paid ?? "0"));
    const approved = r.status === "approved";
    const remaining = approved ? total - paid : 0;
    return {
      id: Number(r.id), number: r.number, supplierId: Number(r.supplier_id), supplierName: r.supplier_name, supplierVatNumber: r.supplier_vat ?? null,
      supplierInvoiceNo: r.supplier_invoice_no ?? null, billDate: r.bill_date_s, dueDate: r.due_date_s, status: r.status,
      ownerId: r.owner_id ?? null, propertyId: r.property_id ?? null, chargeTo: r.charge_to, attachmentKey: r.attachment_key ?? null, notes: r.notes ?? null,
      subtotal: m(r.subtotal), vatTotal: m(r.vat_total), total: fromHalalas(total), paid: fromHalalas(paid), remaining: fromHalalas(remaining),
      paymentStatus: approved ? paymentStatusOf(total, paid) : null, overdue: approved && remaining > 0 && r.due_date_s < riyadhToday(),
      approvedAt: iso(r.approved_at), approvedBy: r.approved_by ?? null, voidedOn: r.voided_on_s ?? null, voidReason: r.void_reason ?? null,
      createdAt: iso(r.created_at)!,
      posting: r.o_status ? { status: r.o_status, entryId: r.o_entry == null ? null : Number(r.o_entry), entryNo: r.o_entry_no ?? null } : null,
    };
  }

  private shapePayment(r: any, allocations: SupplierPaymentOut["allocations"]): SupplierPaymentOut {
    return {
      id: Number(r.id), number: r.number, supplierId: Number(r.supplier_id), supplierName: r.supplier_name, paidOn: r.paid_on_s, amount: m(r.amount),
      bankAccountId: r.bank_account_id ?? null, method: r.method ?? null, reference: r.reference ?? null, status: r.status,
      voidedOn: r.voided_on_s ?? null, voidReason: r.void_reason ?? null, allocations,
      posting: r.o_status ? { status: r.o_status, entryId: r.o_entry == null ? null : Number(r.o_entry), entryNo: r.o_entry_no ?? null } : null,
      createdAt: iso(r.created_at)!,
    };
  }
}
