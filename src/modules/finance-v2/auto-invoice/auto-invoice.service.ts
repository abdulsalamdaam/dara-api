import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional,
  type OnModuleDestroy, type OnModuleInit,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { BillingModule } from "../../billing/billing.module";
import { feeLineTreatment } from "../../contracts/installments";
import { readinessMessage } from "../../../common/invoice-readiness";
import { FV2_POOL, withTx, type Fv2Pool } from "../db";
import { riyadhToday } from "../dates";
import { auditRow, requireReason, settingsEvent } from "../audit";
import { sqlOf } from "../hooks/sql";
import { DEPOSIT_DESC } from "../hooks/classify";
import { createRentReceipt, sellerOf } from "../overrides/documents-v2";
import { fromHalalas, toHalalas } from "../money";
import { AUTO_INVOICE_ERROR_TEXT } from "./errors";
import { dueNotInvoicedSql } from "../due-uninvoiced";

export { AUTO_INVOICE_ERROR_TEXT };

/**
 * Automatic invoicing of due installments (the accountant's requirement
 * "فوترة تلقائية للأقساط المستحقة وتنبيه للمستحق غير المفوتر", and his control
 * "every due installment is invoiced").
 *
 *  - A per-account setting, OFF by default (a missing row is off), with a lead
 *    time: issue N days before the due date (0 = on the due date).
 *  - A daily run at 00:05 Riyadh, before the recognizer (00:10), issues the
 *    invoice for every due-and-uninvoiced installment of accounts that have it
 *    on. It goes through the SAME handlers a user's "create invoice from
 *    installment" + "approve" go through (the billing controller's own
 *    `create` / `approve`, or for a landlord with no VAT number the v2 rent
 *    receipt + the same `approve`), so numbering, the readiness gate, VAT,
 *    the seller (the landlord in Manager mode), ZATCA, the v2 commission and
 *    the E01/E08 ledger event behave exactly as they do for a person.
 *  - Ledger: the invoice is a charge document (DESIGN §4.1 rule 1). Issued on
 *    or before the due date, it wins, and the recognizer (which charges only
 *    `due_date < today` with no confirmed covering document) never charges the
 *    installment. Issued after a due-date charge (a backlog "issue now"), the
 *    worker reverses the E02 and posts the document in full
 *    (reverse-and-replace). Either way the installment is charged once.
 *  - Idempotency: `finance_auto_invoice_links` has the installment as its
 *    primary key. A group is claimed in one transaction before anything is
 *    created, so a retry, a second process or a double click never makes a
 *    second invoice; a draft left by a refused approval is re-used, not
 *    re-created.
 *  - Messages: none. Neither `create` nor `approve` (nor ZATCA, nor the v2
 *    hooks and commission) emails, texts or pushes anybody; the DB spec pins it
 *    with the senders stubbed. This service adds none.
 *  - Failures never throw out of the daily run: they are written on the link
 *    row (`failed`, code + message) and shown on the posting-errors list, with
 *    Retry ("issue now") and Dismiss.
 */

/** The billing controller surface used here (its real handlers). */
export interface BillingPort {
  readiness(user: any, contractId?: string, paymentId?: string, tenantId?: string, ownerId?: string): Promise<any>;
  create(user: any, body: any): Promise<any>;
  approve(user: any, id: string, body: any): Promise<any>;
}

export interface AutoInvoiceSettings {
  enabled: boolean;
  leadDays: number;
  startFrom: string | null;
}

export interface IssueResult {
  paymentIds: number[];
  contractId: number;
  dueDate: string;
  status: "issued" | "failed" | "covered" | "busy";
  documentId?: number | null;
  number?: string | null;
  kind?: string | null;
  zatca?: unknown;
  errorCode?: string;
  error?: string;
}

