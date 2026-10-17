/**
 * E4 (DESIGN §9): GET /payments under v2. Same envelope and row shape as the
 * legacy list (payments.module.ts `list`), with ONE status definition
 * (`payment-status-v2.ts`): a part-paid installment past due is overdue, the
 * overdue card is Σ remaining (not Σ face amount), paid-without-money rows are
 * `paid` with `unverified: true` and never overdue. Every row also carries
 * `statusV2`, `remaining` and `ejarSettled` (the part Ejar reported paid,
 * which the remaining already excludes). `?statusV2=` filters on the v2 status exactly;
 * the legacy `?status=` / `?statusIn=` are mapped onto it.
 */
import { listQuerySchema, likeContains, parseDateBound } from "../../../common/pagination";
import { contractFilterText, parseContractFilter } from "../../../common/contract-filter";
import { liveStatusV2Sql, remainingSqlV2, collectedSqlV2, ejarSettledSqlV2, riyadhTodayV2 } from "../../../common/payment-status-v2";
import type { Sql } from "../hooks/sql";

const DEPOSIT_DESC = "تأمين (وديعة)";
const LEGACY = ["paid", "pending", "overdue", "cancelled", "partially_paid", "settled_external"];
const V2 = ["paid", "paid_unverified", "pending", "overdue", "cancelled", "partially_paid", "settled_external", "written_off"];

/** A legacy status filter value → the v2 statuses it stands for. */
function mapLegacy(s: string): string[] {
  if (s === "paid") return ["paid", "paid_unverified"];
  if (s === "cancelled") return ["cancelled", "written_off"];
  return [s];
}

/** The v2 status → the legacy-compatible `status` the current screens understand. */
export function displayStatus(v2: string): string {
  if (v2 === "paid_unverified") return "paid";
  if (v2 === "written_off") return "cancelled";
  return v2;
}

const toNum = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

/**
 * Per installment, the invoice already covering it — the text-SQL twin of
 * `invoicesForPayments` in payments.module.ts; keep the two rules identical.
 */
async function invoicesForPaymentsV2(q: Sql, scope: number, ids: number[]) {
  const out = new Map<number, { id: number; number: string; status: string }>();
  if (!ids.length) return out;
  const rows = await q.rows(
    `select distinct on (x.pid) x.pid as payment_id, d.id, d.number, d.status::text as status
       from simple_invoices d
       cross join lateral (
         select distinct v::int as pid from jsonb_array_elements_text(case
           when jsonb_typeof(d.payment_ids) = 'array' and jsonb_array_length(d.payment_ids) > 0 then d.payment_ids
           when d.payment_id is not null then jsonb_build_array(d.payment_id)
           else '[]'::jsonb end) v
       ) x
      where d.user_id = $1 and d.deleted_at is null and d.type = 'invoice'
        and d.status::text <> 'cancelled' and coalesce(d.kind, '') not in ('receipt', 'deposit', 'commission')
        and x.pid = any($2::int[])
      order by x.pid, d.created_at desc, d.id desc`,
    [scope, ids],
  );
  for (const r of rows as any[]) out.set(Number(r.payment_id), { id: Number(r.id), number: String(r.number), status: String(r.status) });
  return out;
}

