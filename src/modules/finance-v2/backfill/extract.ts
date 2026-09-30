/**
 * Backfill event extraction (DESIGN §6.3) and ordering (§6.4).
 *
 * Reads an account's existing records and returns the ledger events live
 * posting WOULD have produced, keyed exactly as the live hooks and the
 * recognizer key them, so a backfill and live posting can never double-post
 * (the outbox and the ledger are unique on the key). Facts are built by the
 * same loaders the hooks use (`hooks/facts-loader.ts`); only which events
 * exist, and when, is decided here.
 *
 * Read-only apart from `finance_contract_dims`, which `contractCtx` fills
 * lazily exactly as the hooks do (idempotent, v2 side table).
 */
import type { LedgerEvent } from "../ledger-emitter.service";
import { toHalalas, fromHalalas } from "../money";
import { lastDayOfMonth } from "../dates";
import type { Sql } from "../hooks/sql";
import {
  collectionEvents, contractCtx, depositRefundedEvent, documentEvents, expenseEvent, installmentFacts, INSTALLMENT_COLS, payoutEvent,
  reversalEvent, voucherUnlinked, type ContractCtx, type FinanceSettingsRow, type InstallmentRow,
} from "../hooks/facts-loader";
import { DEPOSIT_DESC, installmentNature, installmentVat } from "../hooks/classify";
import { coverageWindow, monthsBetween } from "../recognizer.service";
import type { ReleaseFacts, RuleCode } from "../rules";
import { depositForfeitEvent } from "../hooks/facts-loader";
import { creditActionEvents, writeOffEvents } from "../tier1/credit-events";
import { billEvents, supplierPaymentEvents } from "../tier3/ap-events";
import { assetEvents } from "../assets/asset-events";

export interface PlannedEvent extends LedgerEvent {
  /** §6.4 rank within a business date. */
  rank: number;
  /** The source row's creation time (ISO), the third sort key. */
  sourceCreatedAt: string;
  /** Order of events that share one source (a collection before its advance VAT). */
  sub: number;
  /** The rule code, or 'reversal'. */
  code: string;
}

export interface ExtractOptions {
  /** Riyadh "today": due-date charges and releases are extracted strictly before it (§5.6). */
  today: string;
  /** Cutover: only events with a business date on or after this (§6.2). */
  from?: string | null;
  /** Opening-proposal simulation: only events with a business date strictly before this. */
  upTo?: string | null;
}

export interface Note {
  count: number;
  sample: Array<{ sourceType: string; sourceId: number; date?: string }>;
}

export interface ExtractResult {
  events: PlannedEvent[];
  /** Extraction-level findings for the dry-run report (cancelled_history, paid_without_collection, covered_by_opening). */
  notes: Record<string, Note>;
}

/**
 * §6.4 rank of an event within one business date:
 * 1 charges (documents, then due-date charges, then external settlements),
 * 2 deposits received, 3 collections (+ their advance VAT), 4 notes,
 * 5 commission, 6 refunds, 7 conversions, forfeits and charge cancellations,
 * 8 expenses, payouts, supplier bills and reversals (supplier payments just after,
 * 8.5), 9 releases and the VAT settlement.
 * The fractional part orders the three kinds of charge within rank 1.
 */
export function rankOf(code: string): number {
  switch (code) {
    case "E01": case "E07": case "E08": case "E17": return 1;
    case "E02": return 1.1;
    case "E33": return 1.2;
    case "E09": return 2;
    case "E03": case "E09C": case "E12B": case "E34": return 3;
    case "E06": case "E36": return 4;
    case "E15": case "E16": return 5;
    case "E04": case "E10": case "E20": return 6;
    case "E05": case "E11": case "E12": case "E24": return 7;
    case "E14": case "E18": case "E19": case "E21": case "E28": case "E38": case "reversal": return 8;
    case "E39": return 8.5;
    case "FA01": return 8; // fixed-asset acquisition
    case "FA03": return 8.7; // disposal: after the reversals of that day
    case "FA02": return 9; // depreciation at the month end, with the releases
    case "E35": case "E37": return 9;
    default: return 8;
  }
}

