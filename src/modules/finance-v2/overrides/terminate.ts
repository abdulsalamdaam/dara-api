/**
 * E7 (DESIGN §4.6, §9): ending a contract under v2 gives EVERY open
 * installment an honest disposition, before the legacy terminate writes:
 *
 *  - `collect`   record the remaining as a real collection (date, method,
 *                bank account) → E03;
 *  - `write_off` (approve capability) a `finance_write_offs` row → E24; the
 *                row is charged first when it is past due and not yet charged
 *                (E02), and becomes `cancelled` so E05 skips it (`written_off`);
 *  - `cancel`    the row becomes `cancelled` → E05 for a due-date charge.
 *                Refused for a row on a confirmed charge document (issue a
 *                credit note).
 *
 * A body that leaves an open row without a disposition is refused (400
 * FINANCE_V2_DISPOSITION_REQUIRED, listing the rows with a suggestion);
 * legacy `mode:"cancelled"` with no list means "cancel" for every row. The
 * legacy terminate then runs as before on rows that are no longer open.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { remainingSqlV2, riyadhTodayV2 } from "../../../common/payment-status-v2";
import { collectionEvents, contractCtx, dimsOf, installmentFacts, installmentRows, loadSettings, type FinanceSettingsRow } from "../hooks/facts-loader";
import type { LedgerEvent } from "../ledger-emitter.service";
import { fromHalalas, toHalalas } from "../money";
import type { MoneyFacts } from "../rules";
import { DEPOSIT_DESC } from "./reads";
import type { Sql } from "../hooks/sql";

export type DispositionAction = "collect" | "write_off" | "cancel";
export interface Disposition {
  paymentId: number;
  action: DispositionAction;
  date?: string;
  method?: string;
  bankAccountId?: number | null;
  reason?: string;
}

export interface OpenInstallment {
  paymentId: number;
  dueDate: string;
  amount: string;
  collected: string;
  remaining: string;
  charged: boolean;
  invoiced: boolean;
  pastDue: boolean;
  suggested: DispositionAction;
  allowed: DispositionAction[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = new Set(["cash", "bank_transfer", "cheque", "card", "mada", "sadad", "ejar", "other"]);

/** GET /finance/v2/contracts/:id/open-installments — the End-contract dialog's list. */
export async function openInstallments(q: Sql, scope: number, contractId: number, endDate?: string): Promise<OpenInstallment[]> {
  const today = riyadhTodayV2();
  const end = endDate && ISO.test(endDate) ? endDate : today;
  const rows = await q.rows(
    `select p.id, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount,
            coalesce((select sum(pc.amount) from payment_collections pc where pc.payment_id = p.id and pc.user_id = p.user_id), 0)::text as collected,
            ${remainingSqlV2("p")}::text as remaining,
            (exists (select 1 from finance_installment_charges ch where ch.payment_id = p.id and ch.user_id = p.user_id and ch.reversed_at is null)
             or exists (select 1 from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                          and o.event ~ '^charge(:g[0-9]+)?$' and o.status in ('pending','failed'))) as charged,
            exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                      and si.type = 'invoice' and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
                      and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id))) as invoiced
       from payments p
      where p.user_id = $1 and p.contract_id = $2 and p.deleted_at is null and coalesce(p.description, '') <> $3
        and p.status::text in ('pending','overdue','partially_paid')
        and ${remainingSqlV2("p")} > 0.005
      order by p.due_date, p.id`,
    [scope, contractId, DEPOSIT_DESC],
  );
  return rows.map((r: any) => {
    const pastDue = r.due < today;
    const allowed: DispositionAction[] = ["collect"];
    if (r.charged || pastDue) allowed.push("write_off");
    if (!r.invoiced) allowed.push("cancel");
    const suggested: DispositionAction = r.due > end ? (r.invoiced ? "write_off" : "cancel") : "collect";
    return {
      paymentId: Number(r.id), dueDate: r.due, amount: fromHalalas(toHalalas(r.amount)), collected: fromHalalas(toHalalas(r.collected)),
      remaining: fromHalalas(toHalalas(r.remaining)), charged: r.charged === true, invoiced: r.invoiced === true, pastDue,
      suggested: allowed.includes(suggested) ? suggested : "collect", allowed,
    };
  });
}

