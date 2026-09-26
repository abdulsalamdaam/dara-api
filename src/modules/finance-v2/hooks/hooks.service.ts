import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { FinanceFlagService } from "../flag.service";
import { LedgerEmitter, type LedgerEvent } from "../ledger-emitter.service";
import { appLog } from "../../../common/logging/app-log.service";
import { sqlOf, type Sql } from "./sql";
import {
  captureDims, collectionEvents, contractCtx, depositForfeitEvent, depositRefundedEvent, documentEvents, expenseEvent, expenseRevision,
  installmentFacts, installmentRows, loadSettings, payoutEvent, reversalEvent, today, voucherUnlinked, type FinanceSettingsRow,
} from "./facts-loader";
import { CONVERSION_NOTE, mapEjarStatusV2 } from "./classify";
import { withTx } from "../db";
import { and, eq } from "drizzle-orm";
import { simpleInvoicesTable } from "@dara/database";
import { capabilities } from "../capabilities";
import { createCommissionCreditV2, createCommissionV2 } from "../commission";
import { paymentsListV2 } from "../overrides/payments-list";
import { accountingV2, dashboardV2 } from "../overrides/reads";
import { approveV2Kind, ensureAgencyFeeDraft } from "../overrides/documents-v2";
import { applyDispositions } from "../overrides/terminate";
import { fromHalalas } from "../money";

/** What a legacy handler passes: the flag resolved at handler entry, the scope, and its transaction if it has one. */
export interface HookCtx {
  fv2: boolean;
  userId: number;
  /** The source transaction (Drizzle `tx`). Omit on paths without one. */
  tx?: any;
}

/** Bilingual refusal bodies (§4.6, §9 E7, §10.2). */
export const FV2_ERRORS = {
  MARK_PAID_REFUSED: {
    error: "FINANCE_V2_MARK_PAID_REFUSED",
    message: "لا يمكن اعتبار الأقساط مدفوعة دون تحصيل — سجّل التحصيل أو اشطب المبلغ أو ألغِ الأقساط · "
      + "Installments cannot be marked paid without money: record the collections, write the balance off, or cancel them",
  },
  FIELD_LOCKED: (fields: string[]) => ({
    error: "FINANCE_V2_FIELD_LOCKED",
    message: `هذه الحقول تُدار عبر التحصيل والمستندات في المالية v2: ${fields.join(", ")} · `
      + `These fields are managed through collections and documents under Finance v2: ${fields.join(", ")}`,
    fields,
  }),
  INSTALLMENTS_LINKED: {
    error: "FINANCE_V2_INSTALLMENTS_LINKED",
    message: "توجد أقساط مفوترة أو مُثبتة في الدفاتر؛ لا يمكن إعادة توليد الجدول · "
      + "Some installments are invoiced or charged in the ledger; the schedule cannot be regenerated",
  },
  SETTLE_AGAIN: {
    error: "FINANCE_V2_SETTLE_AGAIN_REFUSED",
    message: "سبق تسوية هذا القسط خارج المنصة ثم التراجع عنها — سجّل تحصيلاً بدلاً من ذلك · "
      + "This installment was settled outside Dara and reverted before; record a collection instead",
  },
} as const;

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * The single seam between the legacy finance handlers and Finance v2 (DESIGN
 * §1.4 point 3-4, §5.1, §5.7). Every legacy file gains only ADDED lines that
 * call this service, each marked `// finance-v2:`.
 *
 *  - `resolve` reads the flag once, at handler entry, before any transaction.
 *  - Hooks (`collectionsAdded`, `documentConfirmed`, …) do nothing when the
 *    flag is off and NEVER throw: inside a source transaction they run in a
 *    savepoint, so their failure rolls back only themselves; the nightly
 *    catch-up fills any gap.
 *  - Guards (`refuseMarkPaid`, `guardPaymentPatch`, …) are the deliberate v2
 *    behaviour changes: they throw an HTTP error, only with the flag on, and
 *    always BEFORE the legacy handler writes anything.
 */