export async function paymentsListV2(q: Sql, scope: number, raw: any) {
  const status = typeof raw?.status === "string" && LEGACY.includes(raw.status) ? raw.status : undefined;
  const statusIn = typeof raw?.statusIn === "string"
    ? raw.statusIn.split(",").map((s: string) => s.trim()).filter((s: string) => LEGACY.includes(s)) : undefined;
  const statusV2 = typeof raw?.statusV2 === "string"
    ? raw.statusV2.split(",").map((s: string) => s.trim()).filter((s: string) => V2.includes(s)) : undefined;
  // Same contract filter as the legacy list (common/contract-filter): ids
  // bounded to int4, and a filter sent with no usable id matches no rows.
  const cf = parseContractFilter(raw);
  const usePaginated = raw && (raw.page != null || raw.pageSize != null || raw.search != null || status != null || statusIn != null
    || raw.contractIds != null || statusV2 != null);
  const lq = listQuerySchema.parse(raw ?? {});
  const today = riyadhTodayV2();

  const params: unknown[] = [scope, today, DEPOSIT_DESC];
  const P = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const st = liveStatusV2Sql("p", "$2::date");
  const base = [`p.user_id = $1`, `p.deleted_at is null`, `(p.description is null or p.description <> $3)`];
  if (cf) base.push(contractFilterText(cf, "$1", "p.contract_id", P));
  const statsWhere = base.join(" and ");
  const statParamCount = params.length; // the stats read only the base filters' params
  const rowConds = [...base];
  if (lq.search) {
    const s = P(likeContains(lq.search));
    rowConds.push(`(p.receipt_number ilike ${s} or c.tenant_name ilike ${s} or c.contract_number ilike ${s})`);
  }
  const wanted = statusV2?.length ? statusV2 : status ? mapLegacy(status) : statusIn?.length ? statusIn.flatMap(mapLegacy) : null;
  if (wanted) rowConds.push(`${st} = any(string_to_array(${P(wanted.join(","))}::text, ','))`);
  const dueFrom = parseDateBound(raw?.dueFrom);
  const dueTo = parseDateBound(raw?.dueTo);
  if (dueFrom) rowConds.push(`p.due_date >= ${P(dueFrom)}::date`);
  if (dueTo) rowConds.push(`p.due_date <= ${P(dueTo)}::date`);
  const where = rowConds.join(" and ");
  const dir = lq.order === "asc" ? "asc" : "desc";
  const order = raw?.sort === "createdAt" ? `p.created_at desc, p.id desc`
    // The Paid tab: most recently collected first, undated rows last.
    : raw?.sort === "paidDate" ? `p.paid_date ${dir} nulls last, p.id ${dir}`
    : `p.due_date ${dir}, p.id ${dir}`;
  const limit = usePaginated ? ` limit ${Number(lq.pageSize)} offset ${(Number(lq.page) - 1) * Number(lq.pageSize)}` : "";

  const rows = await q.rows(
    `select p.id, p.contract_id, p.amount::text as amount, to_char(p.due_date,'YYYY-MM-DD') as due_date,
            to_char(p.paid_date,'YYYY-MM-DD') as paid_date, p.receipt_number, p.attachment_key, p.description, p.notes, p.created_at,
            p.vat_enabled, c.contract_number, c.tenant_name, c.vat_enabled as contract_vat, t.short_name as tenant_short_name,
            ${collectedSqlV2("p")}::text as collected, ${remainingSqlV2("p")}::text as remaining, ${st} as status_v2,
            ${ejarSettledSqlV2("p")}::text as ejar_settled
       from payments p left join contracts c on c.id = p.contract_id left join tenants t on t.id = c.tenant_id
      where ${where} order by ${order}${limit}`,
    params,
  );
  const invMap = await invoicesForPaymentsV2(q, scope, rows.map((r: any) => Number(r.id)));
  const data = rows.map((r: any) => ({
    id: r.id,
    contractId: r.contract_id,
    amount: r.amount,
    collectedAmount: toNum(r.collected),
    dueDate: r.due_date,
    paidDate: r.paid_date,
    status: displayStatus(r.status_v2),
    receiptNumber: r.receipt_number,
    attachmentKey: r.attachment_key,
    description: r.description,
    notes: r.notes,
    createdAt: r.created_at,
    vatEnabled: !!r.vat_enabled,
    contract: r.contract_number ? { contractNumber: r.contract_number, tenantName: r.tenant_name, tenantShortName: r.tenant_short_name, vatEnabled: !!r.contract_vat } : null,
    /** The invoice already covering this installment — the same rule as the legacy list (`invoicesForPayments`). */
    invoice: invMap.get(Number(r.id)) ?? null,
    // finance-v2 additions (flag on only)
    statusV2: r.status_v2,
    remaining: toNum(r.remaining),
    unverified: r.status_v2 === "paid_unverified",
    /** What Ejar reported part-paid on this row (settled outside Dara; not in `collectedAmount`). */
    ejarSettled: toNum(r.ejar_settled),
  }));
  if (!usePaginated) return data;

  const [totalRow] = await q.rows(
    `select count(*)::int as n from payments p left join contracts c on c.id = p.contract_id where ${where} and $2::date is not null`, params);
  const statParams = params.slice(0, statParamCount);
  const statsRows = await q.rows(
    `select s, count(*)::int as cnt, sum(amount)::text as amount, sum(remaining)::text as remaining from (
       select ${st} as s, p.amount, ${remainingSqlV2("p")} as remaining from payments p where ${statsWhere}) x group by s`,
    statParams,
  );
  const collParams: unknown[] = [scope];
  const PC = (v: unknown) => { collParams.push(v); return `$${collParams.length}`; };
  const collCf = cf ? `and (${contractFilterText(cf, "$1", "p.contract_id", PC)} or ${contractFilterText(cf, "$1", "si.contract_id", PC)})` : "";
  const [collectedRow] = await q.rows(
    `select coalesce(sum(pc.amount), 0)::text as amount from payment_collections pc
       left join payments p on p.id = pc.payment_id left join simple_invoices si on si.id = pc.invoice_id
      where pc.user_id = $1 and (pc.payment_id is null or p.deleted_at is null) ${collCf}`,
    collParams,
  );
  const freeParams: unknown[] = [scope];
  const PF = (v: unknown) => { freeParams.push(v); return `$${freeParams.length}`; };
  const freeCf = cf ? `and ${contractFilterText(cf, "$1", "si.contract_id", PF)}` : "";
  const [freeRow] = await q.rows(
    `select coalesce(sum(si.total), 0)::text as amount, count(*)::int as cnt from simple_invoices si
      where si.user_id = $1 and si.status = 'confirmed' and si.type = 'invoice' and si.payment_id is null and si.deleted_at is null
        and si.paid_date is not null and (si.kind is null or (si.kind <> 'deposit' and si.kind <> 'receipt'))
        and not exists (select 1 from payment_collections pc where pc.invoice_id = si.id)
        ${freeCf}`,
    freeParams,
  );
  const freeCollected = toNum(freeRow?.amount);
  const stats = {
    paid: 0, pending: 0, overdue: 0, cancelled: 0, partiallyPaid: 0,
    collected: toNum(Number(collectedRow?.amount ?? 0) + freeCollected),
    freeCollected, freeCollectedCount: Number(freeRow?.cnt ?? 0),
    paidCount: 0, pendingCount: 0, overdueCount: 0, cancelledCount: 0, partiallyPaidCount: 0,
    // Same key as the legacy list; under v2 `partiallyPaid` is already Σ remaining.
    partiallyPaidRemaining: 0,
    // finance-v2 additions
    unverified: 0, unverifiedCount: 0, writtenOff: 0, writtenOffCount: 0, settledExternal: 0, settledExternalCount: 0,
  };
  for (const s of statsRows) {
    const amt = toNum(s.amount);
    const rem = toNum(s.remaining);
    const n = Number(s.cnt);
    switch (s.s) {
      case "paid": stats.paid = toNum(stats.paid + amt); stats.paidCount += n; break;
      case "paid_unverified": stats.paid = toNum(stats.paid + amt); stats.paidCount += n; stats.unverified = amt; stats.unverifiedCount = n; break;
      case "pending": stats.pending = rem; stats.pendingCount = n; break;
      case "overdue": stats.overdue = rem; stats.overdueCount = n; break;
      case "partially_paid": stats.partiallyPaid = rem; stats.partiallyPaidRemaining = rem; stats.partiallyPaidCount = n; break;
      case "cancelled": stats.cancelled = toNum(stats.cancelled + amt); stats.cancelledCount += n; break;
      case "written_off": stats.writtenOff = amt; stats.writtenOffCount = n; break;
      case "settled_external": stats.settledExternal = amt; stats.settledExternalCount = n; break;
    }
  }
  return { data, page: lq.page, pageSize: lq.pageSize, total: Number(totalRow?.n ?? 0), stats };
}

/** Σ remaining of v2-overdue installments per tenant (E4, the arrears definition shared with the list). */
export async function overdueByTenantV2(q: Sql, scope: number, today = riyadhTodayV2()) {
  return q.rows(
    `select c.tenant_id, coalesce(c.tenant_name, t.name, '—') as tenant, sum(x.remaining)::text as amount, max($2::date - x.due_date)::int as days
       from (select p.contract_id, p.due_date, ${remainingSqlV2("p")} as remaining, ${liveStatusV2Sql("p", "$2::date")} as s
               from payments p where p.user_id = $1 and p.deleted_at is null and (p.description is null or p.description <> $3)) x
       join contracts c on c.id = x.contract_id left join tenants t on t.id = c.tenant_id
      where x.s = 'overdue' and x.remaining > 0.005
      group by c.tenant_id, coalesce(c.tenant_name, t.name, '—')`,
    [scope, today, DEPOSIT_DESC],
  );
}