function parseDispositions(body: any): Disposition[] | null {
  if (!Array.isArray(body?.dispositions)) return null;
  return body.dispositions.map((d: any) => ({
    paymentId: Number(d?.paymentId),
    action: d?.action,
    date: typeof d?.date === "string" ? d.date : undefined,
    method: typeof d?.method === "string" ? d.method : undefined,
    bankAccountId: d?.bankAccountId == null ? null : Number(d.bankAccountId),
    reason: typeof d?.reason === "string" ? d.reason.slice(0, 500) : undefined,
  }));
}

export interface DispositionResult {
  collected: number[];
  writtenOff: number[];
  cancelled: number[];
  events: LedgerEvent[];
}

/**
 * Validate and apply the dispositions (flag on only), inside `q`'s
 * transaction. Throws before writing anything when the body is incomplete or
 * a choice is not allowed. Returns the ledger events to enqueue.
 */
export async function applyDispositions(
  q: Sql, scope: number, contractId: number, body: any, actor: { id: number; canApprove: boolean },
): Promise<DispositionResult> {
  const [c] = await q.rows(`select id, tenant_id from contracts where id = $1 and user_id = $2 and deleted_at is null`, [contractId, scope]);
  if (!c) throw new NotFoundException("Contract not found");
  const today = riyadhTodayV2();
  const open = await openInstallments(q, scope, contractId, today);
  const out: DispositionResult = { collected: [], writtenOff: [], cancelled: [], events: [] };
  if (!open.length) return out;

  // Explicit choices win; legacy `mode:"cancelled"` supplies "cancel" for every
  // other row that is untouched (no money, no confirmed document) — exactly the
  // rows legacy cancels. A part-collected or invoiced row always needs a choice.
  const list: Disposition[] = parseDispositions(body) ?? [];
  const byId = new Map(list.map((d) => [d.paymentId, d]));
  if (body?.mode === "cancelled") {
    for (const o of open) {
      if (byId.has(o.paymentId) || o.invoiced || o.collected !== "0.00") continue;
      const d = { paymentId: o.paymentId, action: "cancel" as const };
      list.push(d);
      byId.set(o.paymentId, d);
    }
  }
  const missing = open.filter((o) => !byId.has(o.paymentId));
  if (missing.length) {
    throw new BadRequestException({
      error: "FINANCE_V2_DISPOSITION_REQUIRED",
      message: "حدد لكل قسط مفتوح: تحصيل أو شطب أو إلغاء · Choose collect, write off or cancel for every open installment",
      openInstallments: missing,
    });
  }
  const openById = new Map(open.map((o) => [o.paymentId, o]));
  for (const d of list) {
    const o = openById.get(d.paymentId);
    if (!o) throw new BadRequestException({ error: "FINANCE_V2_BAD_DISPOSITION", message: `القسط ${d.paymentId} ليس مفتوحاً في هذا العقد · Installment ${d.paymentId} is not open on this contract` });
    if (!["collect", "write_off", "cancel"].includes(d.action)) {
      throw new BadRequestException({ error: "FINANCE_V2_BAD_DISPOSITION", message: `إجراء غير معروف · Unknown action for installment ${d.paymentId}` });
    }
    if (d.action === "cancel" && o.invoiced) {
      throw new ConflictException({
        error: "FINANCE_V2_CANCEL_INVOICED", paymentId: d.paymentId,
        message: "القسط مفوتر بمستند معتمد؛ أصدر إشعاراً دائناً أو اشطبه · The installment is on a confirmed invoice: issue a credit note or write it off",
      });
    }
    if (d.action === "write_off") {
      if (!actor.canApprove) throw new ForbiddenException("Missing capability: approve");
      if (!o.charged && !o.pastDue) {
        throw new ConflictException({
          error: "FINANCE_V2_WRITE_OFF_UNCHARGED", paymentId: d.paymentId,
          message: "لا يمكن شطب قسط لم يستحق بعد؛ ألغِه بدلاً من ذلك · An installment not yet due cannot be written off; cancel it instead",
        });
      }
    }
    if (d.action === "collect") {
      if (d.date != null && !ISO.test(d.date)) throw new BadRequestException({ error: "FINANCE_V2_BAD_DISPOSITION", message: "تاريخ غير صالح · Invalid date" });
      if (d.method != null && !METHODS.has(d.method)) throw new BadRequestException({ error: "FINANCE_V2_BAD_DISPOSITION", message: "طريقة غير صالحة · Invalid method" });
      if (d.bankAccountId != null) {
        const [b] = await q.rows(`select 1 from bank_accounts where id = $1 and user_id = $2 and is_active`, [d.bankAccountId, scope]);
        if (!b) throw new NotFoundException("Bank account not found");
      }
    }
  }

  const s = (await loadSettings(q, scope)) as FinanceSettingsRow;
  const cctx = s ? await contractCtx(q, scope, s.mode, contractId) : null;
  for (const d of list) {
    const o = openById.get(d.paymentId)!;
    if (d.action === "collect") {
      const date = d.date ?? today;
      const [col] = await q.rows(
        `insert into payment_collections (payment_id, user_id, amount, collected_date, method, notes)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [d.paymentId, scope, o.remaining, date, d.method ?? "bank_transfer", "تحصيل عند إنهاء العقد · Collected at contract end"],
      );
      await q.exec(
        `insert into finance_collection_meta (collection_id, user_id, bank_account_id) values ($1, $2, $3)
         on conflict (collection_id) do nothing`,
        [Number(col.id), scope, d.bankAccountId ?? null],
      );
      await q.exec(`update payments set status = 'paid', paid_date = $3, updated_at = now() where id = $1 and user_id = $2`, [d.paymentId, scope, date]);
      out.collected.push(d.paymentId);
      if (s) out.events.push(...(await collectionEvents(q, scope, s, [Number(col.id)])));
    } else if (d.action === "write_off") {
      if (s && !o.charged) {
        // Past due but not charged yet (the recognizer runs daily): charge it first so E24 has AR to clear.
        const [p] = await installmentRows(q, scope, [d.paymentId]);
        const f = p ? installmentFacts(p, cctx, s, p.due) : null;
        const [g] = await q.rows(
          `select count(*)::int + 1 as gen from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event ~ '^charge(:g[0-9]+)?$'`,
          [scope, d.paymentId],
        );
        if (f) out.events.push({ sourceType: "payment", sourceId: d.paymentId, event: g.gen <= 1 ? "charge" : `charge:g${g.gen}`, occurredOn: p.due, payload: { rule: "E02", facts: f, paymentIds: [d.paymentId] } });
      }
      const [w] = await q.rows(
        `insert into finance_write_offs (user_id, tenant_id, contract_id, owner_id, payment_ids, amount, written_off_on, reason, created_by, approved_by)
         values ($1, $2, $3, $4, $5::int[], $6, $7, $8, $9, $9) returning id`,
        [scope, c.tenant_id ?? null, contractId, cctx?.ownerId ?? null, [d.paymentId], o.remaining, today,
          d.reason || "شطب عند إنهاء العقد · Written off at contract end", actor.id],
      );
      await q.exec(`update payments set status = 'cancelled', updated_at = now() where id = $1 and user_id = $2`, [d.paymentId, scope]);
      out.writtenOff.push(d.paymentId);
      if (s) out.events.push(writeOffEvent(Number(w.id), o.remaining, today, cctx, s, d.paymentId));
    } else {
      await q.exec(`update payments set status = 'cancelled', updated_at = now() where id = $1 and user_id = $2`, [d.paymentId, scope]);
      out.cancelled.push(d.paymentId);
    }
  }
  return out;
}

export function writeOffEvent(id: number, amount: string, date: string, ctx: Awaited<ReturnType<typeof contractCtx>>, s: FinanceSettingsRow, paymentId: number | null): LedgerEvent {
  const t = ctx ? { treatment: ctx.treatment, warnings: ctx.warnings } : { treatment: s.mode === "owner" ? "principal" as const : "agent" as const, warnings: ["landlord_unresolved"] };
  const facts: MoneyFacts = {
    date, treatment: t.treatment, dims: dimsOf(ctx, paymentId ? { paymentId } : {}), warnings: t.warnings,
    amount, paymentIds: paymentId ? [paymentId] : undefined,
  };
  return { sourceType: "write_off", sourceId: id, event: "posted", occurredOn: date, payload: { rule: "E24", facts, paymentIds: paymentId ? [paymentId] : undefined } };
}

/**
 * POST /finance/v2/write-offs {paymentIds[], reason, date?} (approve): write
 * off the remaining of each charged or past-due installment (one row per
 * installment), outside a termination.
 */
export async function writeOffInstallments(q: Sql, scope: number, body: any, actor: { id: number }): Promise<{ writeOffs: Array<{ id: number; paymentId: number; amount: string }>; events: LedgerEvent[] }> {
  const ids: number[] = Array.isArray(body?.paymentIds) ? [...new Set<number>(body.paymentIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] : [];
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!ids.length) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "حدد الأقساط · paymentIds is required" });
  if (reason.length < 3 || reason.length > 500) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "السبب مطلوب · A reason is required (3–500 characters)" });
  const rows = await q.rows(`select id, contract_id from payments where user_id = $1 and id = any($2::int[]) and deleted_at is null`, [scope, ids]);
  if (rows.length !== ids.length) throw new NotFoundException("Installment not found");
  const s = await loadSettings(q, scope);
  if (!s) throw new NotFoundException();
  const out = { writeOffs: [] as Array<{ id: number; paymentId: number; amount: string }>, events: [] as LedgerEvent[] };
  const today = riyadhTodayV2();
  for (const r of rows) {
    const open = (await openInstallments(q, scope, Number(r.contract_id))).find((o) => o.paymentId === Number(r.id));
    if (!open) throw new ConflictException({ error: "FINANCE_V2_NOT_OPEN", paymentId: r.id, message: "القسط ليس مفتوحاً · The installment has nothing left to write off" });
    out.events.push(...(await singleWriteOff(q, scope, s, Number(r.contract_id), open, reason, actor.id, today, out)));
  }
  return out;
}

async function singleWriteOff(
  q: Sql, scope: number, s: FinanceSettingsRow, contractId: number, o: OpenInstallment, reason: string, actorId: number, today: string,
  out: { writeOffs: Array<{ id: number; paymentId: number; amount: string }> },
): Promise<LedgerEvent[]> {
  if (!o.charged && !o.pastDue) {
    throw new ConflictException({ error: "FINANCE_V2_WRITE_OFF_UNCHARGED", paymentId: o.paymentId, message: "لا يمكن شطب قسط لم يستحق بعد · An installment not yet due cannot be written off" });
  }
  const events: LedgerEvent[] = [];
  const cctx = await contractCtx(q, scope, s.mode, contractId);
  if (!o.charged) {
    const [p] = await installmentRows(q, scope, [o.paymentId]);
    const f = p ? installmentFacts(p, cctx, s, p.due) : null;
    const [g] = await q.rows(
      `select count(*)::int + 1 as gen from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event ~ '^charge(:g[0-9]+)?$'`,
      [scope, o.paymentId],
    );
    if (f) events.push({ sourceType: "payment", sourceId: o.paymentId, event: g.gen <= 1 ? "charge" : `charge:g${g.gen}`, occurredOn: p.due, payload: { rule: "E02", facts: f, paymentIds: [o.paymentId] } });
  }
  const [c] = await q.rows(`select tenant_id from contracts where id = $1 and user_id = $2`, [contractId, scope]);
  const [w] = await q.rows(
    `insert into finance_write_offs (user_id, tenant_id, contract_id, owner_id, payment_ids, amount, written_off_on, reason, created_by, approved_by)
     values ($1, $2, $3, $4, $5::int[], $6, $7, $8, $9, $9) returning id`,
    [scope, c?.tenant_id ?? null, contractId, cctx?.ownerId ?? null, [o.paymentId], o.remaining, today, reason, actorId],
  );
  await q.exec(`update payments set status = 'cancelled', updated_at = now() where id = $1 and user_id = $2`, [o.paymentId, scope]);
  events.push(writeOffEvent(Number(w.id), o.remaining, today, cctx, s, o.paymentId));
  out.writeOffs.push({ id: Number(w.id), paymentId: o.paymentId, amount: o.remaining });
  return events;
}