@Injectable()
export class FinanceV2Hooks {
  private readonly log = new Logger("FinanceV2Hooks");

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    private readonly emitter: LedgerEmitter,
  ) {}

  /** The flag for this scope, resolved once per request (never throws; off when unknown). */
  async resolve(scopeUserId: number): Promise<boolean> {
    try {
      return await this.flag.isOn(scopeUserId);
    } catch {
      return false;
    }
  }

  // ─── Guards: throw before any legacy write, flag on only ────────────────

  /** §4.6 / E25: terminate or DELETE with mode "paid" is refused under v2. */
  refuseMarkPaid(fv2: boolean, mode: unknown): void {
    if (fv2 && mode === "paid") throw new ConflictException(FV2_ERRORS.MARK_PAID_REFUSED);
  }

  /** §9 E7: POST /payments under v2 — pending only, validated amount, the contract in scope. */
  async paymentCreateBody(fv2: boolean, scope: number, body: any): Promise<any> {
    if (!fv2) return body;
    const amount = typeof body?.amount === "number" ? String(body.amount) : String(body?.amount ?? "").trim();
    if (!AMOUNT_RE.test(amount) || !(Number(amount) > 0)) {
      throw new BadRequestException({ error: "FINANCE_V2_BAD_AMOUNT", message: "المبلغ غير صالح · Invalid amount" });
    }
    const contractId = Number(body?.contractId);
    if (Number.isInteger(contractId) && contractId > 0) {
      const r = await this.pool.query(`select 1 from contracts where id = $1 and user_id = $2 and deleted_at is null`, [contractId, scope]);
      if (!r.rowCount) throw new NotFoundException("Contract not found");
    }
    return { ...body, amount, status: "pending", paidDate: null, receiptNumber: null };
  }

  /** §9 E7: PATCH /payments/:id under v2 — money fields locked; dueDate locked once charged. */
  async guardPaymentPatch(fv2: boolean, scope: number, paymentId: number, body: any): Promise<void> {
    if (!fv2) return;
    const locked = ["amount", "status", "paidDate", "receiptNumber"].filter((f) => body?.[f] !== undefined);
    if (body?.dueDate !== undefined && Number.isInteger(paymentId) && (await this.isCharged(this.sqlPool(), scope, paymentId))) locked.push("dueDate");
    if (locked.length) throw new BadRequestException(FV2_ERRORS.FIELD_LOCKED(locked));
  }

  /** E27: a second settle-external after a revert is refused under v2 (the charge key is never reused). */
  async guardSettleExternal(fv2: boolean, scope: number, paymentId: number): Promise<void> {
    if (!fv2 || !Number.isInteger(paymentId)) return;
    const r = await this.pool.query(
      `select 1 from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event = 'settled_external'`,
      [scope, paymentId],
    );
    if (r.rowCount) throw new ConflictException(FV2_ERRORS.SETTLE_AGAIN);
  }

  /** E23: generate-installments under v2 refuses to delete a charged or invoiced row. */
  async guardRegenerate(fv2: boolean, scope: number, contractId: number): Promise<void> {
    if (!fv2) return;
    const r = await this.pool.query(
      `select 1 from payments p
        where p.user_id = $1 and p.contract_id = $2 and p.deleted_at is null and p.status::text in ('pending','settled_external')
          and (exists (select 1 from finance_installment_charges c where c.payment_id = p.id and c.user_id = p.user_id and c.reversed_at is null)
            or exists (select 1 from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                        and o.event ~ '^charge(:g[0-9]+)?$' and o.status in ('pending','failed'))
            or exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null
                        and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id))))
        limit 1`,
      [scope, contractId],
    );
    if (r.rowCount) throw new ConflictException(FV2_ERRORS.INSTALLMENTS_LINKED);
  }

  // ─── Hooks: enqueue, never throw ────────────────────────────────────────

  /** POST /payments/:id/collections (inside its transaction), and any path that knows its new collection ids. */
  async collectionsAdded(ctx: HookCtx, collectionIds: number[]): Promise<void> {
    await this.run(ctx, "collections", (q, s) => collectionEvents(q, ctx.userId, s, collectionIds.filter((n) => Number.isInteger(n))));
  }

  /** POST /simple-invoices/:id/collect (inside its transaction): the collections this transaction wrote. */
  async invoiceCollected(ctx: HookCtx, documentId: number): Promise<void> {
    await this.run(ctx, "invoice_collect", async (q, s) => {
      const rows = await q.rows(
        `select id from payment_collections where user_id = $1 and invoice_id = $2 and created_at = now() order by id`,
        [ctx.userId, documentId],
      );
      return collectionEvents(q, ctx.userId, s, rows.map((r: any) => Number(r.id)));
    });
  }

  /** POST /simple-invoices/:id/approve, right after the `confirmed` update (before ZATCA). */
  async documentConfirmed(ctx: HookCtx, documentId: number): Promise<void> {
    await this.run(ctx, "document_confirmed", (q, s) => documentEvents(q, ctx.userId, s, documentId));
  }

  /** POST /simple-invoices/receipt-voucher, after its last write: the voucher's collections, and E09 for a deposit voucher. */
  async voucherIssued(ctx: HookCtx, voucherId: number): Promise<void> {
    await this.run(ctx, "voucher", async (q, s) => {
      const rows = await q.rows(`select id from payment_collections where user_id = $1 and invoice_id = $2 order by id`, [ctx.userId, voucherId]);
      return [
        ...(await collectionEvents(q, ctx.userId, s, rows.map((r: any) => Number(r.id)))),
        ...(await documentEvents(q, ctx.userId, s, voucherId)),
      ];
    });
  }

  /** POST /contracts/:id/collect-deposit: the new deposit voucher (E09). */
  async depositCollected(ctx: HookCtx, voucherId: number | null | undefined): Promise<void> {
    if (!voucherId) return;
    await this.run(ctx, "deposit_collected", (q, s) => documentEvents(q, ctx.userId, s, voucherId));
  }

  /** POST /simple-invoices: advance collections re-pointed to the new invoice (E14, always skipped: informative). */
  async invoiceCreated(ctx: HookCtx, documentId: number): Promise<void> {
    await this.run(ctx, "repoint", async (q) => {
      const [r] = await q.rows(`select count(*)::int as n from payment_collections where user_id = $1 and invoice_id = $2`, [ctx.userId, documentId]);
      if (!r?.n) return [];
      return [{ sourceType: "simple_invoice", sourceId: documentId, event: "repoint", occurredOn: today(),
        payload: { rule: "E14", facts: { date: today(), treatment: "principal", dims: { documentId } } } }];
    });
  }

  /**
   * Contract create / rebuild (inside the transaction, after materializeContract):
   * capture (or refresh) the dimensions, then the advance collections and the
   * deposit voucher this transaction wrote.
   */
  async contractMaterialized(ctx: HookCtx, contractId: number, opts: { refreshDims?: boolean } = {}): Promise<void> {
    await this.run(ctx, "contract_materialized", async (q, s) => {
      await captureDims(q, ctx.userId, contractId, { refresh: opts.refreshDims });
      const cols = await q.rows(
        `select pc.id from payment_collections pc join payments p on p.id = pc.payment_id
          where pc.user_id = $1 and p.contract_id = $2 and pc.created_at = now() order by pc.id`,
        [ctx.userId, contractId],
      );
      const vouchers = await q.rows(
        `select id from simple_invoices where user_id = $1 and contract_id = $2 and kind = 'deposit' and status = 'confirmed'
            and deleted_at is null and created_at = now() order by id`,
        [ctx.userId, contractId],
      );
      const out: LedgerEvent[] = await collectionEvents(q, ctx.userId, s, cols.map((r: any) => Number(r.id)));
      for (const v of vouchers) out.push(...(await documentEvents(q, ctx.userId, s, Number(v.id))));
      // E8: a contract with an agency fee gets its DRAFT brokerage-fee document (idempotent).
      await ensureAgencyFeeDraft(q, ctx.userId, contractId);
      return out;
    });
  }

  /**
   * Contract rebuild, inside its transaction BEFORE the hard deletes (E22):
   * a `reversal:<event>` for every live event of the installments and
   * collections about to be destroyed, with a snapshot of the deleted rows.
   */
  async beforeRebuildDestroy(ctx: HookCtx, contractId: number, paymentIds: number[]): Promise<void> {
    await this.run(ctx, "rebuild", async (q) => {
      const ids = paymentIds.filter((n) => Number.isInteger(n));
      if (!ids.length) return [];
      const snapshot = await q.rows(
        `select 'payment' as t, id, amount::text as amount, to_char(due_date,'YYYY-MM-DD') as d, status::text as status
           from payments where user_id = $1 and id = any($2::int[])
         union all
         select 'payment_collection', id, amount::text, to_char(collected_date,'YYYY-MM-DD'), coalesce(receipt_number,'')
           from payment_collections where user_id = $1 and payment_id = any($2::int[])`,
        [ctx.userId, ids],
      );
      const colIds = snapshot.filter((r: any) => r.t === "payment_collection").map((r: any) => Number(r.id));
      const live = await q.rows(
        `select source_type, source_id, event from ledger_outbox o
          where o.user_id = $1 and o.status in ('pending','posted','failed') and o.event not like 'reversal:%'
            and ((o.source_type = 'payment' and o.source_id = any($2::int[]))
              or (o.source_type = 'payment_collection' and o.source_id = any($3::int[])))
            and not exists (select 1 from ledger_outbox r where r.user_id = o.user_id and r.source_type = o.source_type
                             and r.source_id = o.source_id and r.event = 'reversal:' || o.event)
          order by o.id`,
        [ctx.userId, ids, colIds],
      );
      const date = today();
      const snap = (t: string, id: number) => snapshot.find((r: any) => r.t === t && Number(r.id) === id) ?? null;
      return live.map((o: any) => reversalEvent(o.source_type, Number(o.source_id), o.event, date,
        { reason: "contract_rebuild", contractId, snapshot: snap(o.source_type, Number(o.source_id)) }));
    });
  }

  /** Before terminate / DELETE unlink the contract's units: make sure its dimensions are captured (§4.3). */
  async captureContractDims(ctx: HookCtx, contractId: number): Promise<void> {
    await this.run(ctx, "capture_dims", async (q) => {
      await captureDims(q, ctx.userId, contractId);
      return [];
    });
  }

  /**
   * After the legacy terminate (§4.6, E04/E05/E09C/E10/E11/E12): set
   * `ended_on`, then enqueue the refunds it wrote, the deposit refund or
   * forfeit or conversion, and a `charge_cancelled` per cancelled installment.
   */
  async contractTerminated(ctx: HookCtx, contractId: number, info: {
    mode?: string; deposit?: string; refundNumber?: string | null; refundMethod?: string | null; depositVoucherIds?: number[]; actorId?: number | null;
  }): Promise<void> {
    await this.run(ctx, "terminate", async (q, s) => {
      const date = today();
      await captureDims(q, ctx.userId, contractId);
      await q.exec(`update finance_contract_dims set ended_on = $3 where contract_id = $1 and user_id = $2 and ended_on is null`, [contractId, ctx.userId, date]);
      const cctx = await contractCtx(q, ctx.userId, s.mode, contractId);
      const out: LedgerEvent[] = [];
      if (info.refundNumber) {
        const rows = await q.rows(
          `select pc.id from payment_collections pc join payments p on p.id = pc.payment_id
            where pc.user_id = $1 and p.contract_id = $2 and pc.receipt_number = $3 and pc.amount < 0 order by pc.id`,
          [ctx.userId, contractId, info.refundNumber],
        );
        out.push(...(await collectionEvents(q, ctx.userId, s, rows.map((r: any) => Number(r.id)))));
      }
      const vids = (info.depositVoucherIds ?? []).filter((n) => Number.isInteger(n));
      if (info.deposit === "refund" && vids.length) {
        const unlinked = await voucherUnlinked(q, ctx.userId, vids);
        const refunded = [...unlinked.entries()].filter(([, amt]) => amt > 0);
        // E10: the v2 refund record — one payment voucher (سند صرف) per refund, listing its deposit vouchers.
        let pv: string | null = null;
        if (refunded.length) {
          const [c] = await q.rows(`select tenant_id from contracts where id = $1 and user_id = $2`, [contractId, ctx.userId]);
          pv = info.refundNumber ?? (await this.nextRefundNumber(q, ctx.userId));
          await q.exec(
            `insert into finance_deposit_refunds (user_id, contract_id, tenant_id, owner_id, voucher_ids, amount, refunded_on, method, number, created_by)
             values ($1, $2, $3, $4, $5::int[], $6, $7, $8, $9, $10) on conflict (user_id, number) do nothing`,
            [ctx.userId, contractId, c?.tenant_id ?? null, cctx?.ownerId ?? null, refunded.map(([vid]) => vid),
              fromHalalas(refunded.reduce((a, [, amt]) => a + amt, 0)), date, info.refundMethod ?? null, pv, info.actorId ?? null],
          );
        }
        for (const [vid, amt] of refunded) {
          const e = depositRefundedEvent(vid, amt, cctx, date, info.refundMethod ?? null, s);
          (e.payload as any).facts.memo = pv ? `سند صرف ${pv} · Payment voucher ${pv}` : undefined;
          out.push(e);
        }
      }
      if (info.deposit === "forfeit" && cctx) {
        const e = await depositForfeitEvent(q, ctx.userId, s, cctx, date);
        if (e) out.push(e);
      }
      if (info.deposit === "revenue" && vids.length) {
        const conv = await q.rows(
          `select id from payment_collections where user_id = $1 and invoice_id = any($2::int[]) and payment_id is null and notes = $3 order by id`,
          [ctx.userId, vids, CONVERSION_NOTE],
        );
        for (const r of conv) {
          await q.exec(
            `insert into finance_collection_meta (collection_id, user_id, classification) values ($1, $2, 'deposit_conversion')
             on conflict (collection_id) do update set classification = 'deposit_conversion' where finance_collection_meta.user_id = excluded.user_id`,
            [Number(r.id), ctx.userId],
          );
        }
        out.push(...(await collectionEvents(q, ctx.userId, s, conv.map((r: any) => Number(r.id)))));
      }
      out.push(...(await this.cancelledEvents(q, ctx.userId, s, contractId, date)));
      return out;
    });
  }

  /** After the legacy DELETE /contracts/:id (mode cancelled or none): `ended_on` and E05 for cancelled rows. */
  async contractRemoved(ctx: HookCtx, contractId: number): Promise<void> {
    await this.run(ctx, "remove", async (q, s) => {
      const date = today();
      await captureDims(q, ctx.userId, contractId);
      await q.exec(`update finance_contract_dims set ended_on = $3 where contract_id = $1 and user_id = $2 and ended_on is null`, [contractId, ctx.userId, date]);
      return this.cancelledEvents(q, ctx.userId, s, contractId, date);
    });
  }

  /** E05 for every cancelled installment of a contract (the rule skips uncharged and invoiced ones). */
  private async cancelledEvents(q: Sql, userId: number, s: FinanceSettingsRow, contractId: number, date: string): Promise<LedgerEvent[]> {
    const rows = await q.rows(`select id from payments where user_id = $1 and contract_id = $2 and status = 'cancelled' and deleted_at is null order by id`, [userId, contractId]);
    if (!rows.length) return [];
    const cctx = await contractCtx(q, userId, s.mode, contractId);
    const out: LedgerEvent[] = [];
    for (const p of await installmentRows(q, userId, rows.map((r: any) => Number(r.id)))) {
      const f = installmentFacts(p, cctx, s, date);
      if (f) out.push({ sourceType: "payment", sourceId: p.id, event: "charge_cancelled", occurredOn: date, payload: { rule: "E05", facts: f, paymentIds: [p.id] } });
    }
    return out;
  }

  /** POST /payments/:id/settle-external (E27): E33 now if the installment is charged (or its charge is queued); else the recognizer does it. */
  async settledExternal(ctx: HookCtx, paymentId: number): Promise<void> {
    await this.run(ctx, "settle_external", async (q, s) => {
      const [p] = await installmentRows(q, ctx.userId, [paymentId]);
      if (!p || p.status !== "settled_external") return [];
      if (!(await this.isCharged(q, ctx.userId, paymentId))) return [];
      const cctx = await contractCtx(q, ctx.userId, s.mode, p.contract_id);
      const f = installmentFacts(p, cctx, s, p.due);
      return f ? [{ sourceType: "payment", sourceId: p.id, event: "settled_external", occurredOn: p.due, payload: { rule: "E33", facts: f, paymentIds: [p.id] } }] : [];
    });
  }

  /** POST /payments/:id/revert-external (E27): reverse E33 if it was queued. */
  async revertedExternal(ctx: HookCtx, paymentId: number): Promise<void> {
    await this.run(ctx, "revert_external", async (q) => {
      const [o] = await q.rows(
        `select 1 from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event = 'settled_external'`,
        [ctx.userId, paymentId],
      );
      return o ? [reversalEvent("payment", paymentId, "settled_external", today(), { reason: "revert_external" })] : [];
    });
  }

  /** POST /reports/expenses (E18 rev:1). */
  async expenseCreated(ctx: HookCtx, expenseId: number): Promise<void> {
    await this.run(ctx, "expense", async (q, s) => {
      const e = await expenseEvent(q, ctx.userId, s, expenseId);
      return e ? [e] : [];
    });
  }

  /** DELETE /reports/expenses/:id (E18 reversal:rev:<n>), only when the row is in scope and now deleted. */
  async expenseDeleted(ctx: HookCtx, expenseId: number): Promise<void> {
    await this.run(ctx, "expense_delete", async (q) => {
      if (!Number.isInteger(expenseId)) return [];
      const r = await expenseRevision(q, ctx.userId, expenseId);
      if (!r?.deleted) return [];
      return [reversalEvent("expense", expenseId, `rev:${r.revision}`, today(), { reason: "deleted" })];
    });
  }

  /** POST /reports/landlord-payouts (E19). */
  async payoutCreated(ctx: HookCtx, payoutId: number): Promise<void> {
    await this.run(ctx, "payout", async (q, s) => {
      const e = await payoutEvent(q, ctx.userId, s, payoutId);
      return e ? [e] : [];
    });
  }

  /** DELETE /reports/landlord-payouts/:id (E19 reversal). */
  async payoutDeleted(ctx: HookCtx, payoutId: number): Promise<void> {
    await this.run(ctx, "payout_delete", async (q) => {
      if (!Number.isInteger(payoutId)) return [];
      const [r] = await q.rows(`select deleted_at is not null as deleted from landlord_payouts where id = $1 and user_id = $2`, [payoutId, ctx.userId]);
      return r?.deleted ? [reversalEvent("landlord_payout", payoutId, "created", today(), { reason: "deleted" })] : [];
    });
  }

  /**
   * POST /ejar/import under v2 (E26, §9 E7): the legacy attach step with the
   * status mapped by `mapEjarStatusV2` — Ejar-paid becomes `settled_external`
   * (charged at its due date by the recognizer, settled by E33), a partial
   * payment stays pending, and what Ejar reported is kept in
   * `finance_ejar_settlements`. Nothing becomes paid without a collection.
   * Unlike the hooks this is a replacement write path, so it runs even though
   * the enqueue part is best-effort; it swallows its own errors like the
   * legacy step (whose errors the import already swallows).
   */
  async ejarAttachV2(ctx: HookCtx, rows: Array<{ id: number; dueDate: string }>, invoices: Array<Record<string, any>>): Promise<void> {
    if (!ctx.fv2 || !rows.length || !invoices.length) return;
    try {
      const byDue = new Map<string, Record<string, any>>();
      for (const inv of invoices) {
        const key = String(inv?.dueDate ?? "").slice(0, 10);
        if (key && !byDue.has(key)) byDue.set(key, inv);
      }
      for (const row of rows) {
        const inv = byDue.get(String(row.dueDate).slice(0, 10));
        if (!inv) continue;
        const m = mapEjarStatusV2(inv);
        const description = [
          inv.number && `فاتورة إيجار رقم ${inv.number}`,
          inv.issueDate && `تاريخ الإصدار ${inv.issueDate}`,
          inv.lateDate && `تاريخ التأخر ${inv.lateDate}`,
        ].filter(Boolean).join(" — ") || null;
        await this.pool.query(
          `update payments set receipt_number = coalesce($3, receipt_number),
                  status = coalesce($4::text, status::text)::payment_status,
                  paid_date = case when $4::text = 'settled_external' then due_date else paid_date end,
                  description = coalesce($5, description), updated_at = now()
            where id = $1 and user_id = $2`,
          [row.id, ctx.userId, inv.number ?? null, m.status, description],
        );
        if (m.reported) {
          await this.pool.query(
            `insert into finance_ejar_settlements (payment_id, user_id, reported_status, reported_amount) values ($1, $2, $3, $4)
             on conflict (payment_id) do update set reported_status = excluded.reported_status, reported_amount = excluded.reported_amount, imported_at = now()
              where finance_ejar_settlements.user_id = excluded.user_id`,
            [row.id, ctx.userId, m.reported, m.reportedAmount],
          );
        }
      }
      const [c] = (await this.pool.query(`select contract_id from payments where id = $1 and user_id = $2`, [rows[0].id, ctx.userId])).rows;
      if (c?.contract_id) await captureDims(this.sqlPool(), ctx.userId, Number(c.contract_id));
    } catch (err) {
      this.fail("ejar_attach", ctx.userId, err);
    }
  }

  /** Admin hard delete of an account (§2.4.5): purge its v2 rows. Unconditional, never throws. */
  async purgeAccount(userId: number): Promise<void> {
    try {
      await this.pool.query(`select fv2_purge_account($1)`, [userId]);
    } catch (err: any) {
      if (err?.code !== "42883" && err?.code !== "42P01") this.fail("purge", userId, err);
    }
  }

  // ─── v2 forks: the legacy shape with the v2 values (flag on only) ────────
  // Unlike the hooks these are replacement read/write paths: their errors
  // reach the caller (they run only for flag-on accounts).

  /** E4: GET /payments. */
  async paymentsList(scope: number, rawQuery: any): Promise<any> {
    return paymentsListV2(this.sqlPool(), scope, rawQuery);
  }

  /** E2/E4: GET /dashboard/summary — v2 values over the legacy result. */
  async dashboardSummary(scope: number, legacy: any): Promise<any> {
    return dashboardV2(this.sqlPool(), scope, legacy);
  }

  /** E3/E4/E1: GET /reports/accounting — v2 values over the legacy result. */
  async accounting(scope: number, legacy: any): Promise<any> {
    return accountingV2(this.sqlPool(), scope, legacy);
  }

  /** E8/E9: the v2 approve of `rent_receipt` / `agency_fee`; never ZATCA. `db` is the legacy Drizzle handle (same row shape). */
  async approveV2Kind(ctx: HookCtx, db: any, doc: any): Promise<any> {
    return approveV2Kind(this.sqlPool(), db, ctx.userId, doc, (id) => this.documentConfirmed(ctx, id));
  }

  /**
   * E1: the v2 commission for an approved rent invoice (replaces the legacy
   * commission step for flag-on accounts): the effective rate (property, else
   * landlord), none for a principal landlord, VAT only if the account is
   * VAT-registered. Returns the new draft row (legacy shape) or null.
   */
  async commissionOnApprove(ctx: HookCtx, db: any, doc: any): Promise<any> {
    if (!ctx.fv2 || doc?.kind === "commission" || !doc?.contractId) return null;
    const payIds: number[] = Array.isArray(doc.paymentIds) && doc.paymentIds.length ? doc.paymentIds.map(Number) : doc.paymentId ? [Number(doc.paymentId)] : [];
    if (!payIds.length) return null;
    try {
      const id = await createCommissionV2(this.sqlPool(), ctx.userId, {
        id: doc.id, number: doc.number, contractId: Number(doc.contractId), paymentId: doc.paymentId ?? null, paymentIds: payIds, dueDate: doc.dueDate ?? null,
      });
      if (!id) return null;
      const [row] = await db.select().from(simpleInvoicesTable).where(and(eq(simpleInvoicesTable.id, id), eq(simpleInvoicesTable.userId, ctx.userId)));
      return row ?? null;
    } catch (err) {
      this.fail("commission", ctx.userId, err); // best-effort, like the legacy step: never blocks the approval
      return null;
    }
  }

  /** E36: after a credit note is approved under v2, the draft commission credit note (best-effort). */
  async afterNoteApproved(ctx: HookCtx, note: any): Promise<void> {
    if (!ctx.fv2 || note?.type !== "credit") return;
    try {
      await createCommissionCreditV2(this.sqlPool(), ctx.userId, {
        id: note.id, number: note.number, type: note.type, billingReference: note.billingReference ?? null, subtotal: String(note.subtotal ?? "0"),
      });
    } catch (err) {
      this.fail("commission_credit", ctx.userId, err);
    }
  }

  /**
   * E7 (§4.6): the dispositions of every open installment, applied BEFORE
   * the legacy terminate writes (flag on only). Refuses (400/403/409) an
   * incomplete or disallowed body with nothing written.
   */
  async terminateDispositions(ctx: HookCtx, contractId: number, body: any, user: any): Promise<void> {
    if (!ctx.fv2) return;
    const events = await withTx(this.pool, async (c) => {
      const q = sqlOf(c as any);
      const res = await applyDispositions(q, ctx.userId, contractId, body, { id: Number(user?.id ?? ctx.userId), canApprove: capabilities(user ?? {}).includes("approve") });
      for (const e of res.events) await this.emitter.emit({ fv2: true, userId: ctx.userId, tx: c as any }, e);
      return res.events.length;
    });
    if (events) this.emitter.kick(ctx.userId);
  }

  /** Next RFND-#### across legacy refund collections and v2 deposit refunds. */
  private async nextRefundNumber(q: Sql, userId: number): Promise<string> {
    const [r] = await q.rows(
      `select coalesce(max(n), 0) as m from (
         select cast(substring(receipt_number from 'RFND-([0-9]+)') as integer) as n from payment_collections where user_id = $1 and receipt_number ilike 'RFND-%'
         union all select cast(substring(number from 'RFND-([0-9]+)') as integer) from finance_deposit_refunds where user_id = $1 and number ilike 'RFND-%') x`,
      [userId],
    );
    return `RFND-${String(Number(r?.m ?? 0) + 1).padStart(4, "0")}`;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private sqlPool(): Sql {
    return sqlOf(this.pool as any);
  }

  /** Active charge marker, or a charge event still queued. */
  private async isCharged(q: Sql, userId: number, paymentId: number): Promise<boolean> {
    const [r] = await q.rows(
      `select exists (select 1 from finance_installment_charges where user_id = $1 and payment_id = $2 and reversed_at is null)
           or exists (select 1 from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2
                        and event ~ '^charge(:g[0-9]+)?$' and status in ('pending','failed')) as charged`,
      [userId, paymentId],
    );
    return r?.charged === true;
  }

  /**
   * Load facts and enqueue, flag on only, never throwing. With a source
   * transaction the whole step runs in ONE savepoint (reads see the
   * transaction's own rows; a failure rolls back only the savepoint); the
   * worker is kicked shortly after, once the source has had time to commit.
   */
  private async run(ctx: HookCtx, what: string, build: (q: Sql, s: FinanceSettingsRow) => Promise<LedgerEvent[]>): Promise<void> {
    if (ctx?.fv2 !== true) return;
    try {
      if (ctx.tx && typeof ctx.tx.transaction === "function") {
        // Everything on the caller's connection (no second pool connection while it holds its locks, §1.2).
        await ctx.tx.transaction(async (sp: any) => {
          const q = sqlOf(sp);
          const s = await loadSettings(q, ctx.userId);
          if (!s) return;
          const events = await build(q, s);
          for (const e of events) await this.emitter.emit({ fv2: true, userId: ctx.userId, tx: sp }, e);
        });
        const t = setTimeout(() => this.emitter.kick(ctx.userId), 1000);
        t.unref?.();
        return;
      }
      const s = await loadSettings(this.sqlPool(), ctx.userId);
      if (!s) return;
      const events = await build(this.sqlPool(), s);
      for (const e of events) await this.emitter.emit({ fv2: true, userId: ctx.userId }, e);
      this.emitter.kick(ctx.userId);
    } catch (err) {
      this.fail(what, ctx.userId, err);
    }
  }

  private fail(what: string, userId: number, err: unknown): void {
    const message = String((err as any)?.cause?.message ?? (err as any)?.message ?? err).split("\n")[0];
    this.log.warn(`finance_v2.hook_failed ${what} (scope ${userId}): ${message}`);
    try {
      appLog()?.record({ level: "warn", event: "finance_v2.hook_failed", ownerUserId: userId, message: `${what}: ${message}`, error: err });
    } catch {
      /* never reaches the user action */
    }
  }
}
