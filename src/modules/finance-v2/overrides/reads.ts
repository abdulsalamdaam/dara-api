/**
 * The v2 GET forks (DESIGN §9 E2, E3, E4, E5, E1 display). Each keeps the
 * legacy response SHAPE and changes only the values the bug decisions name;
 * it runs only for flag-on accounts (the legacy handler forks at its return).
 * Every query is scoped to the account (`user_id = scope`); money is exact
 * (numeric in SQL, halalas in TS).
 */
import { ejarSettledSqlV2, liveStatusV2Sql, remainingSqlV2, riyadhTodayV2 } from "../../../common/payment-status-v2";
import { effectiveFeeForProperty, effectiveManagementFee } from "../commission";
import { fromHalalas, toHalalas } from "../money";
import { overdueByTenantV2 } from "./payments-list";
import type { Sql } from "../hooks/sql";

export const DEPOSIT_DESC = "تأمين (وديعة)";
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const H = (v: unknown) => toHalalas(String(v ?? "0"));

/**
 * SQL (over `payments p` joined `contracts c`, `finance_contract_dims d`) for
 * an installment that is a CHARGE by today: due before Riyadh today ($today),
 * not cancelled / externally settled / a deposit row, not after its ended
 * contract's end, and not covered by a confirmed tenant charge document (the
 * document is the charge then). The same rule the recognizer charges by (§4.1).
 */
export const DUE_CHARGE_SQL = (today: string) => `p.deleted_at is null and c.deleted_at is null
  and p.due_date < ${today}
  and p.status::text not in ('cancelled','settled_external')
  and coalesce(p.description, '') <> '${DEPOSIT_DESC}'
  and not (c.status::text in ('terminated','cancelled') and d.ended_on is not null and p.due_date > d.ended_on)
  and not exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                    and si.type = 'invoice' and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
                    and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id)))`;

/**
 * E3: GET /reports/accounting under v2. `tenantStatement.invoiced` = confirmed
 * charge documents (as legacy) + installments charged by their due date with
 * no covering document − write-offs, so a tenant paid on receipt vouchers
 * with no invoice nets to 0, not −total. `tenantOverdue` uses the E4
 * definition (Riyadh today, Σ remaining). `revenue[].commissionPct` is the
 * E1 effective rate, with its `commissionSource`.
 */
export async function accountingV2(q: Sql, scope: number, legacy: any, today = riyadhTodayV2()): Promise<any> {
  // ── E3 ──
  const extra = await q.rows(
    `select c.tenant_id, coalesce(nullif(c.tenant_name, ''), t.name, '—') as tenant, sum(p.amount)::text as amount
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
       left join tenants t on t.id = c.tenant_id
      where p.user_id = $1 and ${DUE_CHARGE_SQL("$2::date")}
      group by 1, 2`,
    [scope, today],
  );
  const wo = await q.rows(
    `select w.tenant_id, coalesce(nullif(c.tenant_name, ''), t.name, '—') as tenant, sum(w.amount)::text as amount
       from finance_write_offs w left join contracts c on c.id = w.contract_id and c.user_id = w.user_id
       left join tenants t on t.id = w.tenant_id
      where w.user_id = $1 group by 1, 2`,
    [scope],
  );
  // What Ejar reported part-paid on a charged installment was paid outside Dara: E33 cleared it from AR.
  const ejar = await q.rows(
    `select c.tenant_id, coalesce(nullif(c.tenant_name, ''), t.name, '—') as tenant, sum(${ejarSettledSqlV2("p")})::text as amount
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
       left join tenants t on t.id = c.tenant_id
      where p.user_id = $1 and ${DUE_CHARGE_SQL("$2::date")}
      group by 1, 2 having sum(${ejarSettledSqlV2("p")}) > 0`,
    [scope, today],
  );
  const rows: any[] = (legacy.tenantStatement ?? []).map((r: any) => ({ ...r }));
  const byKey = new Map<string, any>(rows.map((r) => [r.key, r]));
  const bump = (tenantId: number | null, name: string, delta: number) => {
    const key = tenantId != null ? `t:${tenantId}` : `n:${name}`;
    let r = byKey.get(key);
    if (!r) {
      r = { key, tenantId, tenant: name, invoiced: 0, collected: 0, deposit: 0, balance: 0 };
      byKey.set(key, r);
      rows.push(r);
    }
    r.invoiced = r2(r.invoiced + delta);
  };
  for (const e of extra) bump(e.tenant_id ?? null, e.tenant, Number(fromHalalas(H(e.amount))));
  for (const w of wo) bump(w.tenant_id ?? null, w.tenant, -Number(fromHalalas(H(w.amount))));
  for (const e of ejar) bump(e.tenant_id ?? null, e.tenant, -Number(fromHalalas(H(e.amount))));
  for (const r of rows) r.balance = r2(r.invoiced - r.collected);
  rows.sort((a, b) => b.balance - a.balance);

  // ── E4 ──
  const overdue = (await overdueByTenantV2(q, scope, today)).map((o: any) => ({
    tenantId: o.tenant_id ?? null, tenant: o.tenant, amount: r2(Number(o.amount)), days: Number(o.days ?? 0),
  })).sort((a: any, b: any) => b.amount - a.amount);

  // ── E1 ──
  const revenue = [];
  for (const r of legacy.revenue ?? []) {
    const f = await effectiveFeeForProperty(q, scope, Number(r.propertyId));
    revenue.push({ ...r, commissionPct: f?.pct != null ? Number(f.pct) : 0, commissionSource: f?.source ?? null });
  }
  return { ...legacy, tenantStatement: rows, tenantOverdue: overdue, revenue };
}

