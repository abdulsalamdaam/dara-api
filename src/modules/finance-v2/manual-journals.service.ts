import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { classifyKey } from "../uploads/key-scope";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { JournalRepository, type LineInput } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { capabilities, isAccountHolder } from "./capabilities";
import { fromHalalas, toHalalas } from "./money";
import { auditRow, isoDate, mapLedgerError, requireReason } from "./audit";

export type ManualKind = "manual" | "opening";

/** Attachment required on approval above this total (DESIGN §8.1, Q17 policy default): 10,000 SAR. */
export const ATTACHMENT_THRESHOLD_HALALAS = 1_000_000;

const DIMS = ["ownerId", "propertyId", "unitId", "tenantId", "contractId"] as const;
type DimKey = (typeof DIMS)[number] | "paymentId";

export interface StoredLine {
  accountId: number;
  debit: string;
  credit: string;
  memo: string | null;
  ownerId?: number;
  propertyId?: number;
  unitId?: number;
  tenantId?: number;
  contractId?: number;
  paymentId?: number;
}

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

const COLS = `id, kind, status, to_char(entry_date,'YYYY-MM-DD') as "entryDate", memo, attachment_key as "attachmentKey", lines,
  created_by as "createdBy", submitted_at as "submittedAt", approved_by as "approvedBy", approved_at as "approvedAt",
  rejected_by as "rejectedBy", rejected_reason as "rejectedReason", posted_entry_id::int as "postedEntryId",
  created_at as "createdAt", updated_at as "updatedAt"`;

function withTotal(r: any) {
  if (!r) return r;
  const total = (r.lines as StoredLine[]).reduce((s, l) => s + toHalalas(l.debit), 0);
  return { ...r, total: fromHalalas(total) };
}

/**
 * Manual journal entries (قيد يدوي) and the opening-balance entry (DESIGN
 * §8.1, §6.7). A draft goes to submitted, then approval posts it at once
 * through JournalRepository (a user action that succeeds or fails visibly,
 * not the outbox), keyed `manual_journal,<id>,posted` (`opening_balance`
 * for the opening). Before it posts it can be rejected or voided; after, it
 * is corrected only by a reversal (`POST /journal/:id/reverse`).
 *
 *  - Amounts are decimal strings, validated in integer halalas; Σ debit =
 *    Σ credit > 0, one side per line; accounts leaf, active, in scope; every
 *    dimension id belongs to the scope (one query per dimension type).
 *  - The approver needs `approve` and must not be the drafter, unless the
 *    approver is the account holder (an owner-mobile token never is).
 *  - An attachment (an `acct/<scope>/…` upload key) is required on approval
 *    above 10,000 SAR.
 *  - Period: open, or closed when the approver holds `settings` (an audit
 *    adjustment; never the opening); never locked. Manual entries are never
 *    moved to a later period (§4.7).
 */
