import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Pool } from "./db";
import { AUTO_INVOICE_ERROR_TEXT } from "./auto-invoice/errors";

export type PostingErrorsTab = "errors" | "skipped";

/** Plain Arabic and English per error code (§5.5). Unknown codes fall back to POST_ERROR. */
export const ERROR_TEXT: Record<string, { ar: string; en: string }> = {
  PERIOD_LOCKED: { ar: "الفترة المحاسبية مقفلة", en: "The accounting period is locked" },
  PERIOD_CLOSED: { ar: "الفترة المحاسبية مغلقة", en: "The accounting period is closed" },
  VAT_LOCKED: { ar: "فترة ضريبة القيمة المضافة مقفلة", en: "The VAT period is locked" },
  ACCOUNT_INACTIVE: { ar: "الحساب المرتبط غير نشط", en: "A linked account is inactive" },
  ACCOUNT_GROUP: { ar: "لا يمكن الترحيل إلى حساب تجميعي", en: "Cannot post to a group account" },
  MISSING_ACCOUNT: { ar: "حساب مطلوب غير موجود في دليل الحسابات", en: "A required account is missing from the chart" },
  UNBALANCED: { ar: "القيد غير متوازن", en: "The entry does not balance" },
  MISSING_FACT: { ar: "بيانات الحدث ناقصة", en: "The event is missing data" },
  BAD_FACTS: { ar: "بيانات الحدث غير صحيحة", en: "The event data is invalid" },
  KEY_COLLISION: { ar: "يوجد قيد آخر بنفس المرجع وبيانات مختلفة", en: "Another entry has this key with different data" },
  KEY_RACE: { ar: "تم الترحيل في نفس اللحظة من مسار آخر", en: "Posted concurrently by another path" },
  NOT_CHARGED: { ar: "القسط لم يُستحق بعد في الدفاتر", en: "The installment is not charged yet" },
  CROSS_LANDLORD: { ar: "لا يمكن نقل رصيد المستأجر بين ملاك مختلفين", en: "Tenant credit cannot move between landlords" },
  NO_OPEN_PERIOD: { ar: "لا توجد فترة مفتوحة", en: "No open period" },
  UNKNOWN_RULE: { ar: "نوع حدث غير معروف", en: "Unknown event type" },
  POST_ERROR: { ar: "تعذّر الترحيل", en: "Posting failed" },
};

const COLS = `id, source_type as "sourceType", source_id::int as "sourceId", event, to_char(occurred_on,'YYYY-MM-DD') as "occurredOn",
  origin, status, attempts, last_error as "lastError", last_error_code as "lastErrorCode", skip_reason as "skipReason",
  next_attempt_at as "nextAttemptAt", blocked_on::int as "blockedOn", entry_id::int as "entryId", created_at as "createdAt",
  processed_at as "processedAt", payload->>'rule' as rule`;

/**
 * The posting-errors list (DESIGN §5.5): `failed` rows, plus `pending` rows
 * that are retrying (attempts > 0) or blocked on another row; a separate tab
 * lists `skipped` rows with their reason. Retry and Dismiss are audited with
 * an explicit `audit_logs` row (the interceptor skips POST).
 */