interface Candidate {
  id: number;
  contract_id: number;
  due: string;
  amount: string;
  description: string | null;
  status: string;
  vat_enabled: boolean;
  contract_number: string | null;
  tenant_name: string | null;
  property_name: string | null;
  link_status: string | null;
  link_document_id: number | null;
  link_error_code: string | null;
  link_error: string | null;
  link_attempts: number | null;
  link_origin: string | null;
  link_claimed_at: Date | null;
  draft_id: number | null;
  draft_number: string | null;
}

const CHECK_MS = 60_000;
/** Minutes after Riyadh midnight when the daily run is due: 00:05, before the recognizer's 00:10. */
const RUN_AFTER_MIN = 5;
/** A claim older than this is a crashed attempt and may be taken again. */
const STALE_CLAIM = "15 minutes";
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;


class ClaimBusy extends Error {}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The code and message of whatever the billing handler threw. */
function errorOf(err: any, fallback: string): { code: string; message: string } {
  const res = typeof err?.getResponse === "function" ? err.getResponse() : null;
  const inner = res && typeof res === "object" ? (res as any) : null;
  const code = typeof inner?.error === "string" && /^[A-Za-z_]+$/.test(inner.error) ? String(inner.error) : fallback;
  const msg = inner?.message ?? (typeof res === "string" ? res : err?.message) ?? String(err);
  return { code, message: (Array.isArray(msg) ? msg.join("; ") : String(msg)).slice(0, 1000) };
}