@Injectable()
export class ManualJournalsService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly journal: JournalRepository,
    private readonly periods: PeriodsService,
  ) {}

  async list(scope: number, q: { status?: string; kind?: string; limit?: string | number; offset?: string | number } = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const where = ["user_id = $1"];
    const p: unknown[] = [scope];
    if (q.status) { p.push(String(q.status)); where.push(`status = $${p.length}`); }
    if (q.kind) { p.push(String(q.kind)); where.push(`kind = $${p.length}`); }
    const rows = await this.pool.query(`select ${COLS} from manual_journals where ${where.join(" and ")} order by id desc limit ${limit} offset ${offset}`, p);
    const n = await this.pool.query(`select count(*)::int as n from manual_journals where ${where.join(" and ")}`, p);
    return { total: n.rows[0].n, items: rows.rows.map(withTotal) };
  }

  async get(scope: number, id: number, q: Q = this.pool) {
    const r = await q.query(`select ${COLS} from manual_journals where id = $1 and user_id = $2`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException("Manual journal not found");
    return withTotal(r.rows[0]);
  }

  async create(scope: number, user: AuthUser, body: any, kind: ManualKind = "manual") {
    return withTx(this.pool, async (c) => {
      const v = await this.validate(c, scope, body, kind);
      await this.assertNotLocked(c, scope, v.entryDate);
      const r = await c.query(
        `insert into manual_journals (user_id, kind, status, entry_date, memo, attachment_key, lines, created_by)
         values ($1, $2, 'draft', $3, $4, $5, $6::jsonb, $7) returning id`,
        [scope, kind, v.entryDate, v.memo, v.attachmentKey, JSON.stringify(v.lines), user.id],
      );
      return this.get(scope, Number(r.rows[0].id), c);
    });
  }

  /** Edit a draft (or a rejected one, which returns to draft). */
  async update(scope: number, user: AuthUser, id: number, body: any) {
    return withTx(this.pool, async (c) => {
      const cur = await this.lockRow(c, scope, id);
      if (cur.status !== "draft" && cur.status !== "rejected") throw new ConflictException({ error: "NOT_EDITABLE", message: `A ${cur.status} journal cannot be edited` });
      const merged = {
        entryDate: body?.entryDate ?? cur.entryDate,
        memo: body?.memo ?? cur.memo,
        attachmentKey: body && "attachmentKey" in body ? body.attachmentKey : cur.attachmentKey,
        lines: body?.lines ?? cur.lines,
      };
      const v = await this.validate(c, scope, merged, cur.kind);
      await this.assertNotLocked(c, scope, v.entryDate);
      await c.query(
        `update manual_journals set entry_date = $3, memo = $4, attachment_key = $5, lines = $6::jsonb, status = 'draft',
                rejected_by = null, rejected_reason = null, updated_at = now()
          where id = $1 and user_id = $2`,
        [id, scope, v.entryDate, v.memo, v.attachmentKey, JSON.stringify(v.lines)],
      );
      return this.get(scope, id, c);
    });
  }

  async submit(scope: number, user: AuthUser, id: number) {
    return withTx(this.pool, async (c) => {
      const cur = await this.lockRow(c, scope, id);
      if (cur.status !== "draft") throw new ConflictException({ error: "NOT_DRAFT", message: `A ${cur.status} journal cannot be submitted` });
      await this.validate(c, scope, cur, cur.kind);
      await this.assertNotLocked(c, scope, cur.entryDate);
      await c.query(`update manual_journals set status = 'submitted', submitted_at = now(), updated_at = now() where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "finance_v2_manual_journal", id, `/finance/v2/manual-journals/${id}/submit`);
      return this.get(scope, id, c);
    });
  }

  async approve(scope: number, user: AuthUser, id: number) {
    try {
      return await withTx(this.pool, async (c) => {
        const cur = await this.lockRow(c, scope, id);
        if (cur.status !== "submitted") throw new ConflictException({ error: "NOT_SUBMITTED", message: `A ${cur.status} journal cannot be approved` });
        if (cur.createdBy === user.id && !isAccountHolder(user)) {
          throw new ForbiddenException({ error: "SAME_APPROVER", message: "The approver must differ from the person who drafted the entry" });
        }
        const v = await this.validate(c, scope, cur, cur.kind);
        const total = v.lines.reduce((s, l) => s + toHalalas(l.debit), 0);
        if (total > ATTACHMENT_THRESHOLD_HALALAS && !v.attachmentKey) {
          throw new BadRequestException({ error: "ATTACHMENT_REQUIRED", message: "An attachment is required above 10,000 SAR" });
        }
        const period = await this.periods.ensurePeriod(c, scope, v.entryDate);
        if (period.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "The period is locked; re-date the entry" });
        if (period.status === "closed") {
          if (cur.kind === "opening") throw new ConflictException({ error: "PERIOD_CLOSED", message: "The opening entry needs an open period" });
          if (!capabilities(user).includes("settings")) {
            throw new ConflictException({ error: "PERIOD_CLOSED", message: "The period is closed; only a finance settings holder can post an adjustment into it" });
          }
        }
        if (cur.kind === "opening") {
          const other = await c.query(`select 1 from journal_entries where user_id = $1 and origin = 'opening' and status = 'posted' limit 1`, [scope]);
          if (other.rowCount) throw new ConflictException({ error: "OPENING_EXISTS", message: "An opening entry is already posted; reverse it first" });
          const earlier = await c.query(
            `select 1 from journal_entries where user_id = $1 and entry_date < $2 and origin not in ('opening','reversal') and status = 'posted' limit 1`,
            [scope, v.entryDate]);
          if (earlier.rowCount) throw new ConflictException({ error: "OPENING_NOT_FIRST", message: "The opening entry must be dated before every other entry" });
        }
        const lines: LineInput[] = v.lines.map((l) => ({
          accountId: l.accountId, debit: toHalalas(l.debit), credit: toHalalas(l.credit), memo: l.memo,
          ownerId: l.ownerId ?? null, propertyId: l.propertyId ?? null, unitId: l.unitId ?? null, tenantId: l.tenantId ?? null,
          contractId: l.contractId ?? null, paymentId: l.paymentId ?? null,
        }));
        const res = await this.journal.post(c, {
          userId: scope, entryDate: v.entryDate, origin: cur.kind === "opening" ? "opening" : "manual",
          sourceType: cur.kind === "opening" ? "opening_balance" : "manual_journal", sourceId: id, event: "posted",
          memo: v.memo, payload: { manualJournalId: id, draftedBy: cur.createdBy, attachmentKey: v.attachmentKey },
          createdBy: user.id, lines,
        });
        await c.query(
          `update manual_journals set status = 'posted', approved_by = $3, approved_at = now(), posted_entry_id = $4, updated_at = now()
            where id = $1 and user_id = $2`,
          [id, scope, user.id, res.id],
        );
        await auditRow(c, scope, user.id, "finance_v2_manual_journal", id, `/finance/v2/manual-journals/${id}/approve`);
        return { ...(await this.get(scope, id, c)), entryNo: res.entryNo };
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  async reject(scope: number, user: AuthUser, id: number, body: any) {
    const reason = requireReason(body);
    return withTx(this.pool, async (c) => {
      const cur = await this.lockRow(c, scope, id);
      if (cur.status !== "submitted") throw new ConflictException({ error: "NOT_SUBMITTED", message: `A ${cur.status} journal cannot be rejected` });
      await c.query(`update manual_journals set status = 'rejected', rejected_by = $3, rejected_reason = $4, updated_at = now() where id = $1 and user_id = $2`,
        [id, scope, user.id, reason]);
      await auditRow(c, scope, user.id, "finance_v2_manual_journal", id, `/finance/v2/manual-journals/${id}/reject`);
      return this.get(scope, id, c);
    });
  }

  async void(scope: number, user: AuthUser, id: number) {
    return withTx(this.pool, async (c) => {
      const cur = await this.lockRow(c, scope, id);
      if (!["draft", "submitted", "rejected"].includes(cur.status)) {
        throw new ConflictException({ error: "NOT_VOIDABLE", message: `A ${cur.status} journal cannot be voided${cur.status === "posted" ? "; reverse its entry" : ""}` });
      }
      await c.query(`update manual_journals set status = 'void', updated_at = now() where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "finance_v2_manual_journal", id, `/finance/v2/manual-journals/${id}/void`);
      return this.get(scope, id, c);
    });
  }

  // ── validation ──────────────────────────────────────────────────────────

  private async lockRow(c: Fv2Client, scope: number, id: number) {
    const r = await c.query(`select ${COLS} from manual_journals where id = $1 and user_id = $2 for update`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException("Manual journal not found");
    return r.rows[0];
  }

  private async assertNotLocked(c: Fv2Client, scope: number, date: string) {
    const r = await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2 and ends_on >= $2`, [scope, date]);
    if (r.rows[0]?.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "The period is locked; choose another date" });
  }

  async validate(q: Q, scope: number, body: any, kind: ManualKind): Promise<{ entryDate: string; memo: string; attachmentKey: string | null; lines: StoredLine[] }> {
    const entryDate = isoDate(body?.entryDate, "entryDate");
    const memo = typeof body?.memo === "string" ? body.memo.trim() : "";
    if (!memo || memo.length > 500) throw new BadRequestException({ error: "MEMO_REQUIRED", message: "memo is required (1–500 characters)" });
    let attachmentKey: string | null = null;
    if (body?.attachmentKey != null && body.attachmentKey !== "") {
      if (typeof body.attachmentKey !== "string" || classifyKey(body.attachmentKey, scope).kind !== "own") {
        throw new ForbiddenException({ error: "ATTACHMENT_FORBIDDEN", message: "The attachment must be an upload of this account" });
      }
      attachmentKey = body.attachmentKey;
    }
    const raw = body?.lines;
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 500) throw new BadRequestException({ error: "LINES_REQUIRED", message: "2 to 500 lines are required" });
    let dr = 0;
    let cr = 0;
    const dimIds: Record<DimKey, Set<number>> = { ownerId: new Set(), propertyId: new Set(), unitId: new Set(), tenantId: new Set(), contractId: new Set(), paymentId: new Set() };
    const lines: StoredLine[] = raw.map((l: any, i: number) => {
      const n = i + 1;
      const accountId = Number(l?.accountId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new BadRequestException({ error: "BAD_LINE", message: `line ${n}: accountId is required` });
      let d: number;
      let c: number;
      try {
        d = toHalalas(l?.debit == null || l.debit === "" ? "0" : String(l.debit));
        c = toHalalas(l?.credit == null || l.credit === "" ? "0" : String(l.credit));
      } catch {
        throw new BadRequestException({ error: "BAD_AMOUNT", message: `line ${n}: amounts must be decimals with at most 2 places` });
      }
      if (d < 0 || c < 0 || (d > 0) === (c > 0)) throw new BadRequestException({ error: "BAD_LINE", message: `line ${n}: exactly one of debit or credit must be positive` });
      dr += d;
      cr += c;
      const memoL = l?.memo == null ? null : String(l.memo).trim().slice(0, 500) || null;
      const out: StoredLine = { accountId, debit: fromHalalas(d), credit: fromHalalas(c), memo: memoL };
      for (const k of [...DIMS, ...(kind === "opening" ? (["paymentId"] as const) : [])] as DimKey[]) {
        const v = l?.[k];
        if (v == null || v === "") continue;
        const id = Number(v);
        if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException({ error: "BAD_LINE", message: `line ${n}: ${k} must be an id` });
        out[k] = id;
        dimIds[k].add(id);
      }
      if (kind !== "opening" && l?.paymentId != null) throw new BadRequestException({ error: "BAD_LINE", message: `line ${n}: paymentId is only allowed on the opening entry` });
      return out;
    });
    if (dr !== cr) throw new BadRequestException({ error: "UNBALANCED", message: `Debits ${fromHalalas(dr)} and credits ${fromHalalas(cr)} differ` });
    if (dr <= 0) throw new BadRequestException({ error: "ZERO_ENTRY", message: "The entry total must be positive" });

    const accIds = [...new Set(lines.map((l) => l.accountId))];
    const acc = await q.query(`select id, code, is_group, is_active from accounts where user_id = $1 and id = any($2::int[])`, [scope, accIds]);
    const byId = new Map<number, any>(acc.rows.map((r: any) => [Number(r.id), r]));
    for (const id of accIds) {
      const a = byId.get(id);
      if (!a) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: `Account ${id} not found` });
      if (a.is_group) throw new BadRequestException({ error: "ACCOUNT_GROUP", message: `Account ${a.code} is a group account` });
      if (!a.is_active) throw new BadRequestException({ error: "ACCOUNT_INACTIVE", message: `Account ${a.code} is inactive` });
    }
    const checks: Array<[DimKey, string]> = [
      ["ownerId", `select id from owners where user_id = $1 and id = any($2::int[])`],
      ["propertyId", `select id from properties where user_id = $1 and id = any($2::int[])`],
      ["unitId", `select u.id from units u join properties p on p.id = u.property_id where p.user_id = $1 and u.id = any($2::int[])`],
      ["tenantId", `select id from tenants where user_id = $1 and id = any($2::int[])`],
      ["contractId", `select id from contracts where user_id = $1 and id = any($2::int[])`],
      ["paymentId", `select id from payments where user_id = $1 and id = any($2::int[])`],
    ];
    for (const [k, sqlText] of checks) {
      const ids = [...dimIds[k]];
      if (!ids.length) continue;
      const found = new Set((await q.query(sqlText, [scope, ids])).rows.map((r: any) => Number(r.id)));
      const miss = ids.find((x) => !found.has(x));
      if (miss != null) throw new NotFoundException({ error: "DIMENSION_NOT_FOUND", message: `${k} ${miss} not found` });
    }
    return { entryDate, memo, attachmentKey, lines };
  }
}