@Injectable()
export class PostingErrorsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  async list(userId: number, q: { tab?: string; limit?: string | number; offset?: string | number } = {}) {
    const tab: PostingErrorsTab = q.tab === "skipped" ? "skipped" : "errors";
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const where = tab === "skipped"
      ? `status = 'skipped'`
      : `(status = 'failed' or (status = 'pending' and (attempts > 0 or blocked_on is not null)))`;
    const rows = await this.pool.query(
      `select ${COLS} from ledger_outbox where user_id = $1 and ${where} order by id desc limit $2 offset $3`,
      [userId, limit, offset],
    );
    const counts = await this.pool.query(
      `select count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'pending' and attempts > 0)::int as retrying,
              count(*) filter (where status = 'pending' and blocked_on is not null)::int as blocked,
              count(*) filter (where status = 'skipped')::int as skipped,
              count(*) filter (where status = 'pending')::int as pending
         from ledger_outbox where user_id = $1`,
      [userId],
    );
    const autoInvoice = await this.autoInvoiceFailures(userId);
    return {
      tab,
      counts: { ...counts.rows[0], autoInvoiceFailed: autoInvoice.length },
      autoInvoice,
      items: rows.rows.map((r: any) => ({
        ...r,
        state: r.status === "failed" ? "failed" : r.status === "skipped" ? "skipped" : r.blockedOn ? "blocked" : "retrying",
        message: r.lastErrorCode ? ERROR_TEXT[r.lastErrorCode] ?? ERROR_TEXT.POST_ERROR : null,
      })),
    };
  }

  /**
   * Automatic-invoicing failures (finance_auto_invoice_links, 0073): not ledger
   * events, so they are listed beside the outbox rows rather than in them. Their
   * Retry is "issue now" and their Dismiss is /finance/v2/auto-invoice/:paymentId/dismiss.
   */
  private async autoInvoiceFailures(userId: number): Promise<any[]> {
    try {
      const r = await this.pool.query(
        `select l.payment_id::int as "paymentId", l.document_id::int as "documentId", l.origin, l.attempts, l.last_error_code as "errorCode",
                l.last_error as "error", l.updated_at as "updatedAt", to_char(p.due_date,'YYYY-MM-DD') as "dueDate", p.amount::text as amount,
                p.contract_id::int as "contractId", c.contract_number as "contractNumber", c.tenant_name as "tenantName"
           from finance_auto_invoice_links l
           join payments p on p.id = l.payment_id and p.user_id = l.user_id
           left join contracts c on c.id = p.contract_id and c.user_id = p.user_id
          where l.user_id = $1 and l.status = 'failed' order by l.updated_at desc limit 500`,
        [userId],
      );
      return r.rows.map((x: any) => ({ ...x, message: AUTO_INVOICE_ERROR_TEXT[x.errorCode] ?? AUTO_INVOICE_ERROR_TEXT.ISSUE_FAILED }));
    } catch (err: any) {
      if (err?.code === "42P01") return []; // 0073 not applied
      throw err;
    }
  }

  /** Retry: attempts reset, due now. Only failed or pending rows. */
  async retry(userId: number, actorId: number, id: number) {
    return withTx(this.pool, async (c) => {
      const r = await c.query(`select status from ledger_outbox where id = $1 and user_id = $2 for update`, [id, userId]);
      if (!r.rows[0]) throw new NotFoundException();
      if (!["failed", "pending"].includes(r.rows[0].status)) throw new ConflictException(`cannot retry a ${r.rows[0].status} event`);
      await c.query(
        `update ledger_outbox set status = 'pending', attempts = 0, next_attempt_at = now() where id = $1`,
        [id],
      );
      await this.audit(c, userId, actorId, id, "retry");
      return (await c.query(`select ${COLS} from ledger_outbox where id = $1`, [id])).rows[0];
    });
  }

  /** Dismiss with a reason (5–500 chars). A reversal waiting on it then skips `nothing_to_reverse` (§5.4). */
  async dismiss(userId: number, actorId: number, id: number, body: any) {
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 5 || reason.length > 500) throw new BadRequestException("reason must be 5 to 500 characters");
    return withTx(this.pool, async (c) => {
      const r = await c.query(`select status from ledger_outbox where id = $1 and user_id = $2 for update`, [id, userId]);
      if (!r.rows[0]) throw new NotFoundException();
      if (!["failed", "pending"].includes(r.rows[0].status)) throw new ConflictException(`cannot dismiss a ${r.rows[0].status} event`);
      await c.query(
        `update ledger_outbox set status = 'dismissed', dismissed_by = $2, dismissed_reason = $3, processed_at = now() where id = $1`,
        [id, actorId, reason],
      );
      await this.audit(c, userId, actorId, id, "dismiss");
      return (await c.query(`select ${COLS} from ledger_outbox where id = $1`, [id])).rows[0];
    });
  }

  private async audit(c: { query: Fv2Pool["query"] }, userId: number, actorId: number, id: number, action: "retry" | "dismiss") {
    await c.query(
      `insert into audit_logs (owner_user_id, actor_user_id, action, entity, entity_id, method, path)
       values ($1, $2, 'update', 'finance_v2_posting', $3, 'POST', $4)`,
      [userId, actorId, String(id), `/finance/v2/posting-errors/${id}/${action}`],
    );
  }
}