@Injectable()
export class AutoInvoiceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2AutoInvoice");
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;
  private running = false;
  /** Set directly by the DB specs; resolved lazily from the Nest container otherwise. */
  billing: BillingPort | null = null;

  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, @Optional() private readonly moduleRef?: ModuleRef) {}

  onModuleInit(): void {
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_AUTOINVOICE_DISABLED === "1") return;
    this.timer = setInterval(() => void this.maybeRunDaily(), CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private port(): BillingPort {
    if (this.billing) return this.billing;
    const Ctl = (Reflect as any).getMetadata("controllers", BillingModule)?.[0];
    if (!Ctl || !this.moduleRef) throw new Error("fv2 auto-invoice: the billing controller is not available");
    this.billing = this.moduleRef.get(Ctl, { strict: false }) as BillingPort;
    return this.billing;
  }

  /** The system actor of the daily run: the account itself (scopeId = the account). */
  private systemUser(scope: number) {
    return { id: scope, ownerUserId: null, ownerScopeId: null, role: "user", permissions: [] as string[], fv2AutoInvoice: true };
  }

  private async maybeRunDaily(): Promise<void> {
    const day = riyadhToday();
    const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.lastRunDay === day || h * 60 + m < RUN_AFTER_MIN || this.running) return;
    this.running = true;
    try {
      const r = await this.pool.query(
        `select a.user_id from finance_auto_invoice_settings a
           join finance_settings s on s.account_user_id = a.user_id and s.finance_v2_enabled
          where a.enabled order by a.user_id`,
      );
      for (const x of r.rows) {
        try {
          await this.runAccount(Number(x.user_id), day);
        } catch (err: any) {
          this.log.warn(`auto-invoice failed for scope ${x.user_id}: ${err?.message ?? err}`);
        }
      }
      this.lastRunDay = day;
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`auto-invoice run failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async getSettings(scope: number): Promise<AutoInvoiceSettings> {
    const r = await this.pool.query(
      `select enabled, lead_days, to_char(start_from,'YYYY-MM-DD') as start_from from finance_auto_invoice_settings where user_id = $1`, [scope]);
    const row = r.rows[0];
    return { enabled: row?.enabled === true, leadDays: Number(row?.lead_days ?? 0), startFrom: row?.start_from ?? null };
  }

  /** PATCH {enabled?, leadDays?, reason}. Turning it on (again) sets `startFrom` to today: no backlog is mass-issued. */
  async patchSettings(scope: number, actorId: number, body: any): Promise<AutoInvoiceSettings> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException({ error: "BAD_INPUT", message: "The body must be an object" });
    const unknown = Object.keys(body).filter((k) => !["enabled", "leadDays", "reason"].includes(k));
    if (unknown.length) throw new BadRequestException({ error: "UNKNOWN_FIELD", message: `Unknown field: ${unknown[0]}` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadRequestException({ error: "BAD_VALUE", message: "enabled must be a boolean" });
    if (body.leadDays !== undefined && !(Number.isInteger(body.leadDays) && body.leadDays >= 0 && body.leadDays <= 60)) {
      throw new BadRequestException({ error: "BAD_VALUE", message: "leadDays must be a whole number from 0 to 60" });
    }
    if (body.enabled === undefined && body.leadDays === undefined) throw new BadRequestException({ error: "NOTHING_TO_CHANGE", message: "Name at least one setting to change" });
    const reason = requireReason(body);
    await withTx(this.pool, async (c) => {
      await c.query(`insert into finance_auto_invoice_settings (user_id) values ($1) on conflict (user_id) do nothing`, [scope]);
      const cur = (await c.query(`select enabled, lead_days, to_char(start_from,'YYYY-MM-DD') as start_from from finance_auto_invoice_settings where user_id = $1 for update`, [scope])).rows[0];
      let changed = false;
      if (body.enabled !== undefined && body.enabled !== cur.enabled) {
        changed = true;
        const startFrom = body.enabled ? riyadhToday() : cur.start_from;
        await c.query(`update finance_auto_invoice_settings set enabled = $2, start_from = $3, updated_by = $4, updated_at = now() where user_id = $1`,
          [scope, body.enabled, startFrom, actorId]);
        await settingsEvent(c, scope, actorId, "auto_invoice_enabled", cur.enabled, body.enabled, reason);
      }
      if (body.leadDays !== undefined && body.leadDays !== Number(cur.lead_days)) {
        changed = true;
        await c.query(`update finance_auto_invoice_settings set lead_days = $2, updated_by = $3, updated_at = now() where user_id = $1`, [scope, body.leadDays, actorId]);
        await settingsEvent(c, scope, actorId, "auto_invoice_lead_days", Number(cur.lead_days), body.leadDays, reason);
      }
      if (changed) await auditRow(c, scope, actorId, "finance_v2_auto_invoice", scope, "/finance/v2/auto-invoice/settings", "PATCH");
    });
    return this.getSettings(scope);
  }

  // ─── What is due and not invoiced ─────────────────────────────────────────

  /**
   * Installments due on or before `horizon` with no confirmed charge document
   * (tax invoice or rent receipt) covering them: not cancelled, not deleted,
   * not a deposit row, not Ejar-settled (Ejar issues those), not a draft or
   * demo contract, not after an ended contract's end, not before a cutover
   * go-live (those are in the opening balance). A draft document covering one
   * is reported (`draft_id`), since a draft is not an issued invoice.
   */
  private async candidates(scope: number, horizon: string, extra = "", params: unknown[] = []): Promise<Candidate[]> {
    const r = await this.pool.query(
      `select p.id, p.contract_id, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount, p.description, p.status::text as status,
              p.vat_enabled, c.contract_number, c.tenant_name, pr.name as property_name,
              l.status as link_status, l.document_id as link_document_id, l.last_error_code as link_error_code, l.last_error as link_error,
              l.attempts as link_attempts, l.origin as link_origin, l.claimed_at as link_claimed_at,
              dr.id as draft_id, dr.number as draft_number
         from payments p
         join contracts c on c.id = p.contract_id and c.user_id = p.user_id
         left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
         left join properties pr on pr.id = d.property_id and pr.user_id = p.user_id
         left join finance_auto_invoice_links l on l.payment_id = p.id and l.user_id = p.user_id
         left join lateral (
           select si.id, si.number from simple_invoices si
            where si.user_id = p.user_id and si.deleted_at is null and si.status = 'draft' and si.type = 'invoice'
              and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
              and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id))
            order by si.id limit 1) dr on true
         left join finance_settings s on s.account_user_id = p.user_id
        where p.user_id = $1 and p.due_date <= $2::date
          and ${dueNotInvoicedSql({ depositParam: "$3", goLive: "s.ledger_go_live_date" })}
          ${extra}
        order by p.due_date, p.contract_id, p.id`,
      [scope, horizon, DEPOSIT_DESC, ...params],
    );
    return r.rows as Candidate[];
  }

  /** GET …/uninvoiced: due on or before today and not invoiced (the list and the badge). */
  async uninvoiced(scope: number, q: { limit?: unknown; offset?: unknown } = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const all = await this.candidates(scope, riyadhToday());
    const settings = await this.getSettings(scope);
    const total = all.reduce((s, r) => s + toHalalas(r.amount), 0);
    return {
      settings,
      count: all.length,
      amount: fromHalalas(total),
      items: all.slice(offset, offset + limit).map((r) => ({
        paymentId: r.id, contractId: r.contract_id, contractNumber: r.contract_number, tenantName: r.tenant_name, propertyName: r.property_name,
        dueDate: r.due, amount: r.amount, description: r.description, status: r.status, vatEnabled: r.vat_enabled,
        draft: r.draft_id ? { id: r.draft_id, number: r.draft_number } : null,
        auto: r.link_status ? {
          status: r.link_status, origin: r.link_origin, attempts: r.link_attempts, errorCode: r.link_error_code, error: r.link_error,
          message: r.link_error_code ? AUTO_INVOICE_ERROR_TEXT[r.link_error_code] ?? AUTO_INVOICE_ERROR_TEXT.ISSUE_FAILED : null,
        } : null,
      })),
    };
  }

  /** GET …/summary: just the badge numbers. */
  async summary(scope: number) {
    const all = await this.candidates(scope, riyadhToday());
    const failed = await this.pool.query(`select count(*)::int as n from finance_auto_invoice_links where user_id = $1 and status = 'failed'`, [scope]);
    return { count: all.length, amount: fromHalalas(all.reduce((s, x) => s + toHalalas(x.amount), 0)), failed: Number(failed.rows[0]?.n ?? 0) };
  }

  // ─── Issuing ──────────────────────────────────────────────────────────────

  /**
   * The daily run for one account, as of `today` (Riyadh): every installment
   * due by `today + leadDays`, due on or after `startFrom`, not invoiced, and
   * not already issued, covered, dismissed or being issued. One invoice per
   * contract and due date, as the installments screen's combined invoice.
   */
  async runAccount(scope: number, today = riyadhToday()): Promise<IssueResult[]> {
    const s = await this.getSettings(scope);
    if (!s.enabled) return [];
    const flag = await this.pool.query(`select 1 from finance_settings where account_user_id = $1 and finance_v2_enabled`, [scope]);
    if (!flag.rowCount) return [];
    const horizon = addDays(today, s.leadDays);
    const rows = await this.candidates(scope, horizon,
      `and p.due_date >= coalesce($4::date, $5::date)
       and (l.status is null or l.status in ('failed','draft') or (l.status = 'claimed' and l.claimed_at < now() - interval '${STALE_CLAIM}'))`,
      [s.startFrom, today]);
    return this.issueGroups(scope, this.systemUser(scope), rows, "auto", today);
  }

  /** POST …/issue {paymentIds}: "issue now" from the list (also the Retry of a failure). */
  async issueNow(scope: number, user: any, body: any): Promise<{ results: IssueResult[] }> {
    const perms: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
    if (!perms.includes("invoices.write")) throw new ForbiddenException("Missing permission: invoices.write");
    const ids: number[] = Array.isArray(body?.paymentIds)
      ? [...new Set<number>(body.paymentIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] : [];
    if (!ids.length) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "حدد الأقساط · paymentIds is required" });
    if (ids.length > 200) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "200 installments at most per request" });
    const today = riyadhToday();
    const s = await this.getSettings(scope);
    const rows = await this.candidates(scope, addDays(today, s.leadDays), `and p.id = any($4::int[])`, [`{${ids.join(",")}}`]);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new ConflictException({
        error: "FINANCE_V2_NOT_UNINVOICED",
        message: "بعض الأقساط ليست مستحقة غير مفوترة · Some installments are not due-and-uninvoiced", paymentIds: missing,
      });
    }
    const results = await this.issueGroups(scope, user, rows, "bulk", today);
    await withTx(this.pool, (c) => auditRow(c, scope, Number(user?.id ?? scope), "finance_v2_auto_invoice", ids.join(","), "/finance/v2/auto-invoice/issue"));
    return { results };
  }

  /** POST …/:paymentId/dismiss {reason}: the daily run leaves the installment alone (it stays on the list). */
  async dismiss(scope: number, actorId: number, paymentId: number, body: any) {
    const reason = requireReason(body);
    return withTx(this.pool, async (c) => {
      const r = await c.query(`select status from finance_auto_invoice_links where payment_id = $1 and user_id = $2 for update`, [paymentId, scope]);
      if (!r.rows[0]) throw new NotFoundException();
      if (r.rows[0].status !== "failed") throw new ConflictException(`cannot dismiss a ${r.rows[0].status} auto-invoice`);
      await c.query(`update finance_auto_invoice_links set status = 'dismissed', dismissed_by = $3, dismissed_reason = $4, updated_at = now()
                      where payment_id = $1 and user_id = $2`, [paymentId, scope, actorId, reason]);
      await auditRow(c, scope, actorId, "finance_v2_auto_invoice", paymentId, `/finance/v2/auto-invoice/${paymentId}/dismiss`);
      return { ok: true };
    });
  }

  private async issueGroups(scope: number, user: any, rows: Candidate[], origin: "auto" | "bulk", today: string): Promise<IssueResult[]> {
    const groups = new Map<string, Candidate[]>();
    for (const r of rows) {
      const k = `${r.contract_id}|${r.due}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const out: IssueResult[] = [];
    for (const g of groups.values()) {
      try {
        out.push(await this.issueGroup(scope, user, g, origin, today));
      } catch (err: any) {
        // Never let one group stop the run (the claim step itself failed, e.g. the table is missing).
        this.log.warn(`auto-invoice group failed for scope ${scope}: ${err?.message ?? err}`);
        out.push({ paymentIds: g.map((x) => x.id), contractId: g[0].contract_id, dueDate: g[0].due, status: "failed", errorCode: "ISSUE_FAILED", error: String(err?.message ?? err) });
      }
    }
    return out;
  }

  /** Claim the group's installments (all or none). Returns the claimed rows' previous draft document, or null when another attempt holds one. */
  private async claim(scope: number, ids: number[], origin: "auto" | "bulk"): Promise<{ draftId: number | null } | null> {
    try {
      return await withTx(this.pool, async (c) => {
        const r = await c.query(
          `insert into finance_auto_invoice_links as l (payment_id, user_id, status, origin, attempts, claimed_at)
           select x, $2, 'claimed', $3, 1, now() from unnest($1::int[]) x
           on conflict (payment_id) do update set status = 'claimed', origin = excluded.origin, attempts = l.attempts + 1,
                  claimed_at = now(), updated_at = now()
            where l.user_id = excluded.user_id
              and (l.status in ('failed','draft')
                   or (excluded.origin = 'bulk' and l.status in ('dismissed','issued','covered'))
                   or (l.status = 'claimed' and l.claimed_at < now() - interval '${STALE_CLAIM}'))
           returning payment_id, document_id`,
          [`{${ids.join(",")}}`, scope, origin],
        );
        if (r.rowCount !== ids.length) throw new ClaimBusy(); // all or none: the transaction rolls back
        const drafts = [...new Set(r.rows.map((x: any) => x.document_id).filter((x: any) => x != null).map(Number))];
        return { draftId: drafts.length === 1 ? drafts[0] : null };
      });
    } catch (err) {
      if (err instanceof ClaimBusy) return null;
      throw err;
    }
  }

  private async mark(scope: number, ids: number[], set: { status: string; documentId?: number | null; code?: string | null; error?: string | null; zatca?: unknown }) {
    await this.pool.query(
      `update finance_auto_invoice_links set status = $3,
              document_id = coalesce($4, document_id),
              last_error_code = $5, last_error = $6,
              zatca = coalesce($7::jsonb, zatca),
              issued_at = case when $3 = 'issued' then now() else issued_at end,
              updated_at = now()
        where user_id = $1 and payment_id = any($2::int[])`,
      [scope, `{${ids.join(",")}}`, set.status, set.documentId ?? null, set.code ?? null, set.error ?? null,
        set.zatca === undefined ? null : JSON.stringify(set.zatca)],
    );
  }

  private async issueGroup(scope: number, user: any, group: Candidate[], origin: "auto" | "bulk", today: string): Promise<IssueResult> {
    const contractId = Number(group[0].contract_id);
    const dueDate = group[0].due;
    let ids = group.map((x) => Number(x.id));
    const base = { contractId, dueDate };
    const claimed = await this.claim(scope, ids, origin);
    if (!claimed) return { ...base, paymentIds: ids, status: "busy" };
    let draftId = claimed.draftId;

    // Re-check coverage now that the installments are ours: a person may have issued or drafted a document meanwhile.
    const q = sqlOf(this.pool as any);
    const covering = await q.rows(
      `select si.id, si.number, si.status::text as status,
              array(select x from unnest($2::int[]) x
                     where si.payment_id = x or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(x)) as ids
         from simple_invoices si
        where si.user_id = $1 and si.deleted_at is null and si.status <> 'cancelled' and si.type = 'invoice'
          and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
          and (si.payment_id = any($2::int[]) or exists (select 1 from jsonb_array_elements_text(coalesce(si.payment_ids, '[]'::jsonb)) e
                                                          where e::int = any($2::int[])))`,
      [scope, ids],
    );
    const own = draftId != null ? covering.find((d: any) => Number(d.id) === draftId && d.status === "draft") : null;
    if (draftId != null && !own) draftId = null; // our draft was deleted or approved by hand
    let userDraft: any = null;
    for (const d of covering) {
      if (own && Number(d.id) === Number(own.id)) continue;
      const dIds = (d.ids as number[]).map(Number);
      if (d.status === "confirmed") await this.mark(scope, dIds, { status: "covered", documentId: Number(d.id) });
      else {
        userDraft = d;
        await this.mark(scope, dIds, { status: "failed", documentId: Number(d.id), code: "DRAFT_EXISTS", error: `مسودة ${d.number} · draft ${d.number}` });
      }
      ids = ids.filter((x) => !dIds.includes(x));
    }
    if (!ids.length) {
      return userDraft
        ? { ...base, paymentIds: group.map((x) => x.id), status: "failed", documentId: Number(userDraft.id), number: userDraft.number, errorCode: "DRAFT_EXISTS" }
        : { ...base, paymentIds: group.map((x) => x.id), status: "covered" };
    }
    if (own) ids = ids.filter((x) => (own.ids as number[]).map(Number).includes(x)); // an adopted draft covers what it covers
    const lines = group.filter((x) => ids.includes(Number(x.id)));

    let docId: number | null = own ? Number(own.id) : null;
    let stage: "prepare" | "create" | "approve" = "prepare";
    try {
      const billing = this.port();
      const seller = await sellerOf(q, scope, contractId);
      let approveBody: any = {};
      if (docId == null) {
        if (!seller.vatRegistered) {
          // A landlord with no VAT number issues the v2 non-tax rent receipt (DESIGN §9 E9) — the only document v2 lets him issue.
          stage = "create";
          const rr = await createRentReceipt(q, scope, { paymentIds: ids, issueDate: today });
          docId = Number(rr.id);
        } else {
          const body = await this.taxInvoiceBody(scope, contractId, lines, today);
          // Pre-check with the controller's own gates, so a refused approval never leaves a draft (or a spent number) behind.
          const readiness = await billing.readiness(user, String(contractId));
          const lineBlocker = typeof (billing as any).unexplainedLinesBlocker === "function"
            ? (billing as any).unexplainedLinesBlocker({ id: null, items: body.items }) : null;
          if (lineBlocker) {
            await this.mark(scope, ids, { status: "failed", code: "LINE_REASON", error: `بنود بلا سبب إعفاء: ${lineBlocker.name}` });
            return { ...base, paymentIds: ids, status: "failed", errorCode: "LINE_REASON", error: String(lineBlocker.name) };
          }
          if (readiness && readiness.ok === false) {
            const msg = readinessMessage(readiness);
            await this.mark(scope, ids, { status: "failed", code: "NOT_READY", error: msg });
            return { ...base, paymentIds: ids, status: "failed", errorCode: "NOT_READY", error: msg };
          }
          stage = "create";
          const doc = await billing.create(user, body);
          docId = Number(doc.id);
        }
        await this.mark(scope, ids, { status: "draft", documentId: docId });
      }
      stage = "approve";
      // The daily run IS the account's standing decision to issue these; an individual tenant with no VAT number
      // is acknowledged by it (the one confirmation the manual dialog asks for).
      if (seller.vatRegistered) approveBody = { confirmations: { tenantNoVat: true } };
      const ap = await billing.approve(user, String(docId), approveBody);
      await this.mark(scope, ids, { status: "issued", documentId: docId, zatca: ap?.zatca ?? null });
      return { ...base, paymentIds: ids, status: "issued", documentId: docId, number: ap?.number ?? null, kind: ap?.kind ?? null, zatca: ap?.zatca ?? null };
    } catch (err: any) {
      const { code, message } = errorOf(err, stage === "approve" ? "APPROVE_REFUSED" : stage === "create" ? "CREATE_REFUSED" : "ISSUE_FAILED");
      const known = AUTO_INVOICE_ERROR_TEXT[code] ? code : stage === "approve" ? "APPROVE_REFUSED" : stage === "create" ? "CREATE_REFUSED" : "ISSUE_FAILED";
      await this.mark(scope, ids, { status: "failed", documentId: docId, code: known, error: code === known ? message : `${code}: ${message}` });
      return { ...base, paymentIds: ids, status: "failed", documentId: docId, errorCode: known, error: message };
    }
  }

  /**
   * The create body of a rent invoice for installments, built exactly as the
   * web's "invoice this installment" does (InstallmentsView / contract finance
   * panel, and payment-confirmations on the API): the full face value, the net
   * on the line when the installment carries VAT, rent without VAT stated as
   * the Article-30 exemption, a fee as the landlord set it on the contract.
   */
  private async taxInvoiceBody(scope: number, contractId: number, lines: Candidate[], issueDate: string) {
    const [c] = (await this.pool.query(
      `select tenant_id, tenant_name, tenant_phone, tenant_email, tenant_address, tenant_tax_number, additional_fees
         from contracts where id = $1 and user_id = $2`, [contractId, scope])).rows;
    const items = lines.map((l) => {
      const gross = round2(Number(l.amount));
      const vat = l.vat_enabled === true;
      const net = vat ? round2(gross / 1.15) : gross;
      const treatment = vat ? { vatCategory: "S" as const }
        : !l.description ? { vatCategory: "E" as const, exemptionReason: "VATEX-SA-30" }
          : feeLineTreatment(c?.additional_fees, l.description);
      return { description: l.description || "إيجار", quantity: 1, unitPrice: net, amount: net, vat, ...treatment };
    });
    const total = round2(items.reduce((s, it) => s + (it.vat ? it.amount * 1.15 : it.amount), 0));
    return {
      type: "invoice",
      items,
      total,
      paymentIds: lines.map((l) => Number(l.id)),
      paymentId: Number(lines[0].id),
      contractId,
      tenantId: c?.tenant_id ?? null,
      tenantName: c?.tenant_name ?? null,
      issueDate,
      dueDate: lines[0].due,
      client: c ? {
        phone: c.tenant_phone ?? undefined, email: c.tenant_email ?? undefined,
        address: c.tenant_address ?? undefined, vatNumber: c.tenant_tax_number ?? undefined,
      } : null,
    };
  }
}
