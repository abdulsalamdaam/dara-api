/**
 * "Due but not invoiced": the one rule behind both the auto-invoice list
 * (auto-invoice.service.ts, DESIGN §8.6) and the accountant's control check
 * #19 (reports/control-checks.ts R19), so the two never disagree about which
 * installments count.
 *
 * An installment counts unless it is deleted (or its contract is), belongs to
 * a draft contract or is a demo row, is cancelled or Ejar-settled
 * (`settled_external`: Ejar issues those), is the deposit row, falls before
 * the ledger go-live (it is in the opening balance), falls after an ended
 * contract's end, or is covered by a confirmed tax invoice / manual invoice /
 * rent receipt (linked by payment_id or payment_ids).
 *
 * Aliases the caller must provide: p = payments, c = contracts,
 * d = finance_contract_dims (left join on the contract). The due-date cutoff
 * is the caller's (the list: due on or before today; R19: its as-of rule).
 */
export function dueNotInvoicedSql(o: { depositParam: string; goLive: string }): string {
  return `p.deleted_at is null and c.deleted_at is null
          and not c.is_draft and not p.is_demo
          and p.status::text not in ('cancelled','settled_external')
          and coalesce(p.description, '') <> ${o.depositParam}
          and (${o.goLive} is null or p.due_date >= ${o.goLive})
          and not (c.status::text in ('terminated','cancelled')
                   and p.due_date > coalesce(d.ended_on, (c.updated_at at time zone 'Asia/Riyadh')::date))
          and not exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                            and si.type = 'invoice' and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
                            and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id)))`;
}