/** The §6.4 sort: (business date, rank, source created_at, source id, sub). */
export function compareEvents(a: PlannedEvent, b: PlannedEvent): number {
  return a.occurredOn.localeCompare(b.occurredOn)
    || a.rank - b.rank
    || a.sourceCreatedAt.localeCompare(b.sourceCreatedAt)
    || a.sourceType.localeCompare(b.sourceType)
    || a.sourceId - b.sourceId
    || a.sub - b.sub;
}

export const keyOf = (e: { sourceType: string; sourceId: number; event: string }) => `${e.sourceType}|${e.sourceId}|${e.event}`;

const CHARGE_DOC_KINDS = "('invoice','manual','rent_receipt')";

function note(notes: Record<string, Note>, code: string, x: { sourceType: string; sourceId: number; date?: string }) {
  const n = (notes[code] ??= { count: 0, sample: [] });
  n.count++;
  if (n.sample.length < 10) n.sample.push(x);
}

export async function extractEvents(q: Sql, userId: number, s: FinanceSettingsRow, opts: ExtractOptions): Promise<ExtractResult> {
  const events: PlannedEvent[] = [];
  const notes: Record<string, Note> = {};
  const inRange = (d: string) => (!opts.from || d >= opts.from) && (!opts.upTo || d < opts.upTo);
  const ctxCache = new Map<number, ContractCtx | null>();
  const ctxOf = async (cid: number | null | undefined) => {
    if (!cid) return null;
    if (!ctxCache.has(cid)) ctxCache.set(cid, await contractCtx(q, userId, s.mode, cid));
    return ctxCache.get(cid) ?? null;
  };
  const push = (e: LedgerEvent, createdAt: string, sub = 0, rankOverride?: number) => {
    if (!inRange(e.occurredOn)) return;
    const code = e.event.startsWith("reversal:") ? "reversal" : String((e.payload as any)?.rule ?? "reversal");
    events.push({ ...e, rank: rankOverride ?? rankOf(code), sourceCreatedAt: createdAt, sub, code });
  };

  // Installment dues, used to skip documents that only cover installments the cutover opening already charged.
  const dueOf = new Map<number, string>();
  if (opts.from) {
    for (const r of await q.rows(`select id, to_char(due_date,'YYYY-MM-DD') as due from payments where user_id = $1`, [userId])) dueOf.set(Number(r.id), r.due);
  }

  // ── Documents (E01/E06/E07/E08/E15/E17/E36, deposit vouchers E09 + E10) ──
  const docs = await q.rows(
    `select si.id, si.kind, si.status::text as status, si.created_at::text as created, si.contract_id,
            c.deposit_status, to_char(c.updated_at at time zone 'Asia/Riyadh','YYYY-MM-DD') as contract_updated
       from simple_invoices si left join contracts c on c.id = si.contract_id and c.user_id = si.user_id
      where si.user_id = $1 and si.deleted_at is null
        and (si.status = 'confirmed' or (si.kind = 'deposit' and si.status = 'cancelled' and c.deposit_status = 'returned'))
      order by si.id`,
    [userId],
  );
  for (const d of docs) {
    const evs = await documentEvents(q, userId, s, Number(d.id), { includeReturnedDeposit: true });
    for (const e of evs) {
      const pids = (e.payload as any).paymentIds as number[] | undefined;
      if (opts.from && pids?.length && e.event === "confirmed" && pids.every((p) => (dueOf.get(p) ?? "9999") < opts.from!)) {
        if (inRange(e.occurredOn)) note(notes, "covered_by_opening", { sourceType: "simple_invoice", sourceId: Number(d.id), date: e.occurredOn });
        continue;
      }
      push(e, d.created);
    }
    // A returned deposit voucher: E10 from the v2 refund record, else at an inferred date.
    if (d.kind === "deposit" && d.status === "cancelled") {
      const unlinked = (await voucherUnlinked(q, userId, [Number(d.id)])).get(Number(d.id)) ?? 0;
      if (unlinked <= 0) continue;
      const ctx = await ctxOf(d.contract_id);
      const [ref] = await q.rows(
        `select amount::text as amount, to_char(refunded_on,'YYYY-MM-DD') as on, method, cardinality(voucher_ids) as n, bank_account_id
           from finance_deposit_refunds where user_id = $1 and $2 = any(voucher_ids) order by id limit 1`,
        [userId, Number(d.id)],
      );
      let date: string;
      let amount = unlinked;
      const warn: string[] = [];
      if (ref) {
        date = ref.on;
        if (Number(ref.n) === 1) amount = toHalalas(ref.amount);
      } else {
        date = ctx?.endedOn ?? d.contract_updated;
        warn.push("inferred_date");
      }
      const e = depositRefundedEvent(Number(d.id), amount, ctx, date, ref?.method ?? null, s, ref?.bank_account_id ?? null);
      (e.payload as any).facts.warnings = [...((e.payload as any).facts.warnings ?? []), ...warn];
      push(e, d.created);
    }
  }

  // ── Collections (E03/E04/E09C/E12/E12B/E16 + E34), classified like live posting ──
  const cols = await q.rows(`select id, created_at::text as created from payment_collections where user_id = $1 order by id`, [userId]);
  const colCreated = new Map<number, string>(cols.map((r: any) => [Number(r.id), r.created]));
  for (let i = 0; i < cols.length; i += 500) {
    const ids = cols.slice(i, i + 500).map((r: any) => Number(r.id));
    const evs = await collectionEvents(q, userId, s, ids);
    let prevRank = 3;
    for (const e of evs) {
      const rule = (e.payload as any).rule as RuleCode;
      // E34 follows its own collection (same rank, sub 1).
      const rank = rule === "E34" ? prevRank : rankOf(rule);
      prevRank = rank;
      push(e, colCreated.get(e.sourceId) ?? "", rule === "E34" ? 1 : 0, rank);
    }
  }

  // ── Installments: due-date charges (E02), external settlements (E33), releases (E35) ──
  const pays = await q.rows<InstallmentRow & { created: string; doc_date: string | null; collected: string; has_col: boolean;
    c_status: string; ended: string | null; charge_events: number; written_off: boolean; ejar_reported: string | null; ejar_partial_posted: string | null }>(
    `select ${INSTALLMENT_COLS}, p.created_at::text as created, c.status::text as c_status,
            to_char(coalesce(d.ended_on, case when c.status::text in ('terminated','cancelled') then (c.updated_at at time zone 'Asia/Riyadh')::date end),'YYYY-MM-DD') as ended,
            (select to_char(min(coalesce(si.issue_date, (si.confirmed_at at time zone 'Asia/Riyadh')::date)),'YYYY-MM-DD')
               from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                and si.type = 'invoice' and coalesce(si.kind, 'invoice') in ${CHARGE_DOC_KINDS}
                and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id))) as doc_date,
            (select coalesce(sum(pc.amount), 0)::text from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id) as collected,
            exists (select 1 from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id) as has_col,
            exists (select 1 from finance_write_offs w where w.user_id = p.user_id and p.id = any(w.payment_ids)) as written_off,
            (select es.reported_amount::text from finance_ejar_settlements es where es.payment_id = p.id and es.user_id = p.user_id
                and es.reported_status = 'partially_paid') as ejar_reported,
            (select o.payload->'facts'->>'amount' from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment'
                and o.source_id = p.id and o.event = 'ejar_partial' and o.status in ('pending','posted','failed')
                and not exists (select 1 from ledger_outbox r where r.user_id = o.user_id and r.source_type = 'payment' and r.source_id = o.source_id
                                 and r.event = 'reversal:ejar_partial')) as ejar_partial_posted,
            (select count(*)::int from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                and o.event ~ '^charge(:g[0-9]+)?$') as charge_events
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where p.user_id = $1 and p.deleted_at is null and c.deleted_at is null and p.due_date < $2::date
      order by p.due_date, p.id`,
    [userId, opts.today],
  );
  for (const p of pays) {
    if ((p.description ?? "") === DEPOSIT_DESC || installmentNature(p.description) === "deposit") continue;
    // A written-off row is stored cancelled, but live posting charged it (E02, or the write-off's own charge) before E24 cleared it.
    if (p.status === "cancelled" && !p.written_off) {
      if (!p.has_col) {
        // Charged at its due date and cancelled when the contract ended nets to nothing: nothing to post.
        note(notes, "cancelled_history", { sourceType: "payment", sourceId: p.id, date: p.due });
        continue;
      }
      // Money was collected on it before it was cancelled at the contract's end. Live posting charged it at its due
      // date (so the collection settled AR, with no advance VAT) and reversed the charge at the end (E05), leaving the
      // money as the tenant's credit. Skipping both would book the collection as an advance, with advance VAT.
      if (p.ended && !(opts.from && p.due < opts.from)) {
        const byDoc = p.doc_date != null && p.doc_date <= p.due;
        const ctx = await ctxOf(p.contract_id);
        const f = installmentFacts(p, ctx, s, p.due);
        const fEnd = installmentFacts(p, ctx, s, p.ended);
        if (f && fEnd && !byDoc) {
          if (p.due < p.ended && Number(p.charge_events) === 0) {
            push({ sourceType: "payment", sourceId: p.id, event: "charge", occurredOn: p.due, payload: { rule: "E02", facts: f, paymentIds: [p.id] } }, p.created);
          }
          // E05 also reverses advance VAT its collections booked when it was never charged.
          push({ sourceType: "payment", sourceId: p.id, event: "charge_cancelled", occurredOn: p.ended, payload: { rule: "E05", facts: fEnd, paymentIds: [p.id] } }, p.created);
        }
      }
      continue;
    }
    if (p.ended && p.due > p.ended) continue;
    if (opts.from && p.due < opts.from) continue;
    if (p.status === "paid" && toHalalas(p.collected) < toHalalas(p.amount) && inRange(p.due)) {
      note(notes, "paid_without_collection", { sourceType: "payment", sourceId: p.id, date: p.due });
    }
    const ctx = await ctxOf(p.contract_id);
    const f = installmentFacts(p, ctx, s, p.due);
    if (!f) continue;
    // Charged by a document that existed by the due date → E01 charges it; a later document reverse-and-replaces E02.
    const byDocument = p.doc_date != null && p.doc_date <= p.due;
    if (!byDocument && Number(p.charge_events) === 0) {
      push({ sourceType: "payment", sourceId: p.id, event: "charge", occurredOn: p.due, payload: { rule: "E02", facts: f, paymentIds: [p.id] } }, p.created);
    }
    if (p.status === "settled_external") {
      const before = p.ejar_partial_posted ?? null; // live posting settled a part Ejar reported before the row was settled whole
      const fs = before ? { ...f, settledBefore: before } : f;
      push({ sourceType: "payment", sourceId: p.id, event: "settled_external", occurredOn: p.due, payload: { rule: "E33", facts: fs, paymentIds: [p.id] } }, p.created);
    } else if (p.ejar_reported != null && toHalalas(p.ejar_reported) > 0) {
      // A part payment Ejar reported (§9 E7): E33 settles the reported amount only, at the due date.
      push({ sourceType: "payment", sourceId: p.id, event: "ejar_partial", occurredOn: p.due,
        payload: { rule: "E33", facts: { ...f, amount: p.ejar_reported }, paymentIds: [p.id] } }, p.created);
    }
    // Straight-line releases for principal rent (§4.1), every passed month-end inside the window.
    if (s.deferRent && ctx && ctx.treatment === "principal" && installmentNature(p.description) === "rent") {
      const w = await coverageWindow(q, userId, p, ctx);
      if (!w) continue;
      const category = installmentVat({ vatEnabled: p.vat_enabled === true, usage: ctx.usage, sellerRegistered: ctx.sellerRegistered }).category;
      for (const month of monthsBetween(w.start, w.end)) {
        const [y, m] = month.split("-").map(Number);
        const monthEnd = `${month}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
        const date = monthEnd < w.end ? monthEnd : w.end;
        if (!(date < opts.today)) break;
        const facts: ReleaseFacts = {
          date, treatment: "principal",
          dims: { ownerId: ctx.ownerId, propertyId: ctx.propertyId, unitId: ctx.unitId, tenantId: ctx.tenantId, contractId: ctx.contractId, paymentId: p.id },
          warnings: ctx.warnings, paymentId: p.id, month, windowStart: w.start, windowEnd: w.end, category, usage: ctx.usage,
        };
        push({ sourceType: "payment", sourceId: p.id, event: `release:${month}`, occurredOn: date, payload: { rule: "E35", facts, paymentIds: [p.id] } }, p.created);
      }
    }
  }

  // ── Cancelled installments not yet due that carry collections (prepaid, then cancelled at the contract's end):
  //    live posting's E05 reversed the advance VAT those collections booked ──
  const laterCancelled = await q.rows<InstallmentRow & { created: string; ended: string | null }>(
    `select ${INSTALLMENT_COLS}, p.created_at::text as created,
            to_char(coalesce(d.ended_on, case when c.status::text in ('terminated','cancelled') then (c.updated_at at time zone 'Asia/Riyadh')::date end),'YYYY-MM-DD') as ended
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
       left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where p.user_id = $1 and p.deleted_at is null and c.deleted_at is null and p.due_date >= $2::date and p.status::text = 'cancelled'
        and exists (select 1 from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id)
        and not exists (select 1 from finance_write_offs w where w.user_id = p.user_id and p.id = any(w.payment_ids))
      order by p.due_date, p.id`,
    [userId, opts.today],
  );
  for (const p of laterCancelled) {
    if (!p.ended || (p.description ?? "") === DEPOSIT_DESC || installmentNature(p.description) === "deposit") continue;
    const fEnd = installmentFacts(p, await ctxOf(p.contract_id), s, p.ended);
    if (fEnd) push({ sourceType: "payment", sourceId: p.id, event: "charge_cancelled", occurredOn: p.ended, payload: { rule: "E05", facts: fEnd, paymentIds: [p.id] } }, p.created);
  }

  // ── Deposits forfeited with no conversion collection (E11), at an inferred date ──
  const forfeits = await q.rows(
    `select c.id, c.created_at::text as created, to_char(c.updated_at at time zone 'Asia/Riyadh','YYYY-MM-DD') as updated
       from contracts c
      where c.user_id = $1 and c.deleted_at is null and c.deposit_status = 'forfeited'
        and not exists (select 1 from payment_collections pc join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
                         where pc.user_id = c.user_id and si.contract_id = c.id and si.kind = 'deposit' and pc.payment_id is null)
      order by c.id`,
    [userId],
  );
  for (const c of forfeits) {
    const ctx = await ctxOf(Number(c.id));
    if (!ctx) continue;
    const e = await depositForfeitEvent(q, userId, s, ctx, ctx.endedOn ?? c.updated);
    if (!e) continue;
    (e.payload as any).facts.warnings = [...((e.payload as any).facts.warnings ?? []), "inferred_date"];
    push(e, c.created);
  }

  // ── Expenses (E18 rev:<n>) and landlord payouts (E19) ──
  for (const x of await q.rows(`select id, created_at::text as created from expenses where user_id = $1 and deleted_at is null order by id`, [userId])) {
    const e = await expenseEvent(q, userId, s, Number(x.id));
    if (e) push(e, x.created);
  }
  for (const x of await q.rows(`select id, created_at::text as created from landlord_payouts where user_id = $1 and deleted_at is null order by id`, [userId])) {
    const e = await payoutEvent(q, userId, s, Number(x.id));
    if (e) push(e, x.created);
  }

  // ── v2-only money records (§6.3 "v2 tables"): write-offs (E24) and tenant credit refunds / applications (E20 / E21) ──
  for (const x of await q.rows(`select id from finance_write_offs where user_id = $1 order by id`, [userId])) {
    const r = await writeOffEvents(q, userId, s, Number(x.id));
    for (const e of r?.events ?? []) push(e, r!.createdAt);
  }
  for (const x of await q.rows(`select id from tenant_credit_actions where user_id = $1 order by id`, [userId])) {
    const r = await creditActionEvents(q, userId, s, Number(x.id));
    for (const e of r?.events ?? []) push(e, r!.createdAt);
  }

  // ── Tier 3 AP (§8.4): approved supplier bills (E38) and supplier payments (E39), with the reversal of a voided one ──
  if (await hasTable(q, "supplier_bills")) {
    for (const x of await q.rows(`select id from supplier_bills where user_id = $1 and approved_at is not null order by id`, [userId])) {
      const r = await billEvents(q, userId, s, Number(x.id));
      for (const e of r?.events ?? []) push(e, r!.createdAt);
    }
    for (const x of await q.rows(`select id from supplier_payments where user_id = $1 order by id`, [userId])) {
      const r = await supplierPaymentEvents(q, userId, s, Number(x.id));
      for (const e of r?.events ?? []) push(e, r!.createdAt);
    }
  }

  // ── Fixed assets (§8.5): acquisition (FA01), depreciation through the last ended month (FA02), disposal (FA03), void reversals ──
  if (await hasTable(q, "fixed_assets")) {
    for (const x of await q.rows(`select id from fixed_assets where user_id = $1 order by id`, [userId])) {
      const r = await assetEvents(q, userId, Number(x.id), opts.today);
      for (const e of r?.events ?? []) push(e, r!.createdAt);
    }
  }

  // ── Deleted sources whose entry is posted and not reversed: the missing reversal (catch-up, §6.3) ──
  const orphans = await q.rows(
    `select e.source_type, e.source_id::int as source_id, e.event, coalesce(x.deleted_on, to_char(e.entry_date,'YYYY-MM-DD')) as date,
            coalesce(x.created, '') as created
       from journal_entries e
       join lateral (
         select to_char(ex.deleted_at at time zone 'Asia/Riyadh','YYYY-MM-DD') as deleted_on, ex.created_at::text as created
           from expenses ex where e.source_type = 'expense' and ex.id = e.source_id and ex.user_id = e.user_id and ex.deleted_at is not null
         union all
         select to_char(lp.deleted_at at time zone 'Asia/Riyadh','YYYY-MM-DD'), lp.created_at::text
           from landlord_payouts lp where e.source_type = 'landlord_payout' and lp.id = e.source_id and lp.user_id = e.user_id and lp.deleted_at is not null
         union all
         select to_char(si.deleted_at at time zone 'Asia/Riyadh','YYYY-MM-DD'), si.created_at::text
           from simple_invoices si where e.source_type = 'simple_invoice' and e.event = 'confirmed' and si.id = e.source_id and si.user_id = e.user_id
            and si.deleted_at is not null
       ) x on true
      where e.user_id = $1 and e.status = 'posted' and e.origin <> 'reversal' and e.event !~ '^reversal:'
        and (e.source_type in ('expense','landlord_payout') or e.event = 'confirmed')`,
    [userId],
  );
  for (const o of orphans) {
    const date = o.date > opts.today ? opts.today : o.date;
    push(reversalEvent(o.source_type, Number(o.source_id), o.event, date, { reason: "deleted_source" }), o.created);
  }

  events.sort(compareEvents);
  return { events, notes };
}

/** Whether an (optional, later-migration) table exists in the search path. */
async function hasTable(q: Sql, name: string): Promise<boolean> {
  const [r] = await q.rows(`select to_regclass($1) is not null as ok`, [name]);
  return r?.ok === true;
}

/** Amount formatting helper for reports. */
export const money = (h: number) => fromHalalas(h);
