import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { LedgerEmitter } from "../ledger-emitter.service";
import { auditRow, isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { sqlOf } from "../hooks/sql";
import { expenseEvent, loadSettings, reversalEvent, today } from "../hooks/facts-loader";
import { usageOf } from "../hooks/classify";
import { accountVatRegistered } from "../commission";
import { classifyKey } from "../../uploads/key-scope";
import { asciiDigits } from "./iban";
import { BankAccountsService } from "./bank-accounts.service";
import { expenseAmounts, recoverDefault, SUPPLIER_VAT_RE, type RecoverReason } from "./expense-math";
import type { VatCategory } from "../rules";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

const CATS: readonly VatCategory[] = ["S", "Z", "E", "O"];

export interface ExpenseV2Out {
  id: number;
  expenseDate: string | null;
  ownerId: number | null;
  ownerName: string | null;
  propertyId: number | null;
  propertyName: string | null;
  category: string | null;
  amount: string;
  notes: string | null;
  createdAt: string;
  details: {
    revision: number;
    gross: string;
    net: string;
    vat: string;
    vatRate: string;
    vatCategory: VatCategory;
    vatRecoverable: boolean;
    supplierName: string | null;
    supplierVatNumber: string | null;
    supplierInvoiceNo: string | null;
    supplierInvoiceDate: string | null;
    attachmentKey: string | null;
    bankAccountId: number | null;
    chargeTo: "company" | "landlord";
    glAccountId: number | null;
  } | null;
  posting: { event: string; status: string; entryId: number | null; entryNo: string | null } | null;
}

interface Normalised {
  expenseOn: string;
  ownerId: number | null;
  propertyId: number | null;
  category: string;
  notes: string | null;
  gross: number;
  net: number;
  vat: number;
  rate: number;
  vatCategory: VatCategory;
  vatRecoverable: boolean;
  recoverReason: RecoverReason;
  recoverOverridden: boolean;
  supplierName: string | null;
  supplierVatNumber: string | null;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  attachmentKey: string | null;
  bankAccountId: number | null;
  chargeTo: "company" | "landlord";
  glAccountId: number | null;
}

const optStr = (v: unknown, field: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be a string` });
  const s = v.trim();
  if (s.length > max) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} is too long (max ${max})` });
  return s || null;
};
const optId = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be an id` });
  return n;
};

/**
 * Expenses with input VAT, supplier, attachment and edit (DESIGN §8.2 b),
 * flag-gated (every route is under /finance/v2). The legacy `expenses` row is
 * still written (amount = gross, expense_date = 'YYYY-MM-DD') so every legacy
 * report sees it; the v2 attributes live in `finance_expense_details`. Create
 * enqueues E18 `rev:1`; an edit bumps the revision and enqueues
 * `reversal:rev:<n>` then `rev:<n+1>`.
 */
@Injectable()
export class ExpensesV2Service {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly emitter: LedgerEmitter,
    private readonly banks: BankAccountsService,
  ) {}

  async list(scope: number, q: any): Promise<{ rows: ExpenseV2Out[]; total: number; page: number; pageSize: number; totals: { gross: string; net: string; vat: string } }> {
    const page = Math.max(1, Number(q?.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q?.pageSize) || 50));
    const conds = ["e.user_id = $1", "e.deleted_at is null"];
    const params: unknown[] = [scope];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      conds.push(sql.replace("?", `$${params.length}`));
    };
    if (q?.from) add(`coalesce(d.expense_on::text, e.expense_date) >= ?`, isoDate(q.from, "from"));
    if (q?.to) add(`coalesce(d.expense_on::text, e.expense_date) <= ?`, isoDate(q.to, "to"));
    if (q?.ownerId) add(`e.owner_id = ?`, optId(q.ownerId, "ownerId"));
    if (q?.propertyId) add(`e.property_id = ?`, optId(q.propertyId, "propertyId"));
    if (q?.vatCategory && CATS.includes(q.vatCategory)) add(`coalesce(d.vat_category, 'O') = ?`, q.vatCategory);
    const where = conds.join(" and ");
    const [cnt] = (await this.pool.query(
      `select count(*)::int as n, coalesce(sum(coalesce(d.gross_amount, e.amount)), 0)::text as g, coalesce(sum(coalesce(d.net_amount, e.amount)), 0)::text as n2,
              coalesce(sum(coalesce(d.vat_amount, 0)), 0)::text as v
         from expenses e left join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id where ${where}`, params)).rows;
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await this.pool.query(`${this.selectSql(where)} order by coalesce(d.expense_on::text, e.expense_date) desc nulls last, e.id desc
      limit $${params.length - 1} offset $${params.length}`, params);
    return {
      rows: rows.rows.map((r: any) => this.shape(r)), total: cnt.n, page, pageSize,
      totals: { gross: fromHalalas(toHalalas(cnt.g)), net: fromHalalas(toHalalas(cnt.n2)), vat: fromHalalas(toHalalas(cnt.v)) },
    };
  }

  async get(scope: number, id: number, q: Q = this.pool): Promise<ExpenseV2Out> {
    const r = await q.query(`${this.selectSql("e.user_id = $1 and e.id = $2 and e.deleted_at is null")}`, [scope, id]);
    if (!r.rows[0]) throw new NotFoundException({ error: "EXPENSE_NOT_FOUND", message: "Expense not found" });
    return this.shape(r.rows[0]);
  }

  /** The recoverability default the dialog shows before saving (?ownerId&propertyId&vatCategory&chargeTo). */
  async recoverability(scope: number, q: any) {
    const category: VatCategory = CATS.includes(q?.vatCategory) ? q.vatCategory : "S";
    const chargeTo = q?.chargeTo === "landlord" ? "landlord" : "company";
    const propertyId = optId(q?.propertyId, "propertyId");
    const ownerId = optId(q?.ownerId, "ownerId");
    const ctx = await this.context(this.pool, scope, ownerId, propertyId);
    const d = recoverDefault({ category, chargeTo, accountRegistered: ctx.accountRegistered, hasProperty: propertyId != null, usage: ctx.usage });
    return { vatRecoverable: d.recoverable, reason: d.reason, chargeToLandlordAllowed: ctx.agent, usage: ctx.usage, accountVatRegistered: ctx.accountRegistered };
  }

  async create(scope: number, user: { id: number }, body: any): Promise<ExpenseV2Out> {
    const out = await withTx(this.pool, async (c) => {
      const n = await this.normalise(c, scope, body, null);
      await this.assertPeriodNotLocked(c, scope, n.expenseOn);
      const ins = await c.query(
        `insert into expenses (user_id, property_id, owner_id, category, amount, expense_date, notes) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [scope, n.propertyId, n.ownerId, n.category, fromHalalas(n.gross), n.expenseOn, n.notes],
      );
      const id = Number(ins.rows[0].id);
      await c.query(
        `insert into finance_expense_details (expense_id, user_id, revision, expense_on, gross_amount, net_amount, vat_rate, vat_amount, vat_category,
            vat_recoverable, supplier_name, supplier_vat_number, supplier_invoice_no, supplier_invoice_date, attachment_key, bank_account_id, charge_to,
            gl_account_id, updated_by)
         values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [id, scope, n.expenseOn, fromHalalas(n.gross), fromHalalas(n.net), n.rate, fromHalalas(n.vat), n.vatCategory, n.vatRecoverable,
          n.supplierName, n.supplierVatNumber, n.supplierInvoiceNo, n.supplierInvoiceDate, n.attachmentKey, n.bankAccountId, n.chargeTo, n.glAccountId, user.id],
      );
      await this.enqueue(c, scope, id, null);
      await auditRow(c, scope, user.id, "expense", id, "/finance/v2/expenses");
      return this.get(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  async update(scope: number, user: { id: number }, id: number, body: any): Promise<ExpenseV2Out> {
    const out = await withTx(this.pool, async (c) => {
      const r = await c.query(
        `select e.id, e.amount::text as amount, e.expense_date, e.category, e.notes, e.owner_id, e.property_id,
                to_char((e.created_at at time zone 'Asia/Riyadh')::date,'YYYY-MM-DD') as created
           from expenses e where e.id = $1 and e.user_id = $2 and e.deleted_at is null for update`,
        [id, scope],
      );
      const cur = r.rows[0];
      if (!cur) throw new NotFoundException({ error: "EXPENSE_NOT_FOUND", message: "Expense not found" });
      const DET = `select *, to_char(expense_on,'YYYY-MM-DD') as expense_on_s, to_char(supplier_invoice_date,'YYYY-MM-DD') as sid_s from finance_expense_details where expense_id = $1 and user_id = $2`;
      let [det] = (await c.query(`${DET} for update`, [id, scope])).rows;
      if (!det) {
        // A legacy expense (created with the flag off): its details row is created lazily, revision 1 = the legacy row as it was (O, gross, no VAT).
        const legacyDate = /^\d{4}-\d{2}-\d{2}/.test(String(cur.expense_date ?? "")) ? String(cur.expense_date).slice(0, 10) : cur.created;
        await c.query(
          `insert into finance_expense_details (expense_id, user_id, revision, expense_on, gross_amount, net_amount, vat_rate, vat_amount, vat_category,
              vat_recoverable, charge_to, updated_by)
           values ($1, $2, 1, $3, $4, $4, 0, 0, 'O', false, 'company', $5)`,
          [id, scope, legacyDate, cur.amount, user.id],
        );
        [det] = (await c.query(DET, [id, scope])).rows;
      }
      const prevDate: string | null = det.expense_on_s ?? null;
      if (prevDate) await this.assertPeriodNotLocked(c, scope, prevDate);
      const merged = {
        expenseDate: prevDate, ownerId: cur.owner_id, propertyId: cur.property_id, category: cur.category, notes: cur.notes,
        amountMode: "gross", amount: String(det.gross_amount), vatCategory: det.vat_category, vatRate: Number(det.vat_rate),
        supplierName: det.supplier_name, supplierVatNumber: det.supplier_vat_number, supplierInvoiceNo: det.supplier_invoice_no,
        supplierInvoiceDate: det.sid_s ?? null, attachmentKey: det.attachment_key,
        bankAccountId: det.bank_account_id, chargeTo: det.charge_to, glAccountId: det.gl_account_id,
        ...(det.vat_recoverable != null && body?.vatRecoverable === undefined && !["vatCategory", "chargeTo", "propertyId", "ownerId"].some((k) => body?.[k] !== undefined)
          ? { vatRecoverable: det.vat_recoverable } : {}),
        ...stripUndefined(body ?? {}),
      };
      const n = await this.normalise(c, scope, merged, det.bank_account_id ?? null);
      await this.assertPeriodNotLocked(c, scope, n.expenseOn);
      const rev = Number(det.revision);
      await c.query(
        `update expenses set property_id = $3, owner_id = $4, category = $5, amount = $6, expense_date = $7, notes = $8, updated_at = now()
          where id = $1 and user_id = $2`,
        [id, scope, n.propertyId, n.ownerId, n.category, fromHalalas(n.gross), n.expenseOn, n.notes],
      );
      await c.query(
        `update finance_expense_details set revision = $3, expense_on = $4, gross_amount = $5, net_amount = $6, vat_rate = $7, vat_amount = $8,
                vat_category = $9, vat_recoverable = $10, supplier_name = $11, supplier_vat_number = $12, supplier_invoice_no = $13,
                supplier_invoice_date = $14, attachment_key = $15, bank_account_id = $16, charge_to = $17, gl_account_id = $18, updated_by = $19, updated_at = now()
          where expense_id = $1 and user_id = $2`,
        [id, scope, rev + 1, n.expenseOn, fromHalalas(n.gross), fromHalalas(n.net), n.rate, fromHalalas(n.vat), n.vatCategory, n.vatRecoverable,
          n.supplierName, n.supplierVatNumber, n.supplierInvoiceNo, n.supplierInvoiceDate, n.attachmentKey, n.bankAccountId, n.chargeTo, n.glAccountId, user.id],
      );
      await this.enqueue(c, scope, id, rev);
      await auditRow(c, scope, user.id, "expense", id, `/finance/v2/expenses/${id}`, "PATCH");
      return this.get(scope, id, c);
    });
    this.emitter.kick(scope);
    return out;
  }

  /** reversal:rev:<prev> (only when that key was ever queued) then rev:<current>. */
  private async enqueue(c: Fv2Client, scope: number, id: number, prevRevision: number | null): Promise<void> {
    const q = sqlOf(c as any);
    const s = await loadSettings(q, scope);
    if (!s) return;
    if (prevRevision != null) {
      const [o] = await q.rows(`select 1 from ledger_outbox where user_id = $1 and source_type = 'expense' and source_id = $2 and event = $3`, [scope, id, `rev:${prevRevision}`]);
      if (o) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, reversalEvent("expense", id, `rev:${prevRevision}`, today(), { reason: "edited" }));
    }
    const e = await expenseEvent(q, scope, s, id);
    if (e) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
  }

  private async assertPeriodNotLocked(c: Q, scope: number, date: string): Promise<void> {
    const r = await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [scope, date]);
    if (r.rows[0]?.status === "locked") {
      throw new ConflictException({ error: "PERIOD_LOCKED", message: "الفترة مقفلة نهائياً؛ لا يمكن تسجيل أو تعديل مصروف بتاريخها · The period is locked; an expense dated in it cannot be recorded or edited" });
    }
  }

  private async context(q: Q, scope: number, ownerId: number | null, propertyId: number | null) {
    let usage: ReturnType<typeof usageOf> = null;
    let propOwner: number | null = null;
    if (propertyId != null) {
      const p = (await q.query(
        `select p.owner_id, (select l.key from lookups l where l.id = p.usage_lookup_id) as ukey from properties p where p.id = $1 and p.user_id = $2 and p.deleted_at is null`,
        [propertyId, scope])).rows[0];
      if (!p) throw new NotFoundException({ error: "PROPERTY_NOT_FOUND", message: "Property not found" });
      usage = usageOf(p.ukey);
      propOwner = p.owner_id ?? null;
    }
    const oid = ownerId ?? propOwner;
    let agent = false;
    if (oid != null) {
      const o = (await q.query(`select is_account_holder from owners where id = $1 and user_id = $2 and deleted_at is null`, [oid, scope])).rows[0];
      if (!o) throw new NotFoundException({ error: "OWNER_NOT_FOUND", message: "Landlord not found" });
      const s = await loadSettings(sqlOf(q as any), scope);
      agent = (s?.mode ?? "manager") === "manager" && o.is_account_holder !== true;
    }
    return { usage, propOwner, ownerId: oid, agent, accountRegistered: await accountVatRegistered(sqlOf(q as any), scope) };
  }

  private async normalise(c: Q, scope: number, body: any, currentBank: number | null): Promise<Normalised> {
    const expenseOn = isoDate(body?.expenseDate, "expenseDate");
    const category = optStr(body?.category, "category", 200);
    if (!category) throw new BadRequestException({ error: "BAD_INPUT", message: "البند مطلوب · category is required" });
    const notes = optStr(body?.notes, "notes", 2000);
    const ownerIn = optId(body?.ownerId, "ownerId");
    const propertyId = optId(body?.propertyId, "propertyId");
    const ctx = await this.context(c, scope, ownerIn, propertyId);
    if (ownerIn != null && ctx.propOwner != null && ctx.propOwner !== ownerIn) {
      throw new BadRequestException({ error: "OWNER_PROPERTY_MISMATCH", message: "العقار لا يتبع هذا المؤجر · The property does not belong to this landlord" });
    }
    const vatCategory: VatCategory = body?.vatCategory == null ? "O" : body.vatCategory;
    if (!CATS.includes(vatCategory)) throw new BadRequestException({ error: "BAD_INPUT", message: "vatCategory must be S, Z, E or O" });
    const rate = vatCategory === "S" ? (body?.vatRate == null || body.vatRate === "" ? 15 : Number(body.vatRate)) : 0;
    if (vatCategory === "S" && (!Number.isInteger(rate) || rate <= 0 || rate > 100)) throw new BadRequestException({ error: "BAD_INPUT", message: "vatRate must be a whole percent" });
    const mode = body?.amountMode === "net" ? "net" : "gross";
    let amount: number;
    try {
      amount = toHalalas(asciiDigits(String(body?.amount ?? "")).trim());
    } catch {
      throw new BadRequestException({ error: "BAD_AMOUNT", message: "المبلغ غير صالح · amount must be a decimal with at most 2 places" });
    }
    if (amount <= 0) throw new BadRequestException({ error: "BAD_AMOUNT", message: "المبلغ غير صالح · amount must be positive" });
    const a = expenseAmounts(mode, amount, vatCategory, rate);
    const chargeTo: "company" | "landlord" = body?.chargeTo === "landlord" ? "landlord" : "company";
    if (body?.chargeTo != null && body.chargeTo !== "landlord" && body.chargeTo !== "company") {
      throw new BadRequestException({ error: "BAD_INPUT", message: "chargeTo must be company or landlord" });
    }
    if (chargeTo === "landlord" && !ctx.agent) {
      throw new BadRequestException({ error: "CHARGE_TO_NOT_ALLOWED", message: "التحميل على المؤجر متاح لمؤجري الوكالة في وضع المدير فقط · Charge to landlord applies only to agent landlords in Manager mode" });
    }
    const def = recoverDefault({ category: vatCategory, chargeTo, accountRegistered: ctx.accountRegistered, hasProperty: propertyId != null, usage: ctx.usage });
    let vatRecoverable = def.recoverable;
    let recoverOverridden = false;
    if (body?.vatRecoverable !== undefined && body.vatRecoverable !== null) {
      if (typeof body.vatRecoverable !== "boolean") throw new BadRequestException({ error: "BAD_INPUT", message: "vatRecoverable must be a boolean" });
      if (vatCategory !== "S" && body.vatRecoverable) throw new BadRequestException({ error: "BAD_INPUT", message: "Only standard-rated (S) VAT can be recoverable" });
      recoverOverridden = body.vatRecoverable !== def.recoverable;
      vatRecoverable = body.vatRecoverable;
    }
    const supplierVatNumber = optStr(body?.supplierVatNumber == null ? null : asciiDigits(String(body.supplierVatNumber)), "supplierVatNumber", 15);
    if (supplierVatNumber && !SUPPLIER_VAT_RE.test(supplierVatNumber)) {
      throw new BadRequestException({ error: "BAD_SUPPLIER_VAT", message: "الرقم الضريبي للمورد: 15 رقماً يبدأ وينتهي بـ 3 · The supplier VAT number is 15 digits starting and ending with 3" });
    }
    // Input VAT is recoverable only against a tax invoice (VAT IR Art. 49), as supplier bills already require (ap.service).
    let recoverReason: RecoverReason = def.reason;
    if (vatRecoverable && !supplierVatNumber) {
      if (body?.vatRecoverable === true) {
        throw new BadRequestException({ error: "SUPPLIER_VAT_REQUIRED", message: "استرداد ضريبة المدخلات يتطلب الرقم الضريبي للمورد · Recoverable input VAT needs the supplier's VAT number" });
      }
      vatRecoverable = false;
      recoverReason = "no_supplier_vat";
    }
    const supplierInvoiceDate = body?.supplierInvoiceDate ? isoDate(body.supplierInvoiceDate, "supplierInvoiceDate") : null;
    let attachmentKey: string | null = null;
    if (body?.attachmentKey != null && body.attachmentKey !== "") {
      if (typeof body.attachmentKey !== "string" || classifyKey(body.attachmentKey, scope).kind !== "own") {
        throw new ForbiddenException({ error: "ATTACHMENT_FORBIDDEN", message: "The attachment must be an upload of this account" });
      }
      attachmentKey = body.attachmentKey;
    }
    const bankIn = body?.bankAccountId;
    const bankAccountId = bankIn === currentBank && currentBank != null ? currentBank : await this.banks.assertUsable(c, scope, bankIn);
    const glAccountId = optId(body?.glAccountId, "glAccountId");
    if (glAccountId != null) {
      const g = (await c.query(`select type, is_group, is_active from accounts where id = $1 and user_id = $2`, [glAccountId, scope])).rows[0];
      if (!g) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: "Account not found" });
      if (g.type !== "expense" || g.is_group || !g.is_active) throw new BadRequestException({ error: "BAD_ACCOUNT", message: "glAccountId must be an active expense leaf account" });
    }
    return {
      expenseOn, ownerId: ctx.ownerId, propertyId, category, notes, gross: a.gross, net: a.net, vat: a.vat, rate: a.rate, vatCategory,
      vatRecoverable, recoverReason, recoverOverridden,
      supplierName: optStr(body?.supplierName, "supplierName", 200), supplierVatNumber,
      supplierInvoiceNo: optStr(body?.supplierInvoiceNo, "supplierInvoiceNo", 100), supplierInvoiceDate, attachmentKey, bankAccountId, chargeTo, glAccountId,
    };
  }

  private selectSql(where: string): string {
    return `select e.id, e.expense_date, e.owner_id, e.property_id, e.category, e.amount::text as amount, e.notes, e.created_at,
                   (select o.name from owners o where o.id = e.owner_id and o.user_id = e.user_id) as owner_name,
                   (select p.name from properties p where p.id = e.property_id and p.user_id = e.user_id) as property_name,
                   d.revision, d.gross_amount::text as gross, d.net_amount::text as net, d.vat_amount::text as vat, d.vat_rate::text as vat_rate,
                   d.vat_category, d.vat_recoverable, d.supplier_name, d.supplier_vat_number, d.supplier_invoice_no,
                   to_char(d.supplier_invoice_date,'YYYY-MM-DD') as supplier_invoice_date, d.attachment_key, d.bank_account_id, d.charge_to, d.gl_account_id,
                   to_char(d.expense_on,'YYYY-MM-DD') as expense_on,
                   o.event as o_event, o.status as o_status, o.entry_id as o_entry, je.entry_no as o_entry_no
              from expenses e
              left join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id
              left join lateral (select event, status, entry_id from ledger_outbox x where x.user_id = e.user_id and x.source_type = 'expense'
                                    and x.source_id = e.id and x.event not like 'reversal:%' order by x.id desc limit 1) o on true
              left join journal_entries je on je.id = o.entry_id and je.user_id = e.user_id
             where ${where}`;
  }

  private shape(r: any): ExpenseV2Out {
    const m = (v: any) => fromHalalas(toHalalas(v));
    return {
      id: Number(r.id), expenseDate: r.expense_on ?? r.expense_date ?? null, ownerId: r.owner_id ?? null, ownerName: r.owner_name ?? null,
      propertyId: r.property_id ?? null, propertyName: r.property_name ?? null, category: r.category ?? null, amount: m(r.amount), notes: r.notes ?? null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      details: r.revision == null ? null : {
        revision: Number(r.revision), gross: m(r.gross), net: m(r.net), vat: m(r.vat), vatRate: String(Math.round(Number(r.vat_rate))),
        vatCategory: r.vat_category, vatRecoverable: r.vat_recoverable === true, supplierName: r.supplier_name ?? null,
        supplierVatNumber: r.supplier_vat_number ?? null, supplierInvoiceNo: r.supplier_invoice_no ?? null, supplierInvoiceDate: r.supplier_invoice_date ?? null,
        attachmentKey: r.attachment_key ?? null, bankAccountId: r.bank_account_id ?? null, chargeTo: r.charge_to === "landlord" ? "landlord" : "company",
        glAccountId: r.gl_account_id ?? null,
      },
      posting: r.o_event ? { event: r.o_event, status: r.o_status, entryId: r.o_entry == null ? null : Number(r.o_entry), entryNo: r.o_entry_no ?? null } : null,
    };
  }
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