/**
 * E2 + E4: GET /dashboard/summary under v2. Same shape. `monthlyRevenue` =
 * Σ collections (net of refunds, no deposits, no commission) dated in the
 * current Riyadh month; `revenueByMonth` the same per month of the Riyadh
 * year; `collectedTotal` all of them; overdue count / amount and `pendingDue`
 * from the E4 definition (Σ remaining). `monthlyRevenueBasis: "collections"`
 * tells the v2 card to read "Collections this month".
 */
export async function dashboardV2(q: Sql, scope: number, legacy: any, today = riyadhTodayV2()): Promise<any> {
  const year = Number(today.slice(0, 4));
  const month = today.slice(0, 7);
  const cols = await q.rows(
    `select to_char(pc.collected_date, 'YYYY-MM') as m, sum(pc.amount)::text as amount
       from payment_collections pc
       left join payments p on p.id = pc.payment_id
       left join simple_invoices si on si.id = pc.invoice_id
      where pc.user_id = $1
        and (pc.payment_id is null or (p.deleted_at is null and coalesce(p.description, '') <> $2))
        and (pc.payment_id is not null or si.id is null or coalesce(si.kind, 'invoice') not in ('deposit','commission'))
      group by 1`,
    [scope, DEPOSIT_DESC],
  );
  const months: number[] = Array(12).fill(0);
  let thisMonth = 0;
  let total = 0;
  for (const c of cols) {
    const amt = H(c.amount);
    total += amt;
    if (c.m === month) thisMonth += amt;
    if (Number(String(c.m).slice(0, 4)) === year) {
      const i = Number(String(c.m).slice(5, 7)) - 1;
      if (i >= 0 && i < 12) months[i] += amt;
    }
  }
  const [st] = await q.rows(
    `select count(*) filter (where s = 'overdue')::int as overdue_n,
            coalesce(sum(remaining) filter (where s = 'overdue'), 0)::text as overdue_amt,
            coalesce(sum(remaining) filter (where s in ('overdue','pending','partially_paid')), 0)::text as pending_amt
       from (select ${liveStatusV2Sql("p", "$2::date")} as s, ${remainingSqlV2("p")} as remaining
               from payments p where p.user_id = $1 and p.deleted_at is null and coalesce(p.description, '') <> $3) x`,
    [scope, today, DEPOSIT_DESC],
  );
  return {
    ...legacy,
    monthlyRevenue: Number(fromHalalas(thisMonth)),
    collectedTotal: Number(fromHalalas(total)),
    pendingDue: Number(fromHalalas(H(st?.pending_amt))),
    overduePaymentsCount: Number(st?.overdue_n ?? 0),
    overdueAmount: Number(fromHalalas(H(st?.overdue_amt))),
    revenueByMonth: { year, months: months.map((m) => Number(fromHalalas(m))) },
    monthlyRevenueBasis: "collections",
  };
}

/**
 * E5 (+ E1 display): GET /finance/v2/contracts/:id/summary.
 *  - billed:     confirmed tenant charge documents (invoices, debit notes, rent
 *                receipts, agency fees) − credit notes + installments charged
 *                by their due date with no covering document
 *  - collected:  Σ payment_collections of the contract — installment-linked
 *                plus invoice-linked through documents of the contract —
 *                excluding deposit rows, deposit vouchers and commission
 *  - writtenOff: Σ write-offs (E24)
 *  - settledExternal: charged installments settled outside Dara (E33): Ejar-
 *                paid rows whole (these are billed too) and the part Ejar
 *                reported paid on part-paid rows
 *  - outstanding = max(0, billed − collected − writtenOff − settledExternal); credit = the rest
 *  - overdue:    Σ remaining of v2-overdue installments (E4)
 *  - depositHeld: confirmed deposit vouchers' unlinked amounts − conversions
 *                + net collections on legacy deposit rows
 *  - commission: the effective management fee and its source (E1)
 */
