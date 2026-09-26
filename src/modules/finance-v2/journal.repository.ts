import { Injectable } from "@nestjs/common";
import type { Fv2Client } from "./db";
import { fromHalalas, toHalalas } from "./money";
import { LOCK_KEYS } from "./lock-keys";
import { PeriodsService } from "./periods.service";
import type { JournalOrigin } from "../../../db/src/schema/financeV2";

export interface LineInput {
  accountId: number;
  /** Integer halalas; exactly one of debit/credit is > 0. */
  debit?: number;
  credit?: number;
  memo?: string | null;
  ownerId?: number | null;
  propertyId?: number | null;
  unitId?: number | null;
  tenantId?: number | null;
  contractId?: number | null;
  paymentId?: number | null;
  documentId?: number | null;
  bankAccountId?: number | null;
  vatCategory?: "S" | "Z" | "E" | "O" | null;
  vatRate?: string | null;
  /** Integer halalas, signed. */
  vatBase?: number | null;
  taxRole?: "output" | "input" | "input_nonrecoverable" | null;
  sellerKey?: string | null;
  docClass?: string | null;
}

export interface EntryInput {
  userId: number;
  /** Posting date, YYYY-MM-DD (Riyadh). */
  entryDate: string;
  /** Event date when the entry is routed late; defaults to entryDate. */
  originalDate?: string;
  isLate?: boolean;
  origin: JournalOrigin;
  sourceType: string;
  sourceId: number;
  event: string;
  memo?: string | null;
  payload?: unknown;
  warnings?: string[];
  createdBy?: number | null;
  reversalOf?: number | null;
  lines: LineInput[];
}

export interface PostResult {
  id: number;
  entryNo: string;
  /** False when the idempotency key already existed (nothing was written). */
  created: boolean;
}

/** Throws unless the lines form a valid balanced entry. Returns the total in halalas. */
export function assertBalanced(lines: LineInput[]): number {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error("fv2: an entry needs at least 2 lines");
  let dr = 0;
  let cr = 0;
  lines.forEach((l, i) => {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) {
      throw new Error(`fv2: line ${i + 1} amounts must be non-negative integer halalas`);
    }
    if ((d > 0) === (c > 0)) throw new Error(`fv2: line ${i + 1} must have exactly one of debit or credit`);
    dr += d;
    cr += c;
  });
  if (dr !== cr) throw new Error(`fv2: unbalanced entry (debit ${fromHalalas(dr)}, credit ${fromHalalas(cr)})`);
  return dr;
}

const LINE_COLS = [
  "entry_id", "user_id", "line_no", "entry_date", "account_id", "debit", "credit", "memo",
  "owner_id", "property_id", "unit_id", "tenant_id", "contract_id", "payment_id", "document_id", "bank_account_id",
  "vat_category", "vat_rate", "vat_base", "tax_role", "seller_key", "doc_class",
] as const;

/**
 * The only writer of `journal_entries` / `journal_lines` (DESIGN §2.4, §5).
 * Always called with a client inside the caller's transaction: the balance
 * trigger is deferred to that transaction's commit.
 *
 *  - assertBalanced in halalas first (readable error); the trigger is the backstop.
 *  - Idempotent on (user_id, source_type, source_id, event): the insert is
 *    `on conflict do nothing`, so a replay never raises 23505 inside the
 *    caller's transaction; it returns the existing entry with created=false.
 *  - entry_no is JV-<fiscal year>-<6 digits>, per account, MAX+1 under
 *    pg_advisory_xact_lock(user_id, ENTRY_NO).
 *  - Closed / locked periods are refused by the DB trigger. Routing a late
 *    event to the next open period is the engine's job, not this class's.
 */
@Injectable()
export class JournalRepository {
  constructor(private readonly periods: PeriodsService) {}

