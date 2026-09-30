import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, withTx, type Fv2Pool } from "./db";
import { PostingEngine } from "./posting.engine";
import { riyadhToday } from "./dates";
import { auditRow, isoDate, mapLedgerError } from "./audit";

const ENTRY_COLS = `e.id::int as id, e.entry_no as "entryNo", to_char(e.entry_date,'YYYY-MM-DD') as "entryDate",
  to_char(e.original_date,'YYYY-MM-DD') as "originalDate", e.is_late as "isLate", e.origin, e.source_type as "sourceType",
  e.source_id::int as "sourceId", e.event, e.memo, e.status, e.reversal_of::int as "reversalOf", e.reversed_by::int as "reversedBy",
  e.reversed_at as "reversedAt", e.total::text as total, e.warnings, e.created_by as "createdBy", e.posted_at as "postedAt",
  p.fiscal_year as "fiscalYear", p.period_no as "periodNo"`;

const DIM_FILTERS: Array<[string, string]> = [
  ["accountId", "account_id"], ["ownerId", "owner_id"], ["propertyId", "property_id"], ["unitId", "unit_id"],
  ["tenantId", "tenant_id"], ["contractId", "contract_id"], ["paymentId", "payment_id"],
];

/**
 * The journal (DESIGN §10.2): entries with filters, one entry with its lines
 * and a link to its source, and the manual reversal (§5.4) of a manual or
 * opening entry. Every query is scoped to the account; an id outside it is a 404.
 */