export async function contractSummaryV2(q: Sql, scope: number, contractId: number, today = riyadhTodayV2()) {
  const [c] = await q.rows(`select id, contract_number from contracts where id = $1 and user_id = $2 and deleted_at is null`, [contractId, scope]);
  if (!c) return null;
  const [docs] = await q.rows(
    `select coalesce(sum(case when type = 'credit' then -total else total end), 0)::text as billed
       from simple_invoices where user_id = $1 and contract_id = $2 and status = 'confirmed' and deleted_at is null
        and coalesce(kind, 'invoice') in ('invoice','manual','rent_receipt','agency_fee')`,
    [scope, contractId],
  );
  const [due] = await q.rows(
    `select coalesce(sum(p.amount), 0)::text as amount
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where p.user_id = $1 and p.contract_id = $2 and ${DUE_CHARGE_SQL("$3::date")}`,
    [scope, contractId, today],
  );
  const [col] = await q.rows(
    `select coalesce(sum(pc.amount), 0)::text as amount from payment_collections pc
       left join payments p on p.id = pc.payment_id
       left join simple_invoices si on si.id = pc.invoice_id
      where pc.user_id = $1
        and ((pc.payment_id is not null and p.contract_id = $2 and p.deleted_at is null and coalesce(p.description, '') <> $3)
          or (pc.payment_id is null and si.contract_id = $2 and coalesce(si.kind, 'invoice') not in ('deposit','commission')))`,
    [scope, contractId, DEPOSIT_DESC],
  );
  const [wo] = await q.rows(`select coalesce(sum(amount), 0)::text as amount from finance_write_offs where user_id = $1 and contract_id = $2`, [scope, contractId]);
  // Settled outside Dara (E33): Ejar-paid rows whole, and what Ejar reported on part-paid rows, once they are charges.
  const [ext] = await q.rows(
    `select coalesce(sum(case when p.status::text = 'settled_external' then p.amount else ${ejarSettledSqlV2("p")} end), 0)::text as amount,
            coalesce(sum(p.amount) filter (where p.status::text = 'settled_external'), 0)::text as whole
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where p.user_id = $1 and p.contract_id = $2 and p.deleted_at is null and c.deleted_at is null
        and p.due_date < $3::date and coalesce(p.description, '') <> $4
        and not (c.status::text in ('terminated','cancelled') and d.ended_on is not null and p.due_date > d.ended_on)`,
    [scope, contractId, today, DEPOSIT_DESC],
  );
  const [od] = await q.rows(
    `select coalesce(sum(remaining), 0)::text as amount, count(*)::int as n from (
       select ${remainingSqlV2("p")} as remaining, ${liveStatusV2Sql("p", "$3::date")} as s from payments p
        where p.user_id = $1 and p.contract_id = $2 and p.deleted_at is null and coalesce(p.description, '') <> $4) x where s = 'overdue'`,
    [scope, contractId, today, DEPOSIT_DESC],
  );
  const [dep] = await q.rows(
    `select
       coalesce((select sum(si.total - coalesce((select sum(pc.amount) from payment_collections pc
                                                   where pc.invoice_id = si.id and pc.user_id = si.user_id), 0))
                   from simple_invoices si where si.user_id = $1 and si.contract_id = $2 and si.kind = 'deposit'
                    and si.status = 'confirmed' and si.deleted_at is null), 0)
     + coalesce((select sum(pc.amount) from payment_collections pc join payments p on p.id = pc.payment_id
                  where pc.user_id = $1 and p.contract_id = $2 and p.description = $3 and p.deleted_at is null), 0) as held`,
    [scope, contractId, DEPOSIT_DESC],
  );
  // An Ejar-paid row is charged at its due date too (and settled by E33): it is billed, and settled externally.
  const billed = H(docs.billed) + H(due.amount) + H(ext.whole);
  const collected = H(col.amount);
  const writtenOff = H(wo.amount);
  const settledExternal = H(ext.amount);
  const net = billed - collected - writtenOff - settledExternal;
  const fee = await effectiveManagementFee(q, scope, contractId);
  return {
    contractId, contractNumber: c.contract_number, asOf: today,
    billed: fromHalalas(billed),
    collected: fromHalalas(collected),
    writtenOff: fromHalalas(writtenOff),
    settledExternal: fromHalalas(settledExternal),
    outstanding: fromHalalas(Math.max(0, net)),
    credit: fromHalalas(Math.max(0, -net)),
    overdue: fromHalalas(H(od.amount)),
    overdueCount: Number(od.n ?? 0),
    depositHeld: fromHalalas(Math.max(0, H(dep.held))),
    commission: { pct: fee.pct, source: fee.source, propertyPct: fee.propertyPct, landlordPct: fee.landlordPct, propertyId: fee.propertyId, ownerId: fee.ownerId },
  };
}