  async post(c: Fv2Client, input: EntryInput): Promise<PostResult> {
    const total = assertBalanced(input.lines);
    const existing = await this.findByKey(c, input);
    if (existing) return { ...existing, created: false };

    const period = await this.periods.ensurePeriod(c, input.userId, input.entryDate);
    await c.query(`select pg_advisory_xact_lock($1, $2)`, [input.userId, LOCK_KEYS.ENTRY_NO]);
    const prefix = `JV-${period.fiscalYear}-`;
    const n = await c.query(
      `select coalesce(max(substring(entry_no from '([0-9]+)$')::int), 0) + 1 as n
         from journal_entries where user_id = $1 and entry_no like $2`,
      [input.userId, `${prefix}%`],
    );
    const entryNo = prefix + String(n.rows[0].n).padStart(6, "0");

    const ins = await c.query(
      `insert into journal_entries (user_id, entry_no, entry_date, original_date, period_id, is_late, origin,
                                    source_type, source_id, event, memo, reversal_of, total, payload, warnings, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::text[], $16)
       on conflict (user_id, source_type, source_id, event) do nothing
       returning id`,
      [
        input.userId, entryNo, input.entryDate, input.originalDate ?? input.entryDate, period.id, input.isLate ?? false,
        input.origin, input.sourceType, input.sourceId, input.event, input.memo ?? null, input.reversalOf ?? null,
        fromHalalas(total), JSON.stringify(input.payload ?? {}), input.warnings ?? [], input.createdBy ?? null,
      ],
    );
    if (!ins.rows[0]) {
      const again = await this.findByKey(c, input);
      if (!again) throw new Error("fv2: idempotency conflict without an existing entry");
      return { ...again, created: false };
    }
    const id = Number(ins.rows[0].id);

    const params: unknown[] = [];
    const tuples = input.lines.map((l, i) => {
      const row = [
        id, input.userId, i + 1, input.entryDate, l.accountId, fromHalalas(l.debit ?? 0), fromHalalas(l.credit ?? 0), l.memo ?? null,
        l.ownerId ?? null, l.propertyId ?? null, l.unitId ?? null, l.tenantId ?? null, l.contractId ?? null,
        l.paymentId ?? null, l.documentId ?? null, l.bankAccountId ?? null,
        l.vatCategory ?? null, l.vatRate ?? null, l.vatBase == null ? null : fromHalalas(l.vatBase), l.taxRole ?? null,
        l.sellerKey ?? null, l.docClass ?? null,
      ];
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    await c.query(`insert into journal_lines (${LINE_COLS.join(", ")}) values ${tuples.join(", ")}`, params);
    return { id, entryNo, created: true };
  }

  /**
   * Post the mirror of `entryId` (origin 'reversal', event 'reversal:<event>')
   * dated `entryDate`, then mark the original reversed: the one UPDATE the
   * immutability trigger permits.
   */
  async reverse(
    c: Fv2Client, userId: number, entryId: number,
    opts: { entryDate: string; createdBy?: number | null; memo?: string | null; originalDate?: string; isLate?: boolean; warnings?: string[]; payload?: unknown },
  ): Promise<PostResult> {
    const e = await c.query(
      `select id, source_type, source_id, event, status, memo from journal_entries where user_id = $1 and id = $2 for update`,
      [userId, entryId],
    );
    const orig = e.rows[0];
    if (!orig) throw new Error(`fv2: entry ${entryId} not found`);
    if (orig.status !== "posted") throw new Error(`fv2: entry ${entryId} is already reversed`);
    const l = await c.query(
      `select account_id, debit, credit, memo, owner_id, property_id, unit_id, tenant_id, contract_id, payment_id, document_id,
              bank_account_id, vat_category, vat_rate::text, vat_base::text, tax_role, seller_key, doc_class
         from journal_lines where entry_id = $1 order by line_no`,
      [entryId],
    );
    const res = await this.post(c, {
      userId,
      entryDate: opts.entryDate,
      origin: "reversal",
      sourceType: orig.source_type,
      sourceId: Number(orig.source_id),
      event: `reversal:${orig.event}`,
      memo: opts.memo ?? orig.memo,
      reversalOf: entryId,
      createdBy: opts.createdBy ?? null,
      originalDate: opts.originalDate,
      isLate: opts.isLate,
      warnings: opts.warnings,
      payload: opts.payload,
      lines: l.rows.map((r: any) => ({
        accountId: r.account_id, debit: toHalalas(r.credit), credit: toHalalas(r.debit), memo: r.memo,
        ownerId: r.owner_id, propertyId: r.property_id, unitId: r.unit_id, tenantId: r.tenant_id, contractId: r.contract_id,
        paymentId: r.payment_id, documentId: r.document_id, bankAccountId: r.bank_account_id,
        vatCategory: r.vat_category, vatRate: r.vat_rate, vatBase: r.vat_base == null ? null : -toHalalas(r.vat_base),
        taxRole: r.tax_role, sellerKey: r.seller_key, docClass: r.doc_class,
      })),
    });
    await c.query(
      `update journal_entries set status = 'reversed', reversed_by = $3, reversed_at = now() where user_id = $1 and id = $2`,
      [userId, entryId, res.id],
    );
    return res;
  }

  private async findByKey(c: Fv2Client, k: Pick<EntryInput, "userId" | "sourceType" | "sourceId" | "event">) {
    const r = await c.query(
      `select id, entry_no from journal_entries where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`,
      [k.userId, k.sourceType, k.sourceId, k.event],
    );
    return r.rows[0] ? { id: Number(r.rows[0].id), entryNo: r.rows[0].entry_no as string } : null;
  }
}