@Injectable()
export class JournalQueryService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, private readonly engine: PostingEngine) {}

  async list(scope: number, q: Record<string, any> = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const p: unknown[] = [scope];
    const where = ["e.user_id = $1"];
    const add = (sqlFrag: (n: string) => string, v: unknown) => { p.push(v); where.push(sqlFrag(`$${p.length}`)); };
    if (q.from) add((n) => `e.entry_date >= ${n}`, isoDate(q.from, "from"));
    if (q.to) add((n) => `e.entry_date <= ${n}`, isoDate(q.to, "to"));
    if (q.sourceType) add((n) => `e.source_type = ${n}`, String(q.sourceType));
    if (q.sourceId) add((n) => `e.source_id = ${n}`, intOf(q.sourceId, "sourceId"));
    if (q.origin) add((n) => `e.origin = ${n}`, String(q.origin));
    if (q.status) add((n) => `e.status = ${n}`, String(q.status));
    if (q.late === "true" || q.late === true) where.push("e.is_late");
    const lineConds: string[] = [];
    for (const [k, col] of DIM_FILTERS) {
      if (q[k] == null || q[k] === "") continue;
      p.push(intOf(q[k], k));
      lineConds.push(`l.${col} = $${p.length}`);
    }
    if (lineConds.length) where.push(`exists (select 1 from journal_lines l where l.entry_id = e.id and l.user_id = e.user_id and ${lineConds.join(" and ")})`);
    const w = where.join(" and ");
    const rows = await this.pool.query(
      `select ${ENTRY_COLS} from journal_entries e join fiscal_periods p on p.id = e.period_id and p.user_id = e.user_id
        where ${w} order by e.entry_date desc, e.id desc limit ${limit} offset ${offset}`, p);
    const n = await this.pool.query(`select count(*)::int as n from journal_entries e where ${w}`, p);
    return { total: n.rows[0].n, items: rows.rows };
  }

  async get(scope: number, id: number) {
    const r = await this.pool.query(
      `select ${ENTRY_COLS}, e.payload from journal_entries e join fiscal_periods p on p.id = e.period_id and p.user_id = e.user_id
        where e.id = $1 and e.user_id = $2`, [id, scope]);
    const e = r.rows[0];
    if (!e) throw new NotFoundException("Entry not found");
    const lines = await this.pool.query(
      `select l.line_no as "lineNo", l.account_id as "accountId", a.code, a.name_ar as "nameAr", a.name_en as "nameEn",
              l.debit::text as debit, l.credit::text as credit, l.memo, l.owner_id as "ownerId", l.property_id as "propertyId",
              l.unit_id as "unitId", l.tenant_id as "tenantId", l.contract_id as "contractId", l.payment_id as "paymentId",
              l.document_id as "documentId", l.bank_account_id as "bankAccountId", l.vat_category as "vatCategory",
              l.vat_rate::text as "vatRate", l.vat_base::text as "vatBase", l.tax_role as "taxRole", l.seller_key as "sellerKey", l.doc_class as "docClass"
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.entry_id = $1 and l.user_id = $2 order by l.line_no`, [id, scope]);
    return { ...e, lines: lines.rows, source: await this.sourceLink(scope, e.sourceType, e.sourceId, e.payload) };
  }

  /** `{type, id, number, route}` for the entry's source document (§10.2), or null when it no longer exists. */
  private async sourceLink(scope: number, type: string, id: number, payload: any) {
    const one = async (sql: string) => (await this.pool.query(sql, [id, scope])).rows[0] ?? null;
    switch (type) {
      case "simple_invoice": {
        const r = await one(`select number, kind from simple_invoices where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.number, route: `/dashboard/invoices?id=${id}` } : null;
      }
      case "payment": {
        const r = await one(`select contract_id from payments where id = $1 and user_id = $2`);
        return r ? { type, id, number: null, route: `/dashboard/contracts?id=${r.contract_id}` } : null;
      }
      case "payment_collection": {
        const r = await one(`select pc.receipt_number, p.contract_id from payment_collections pc left join payments p on p.id = pc.payment_id
                              where pc.id = $1 and pc.user_id = $2`);
        return r ? { type, id, number: r.receipt_number ?? null, route: r.contract_id ? `/dashboard/contracts?id=${r.contract_id}` : null } : null;
      }
      case "contract": {
        const r = await one(`select contract_number from contracts where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.contract_number, route: `/dashboard/contracts?id=${id}` } : null;
      }
      case "expense":
        return (await one(`select 1 from expenses where id = $1 and user_id = $2`)) ? { type, id, number: null, route: `/dashboard/reports/expenses?id=${id}` } : null;
      case "landlord_payout":
        return (await one(`select 1 from landlord_payouts where id = $1 and user_id = $2`)) ? { type, id, number: null, route: `/dashboard/reports/payouts?id=${id}` } : null;
      case "tenant_credit_action": {
        const r = await one(`select number, tenant_id from tenant_credit_actions where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.number ?? null, route: `/dashboard/accounting/tenant-credits?tenantId=${r.tenant_id}` } : null;
      }
      case "write_off": {
        const r = await one(`select contract_id from finance_write_offs where id = $1 and user_id = $2`);
        return r ? { type, id, number: null, route: r.contract_id ? `/dashboard/contracts?id=${r.contract_id}` : null } : null;
      }
      case "supplier_bill": {
        const r = await one(`select number from supplier_bills where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.number, route: `/dashboard/accounting/bills?id=${id}` } : null;
      }
      case "supplier_payment": {
        const r = await one(`select number from supplier_payments where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.number, route: `/dashboard/accounting/supplier-payments?id=${id}` } : null;
      }
      case "fixed_asset": {
        const r = await one(`select number from fixed_assets where id = $1 and user_id = $2`);
        return r ? { type, id, number: r.number, route: `/dashboard/accounting/fixed-assets?id=${id}` } : null;
      }
      case "manual_journal":
      case "opening_balance":
        return { type, id, number: null, route: `/dashboard/accounting/manual-journals/${payload?.manualJournalId ?? id}` };
      default:
        return { type, id, number: null, route: null };
    }
  }

  /**
   * Manual reversal (§5.4): only manual and opening entries; automatic ones
   * are corrected by correcting their source. The reversal is dated `date`
   * (default today, Riyadh; never before the entry) and routed to the next
   * open period when that one is closed. The manual journal becomes `void`.
   */
  async reverse(scope: number, user: AuthUser, id: number, body: any) {
    const date = body?.date ? isoDate(body.date, "date") : riyadhToday();
    try {
      return await withTx(this.pool, async (c) => {
        const r = await c.query(`select id, origin, status, to_char(entry_date,'YYYY-MM-DD') as d from journal_entries where id = $1 and user_id = $2 for update`, [id, scope]);
        const e = r.rows[0];
        if (!e) throw new NotFoundException("Entry not found");
        if (!["manual", "opening"].includes(e.origin)) {
          throw new ConflictException({ error: "NOT_MANUAL", message: "Only manual and opening entries are reversed by hand; correct the source document instead" });
        }
        if (e.status !== "posted") throw new ConflictException({ error: "ALREADY_REVERSED", message: "The entry is already reversed" });
        if (date < e.d) throw new BadRequestException({ error: "BAD_DATE", message: "A reversal cannot be dated before the entry" });
        const res = await this.engine.reverseEntry(c, scope, id, date, { reason: "manual_reversal", createdBy: user.id,
          payload: { reason: typeof body?.reason === "string" ? body.reason.slice(0, 500) : null, reversedBy: user.id } });
        await c.query(`update manual_journals set status = 'void', updated_at = now() where user_id = $1 and posted_entry_id = $2 and status = 'posted'`, [scope, id]);
        await auditRow(c, scope, user.id, "finance_v2_journal", id, `/finance/v2/journal/${id}/reverse`);
        return { reversalId: res.id, late: res.late };
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }
}

function intOf(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestException(`${name} must be an id`);
  return n;
}
