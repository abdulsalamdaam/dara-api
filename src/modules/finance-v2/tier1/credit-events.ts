/**
 * Ledger events of the v2-only money records (DESIGN §6.3 "v2 tables"): tenant
 * credit refunds and applications (E20 / E21) and write-offs (E24). One
 * builder per record, used by the live path AND the backfill/catch-up
 * extraction, so both key and freeze the event identically.
 *
 * Keys: `tenant_credit_action,<id>,refund|apply` (§4.4 E20/E21) and
 * `write_off,<id>,posted`; a voided action adds `reversal:<event>`.
 */
import type { LedgerEvent } from "../ledger-emitter.service";
import type { Sql } from "../hooks/sql";
import { contractCtx, dimsOf, reversalEvent, type FinanceSettingsRow } from "../hooks/facts-loader";
import { resolveTreatment, type CreditApplyFacts, type MoneyFacts } from "../rules";
import { writeOffEvent } from "../overrides/terminate";
import { fromHalalas, toHalalas } from "../money";

export async function creditActionEvents(q: Sql, userId: number, s: FinanceSettingsRow, actionId: number): Promise<{ events: LedgerEvent[]; createdAt: string } | null> {
  const [a] = await q.rows(
    `select a.id, a.kind, a.tenant_id, a.contract_id, a.owner_id, a.amount::text as amount, to_char(a.action_on,'YYYY-MM-DD') as action_on,
            a.bank_account_id, a.method, a.reference, a.number, a.status, a.target_document_id, a.created_at::text as created,
            t.target_payment_id, t.target_contract_id,
            (select si.contract_id from simple_invoices si where si.id = a.target_document_id and si.user_id = a.user_id) as doc_contract,
            (select to_char(o.occurred_on,'YYYY-MM-DD') from ledger_outbox o where o.user_id = a.user_id and o.source_type = 'tenant_credit_action'
                and o.source_id = a.id and o.event like 'reversal:%' order by o.id limit 1) as voided_on
       from tenant_credit_actions a left join tenant_credit_targets t on t.action_id = a.id and t.user_id = a.user_id
      where a.id = $1 and a.user_id = $2`,
    [actionId, userId],
  );
  if (!a) return null;
  const src = a.contract_id ? await contractCtx(q, userId, s.mode, Number(a.contract_id)) : null;
  const t = src ? { treatment: src.treatment, warnings: src.warnings, ownerId: src.ownerId } : resolveTreatment(s.mode, null);
  const dims = dimsOf(src, { tenantId: a.tenant_id ?? src?.tenantId ?? null, ownerId: src?.ownerId ?? a.owner_id ?? null });
  const amount = fromHalalas(toHalalas(a.amount));
  const events: LedgerEvent[] = [];
  const event = a.kind === "refund" ? "refund" : "apply";
  if (a.kind === "refund") {
    const facts: MoneyFacts = {
      date: a.action_on, treatment: t.treatment, dims, warnings: [...t.warnings], memo: a.number ? `سند صرف ${a.number} · Payment voucher ${a.number}` : null,
      amount, bank: { bankAccountId: a.bank_account_id ?? null, method: a.method ?? null },
    };
    events.push({ sourceType: "tenant_credit_action", sourceId: a.id, event, occurredOn: a.action_on, payload: { rule: "E20", facts } });
  } else {
    const targetContract: number | null = a.target_contract_id ?? a.doc_contract ?? null;
    const tgt = targetContract ? (targetContract === a.contract_id ? src : await contractCtx(q, userId, s.mode, Number(targetContract))) : src;
    const facts: CreditApplyFacts = {
      date: a.action_on, treatment: t.treatment, dims, warnings: [...t.warnings], memo: null, amount,
      targetDims: dimsOf(tgt, { tenantId: a.tenant_id ?? tgt?.tenantId ?? null, paymentId: a.target_payment_id ?? null, documentId: a.target_document_id ?? null }),
      sameContract: (tgt?.contractId ?? null) === (src?.contractId ?? null),
      sameLandlord: (tgt?.ownerId ?? null) === (src?.ownerId ?? null),
    };
    events.push({ sourceType: "tenant_credit_action", sourceId: a.id, event, occurredOn: a.action_on, payload: { rule: "E21", facts } });
  }
  if (a.status === "void") {
    const date = a.voided_on ?? a.action_on;
    events.push(reversalEvent("tenant_credit_action", a.id, event, date < a.action_on ? a.action_on : date, { reason: "voided" }));
  }
  return { events, createdAt: a.created };
}

export async function writeOffEvents(q: Sql, userId: number, s: FinanceSettingsRow, id: number): Promise<{ events: LedgerEvent[]; createdAt: string } | null> {
  const [w] = await q.rows(
    `select id, contract_id, payment_ids, amount::text as amount, to_char(written_off_on,'YYYY-MM-DD') as on, created_at::text as created
       from finance_write_offs where id = $1 and user_id = $2`,
    [id, userId],
  );
  if (!w) return null;
  const ctx = w.contract_id ? await contractCtx(q, userId, s.mode, Number(w.contract_id)) : null;
  const pids: number[] = (w.payment_ids ?? []).map(Number);
  return { events: [writeOffEvent(Number(w.id), fromHalalas(toHalalas(w.amount)), w.on, ctx, s, pids.length === 1 ? pids[0] : null)], createdAt: w.created };
}
