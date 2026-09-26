import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { auditRow, isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { LOCK_KEYS } from "../lock-keys";
import { ManualJournalsService } from "../manual-journals.service";
import { classifyKey } from "../../uploads/key-scope";
import { ibanTail } from "../tier1/iban";
import { autoMatch, candidates, type JournalLineIn, type StatementLineIn } from "./match";
import { DATE_FORMATS, fingerprints, parseAmount, parseStatement, type DateFormat, type ImportProfile } from "./statement-csv";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

const m = (v: any) => (v == null ? null : fromHalalas(toHalalas(v)));

const PROFILE_COLS = `id, bank_account_id as "bankAccountId", name, delimiter, encoding, skip_rows as "skipRows", date_col as "dateCol", date_format as "dateFormat",
  desc_col as "descCol", ref_col as "refCol", amount_col as "amountCol", debit_col as "debitCol", credit_col as "creditCol", balance_col as "balanceCol"`;

/** Every document number a journal line can be recognised by in a bank line (§8.3 a): the entry's own and its source's. */
const JL_SQL = `select l.id, to_char(l.entry_date,'YYYY-MM-DD') as entry_date, (l.debit - l.credit)::text as amount, l.memo, l.tenant_id,
    e.entry_no, e.memo as entry_memo, e.source_type, e.source_id, e.event,
    (case e.source_type
       when 'payment_collection' then (select pc.receipt_number from payment_collections pc where pc.id = e.source_id and pc.user_id = e.user_id)
       when 'simple_invoice' then (select si.number from simple_invoices si where si.id = e.source_id and si.user_id = e.user_id)
       when 'tenant_credit_action' then (select x.number from tenant_credit_actions x where x.id = e.source_id and x.user_id = e.user_id)
       when 'landlord_payout' then (select lp.reference from landlord_payouts lp where lp.id = e.source_id and lp.user_id = e.user_id)
     end) as src_number,
    (select si.number from payment_collections pc join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
      where e.source_type = 'payment_collection' and pc.id = e.source_id and pc.user_id = e.user_id) as voucher_number,
    (select fr.number from finance_deposit_refunds fr where fr.user_id = e.user_id and e.source_type = 'simple_invoice'
        and e.event = 'deposit_refunded' and e.source_id = any(fr.voucher_ids) order by fr.id limit 1) as refund_number
  from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id`;

/**
 * Bank reconciliation (DESIGN §8.3 a): CSV statement import, auto-match on
 * amount / date / reference, manual match (1:1, 1:n, n:1 with exact sums),
 * ignore, "create entry" (a DRAFT manual journal, subject to approval) and the
 * reconciliation statement. Everything is scoped to the account and to ONE
 * bank account's GL leaf; a completed statement is read-only.
 */
@Injectable()
export class BankRecService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, private readonly mj: ManualJournalsService) {}

  // ─── profiles ─────────────────────────────────────────────────────────

  async profiles(scope: number, bankAccountId?: string) {
    const p: unknown[] = [scope];
    let w = "user_id = $1";
    if (bankAccountId) {
      p.push(Number(bankAccountId));
      w += " and bank_account_id = $2";
    }
    return { rows: (await this.pool.query(`select ${PROFILE_COLS} from bank_import_profiles where ${w} order by id`, p)).rows };
  }

  async saveProfile(scope: number, body: any, id?: number) {
    const bankAccountId = await this.bank(this.pool, scope, body?.bankAccountId);
    const p = this.profileOf(body);
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : null;
    if (!name) throw new BadRequestException({ error: "BAD_INPUT", message: "name is required" });
    const vals = [scope, bankAccountId, name, p.delimiter, p.skipRows, p.dateCol, p.dateFormat, p.descCol ?? null, p.refCol ?? null,
      p.amountCol ?? null, p.debitCol ?? null, p.creditCol ?? null, p.balanceCol ?? null];
    if (id == null) {
      const r = await this.pool.query(
        `insert into bank_import_profiles (user_id, bank_account_id, name, delimiter, skip_rows, date_col, date_format, desc_col, ref_col, amount_col, debit_col, credit_col, balance_col)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning ${PROFILE_COLS}`, vals);
      return r.rows[0];
    }
    const r = await this.pool.query(
      `update bank_import_profiles set bank_account_id = $2, name = $3, delimiter = $4, skip_rows = $5, date_col = $6, date_format = $7, desc_col = $8,
              ref_col = $9, amount_col = $10, debit_col = $11, credit_col = $12, balance_col = $13
        where user_id = $1 and id = $14 returning ${PROFILE_COLS}`, [...vals, id]);
    if (!r.rows[0]) throw new NotFoundException({ error: "PROFILE_NOT_FOUND", message: "Profile not found" });
    return r.rows[0];
  }

  async deleteProfile(scope: number, id: number) {
    const r = await this.pool.query(`delete from bank_import_profiles where user_id = $1 and id = $2`, [scope, id]);
    if (!r.rowCount) throw new NotFoundException({ error: "PROFILE_NOT_FOUND", message: "Profile not found" });
    return { ok: true };
  }

  /** Parse without writing: the first rows and the errors, for the import dialog's preview. */
  async preview(scope: number, body: any) {
    const profile = await this.resolveProfile(this.pool, scope, body);
    const res = this.parse(body?.csv, profile);
    return {
      lines: res.lines.slice(0, 50).map((l) => ({ ...l, amount: fromHalalas(l.amount), runningBalance: l.runningBalance == null ? null : fromHalalas(l.runningBalance) })),
      count: res.lines.length, zero: res.zero, errors: res.errors.slice(0, 50), errorCount: res.errors.length,
    };
  }

  // ─── statements ───────────────────────────────────────────────────────

  /**
   * POST /bank-statements/import {bankAccountId, csv, profileId | profile, periodFrom?, periodTo?, openingBalance?, closingBalance?, fileKey?}
   * Lines already imported (same fingerprint) are skipped, so an overlapping
   * statement re-imports safely. Any unparseable line refuses the whole file
   * (400 with the line numbers), so a statement is never half imported.
   * Auto-match runs right after.
   */
  async importStatement(scope: number, user: AuthUser, body: any) {
    const bankAccountId = await this.bank(this.pool, scope, body?.bankAccountId);
    const profile = await this.resolveProfile(this.pool, scope, body);
    const res = this.parse(body?.csv, profile);
    if (res.errors.length) {
      throw new BadRequestException({ error: "CSV_ERRORS", message: `${res.errors.length} line(s) could not be read`, errors: res.errors.slice(0, 100) });
    }
    if (!res.lines.length) throw new BadRequestException({ error: "CSV_EMPTY", message: "The file has no statement lines" });
    const dates = res.lines.map((l) => l.txnDate).sort();
    const periodFrom = body?.periodFrom ? isoDate(body.periodFrom, "periodFrom") : dates[0];
    const periodTo = body?.periodTo ? isoDate(body.periodTo, "periodTo") : dates[dates.length - 1];
    if (periodFrom > periodTo) throw new BadRequestException({ error: "BAD_PERIOD", message: "periodFrom is after periodTo" });
    const money = (v: unknown, f: string) => {
      if (v == null || v === "") return null;
      try {
        return parseAmount(String(v));
      } catch {
        throw new BadRequestException({ error: "BAD_AMOUNT", message: `${f} must be an amount` });
      }
    };
    const opening = money(body?.openingBalance, "openingBalance");
    let closing = money(body?.closingBalance, "closingBalance");
    const withBal = res.lines.filter((l) => l.runningBalance != null);
    if (closing == null && withBal.length) closing = [...withBal].sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.lineNo - b.lineNo).pop()!.runningBalance;
    if (closing == null && opening != null) closing = opening + res.lines.reduce((s, l) => s + l.amount, 0);
    let fileKey: string | null = null;
    if (body?.fileKey) {
      if (typeof body.fileKey !== "string" || classifyKey(body.fileKey, scope).kind !== "own") throw new BadRequestException({ error: "ATTACHMENT_FORBIDDEN", message: "fileKey must be an upload of this account" });
      fileKey = body.fileKey;
    }
    const fps = fingerprints(bankAccountId, res.lines);
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const st = await c.query(
        `insert into bank_statements (user_id, bank_account_id, period_from, period_to, opening_balance, closing_balance, file_key, imported_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [scope, bankAccountId, periodFrom, periodTo, opening == null ? null : fromHalalas(opening), closing == null ? null : fromHalalas(closing), fileKey, user.id],
      );
      const statementId = Number(st.rows[0].id);
      let imported = 0;
      for (let i = 0; i < res.lines.length; i++) {
        const l = res.lines[i];
        const r = await c.query(
          `insert into bank_statement_lines (statement_id, user_id, bank_account_id, line_no, txn_date, description, reference, amount, running_balance, fingerprint)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (bank_account_id, fingerprint) do nothing`,
          [statementId, scope, bankAccountId, l.lineNo, l.txnDate, l.description, l.reference, fromHalalas(l.amount),
            l.runningBalance == null ? null : fromHalalas(l.runningBalance), fps[i]],
        );
        imported += r.rowCount ?? 0;
      }
      await auditRow(c, scope, user.id, "bank_statement", statementId, "/finance/v2/bank-statements/import");
      const auto = await this.autoMatchIn(c, scope, statementId, user.id);
      return { statementId, imported, duplicates: res.lines.length - imported, zeroLines: res.zero, autoMatched: auto };
    });
    return out;
  }

  async list(scope: number, bankAccountId?: string) {
    const p: unknown[] = [scope];
    let w = "s.user_id = $1";
    if (bankAccountId) {
      p.push(Number(bankAccountId));
      w += " and s.bank_account_id = $2";
    }
    const r = await this.pool.query(
      `select s.id, s.bank_account_id, to_char(s.period_from,'YYYY-MM-DD') as period_from, to_char(s.period_to,'YYYY-MM-DD') as period_to,
              s.opening_balance::text as opening, s.closing_balance::text as closing, s.status, s.imported_at, s.reconciled_at,
              count(l.id)::int as lines, count(l.id) filter (where l.match_status = 'unmatched')::int as unmatched,
              count(l.id) filter (where l.match_status = 'ignored')::int as ignored
         from bank_statements s left join bank_statement_lines l on l.statement_id = s.id and l.user_id = s.user_id
        where ${w} group by s.id order by s.id desc`, p);
    return {
      rows: r.rows.map((x: any) => ({
        id: x.id, bankAccountId: x.bank_account_id, periodFrom: x.period_from, periodTo: x.period_to, openingBalance: m(x.opening), closingBalance: m(x.closing),
        status: x.status, importedAt: iso(x.imported_at), reconciledAt: x.reconciled_at ? iso(x.reconciled_at) : null,
        lines: x.lines, unmatched: x.unmatched, ignored: x.ignored,
      })),
    };
  }

  /** One statement: its lines (with matches), the unmatched ledger lines of the period, and the reconciliation statement. */
  async get(scope: number, id: number) {
    const st = await this.statement(this.pool, scope, id);
    const gl = await this.glOf(this.pool, scope, st.bank_account_id);
    const lines = await this.pool.query(
      `select l.id, l.line_no, to_char(l.txn_date,'YYYY-MM-DD') as txn_date, l.description, l.reference, l.amount::text as amount,
              l.running_balance::text as running_balance, l.match_status, bm.group_id,
              (select json_agg(json_build_object('journalLineId', j.journal_line_id, 'amount', j.amount::text, 'entryId', jl.entry_id, 'entryNo', je.entry_no,
                        'entryDate', to_char(jl.entry_date,'YYYY-MM-DD'), 'memo', coalesce(jl.memo, je.memo)) order by j.id)
                 from bank_matches j join journal_lines jl on jl.id = j.journal_line_id join journal_entries je on je.id = jl.entry_id
                where j.user_id = l.user_id and j.group_id = bm.group_id and j.journal_line_id is not null) as journal
         from bank_statement_lines l left join bank_matches bm on bm.statement_line_id = l.id and bm.user_id = l.user_id
        where l.user_id = $1 and l.statement_id = $2 order by l.txn_date, l.line_no, l.id`, [scope, id]);
    const unmatched = await this.pool.query(
      `${JL_SQL} where l.user_id = $1 and l.account_id = $2 and l.entry_date <= $3::date
          and not exists (select 1 from bank_matches b where b.journal_line_id = l.id)
        order by l.entry_date, l.id limit 2000`, [scope, gl, st.period_to]);
    return {
      statement: this.shapeStatement(st),
      lines: lines.rows.map((l: any) => ({
        id: Number(l.id), lineNo: l.line_no, txnDate: l.txn_date, description: l.description, reference: l.reference, amount: m(l.amount),
        runningBalance: m(l.running_balance), matchStatus: l.match_status, groupId: l.group_id == null ? null : Number(l.group_id),
        journal: (l.journal ?? []).map((j: any) => ({ ...j, amount: m(j.amount), journalLineId: Number(j.journalLineId), entryId: Number(j.entryId) })),
      })),
      unmatchedLedger: unmatched.rows.map((j: any) => this.shapeJl(j)),
      reconciliation: await this.reconciliation(this.pool, scope, st, gl),
    };
  }

  /** Suggestions for one statement line (every exact-amount candidate within 3 days, scored). */
  async candidatesFor(scope: number, lineId: number) {
    const l = await this.line(this.pool, scope, lineId);
    const gl = await this.glOf(this.pool, scope, l.bank_account_id);
    const pool = await this.pool.query(
      `${JL_SQL} where l.user_id = $1 and l.account_id = $2 and (l.debit - l.credit) = $3::numeric
          and l.entry_date between ($4::date - 3) and ($4::date + 3)
          and not exists (select 1 from bank_matches b where b.journal_line_id = l.id)
        order by l.entry_date, l.id`, [scope, gl, l.amount, l.txn_date]);
    const byId = new Map<number, any>(pool.rows.map((r: any) => [Number(r.id), r]));
    const tails = await this.tails(this.pool, scope, pool.rows);
    const sc = candidates(this.slIn(l), pool.rows.map((r: any) => this.jlIn(r, tails)));
    return { rows: sc.map((s) => ({ ...s, line: this.shapeJl(byId.get(s.journalLineId)) })) };
  }

  async autoMatch(scope: number, user: AuthUser, statementId: number) {
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const st = await this.statement(c, scope, statementId);
      if (st.status === "reconciled") throw this.readOnly();
      return { matched: await this.autoMatchIn(c, scope, statementId, user.id) };
    });
  }

  /** POST /bank-matches {statementLineIds[], journalLineIds[]}: a manual match; the two sides must sum to the same signed amount. */
  async match(scope: number, user: AuthUser, body: any) {
    const sIds = ids(body?.statementLineIds, "statementLineIds");
    const jIds = ids(body?.journalLineIds, "journalLineIds");
    if (sIds.length > 1 && jIds.length > 1) throw new BadRequestException({ error: "BAD_MATCH", message: "A match is 1:1, 1:n or n:1" });
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const sl = (await c.query(
        `select l.id, l.amount::text as amount, l.bank_account_id, l.match_status, s.status as st_status
           from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.user_id = l.user_id
          where l.user_id = $1 and l.id = any($2::bigint[]) for update of l`, [scope, sIds])).rows;
      if (sl.length !== sIds.length) throw new NotFoundException({ error: "LINE_NOT_FOUND", message: "Statement line not found" });
      if (sl.some((x: any) => x.st_status === "reconciled")) throw this.readOnly();
      if (sl.some((x: any) => x.match_status !== "unmatched")) throw new ConflictException({ error: "ALREADY_MATCHED", message: "A statement line is already matched or ignored" });
      const bankIds = new Set(sl.map((x: any) => Number(x.bank_account_id)));
      if (bankIds.size !== 1) throw new BadRequestException({ error: "BAD_MATCH", message: "The statement lines belong to different bank accounts" });
      const gl = await this.glOf(c, scope, [...bankIds][0]);
      const jl = (await c.query(
        `select l.id, (l.debit - l.credit)::text as amount, l.account_id from journal_lines l where l.user_id = $1 and l.id = any($2::bigint[])`, [scope, jIds])).rows;
      if (jl.length !== jIds.length) throw new NotFoundException({ error: "LINE_NOT_FOUND", message: "Journal line not found" });
      if (jl.some((x: any) => Number(x.account_id) !== gl)) throw new BadRequestException({ error: "BAD_MATCH", message: "A journal line is not on this bank account's ledger account" });
      const taken = await c.query(`select 1 from bank_matches where journal_line_id = any($1::bigint[]) limit 1`, [jIds]);
      if (taken.rowCount) throw new ConflictException({ error: "ALREADY_MATCHED", message: "A journal line is already matched" });
      const sSum = sl.reduce((s: number, x: any) => s + toHalalas(x.amount), 0);
      const jSum = jl.reduce((s: number, x: any) => s + toHalalas(x.amount), 0);
      if (sSum !== jSum) {
        throw new BadRequestException({ error: "SUMS_DIFFER", message: `The bank side ${fromHalalas(sSum)} and the ledger side ${fromHalalas(jSum)} differ`,
          bank: fromHalalas(sSum), ledger: fromHalalas(jSum) });
      }
      const groupId = await this.insertGroup(c, scope, sl.map((x: any) => ({ id: Number(x.id), amount: x.amount })), jl.map((x: any) => ({ id: Number(x.id), amount: x.amount })), "manual", user.id);
      await auditRow(c, scope, user.id, "bank_match", groupId, "/finance/v2/bank-matches");
      return { groupId };
    });
  }

  /**
   * POST /bank-statements/:id/clear-prior {journalLineIds[]}: ledger lines dated
   * BEFORE the statement's period that the bank already reflects in its opening
   * balance (e.g. the opening entry, or items cleared on an earlier statement
   * that was never imported). They become a ledger-only match group, so they
   * stop counting as outstanding. Undo with DELETE /bank-matches/:groupId.
   */
  async clearPrior(scope: number, user: AuthUser, statementId: number, body: any) {
    const jIds = ids(body?.journalLineIds, "journalLineIds");
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const st = await this.statement(c, scope, statementId);
      if (st.status === "reconciled") throw this.readOnly();
      const gl = await this.glOf(c, scope, st.bank_account_id);
      const jl = (await c.query(
        `select l.id, (l.debit - l.credit)::text as amount, l.account_id, to_char(l.entry_date,'YYYY-MM-DD') as d
           from journal_lines l where l.user_id = $1 and l.id = any($2::bigint[])`, [scope, jIds])).rows;
      if (jl.length !== jIds.length) throw new NotFoundException({ error: "LINE_NOT_FOUND", message: "Journal line not found" });
      if (jl.some((x: any) => Number(x.account_id) !== gl)) throw new BadRequestException({ error: "BAD_MATCH", message: "A journal line is not on this bank account's ledger account" });
      if (st.period_from && jl.some((x: any) => x.d >= st.period_from)) {
        throw new BadRequestException({ error: "NOT_PRIOR", message: "Only ledger lines dated before the statement period can be cleared as prior" });
      }
      const taken = await c.query(`select 1 from bank_matches where journal_line_id = any($1::bigint[]) limit 1`, [jIds]);
      if (taken.rowCount) throw new ConflictException({ error: "ALREADY_MATCHED", message: "A journal line is already matched" });
      const groupId = await this.insertGroup(c, scope, [], jl.map((x: any) => ({ id: Number(x.id), amount: x.amount })), "manual", user.id);
      await auditRow(c, scope, user.id, "bank_match", groupId, `/finance/v2/bank-statements/${statementId}/clear-prior`);
      return { groupId, cleared: jl.length };
    });
  }

  /** DELETE /bank-matches/:groupId: undo a match (not on a completed statement). */
  async unmatch(scope: number, user: AuthUser, groupId: number) {
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const r = await c.query(
        `select b.statement_line_id, s.status from bank_matches b left join bank_statement_lines l on l.id = b.statement_line_id
           left join bank_statements s on s.id = l.statement_id where b.user_id = $1 and b.group_id = $2`, [scope, groupId]);
      if (!r.rows.length) throw new NotFoundException({ error: "MATCH_NOT_FOUND", message: "Match not found" });
      if (r.rows.some((x: any) => x.status === "reconciled")) throw this.readOnly();
      const sIds = r.rows.map((x: any) => x.statement_line_id).filter((x: any) => x != null);
      await c.query(`delete from bank_matches where user_id = $1 and group_id = $2`, [scope, groupId]);
      await c.query(`update bank_statement_lines set match_status = 'unmatched' where user_id = $1 and id = any($2::bigint[])`, [scope, sIds]);
      await auditRow(c, scope, user.id, "bank_match", groupId, `/finance/v2/bank-matches/${groupId}`, "DELETE");
      return { ok: true };
    });
  }

  /** POST /bank-statement-lines/:id/ignore {ignore: boolean}: bank noise that needs no entry (or undo). */
  async ignore(scope: number, user: AuthUser, lineId: number, ignore: boolean) {
    return withTx(this.pool, async (c) => {
      const l = await this.line(c, scope, lineId, true);
      if (l.st_status === "reconciled") throw this.readOnly();
      if (ignore && l.match_status !== "unmatched") throw new ConflictException({ error: "ALREADY_MATCHED", message: "The line is matched or already ignored" });
      if (!ignore && l.match_status !== "ignored") throw new ConflictException({ error: "NOT_IGNORED", message: "The line is not ignored" });
      await c.query(`update bank_statement_lines set match_status = $3 where user_id = $1 and id = $2`, [scope, lineId, ignore ? "ignored" : "unmatched"]);
      await auditRow(c, scope, user.id, "bank_statement_line", lineId, `/finance/v2/bank-statement-lines/${lineId}/ignore`);
      return { id: lineId, matchStatus: ignore ? "ignored" : "unmatched" };
    });
  }

  /**
   * POST /bank-statement-lines/:id/create-entry {accountId, memo?}: a DRAFT
   * manual journal for an unrecorded bank line (bank charges → 5270, profit →
   * 4410, a transfer → another bank account's leaf). It posts only when
   * approved; the user then matches the posted line.
   */
  async createEntry(scope: number, user: AuthUser, lineId: number, body: any) {
    const l = await this.line(this.pool, scope, lineId);
    if (l.match_status !== "unmatched") throw new ConflictException({ error: "ALREADY_MATCHED", message: "The line is matched or ignored" });
    const gl = await this.glOf(this.pool, scope, l.bank_account_id);
    const accountId = Number(body?.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) throw new BadRequestException({ error: "BAD_INPUT", message: "accountId is required" });
    if (accountId === gl) throw new BadRequestException({ error: "BAD_INPUT", message: "Choose the other side of the entry, not the bank account itself" });
    const amt = toHalalas(l.amount);
    const abs = fromHalalas(Math.abs(amt));
    const memo = typeof body?.memo === "string" && body.memo.trim() ? body.memo.trim().slice(0, 500)
      : `كشف بنكي: ${l.description ?? l.reference ?? ""} · Bank statement line ${l.line_no}`.slice(0, 500);
    const lines = amt > 0
      ? [{ accountId: gl, debit: abs, credit: "0" }, { accountId, debit: "0", credit: abs }]
      : [{ accountId, debit: abs, credit: "0" }, { accountId: gl, debit: "0", credit: abs }];
    return this.mj.create(scope, user, { entryDate: l.txn_date, memo, lines }, "manual");
  }

  /** POST /bank-statements/:id/complete: only when the reconciliation difference is zero; the statement becomes read-only. */
  async complete(scope: number, user: AuthUser, id: number) {
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const st = await this.statement(c, scope, id, true);
      if (st.status === "reconciled") throw this.readOnly();
      const gl = await this.glOf(c, scope, st.bank_account_id);
      const rec = await this.reconciliation(c, scope, st, gl);
      if (!rec.balanced) {
        throw new ConflictException({ error: "FINANCE_V2_NOT_RECONCILED", difference: rec.difference,
          message: `الفرق ${rec.difference} يجب أن يكون صفراً · The difference ${rec.difference} must be zero` });
      }
      await c.query(`update bank_statements set status = 'reconciled', reconciled_at = now() where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "bank_statement", id, `/finance/v2/bank-statements/${id}/complete`);
      return { id, status: "reconciled", reconciliation: rec };
    });
  }

  /** DELETE /bank-statements/:id: an open statement and its lines and matches (a completed one is read-only). */
  async remove(scope: number, user: AuthUser, id: number) {
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_REC]);
      const st = await this.statement(c, scope, id, true);
      if (st.status === "reconciled") throw this.readOnly();
      await c.query(
        `delete from bank_matches where user_id = $1 and group_id in (select b.group_id from bank_matches b join bank_statement_lines l on l.id = b.statement_line_id
           where l.statement_id = $2 and b.user_id = $1)`, [scope, id]);
      await c.query(`delete from bank_statement_lines where user_id = $1 and statement_id = $2`, [scope, id]);
      await c.query(`delete from bank_statements where user_id = $1 and id = $2`, [scope, id]);
      await auditRow(c, scope, user.id, "bank_statement", id, `/finance/v2/bank-statements/${id}`, "DELETE");
      return { ok: true };
    });
  }

  // ─── the reconciliation statement ─────────────────────────────────────

  /**
   * As of the statement's `period_to`:
   *   ledger balance (the bank's GL leaf, every line dated ≤ period_to)
   *   = bank closing balance
   *     + outstanding receipts (ledger debits not matched: money booked, not yet in the bank)
   *     − outstanding payments (ledger credits not matched: cheques not yet presented)
   *     − unrecorded bank items (statement lines neither matched nor ignored: in the bank, not in the books)
   * `difference` = ledger − that; zero when everything is explained.
   */
  async reconciliation(q: Q, scope: number, st: any, gl: number) {
    const [led] = (await q.query(
      `select coalesce(sum(l.debit - l.credit), 0)::text as bal,
              coalesce(sum(l.debit) filter (where not exists (select 1 from bank_matches b where b.journal_line_id = l.id)), 0)::text as out_in,
              coalesce(sum(l.credit) filter (where not exists (select 1 from bank_matches b where b.journal_line_id = l.id)), 0)::text as out_out,
              count(*) filter (where not exists (select 1 from bank_matches b where b.journal_line_id = l.id))::int as out_n
         from journal_lines l where l.user_id = $1 and l.account_id = $2 and l.entry_date <= $3::date`, [scope, gl, st.period_to])).rows;
    const [unrec] = (await q.query(
      `select coalesce(sum(amount), 0)::text as s, count(*)::int as n from bank_statement_lines
        where user_id = $1 and bank_account_id = $2 and txn_date <= $3::date and match_status = 'unmatched'`, [scope, st.bank_account_id, st.period_to])).rows;
    const closing = st.closing_balance == null ? null : toHalalas(st.closing_balance);
    const ledger = toHalalas(led.bal);
    const outIn = toHalalas(led.out_in);
    const outOut = toHalalas(led.out_out);
    const unrecorded = toHalalas(unrec.s);
    const adjusted = closing == null ? null : closing + outIn - outOut - unrecorded;
    const difference = adjusted == null ? null : ledger - adjusted;
    return {
      asOf: st.period_to,
      bankClosing: closing == null ? null : fromHalalas(closing),
      outstandingReceipts: fromHalalas(outIn),
      outstandingPayments: fromHalalas(outOut),
      outstandingLedgerLines: led.out_n,
      unrecordedBankItems: fromHalalas(unrecorded),
      unrecordedBankLines: unrec.n,
      adjustedBank: adjusted == null ? null : fromHalalas(adjusted),
      ledgerBalance: fromHalalas(ledger),
      difference: difference == null ? null : fromHalalas(difference),
      balanced: difference === 0,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────

  private async autoMatchIn(c: Fv2Client, scope: number, statementId: number, actorId: number): Promise<number> {
    const st = await this.statement(c, scope, statementId);
    const gl = await this.glOf(c, scope, st.bank_account_id);
    const sl = (await c.query(
      `select id, to_char(txn_date,'YYYY-MM-DD') as txn_date, amount::text as amount, description, reference from bank_statement_lines
        where user_id = $1 and statement_id = $2 and match_status = 'unmatched' order by txn_date, line_no, id`, [scope, statementId])).rows;
    if (!sl.length) return 0;
    const pool = (await c.query(
      `${JL_SQL} where l.user_id = $1 and l.account_id = $2 and l.entry_date between ($3::date - 3) and ($4::date + 3)
          and not exists (select 1 from bank_matches b where b.journal_line_id = l.id)`,
      [scope, gl, st.period_from ?? sl[0].txn_date, st.period_to ?? sl[sl.length - 1].txn_date])).rows;
    const tails = await this.tails(c, scope, pool);
    const byJ = new Map<number, any>(pool.map((r: any) => [Number(r.id), r]));
    const bySl = new Map<number, any>(sl.map((r: any) => [Number(r.id), r]));
    const picks = autoMatch(sl.map((r: any) => this.slIn(r)), pool.map((r: any) => this.jlIn(r, tails)));
    for (const p of picks) {
      await this.insertGroup(c, scope, [{ id: p.statementLineId, amount: bySl.get(p.statementLineId).amount }], [{ id: p.journalLineId, amount: byJ.get(p.journalLineId).amount }], "auto", actorId);
    }
    return picks.length;
  }

  private async insertGroup(c: Fv2Client, scope: number, sl: Array<{ id: number; amount: string }>, jl: Array<{ id: number; amount: string }>, method: "auto" | "manual", actorId: number) {
    const [g] = (await c.query(`select nextval(pg_get_serial_sequence('bank_matches', 'id')) as g`)).rows;
    const groupId = Number(g.g);
    for (const s of sl) {
      await c.query(`insert into bank_matches (user_id, group_id, statement_line_id, amount, method, matched_by) values ($1, $2, $3, $4, $5, $6)`,
        [scope, groupId, s.id, fromHalalas(toHalalas(s.amount)), method, actorId]);
    }
    for (const j of jl) {
      await c.query(`insert into bank_matches (user_id, group_id, journal_line_id, amount, method, matched_by) values ($1, $2, $3, $4, $5, $6)`,
        [scope, groupId, j.id, fromHalalas(toHalalas(j.amount)), method, actorId]);
    }
    if (sl.length) await c.query(`update bank_statement_lines set match_status = $3 where user_id = $1 and id = any($2::bigint[])`, [scope, sl.map((s) => s.id), method]);
    return groupId;
  }

  /** The payer's IBAN tail per tenant (tenants.iban when the column exists; absent → no tail hint). */
  private async tails(q: Q, scope: number, rows: any[]): Promise<Map<number, string>> {
    const ids = [...new Set(rows.map((r) => r.tenant_id).filter((x: any) => x != null).map(Number))];
    const out = new Map<number, string>();
    if (!ids.length) return out;
    try {
      const r = await q.query(`select id, iban from tenants where user_id = $1 and id = any($2::int[])`, [scope, ids]);
      for (const x of r.rows) {
        const t = ibanTail(x.iban ? String(x.iban).replace(/\s/g, "").toUpperCase() : null);
        if (t) out.set(Number(x.id), t);
      }
    } catch {
      /* no iban column: the reference numbers still score */
    }
    return out;
  }

  private slIn(r: any): StatementLineIn {
    return { id: Number(r.id), txnDate: r.txn_date, amount: toHalalas(r.amount), description: r.description ?? null, reference: r.reference ?? null };
  }

  private jlIn(r: any, tails: Map<number, string>): JournalLineIn {
    const refs = [r.src_number, r.voucher_number, r.refund_number, r.entry_no, ...(r.entry_memo ? String(r.entry_memo).match(/[A-Z]{2,5}-\d{3,}/g) ?? [] : [])]
      .filter((x) => typeof x === "string" && x.trim());
    const tail = r.tenant_id != null ? tails.get(Number(r.tenant_id)) : undefined;
    if (tail) refs.push(tail);
    return { id: Number(r.id), entryDate: r.entry_date, amount: toHalalas(r.amount), refs };
  }

  private shapeJl(r: any) {
    if (!r) return null;
    return {
      journalLineId: Number(r.id), entryDate: r.entry_date, amount: m(r.amount), entryNo: r.entry_no ?? null, memo: r.memo ?? r.entry_memo ?? null,
      sourceType: r.source_type, sourceId: r.source_id == null ? null : Number(r.source_id), event: r.event,
      number: r.src_number ?? r.voucher_number ?? r.refund_number ?? null,
    };
  }

  private shapeStatement(s: any) {
    return {
      id: Number(s.id), bankAccountId: Number(s.bank_account_id), periodFrom: s.period_from, periodTo: s.period_to,
      openingBalance: m(s.opening_balance), closingBalance: m(s.closing_balance), status: s.status, fileKey: s.file_key ?? null,
      importedAt: iso(s.imported_at), reconciledAt: s.reconciled_at ? iso(s.reconciled_at) : null,
    };
  }

  private async statement(q: Q, scope: number, id: number, lock = false) {
    const r = await q.query(
      `select id, bank_account_id, to_char(period_from,'YYYY-MM-DD') as period_from, to_char(period_to,'YYYY-MM-DD') as period_to,
              opening_balance::text as opening_balance, closing_balance::text as closing_balance, status, file_key, imported_at, reconciled_at
         from bank_statements where id = $1 and user_id = $2 ${lock ? "for update" : ""}`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "STATEMENT_NOT_FOUND", message: "Statement not found" });
    return r.rows[0];
  }

  private async line(q: Q, scope: number, id: number, lock = false) {
    const r = await q.query(
      `select l.id, l.statement_id, l.bank_account_id, l.line_no, to_char(l.txn_date,'YYYY-MM-DD') as txn_date, l.description, l.reference,
              l.amount::text as amount, l.match_status, s.status as st_status
         from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.user_id = l.user_id
        where l.id = $1 and l.user_id = $2 ${lock ? "for update of l" : ""}`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "LINE_NOT_FOUND", message: "Statement line not found" });
    return r.rows[0];
  }

  private async glOf(q: Q, scope: number, bankAccountId: number): Promise<number> {
    const r = await q.query(`select gl_account_id from bank_accounts where id = $1 and user_id = $2`, [bankAccountId, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
    return Number(r.rows[0].gl_account_id);
  }

  private async bank(q: Q, scope: number, raw: unknown): Promise<number> {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException({ error: "BAD_INPUT", message: "bankAccountId is required" });
    const r = await q.query(`select kind from bank_accounts where id = $1 and user_id = $2`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
    if (r.rows[0].kind !== "bank") throw new BadRequestException({ error: "BAD_INPUT", message: "Statements are imported for bank accounts, not cash boxes" });
    return id;
  }

  private async resolveProfile(q: Q, scope: number, body: any): Promise<ImportProfile> {
    if (body?.profileId != null) {
      const r = await q.query(`select ${PROFILE_COLS} from bank_import_profiles where id = $1 and user_id = $2`, [Number(body.profileId), scope]);
      if (!r.rows[0]) throw new NotFoundException({ error: "PROFILE_NOT_FOUND", message: "Profile not found" });
      return this.profileOf(r.rows[0]);
    }
    return this.profileOf(body?.profile ?? {});
  }

  private profileOf(p: any): ImportProfile {
    const col = (v: unknown) => (v == null || v === "" ? null : String(v).trim().slice(0, 100));
    const delimiter = p?.delimiter == null || p.delimiter === "" ? "," : String(p.delimiter) === "\\t" ? "\t" : String(p.delimiter);
    if (![",", ";", "\t", "|"].includes(delimiter)) throw new BadRequestException({ error: "BAD_PROFILE", message: "delimiter must be , ; | or tab" });
    const dateFormat = (p?.dateFormat ?? "DD/MM/YYYY") as DateFormat;
    if (!DATE_FORMATS.includes(dateFormat)) throw new BadRequestException({ error: "BAD_PROFILE", message: `dateFormat must be one of ${DATE_FORMATS.join(", ")}` });
    const skipRows = Number(p?.skipRows ?? 0);
    if (!Number.isInteger(skipRows) || skipRows < 0 || skipRows > 50) throw new BadRequestException({ error: "BAD_PROFILE", message: "skipRows must be 0–50" });
    const out: ImportProfile = {
      delimiter, skipRows, dateFormat, dateCol: col(p?.dateCol) ?? "", descCol: col(p?.descCol), refCol: col(p?.refCol),
      amountCol: col(p?.amountCol), debitCol: col(p?.debitCol), creditCol: col(p?.creditCol), balanceCol: col(p?.balanceCol),
    };
    if (!out.dateCol) throw new BadRequestException({ error: "BAD_PROFILE", message: "dateCol is required" });
    if (!out.amountCol && !out.debitCol && !out.creditCol) throw new BadRequestException({ error: "BAD_PROFILE", message: "amountCol, or debitCol/creditCol, is required" });
    return out;
  }

  private parse(csv: unknown, profile: ImportProfile) {
    if (typeof csv !== "string" || !csv.trim()) throw new BadRequestException({ error: "CSV_REQUIRED", message: "csv (the file's text) is required" });
    try {
      return parseStatement(csv, profile);
    } catch (err: any) {
      throw new BadRequestException({ error: err?.code ?? "CSV_ERROR", message: String(err?.message ?? err) });
    }
  }

  private readOnly() {
    return new ConflictException({ error: "FINANCE_V2_STATEMENT_RECONCILED", message: "الكشف مُسوّى ومقفل · The statement is reconciled and read-only" });
  }
}

function ids(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || !v.length || v.length > 200) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be a non-empty list` });
  const out = [...new Set(v.map(Number))];
  if (out.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be ids` });
  return out;
}

const iso = (v: any) => (v instanceof Date ? v.toISOString() : String(v));

