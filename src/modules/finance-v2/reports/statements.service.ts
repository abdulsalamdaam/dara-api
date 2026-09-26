import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { fromHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { fyStartOf, riyadhNow } from "./core-math";
import { bad, h, langOf, namesOf, optId, reqId, scopedId, settingsOf, type Lang } from "./common";
import { VatReportService } from "./vat-report.service";
import { vatBoxes } from "./sub-math";

/**
 * The tenant ledger (DESIGN §7.7) and the landlord statement (§7.8), both
 * read from the journal. The landlord statement's PDF is rendered by the web
 * with the Arabic document pipeline (§7.8, DARA-NOTES §5–6) from this JSON;
 * nothing is emailed by the system.
 */

/** Posting rule → the movement type a statement shows. */
const TENANT_TYPES: Record<string, string> = {
  E01: "invoice", E07: "debit_note", E08: "rent_receipt", E17: "agency_fee", E02: "installment_charge", E34: "advance_vat",
  E06: "credit_note", E03: "collection", E04: "refund", E12B: "deposit_applied", E24: "write_off", E20: "refund",
  E21: "credit_transfer", E05: "charge_cancelled", E33: "settled_external", E28: "manual",
};
const DEPOSIT_TYPES: Record<string, string> = {
  E09: "received", E09C: "received", E10: "refunded", E04: "refunded", E12: "converted", E11: "forfeited", E12B: "applied", E28: "manual",
};
const LANDLORD_TYPES: Record<string, string> = {
  E03: "rent_collected", E04: "tenant_refund", E20: "tenant_refund", E12: "deposit_converted", E11: "deposit_forfeited", E12B: "deposit_applied",
  E15: "commission", E36: "commission_credit", E16: "commission_cash", E18: "expense", E19: "payout", E28: "manual",
  E38: "expense",
};

interface Movement {
  entryId: number;
  entryNo: string;
  entryDate: string;
  originalDate: string;
  isLate: boolean;
  origin: string;
  sourceType: string;
  sourceId: number;
  event: string;
  rule: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  contractId: number | null;
  documentId: number | null;
  paymentId: number | null;
  propertyId: number | null;
  unitId: number | null;
  tenantId: number | null;
}

@Injectable()
export class StatementsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  private async accountIds(scope: number, keys: string[]): Promise<number[]> {
    const r = await this.pool.query(`select id from accounts where user_id = $1 and system_key = any($2::text[])`, [scope, keys]);
    return r.rows.map((x: any) => x.id);
  }

  /** Per-entry movements on `accts` for the dimension column = id, in [from, to]. */
  private async movements(scope: number, accts: number[], dim: "tenant_id" | "owner_id", id: number, from: string, to: string, contractId?: number): Promise<Movement[]> {
    const p: unknown[] = [scope, accts, id, from, to];
    let extra = "";
    if (contractId != null) {
      p.push(contractId);
      extra = ` and l.contract_id = $${p.length}`;
    }
    const r = await this.pool.query(
      `select e.id::int as "entryId", e.entry_no as "entryNo", to_char(e.entry_date, 'YYYY-MM-DD') as "entryDate",
              to_char(e.original_date, 'YYYY-MM-DD') as "originalDate", e.is_late as "isLate", e.origin, e.source_type as "sourceType",
              e.source_id::int as "sourceId", e.event, coalesce(e.payload->>'rule', r.payload->>'rule') as rule, e.memo,
              sum(l.debit)::text as debit, sum(l.credit)::text as credit,
              min(l.contract_id) as "contractId", min(l.document_id) as "documentId", min(l.payment_id) as "paymentId",
              min(l.property_id) as "propertyId", min(l.unit_id) as "unitId", min(l.tenant_id) as "tenantId"
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
         left join journal_entries r on r.id = e.reversal_of and r.user_id = e.user_id
        where l.user_id = $1 and l.account_id = any($2::int[]) and l.${dim} = $3 and l.entry_date between $4::date and $5::date${extra}
        group by e.id, r.payload order by e.entry_date, e.id`, p);
    return r.rows.map((x: any) => ({ ...x, debit: h(x.debit), credit: h(x.credit) }));
  }

  private async balanceBefore(scope: number, accts: number[], dim: "tenant_id" | "owner_id", id: number, before: string, inclusive: boolean, contractId?: number) {
    const p: unknown[] = [scope, accts, id, before];
    let extra = "";
    if (contractId != null) {
      p.push(contractId);
      extra = ` and l.contract_id = $${p.length}`;
    }
    const r = await this.pool.query(
      `select coalesce(sum(l.debit - l.credit), 0)::text as net from journal_lines l
        where l.user_id = $1 and l.account_id = any($2::int[]) and l.${dim} = $3 and l.entry_date ${inclusive ? "<=" : "<"} $4::date${extra}`, p);
    return h(r.rows[0].net);
  }

  /** Document numbers, receipt numbers and PV numbers for the movements' sources. */
  private async references(scope: number, ms: Movement[]) {
    const ids = (t: string) => [...new Set(ms.filter((m) => m.sourceType === t).map((m) => m.sourceId))];
    const docIds = [...new Set([...ids("simple_invoice"), ...ms.map((m) => m.documentId).filter((x): x is number => x != null)])];
    const q = async (list: number[], sql: string) => (list.length ? (await this.pool.query(sql, [scope, list])).rows : []);
    const docs = new Map((await q(docIds, `select id, number, type::text as type, kind from simple_invoices where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const cols = new Map((await q(ids("payment_collection"), `select id, receipt_number, method from payment_collections where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const acts = new Map((await q(ids("tenant_credit_action"), `select id, number from tenant_credit_actions where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const refunds = new Map((await q(ids("deposit_refund"), `select id, number from finance_deposit_refunds where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    return (m: Movement) => {
      switch (m.sourceType) {
        case "simple_invoice": return { number: docs.get(m.sourceId)?.number ?? null, method: null };
        case "payment_collection": return { number: cols.get(m.sourceId)?.receipt_number ?? (m.documentId != null ? docs.get(m.documentId)?.number ?? null : null), method: cols.get(m.sourceId)?.method ?? null };
        case "tenant_credit_action": return { number: acts.get(m.sourceId)?.number ?? null, method: null };
        case "deposit_refund": return { number: refunds.get(m.sourceId)?.number ?? null, method: null };
        default: return { number: m.documentId != null ? docs.get(m.documentId)?.number ?? null : null, method: null };
      }
    };
  }

  private static typeOf(m: Movement, table: Record<string, string>): string {
    if (m.origin === "reversal") return "reversal";
    if (m.origin === "opening") return "opening";
    return (m.rule && table[m.rule]) || "other";
  }

  // ───────────────────────────── §7.7 tenant ledger ─────────────────────────────

  /** GET /finance/v2/reports/tenant-ledger?tenantId&from&to&contractId&lang */
  async tenantLedger(scope: number, q: Record<string, any> = {}) {
    const lang: Lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const tenantId = await scopedId(this.pool, scope, "tenantId", reqId(q.tenantId, "tenantId"));
    const cid = optId(q.contractId, "contractId");
    const contractId = cid != null ? await scopedId(this.pool, scope, "contractId", cid) : undefined;
    const to = q.to ? isoDate(q.to, "to") : riyadhToday();
    const from = q.from ? isoDate(q.from, "from") : fyStartOf(to, s.startMonth);
    if (from > to) throw bad("BAD_RANGE", "from must not be after to");

    const ar = await this.accountIds(scope, ["tenant_receivable", "tenant_receivable_agency"]);
    const dep = await this.accountIds(scope, ["deposits_held"]);
    const opening = await this.balanceBefore(scope, ar, "tenant_id", tenantId, from, false, contractId);
    const ms = await this.movements(scope, ar, "tenant_id", tenantId, from, to, contractId);
    const dOpen = -(await this.balanceBefore(scope, dep, "tenant_id", tenantId, from, false, contractId));
    const dms = await this.movements(scope, dep, "tenant_id", tenantId, from, to, contractId);
    const ref = await this.references(scope, [...ms, ...dms]);

    let bal = opening;
    let charges = 0;
    let credits = 0;
    const lines = ms.map((m) => {
      bal += m.debit - m.credit;
      charges += m.debit;
      credits += m.credit;
      const r = ref(m);
      return {
        entryId: m.entryId, entryNo: m.entryNo, date: m.entryDate, originalDate: m.originalDate, isLate: m.isLate,
        type: StatementsService.typeOf(m, TENANT_TYPES), rule: m.rule, documentNumber: r.number, method: r.method, description: m.memo,
        sourceType: m.sourceType, sourceId: m.sourceId, contractId: m.contractId, paymentId: m.paymentId, documentId: m.documentId,
        charge: fromHalalas(m.debit), credit: fromHalalas(m.credit), balance: fromHalalas(bal),
      };
    });

    let held = dOpen;
    const byType: Record<string, number> = {};
    const depLines = dms.map((m) => {
      held += m.credit - m.debit;
      const type = StatementsService.typeOf(m, DEPOSIT_TYPES);
      byType[type] = (byType[type] ?? 0) + (m.credit - m.debit);
      return {
        entryId: m.entryId, entryNo: m.entryNo, date: m.entryDate, type, documentNumber: ref(m).number, description: m.memo,
        contractId: m.contractId, received: fromHalalas(m.credit), released: fromHalalas(m.debit), held: fromHalalas(held),
      };
    });

    const name = (await namesOf(this.pool, scope, "tenants", [tenantId])).get(tenantId) ?? null;
    return {
      report: "tenant-ledger",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { tenantId, from, to, ...(contractId != null ? { contractId } : {}) },
      tenant: { id: tenantId, name },
      opening: fromHalalas(opening),
      lines,
      totals: { charges: fromHalalas(charges), credits: fromHalalas(credits) },
      closing: fromHalalas(bal),
      /** positive = owed by the tenant; negative = the tenant's credit. */
      closingSide: bal > 0 ? "owed" : bal < 0 ? "credit" : "settled",
      deposits: {
        opening: fromHalalas(dOpen),
        received: fromHalalas(byType.received ?? 0),
        refunded: fromHalalas(-(byType.refunded ?? 0)),
        converted: fromHalalas(-(byType.converted ?? 0)),
        forfeited: fromHalalas(-(byType.forfeited ?? 0)),
        applied: fromHalalas(-(byType.applied ?? 0)),
        other: fromHalalas(Object.entries(byType).filter(([k]) => !["received", "refunded", "converted", "forfeited", "applied"].includes(k)).reduce((t, [, v]) => t + v, 0)),
        held: fromHalalas(held),
        lines: depLines,
      },
    };
  }

  // ───────────────────────────── §7.8 landlord statement ─────────────────────────────

  /**
   * GET /finance/v2/reports/landlord-statement?ownerId&from&to&lang. An
   * owner-mobile token may read only its own landlord (§7.11); `ownerScopeId`
   * is passed in by the controller.
   */
  async landlordStatement(scope: number, q: Record<string, any> = {}, ownerScopeId: number | null = null) {
    const lang: Lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const ownerId = await scopedId(this.pool, scope, "ownerId", reqId(q.ownerId, "ownerId"));
    if (ownerScopeId != null && ownerScopeId !== ownerId) throw new ForbiddenException({ error: "OWNER_SCOPE", message: "A landlord login may read only its own statement" });
    const to = q.to ? isoDate(q.to, "to") : riyadhToday();
    const from = q.from ? isoDate(q.from, "from") : `${to.slice(0, 8)}01`;
    if (from > to) throw bad("BAD_RANGE", "from must not be after to");

    const o = (await this.pool.query(
      `select id, name, tax_number, id_number, is_account_holder from owners where user_id = $1 and id = $2`, [scope, ownerId])).rows[0];
    const acct = (await this.pool.query(`select id, name from users where id = $1`, [scope])).rows[0] ?? { id: scope, name: null };
    const principal = o.is_account_holder === true || s.mode === "owner";
    const base = {
      report: "landlord-statement",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { ownerId, from, to },
      variant: principal ? "principal" : "agent",
      landlord: { id: o.id, name: o.name, taxNumber: o.tax_number ?? null, idNumber: o.id_number ?? null, isAccountHolder: o.is_account_holder === true },
      account: { id: acct.id, name: acct.name ?? null },
    };
    if (principal) return { ...base, ...(await this.performance(scope, ownerId, from, to, lang)) };

    const lp = await this.accountIds(scope, ["landlord_payable"]);
    const opening = -(await this.balanceBefore(scope, lp, "owner_id", ownerId, from, false));
    const ms = await this.movements(scope, lp, "owner_id", ownerId, from, to);
    const ref = await this.references(scope, ms);
    const split = await this.vatSplit(scope, ms.map((m) => m.entryId));
    const exp = await this.expenseDetails(scope, ms.filter((m) => m.sourceType === "expense").map((m) => m.sourceId));
    const bills = await this.billDetails(scope, ms.filter((m) => m.sourceType === "supplier_bill").map((m) => m.sourceId));
    const props = await namesOf(this.pool, scope, "properties", ms.map((m) => m.propertyId!).filter((x) => x != null));
    const tenants = await namesOf(this.pool, scope, "tenants", ms.map((m) => m.tenantId!).filter((x) => x != null));

    let bal = opening;
    const summary: Record<string, number> = {};
    const byProperty = new Map<number | null, number>();
    const lines = ms.map((m) => {
      const amt = m.credit - m.debit;
      bal += amt;
      const type = StatementsService.typeOf(m, LANDLORD_TYPES);
      summary[type] = (summary[type] ?? 0) + amt;
      if (type === "rent_collected") byProperty.set(m.propertyId, (byProperty.get(m.propertyId) ?? 0) + amt);
      const v = split.get(m.entryId);
      const e = m.sourceType === "expense" ? exp.get(m.sourceId) : m.sourceType === "supplier_bill" ? bills.get(m.sourceId) : undefined;
      const gross = Math.abs(amt);
      const vat = type === "commission" || type === "commission_credit" ? v?.commissionVat ?? 0 : type === "expense" ? v?.inputVat ?? 0 : 0;
      return {
        entryId: m.entryId, entryNo: m.entryNo, date: m.entryDate, type, rule: m.rule, documentNumber: ref(m).number, method: ref(m).method,
        description: m.memo, sourceType: m.sourceType, sourceId: m.sourceId,
        propertyId: m.propertyId, propertyName: m.propertyId != null ? props.get(m.propertyId) ?? null : null,
        unitId: m.unitId, tenantId: m.tenantId, tenantName: m.tenantId != null ? tenants.get(m.tenantId) ?? null : null,
        contractId: m.contractId, documentId: m.documentId,
        net: vat ? fromHalalas(gross - Math.abs(vat)) : null, vat: vat ? fromHalalas(Math.abs(vat)) : null,
        supplier: e ? { name: e.supplier_name ?? null, invoiceNo: e.supplier_invoice_no ?? null, vatNumber: e.supplier_vat_number ?? null } : null,
        debit: fromHalalas(m.debit), credit: fromHalalas(m.credit), balance: fromHalalas(bal),
      };
    });

    const lpu = await this.accountIds(scope, ["landlord_payable_uncollected"]);
    const dep = await this.accountIds(scope, ["deposits_held"]);
    const perTenant = async (accts: number[]) => {
      const r = await this.pool.query(
        `select l.tenant_id, sum(l.credit - l.debit)::text as bal from journal_lines l
          where l.user_id = $1 and l.account_id = any($2::int[]) and l.owner_id = $3 and l.entry_date <= $4::date
          group by l.tenant_id having sum(l.credit - l.debit) <> 0 order by l.tenant_id nulls last`, [scope, accts, ownerId, to]);
      const names = await namesOf(this.pool, scope, "tenants", r.rows.map((x: any) => x.tenant_id).filter((x: any) => x != null));
      const rows = r.rows.map((x: any) => ({ tenantId: x.tenant_id, tenantName: x.tenant_id != null ? names.get(x.tenant_id) ?? null : null, amount: fromHalalas(h(x.bal)) }));
      return { total: fromHalalas(r.rows.reduce((t: number, x: any) => t + h(x.bal), 0)), rows };
    };
    const vat = vatBoxes(await new VatReportService(this.pool).aggregates(this.pool, scope, `owner:${ownerId}`, from, to));
    const box = (n: number) => vat.boxes.find((b) => b.box === n)!;
    const money = (b: { amount: number; adjustment: number }) => fromHalalas(b.amount + b.adjustment);
    const sum = (k: string) => fromHalalas(summary[k] ?? 0);

    return {
      ...base,
      opening: fromHalalas(opening),
      lines,
      summary: {
        rentCollected: sum("rent_collected"), depositsConverted: sum("deposit_converted"), depositsForfeited: sum("deposit_forfeited"),
        depositsApplied: sum("deposit_applied"), commission: sum("commission"), commissionCredit: sum("commission_credit"),
        commissionCash: sum("commission_cash"), expenses: sum("expense"), payouts: sum("payout"), tenantRefunds: sum("tenant_refund"),
        manual: sum("manual"), reversals: sum("reversal"), other: sum("other"),
      },
      rentByProperty: [...byProperty.entries()].map(([pid, v]) => ({ propertyId: pid, propertyName: pid != null ? props.get(pid) ?? null : null, amount: fromHalalas(v) })),
      closing: fromHalalas(bal),
      memo: {
        uncollectedRent: await perTenant(lpu),
        depositsHeld: await perTenant(dep),
        vat: {
          seller: `owner:${ownerId}`,
          standardRated: { base: money(box(1)), vat: fromHalalas(vat.outputVat) },
          zeroRated: { base: money(box(3)) },
          exempt: { base: money(box(5)) },
          outOfScope: { base: money(vat.outOfScopeSales) },
          inputRecoverable: { base: money(box(7)), vat: fromHalalas(vat.inputVatBooked) },
          inputNonRecoverable: { base: fromHalalas(vat.nonRecoverable.base), vat: fromHalalas(vat.nonRecoverable.vat) },
        },
      },
    };
  }

  /** Commission VAT (2151 credits) and input VAT (LP lines with an S tax role) per entry. */
  private async vatSplit(scope: number, entryIds: number[]) {
    const out = new Map<number, { commissionVat: number; inputVat: number }>();
    if (!entryIds.length) return out;
    const r = await this.pool.query(
      `select l.entry_id::int as id,
              coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'output_vat'), 0)::text as cvat,
              coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'landlord_payable' and l.vat_category = 'S' and l.tax_role in ('input','input_nonrecoverable')), 0)::text as ivat
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_id = any($2::bigint[]) group by l.entry_id`, [scope, entryIds]);
    for (const x of r.rows) out.set(x.id, { commissionVat: h(x.cvat), inputVat: h(x.ivat) });
    return out;
  }

  /** Tier 3: a supplier bill charged to the landlord shows its supplier like an expense does. */
  private async billDetails(scope: number, ids: number[]) {
    if (!ids.length) return new Map<number, any>();
    const r = await this.pool.query(
      `select b.id, s.name_ar as supplier_name, b.supplier_invoice_no, s.vat_number as supplier_vat_number
         from supplier_bills b join suppliers s on s.id = b.supplier_id and s.user_id = b.user_id where b.user_id = $1 and b.id = any($2::int[])`,
      [scope, ids]);
    return new Map<number, any>(r.rows.map((x: any) => [x.id, x]));
  }

  private async expenseDetails(scope: number, ids: number[]) {
    if (!ids.length) return new Map<number, any>();
    const r = await this.pool.query(
      `select expense_id, supplier_name, supplier_invoice_no, supplier_vat_number from finance_expense_details where user_id = $1 and expense_id = any($2::int[])`,
      [scope, ids]);
    return new Map<number, any>(r.rows.map((x: any) => [x.expense_id, x]));
  }

  /** Principal landlords: revenue, expenses and net per property from P&L lines with that owner (§7.8). */
  private async performance(scope: number, ownerId: number, from: string, to: string, lang: Lang) {
    const r = await this.pool.query(
      `select l.property_id,
              coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::text as rev,
              coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense'), 0)::text as exp
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
         join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and l.owner_id = $2 and l.entry_date between $3::date and $4::date
          and a.type in ('revenue','expense') and e.origin <> 'closing'
        group by l.property_id order by l.property_id nulls last`, [scope, ownerId, from, to]);
    const names = await namesOf(this.pool, scope, "properties", r.rows.map((x: any) => x.property_id).filter((x: any) => x != null));
    let rev = 0;
    let exp = 0;
    const properties = r.rows.map((x: any) => {
      rev += h(x.rev);
      exp += h(x.exp);
      return {
        propertyId: x.property_id,
        propertyName: x.property_id != null ? names.get(x.property_id) ?? null : lang === "en" ? "Unallocated" : "غير مخصّص",
        revenue: fromHalalas(h(x.rev)), expenses: fromHalalas(h(x.exp)), net: fromHalalas(h(x.rev) - h(x.exp)),
      };
    });
    return { properties, totals: { revenue: fromHalalas(rev), expenses: fromHalalas(exp), net: fromHalalas(rev - exp) } };
  }
}
