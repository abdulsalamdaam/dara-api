import { Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { fromHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { daysBetween, riyadhNow } from "./core-math";
import { DEPOSIT_DESC, contractDims, h, langOf, namesOf, scopedFilters, settingsOf, type ContractDims, type DimKey } from "./common";
import { BUCKETS, bucketOf, type Bucket } from "./sub-math";

/**
 * AR aging (DESIGN §7.6), built from the SUB-LEDGER per open item, so the
 * ledger's AR can be reconciled to it (R1, §7.10).
 *
 * Open items as of `asOf`:
 *  1. Installments due on or before `asOf` that no confirmed charge document
 *     covers (deposit rows, cancelled, settled-external, written-off, deleted
 *     rows and rows of deleted contracts are not items). remaining = amount −
 *     Σ collections dated ≤ asOf (negative refund rows included) − what Ejar
 *     reported part-paid (settled outside Dara at the due date, E33).
 *  2. Confirmed charge documents issued ≤ asOf (invoice, manual, rent receipt,
 *     agency fee, debit note; never commission, which is billed to the
 *     landlord). remaining = total − credit notes − collections applied (each
 *     collection counted once) − tenant credit applied.
 *  3. Unapplied credit per tenant: collections on nothing chargeable yet
 *     (advances on future installments, receipt-voucher remainders), items
 *     overpaid, excess credit notes, net of credit refunded or applied.
 *
 * Part-paid: an installment of 6,900 with 3,000 collected ages 3,900 in its
 * bucket. A future installment is not a receivable yet; money collected on it
 * is the tenant's credit (as in the ledger, where E03 credits AR before the
 * charge).
 */

const CHARGE_KINDS = new Set(["invoice", "manual", "rent_receipt", "agency_fee"]);

export interface AgingItem {
  type: "installment" | "document";
  id: number;
  number: string | null;
  contractId: number | null;
  tenantId: number | null;
  ownerId: number | null;
  propertyId: number | null;
  dueDate: string;
  amount: number;
  collected: number;
  credited: number;
  /** Paid outside Dara as Ejar reported it (a part payment; E33 at the due date), halalas. */
  settledExternal: number;
  remaining: number;
  daysPastDue: number;
  bucket: Bucket | null;
  /**
   * The buyer's name as the document states it, for a document with no tenant
   * and no contract (a free invoice to an external customer or a landlord);
   * null otherwise. Such items have no tenant key of their own.
   */
  customer?: string | null;
}

export interface AgingData {
  items: AgingItem[];
  /** Unapplied credit per tenant key (halalas, ≤ 0 normally). */
  credit: Map<string, { tenantId: number | null; contractId: number | null; ownerId: number | null; propertyId: number | null; amount: number }>;
  dims: Map<number, ContractDims>;
}

const tkey = (tenantId: number | null, contractId: number | null, by: "tenant" | "contract") =>
  by === "contract" ? `c:${contractId ?? "none"}` : `t:${tenantId ?? "none"}`;

@Injectable()
export class ArAgingService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  /** The open items and unapplied credit as of `asOf` (every tenant; filter afterwards). */
  async openItems(scope: number, asOf: string, by: "tenant" | "contract" = "tenant", opts: { installmentsDueBefore?: string } = {}): Promise<AgingData> {
    const dims = await contractDims(this.pool, scope);
    const [pays, cols, docs, wos, acts, ejar] = await Promise.all([
      this.pool.query(
        `select id, contract_id, amount::text as amount, to_char(due_date, 'YYYY-MM-DD') as due, status::text as status, description,
                deleted_at is not null as deleted
           from payments where user_id = $1`, [scope]),
      this.pool.query(
        `select id, payment_id, invoice_id, amount::text as amount from payment_collections
          where user_id = $1 and collected_date <= $2::date order by id`, [scope, asOf]),
      this.pool.query(
        `select id, number, type::text as type, coalesce(kind, 'invoice') as kind, status::text as status, contract_id, tenant_id,
                payment_id, payment_ids, total::text as total, billing_reference,
                nullif(trim(coalesce(client->>'name', tenant_name, '')), '') as customer,
                to_char(coalesce(issue_date, (confirmed_at at time zone 'Asia/Riyadh')::date), 'YYYY-MM-DD') as issue,
                to_char(due_date, 'YYYY-MM-DD') as due, deleted_at is not null as deleted
           from simple_invoices where user_id = $1`, [scope]),
      this.pool.query(
        `select payment_ids, document_ids, amount::text as amount from finance_write_offs where user_id = $1 and written_off_on <= $2::date`, [scope, asOf]),
      this.pool.query(
        `select a.kind, a.tenant_id, a.contract_id, a.amount::text as amount, a.target_document_id, t.target_payment_id
           from tenant_credit_actions a left join tenant_credit_targets t on t.action_id = a.id and t.user_id = a.user_id
          where a.user_id = $1 and a.status = 'posted' and a.action_on <= $2::date`, [scope, asOf]),
      this.pool.query(
        `select payment_id, reported_amount::text as amount from finance_ejar_settlements
          where user_id = $1 and reported_status = 'partially_paid' and reported_amount > 0`, [scope]),
    ]);

    const payById = new Map<number, any>(pays.rows.map((p: any) => [p.id, p]));
    const docById = new Map<number, any>(docs.rows.map((d: any) => [d.id, d]));
    const writtenPay = new Set<number>(wos.rows.flatMap((w: any) => (w.payment_ids ?? []).map(Number)));
    const writtenDoc = new Set<number>(wos.rows.flatMap((w: any) => (w.document_ids ?? []).map(Number)));

    const live = (d: any) => d && !d.deleted && d.status === "confirmed" && d.issue != null && d.issue <= asOf;
    const isCharge = (d: any) => live(d) && ((d.type === "invoice" && CHARGE_KINDS.has(d.kind)) || d.type === "debit");
    const covers = (d: any): number[] => {
      if (!(d.type === "invoice" && CHARGE_KINDS.has(d.kind))) return [];
      const list = Array.isArray(d.payment_ids) && d.payment_ids.length ? d.payment_ids : d.payment_id ? [d.payment_id] : [];
      return [...new Set<number>(list.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))];
    };
    const coveredBy = new Map<number, number>();
    for (const d of [...docs.rows].sort((a: any, b: any) => a.id - b.id)) {
      if (!isCharge(d)) continue;
      for (const p of covers(d)) if (!coveredBy.has(p)) coveredBy.set(p, d.id);
    }

    const credit: AgingData["credit"] = new Map();
    const addCredit = (tenantId: number | null, contractId: number | null, amount: number) => {
      const c = contractId != null ? dims.get(contractId) : undefined;
      const t = tenantId ?? c?.tenantId ?? null;
      const k = tkey(t, contractId, by);
      const cur = credit.get(k) ?? { tenantId: t, contractId, ownerId: c?.ownerId ?? null, propertyId: c?.propertyId ?? null, amount: 0 };
      cur.amount += amount;
      credit.set(k, cur);
    };

    // Items.
    const items = new Map<string, AgingItem>();
    const docTenant = (d: any) => d.tenant_id ?? (d.contract_id != null ? dims.get(d.contract_id)?.tenantId ?? null : null);
    for (const d of docs.rows) {
      if (!isCharge(d) || writtenDoc.has(d.id)) continue;
      const c = d.contract_id != null ? dims.get(d.contract_id) : undefined;
      const covered = covers(d).map((p) => payById.get(p)?.due).filter(Boolean).sort();
      items.set(`d:${d.id}`, {
        type: "document", id: d.id, number: d.number, contractId: d.contract_id, tenantId: docTenant(d),
        ownerId: c?.ownerId ?? null, propertyId: c?.propertyId ?? null,
        dueDate: d.due ?? covered[covered.length - 1] ?? d.issue, amount: h(d.total), collected: 0, credited: 0, settledExternal: 0, remaining: 0, daysPastDue: 0, bucket: null,
        customer: docTenant(d) == null && d.contract_id == null ? d.customer ?? null : null,
      });
    }
    type PState = "item" | "consumed" | "credit" | "deposit";
    const payState = (p: any): PState => {
      if (p.description === DEPOSIT_DESC) return "deposit";
      const c = dims.get(p.contract_id);
      if (!c || c.deleted || writtenPay.has(p.id) || p.status === "settled_external") return "consumed";
      if (p.deleted || p.status === "cancelled") return "credit";
      if (c.endedOn && (c.status === "terminated" || c.status === "cancelled") && p.due > c.endedOn) return "credit";
      if (p.due > asOf) return "credit";
      if (opts.installmentsDueBefore && !(p.due < opts.installmentsDueBefore)) return "credit";
      return "item";
    };
    for (const p of pays.rows) {
      if (coveredBy.has(p.id) || payState(p) !== "item") continue;
      const c = dims.get(p.contract_id)!;
      items.set(`p:${p.id}`, {
        type: "installment", id: p.id, number: null, contractId: p.contract_id, tenantId: c.tenantId, ownerId: c.ownerId, propertyId: c.propertyId,
        dueDate: p.due, amount: h(p.amount), collected: 0, credited: 0, settledExternal: 0, remaining: 0, daysPastDue: 0, bucket: null,
      });
    }

    // Collections: each applied to exactly one item (or to the tenant's credit).
    for (const col of cols.rows) {
      const amt = h(col.amount);
      const doc = col.invoice_id != null ? docById.get(col.invoice_id) : null;
      const pay = col.payment_id != null ? payById.get(col.payment_id) : null;
      if (doc && (doc.kind === "commission" || (doc.kind === "deposit" && !(pay && pay.description !== DEPOSIT_DESC)))) continue;
      if (doc && isCharge(doc)) {
        if (writtenDoc.has(doc.id)) continue;
        const it = items.get(`d:${doc.id}`);
        if (it) it.collected += amt;
        continue;
      }
      if (pay) {
        const byDoc = coveredBy.get(pay.id);
        if (byDoc != null) {
          if (writtenDoc.has(byDoc)) continue;
          const it = items.get(`d:${byDoc}`);
          if (it) it.collected += amt;
          continue;
        }
        const st = payState(pay);
        if (st === "deposit" || st === "consumed") continue;
        if (st === "credit") {
          addCredit(dims.get(pay.contract_id)?.tenantId ?? null, pay.contract_id, -amt);
          continue;
        }
        items.get(`p:${pay.id}`)!.collected += amt;
        continue;
      }
      // Money received on a document not (yet) issued as of asOf, or on a receipt voucher: the tenant's credit.
      if (doc && !doc.deleted) addCredit(docTenant(doc), doc.contract_id, -amt);
    }

    // What Ejar reported part-paid, on an installment that is an item as of asOf (E33 is dated at its due date): paid
    // outside Dara, so it reduces the item (or the document covering the installment) like the ledger's E33 does.
    for (const e of ejar.rows) {
      const pay = payById.get(Number(e.payment_id));
      if (!pay) continue;
      const byDoc = coveredBy.get(pay.id);
      const it = byDoc != null ? items.get(`d:${byDoc}`) : items.get(`p:${pay.id}`);
      if (it) it.settledExternal += h(e.amount);
    }

    // Credit notes: against the document they reference; the excess is the tenant's credit.
    const byNumber = new Map<string, any>();
    for (const d of docs.rows) if (!d.deleted && d.type !== "credit" && !byNumber.has(d.number)) byNumber.set(d.number, d);
    for (const n of docs.rows) {
      if (n.type !== "credit" || !live(n) || n.kind === "commission") continue;
      const target = n.billing_reference ? byNumber.get(n.billing_reference) : null;
      if (target?.kind === "commission") continue;
      const it = target ? items.get(`d:${target.id}`) : undefined;
      if (it) it.credited += h(n.total);
      else if (!(target && writtenDoc.has(target.id))) addCredit(n.tenant_id ?? target?.tenant_id ?? null, n.contract_id ?? target?.contract_id ?? null, -h(n.total));
    }

    // An installment written off while a confirmed document covers it: E24 cleared that much of the document's AR
    // (the document itself is not in the write-off), so the document's item is reduced by the amount written off.
    for (const w of wos.rows) {
      if ((w.document_ids ?? []).length) continue;
      const docs = new Set((w.payment_ids ?? []).map((p: number) => coveredBy.get(Number(p))));
      if (docs.size !== 1) continue;
      const [d] = [...docs];
      const it = d != null ? items.get(`d:${d}`) : undefined;
      if (it) it.credited += h(w.amount);
    }

    // Tenant credit applied to a document, or refunded.
    for (const a of acts.rows) {
      const amt = h(a.amount);
      if (a.kind === "apply") {
        // A target installment is its own item, or the document covering it; a not-yet-due one is no item (the credit waits).
        const tp = a.target_payment_id != null ? Number(a.target_payment_id) : null;
        const it = a.target_document_id != null ? items.get(`d:${a.target_document_id}`)
          : tp != null ? items.get(`p:${tp}`) ?? (coveredBy.has(tp) ? items.get(`d:${coveredBy.get(tp)}`) : undefined) : undefined;
        if (it) it.credited += amt;
        addCredit(a.tenant_id, a.contract_id, amt);
      } else {
        addCredit(a.tenant_id, a.contract_id, amt);
      }
    }

    const out: AgingItem[] = [];
    for (const it of items.values()) {
      it.remaining = it.amount - it.collected - it.credited - it.settledExternal;
      if (it.remaining < 0) {
        addCredit(it.tenantId, it.contractId, it.remaining);
        it.remaining = 0;
      }
      it.daysPastDue = daysBetween(it.dueDate, asOf);
      it.bucket = it.remaining > 0 ? bucketOf(it.daysPastDue) : null;
      out.push(it);
    }
    out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id));
    return { items: out, credit, dims };
  }

  /** Σ advance VAT (E34) booked ≤ asOf on installments not charged by then, per contract. */
  async openAdvanceVat(scope: number, asOf: string, dims: Map<number, ContractDims>, by: "tenant" | "contract" = "tenant") {
    const r = await this.pool.query(
      `select p.contract_id, sum(v.vat_booked)::text as vat
         from finance_installment_vat_points v join payments p on p.id = v.payment_id and p.user_id = v.user_id
        where v.user_id = $1 and v.booked_on <= $2::date
          and not exists (select 1 from finance_installment_charges c where c.user_id = v.user_id and c.payment_id = v.payment_id
                           and c.reversed_at is null and c.charged_on <= $2::date)
        group by p.contract_id`, [scope, asOf]);
    return r.rows.map((x: any) => {
      const c = dims.get(x.contract_id);
      const tenantId = c?.tenantId ?? null;
      return { key: tkey(tenantId, x.contract_id, by), tenantId, contractId: x.contract_id as number, ownerId: c?.ownerId ?? null, propertyId: c?.propertyId ?? null, vat: h(x.vat) };
    });
  }

  /** Ledger AR (1121 + 1122) as of `asOf`, per tenant key, with optional dimension filters. */
  async ledgerAr(scope: number, asOf: string, f: Partial<Record<DimKey, number>>, by: "tenant" | "contract" = "tenant") {
    const p: unknown[] = [scope, asOf];
    let dimsSql = "";
    for (const [k, col] of [["ownerId", "owner_id"], ["propertyId", "property_id"], ["tenantId", "tenant_id"], ["contractId", "contract_id"]] as const) {
      if (f[k] == null) continue;
      p.push(f[k]);
      dimsSql += ` and l.${col} = $${p.length}`;
    }
    const r = await this.pool.query(
      `select l.tenant_id, l.contract_id, sum(l.debit - l.credit)::text as bal
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and a.system_key in ('tenant_receivable','tenant_receivable_agency')${dimsSql}
        group by 1, 2`, p);
    const out = new Map<string, number>();
    for (const x of r.rows) {
      const k = tkey(x.tenant_id, x.contract_id, by);
      out.set(k, (out.get(k) ?? 0) + h(x.bal));
    }
    return out;
  }

  /** GET /finance/v2/reports/ar-aging */
  async arAging(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const asOf = q.asOf ? isoDate(q.asOf, "asOf") : riyadhToday();
    const by: "tenant" | "contract" = q.groupBy === "contract" ? "contract" : "tenant";
    const f = await scopedFilters(this.pool, scope, q, ["ownerId", "propertyId", "tenantId"]);
    const s = await settingsOf(this.pool, scope);
    const data = await this.openItems(scope, asOf, by);
    const keep = (x: { tenantId: number | null; ownerId: number | null; propertyId: number | null }) =>
      (f.tenantId == null || x.tenantId === f.tenantId) && (f.ownerId == null || x.ownerId === f.ownerId) && (f.propertyId == null || x.propertyId === f.propertyId);

    type Row = { key: string; tenantId: number | null; contractId: number | null; customer: string | null; b: Record<Bucket, number>; credit: number; items: AgingItem[] };
    const rows = new Map<string, Row>();
    const row = (k: string, tenantId: number | null, contractId: number | null, customer: string | null = null) => {
      let r = rows.get(k);
      if (!r) {
        r = { key: k, tenantId, contractId, customer, b: { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 }, credit: 0, items: [] };
        rows.set(k, r);
      }
      return r;
    };
    for (const it of data.items) {
      if (!keep(it) || it.remaining <= 0) continue;
      // An external customer (no tenant, no contract) gets a row of its own, named from the document.
      const r = it.customer
        ? row(`x:${it.customer}`, null, null, it.customer)
        : row(tkey(it.tenantId, it.contractId, by), it.tenantId, by === "contract" ? it.contractId : null);
      r.b[it.bucket!] += it.remaining;
      r.items.push(it);
    }
    for (const [k, c] of data.credit) {
      if (!keep(c) || c.amount === 0) continue;
      row(k, c.tenantId, by === "contract" ? c.contractId : null).credit += c.amount;
    }

    const tenants = await namesOf(this.pool, scope, "tenants", [...rows.values()].map((r) => r.tenantId!).filter((x) => x != null));
    const tot = { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, credit: 0 };
    const out = [...rows.values()].map((r) => {
      const pastDue = r.b.d0_30 + r.b.d31_60 + r.b.d61_90 + r.b.d90p;
      const open = pastDue + r.b.notDue;
      for (const k of BUCKETS) tot[k] += r.b[k];
      tot.credit += r.credit;
      const c = r.contractId != null ? data.dims.get(r.contractId) : undefined;
      return {
        tenantId: r.tenantId,
        tenantName: (r.tenantId != null ? tenants.get(r.tenantId) : null) ?? c?.tenantName ?? r.customer ?? null,
        customerName: r.customer,
        contractId: r.contractId,
        contractNumber: c?.number ?? null,
        notDue: fromHalalas(r.b.notDue), d0_30: fromHalalas(r.b.d0_30), d31_60: fromHalalas(r.b.d31_60), d61_90: fromHalalas(r.b.d61_90), d90p: fromHalalas(r.b.d90p),
        pastDue: fromHalalas(pastDue), open: fromHalalas(open), unappliedCredit: fromHalalas(r.credit), net: fromHalalas(open + r.credit),
        items: r.items.map((it) => ({
          type: it.type, id: it.id, number: it.number, contractId: it.contractId, dueDate: it.dueDate, daysPastDue: it.daysPastDue, bucket: it.bucket,
          amount: fromHalalas(it.amount), collected: fromHalalas(it.collected), credited: fromHalalas(it.credited), remaining: fromHalalas(it.remaining),
        })),
        _net: open + r.credit,
      };
    }).sort((a, b) => b._net - a._net || (a.tenantId ?? 0) - (b.tenantId ?? 0)).map(({ _net, ...r }) => r);

    const pastDue = tot.d0_30 + tot.d31_60 + tot.d61_90 + tot.d90p;
    const open = pastDue + tot.notDue;

    // Reconciliation footer (R1): ledger AR against this sub-ledger (+ advance VAT not yet netted by a charge).
    const ledger = await this.ledgerAr(scope, asOf, f, by);
    let ledgerTotal = 0;
    for (const v of ledger.values()) ledgerTotal += v;
    const advTotal = (await this.openAdvanceVat(scope, asOf, data.dims, by)).filter(keep).reduce((t, x) => t + x.vat, 0);
    const sub = open + tot.credit + advTotal;
    return {
      report: "ar-aging",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { asOf, groupBy: by, ...f },
      rows: out,
      totals: {
        notDue: fromHalalas(tot.notDue), d0_30: fromHalalas(tot.d0_30), d31_60: fromHalalas(tot.d31_60), d61_90: fromHalalas(tot.d61_90), d90p: fromHalalas(tot.d90p),
        pastDue: fromHalalas(pastDue), open: fromHalalas(open), unappliedCredit: fromHalalas(tot.credit), net: fromHalalas(open + tot.credit),
      },
      reconciliation: {
        ledgerAr: fromHalalas(ledgerTotal), subLedger: fromHalalas(sub), advanceVatOpen: fromHalalas(advTotal),
        difference: fromHalalas(ledgerTotal - sub), balanced: ledgerTotal === sub,
      },
    };
  }
}
