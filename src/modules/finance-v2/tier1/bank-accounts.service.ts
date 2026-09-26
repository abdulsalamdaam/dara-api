import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { auditRow } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { checkSaudiIban, SA_BANKS } from "./iban";
import { LOCK_KEYS } from "../lock-keys";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export interface BankAccountOut {
  id: number;
  kind: "bank" | "cash";
  nameAr: string;
  nameEn: string | null;
  name: string;
  bankName: string | null;
  bankCode: string | null;
  bankLabel: { ar: string; en: string } | null;
  iban: string | null;
  accountNumber: string | null;
  currency: string;
  isTrust: boolean;
  isDefault: boolean;
  isActive: boolean;
  glAccountId: number;
  glCode: string;
  openingBalance: string | null;
  /** GL balance of the account's ledger leaf as of today (Riyadh), debit-positive. */
  balance: string;
  /** Referenced by a posting or a v2 record: it can be deactivated, not deleted. */
  used: boolean;
  createdAt: string;
}

const str = (v: unknown, field: string, max = 200): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be a string` });
  const s = v.trim();
  if (s.length > max) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} is too long` });
  return s || null;
};
const bool = (v: unknown, field: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be a boolean` });
  return v;
};

/** Every place a bank account id is recorded; any hit means "used" (DESIGN §8.2 a: deactivate, never delete). */
const USED_SQL = `(
     exists (select 1 from journal_lines l where l.user_id = b.user_id and (l.bank_account_id = b.id or l.account_id = b.gl_account_id))
  or exists (select 1 from finance_collection_meta m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from finance_payout_meta m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from finance_expense_details m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from finance_document_meta m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from finance_deposit_refunds m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from tenant_credit_actions m where m.user_id = b.user_id and m.bank_account_id = b.id)
  or exists (select 1 from bank_statements m where m.user_id = b.user_id and m.bank_account_id = b.id))`;

/**
 * Bank accounts and cash boxes (DESIGN §2.3.6, §8.2 a). Creating one creates
 * its GL leaf under 1110 in the same transaction. The IBAN is a validated
 * Saudi IBAN. There is exactly one default per (kind, trust); the non-trust
 * defaults are also the account's settings defaults (finance_settings), which
 * the engine falls back to when a money event names no account.
 */
@Injectable()
export class BankAccountsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  async list(scope: number, opts: { includeInactive?: boolean } = {}): Promise<BankAccountOut[]> {
    const r = await this.pool.query(this.selectSql(`b.user_id = $1 ${opts.includeInactive ? "" : "and b.is_active"}`), [scope, riyadhToday()]);
    return r.rows.map((x: any) => this.shape(x));
  }

  async get(scope: number, id: number, q: Q = this.pool): Promise<BankAccountOut> {
    const r = await q.query(this.selectSql(`b.user_id = $1 and b.id = $3`), [scope, riyadhToday(), id]);
    if (!r.rows[0]) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
    return this.shape(r.rows[0]);
  }

  /** An active bank account of this scope, or a 400 naming the field (used by every money dialog's `bankAccountId`). */
  async assertUsable(q: Q, scope: number, id: unknown, field = "bankAccountId"): Promise<number | null> {
    if (id === undefined || id === null || id === "") return null;
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException({ error: "BAD_BANK_ACCOUNT", message: `${field} must be an id` });
    const r = await q.query(`select 1 from bank_accounts where id = $1 and user_id = $2 and is_active`, [n, scope]);
    if (!r.rowCount) throw new BadRequestException({ error: "BAD_BANK_ACCOUNT", message: `${field}: no active bank account or cash box with this id` });
    return n;
  }

  async create(scope: number, actorId: number, body: any): Promise<BankAccountOut> {
    const kind = body?.kind;
    if (kind !== "bank" && kind !== "cash") throw new BadRequestException({ error: "BAD_INPUT", message: "kind must be bank or cash" });
    const nameAr = str(body?.nameAr, "nameAr");
    if (!nameAr) throw new BadRequestException({ error: "BAD_INPUT", message: "nameAr is required" });
    const nameEn = str(body?.nameEn, "nameEn");
    const bankName = str(body?.bankName, "bankName");
    const accountNumber = str(body?.accountNumber, "accountNumber", 40);
    const iban = this.iban(body?.iban, kind);
    const isTrust = bool(body?.isTrust, "isTrust") ?? false;
    if (isTrust && kind !== "bank") throw new BadRequestException({ error: "BAD_INPUT", message: "Only a bank account can be a trust (client money) account" });
    const isDefault = bool(body?.isDefault, "isDefault") ?? false;
    let opening: string | null = null;
    if (body?.openingBalance != null && body.openingBalance !== "") {
      try {
        opening = fromHalalas(toHalalas(String(body.openingBalance)));
      } catch {
        throw new BadRequestException({ error: "BAD_AMOUNT", message: "openingBalance must be a decimal with at most 2 places" });
      }
    }
    return withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.BANK_ACCOUNT]);
      const parent = await c.query(`select id, code from accounts where user_id = $1 and code = '1110'`, [scope]);
      if (!parent.rows[0]) throw new ConflictException({ error: "CHART_MISSING", message: "The chart of accounts has no 1110 group" });
      const used = new Set((await c.query(`select code from accounts where user_id = $1 and code like '1110__'`, [scope])).rows.map((x: any) => x.code));
      let code: string | null = null;
      for (let i = 1; i <= 99 && !code; i++) if (!used.has(`1110${String(i).padStart(2, "0")}`)) code = `1110${String(i).padStart(2, "0")}`;
      if (!code) throw new ConflictException({ error: "CHART_FULL", message: "No free account code under 1110" });
      const gl = await c.query(
        `insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id, created_by)
         values ($1, $2, $3, $4, 'asset', 'debit', $5, $6) returning id`,
        [scope, code, nameAr, nameEn ?? nameAr, parent.rows[0].id, actorId],
      );
      try {
        const ins = await c.query(
          `insert into bank_accounts (user_id, kind, name_ar, name_en, bank_name, iban, account_number, is_trust, is_default, gl_account_id, opening_balance, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11) returning id`,
          [scope, kind, nameAr, nameEn, bankName, iban, accountNumber, isTrust, gl.rows[0].id, opening, actorId],
        );
        const id = Number(ins.rows[0].id);
        await c.query(`update accounts set bank_account_id = $2 where id = $1`, [gl.rows[0].id, id]);
        if (isDefault) await this.makeDefault(c, scope, id, kind, isTrust);
        await auditRow(c, scope, actorId, "finance_bank_account", id, "/finance/v2/bank-accounts");
        return this.get(scope, id, c);
      } catch (err: any) {
        if (err?.code === "23505" && /iban/.test(String(err?.constraint ?? err?.message))) {
          throw new ConflictException({ error: "IBAN_EXISTS", message: "هذا الآيبان مسجّل مسبقاً · This IBAN is already registered" });
        }
        throw err;
      }
    });
  }

  async update(scope: number, actorId: number, id: number, body: any): Promise<BankAccountOut> {
    return withTx(this.pool, async (c) => {
      const r = await c.query(`select b.*, a.is_template from bank_accounts b join accounts a on a.id = b.gl_account_id where b.id = $1 and b.user_id = $2 for update of b`, [id, scope]);
      const cur = r.rows[0];
      if (!cur) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
      const has = (k: string) => body && Object.prototype.hasOwnProperty.call(body, k);
      const nameAr = has("nameAr") ? str(body.nameAr, "nameAr") : cur.name_ar;
      if (!nameAr) throw new BadRequestException({ error: "BAD_INPUT", message: "nameAr is required" });
      const nameEn = has("nameEn") ? str(body.nameEn, "nameEn") : cur.name_en;
      const bankName = has("bankName") ? str(body.bankName, "bankName") : cur.bank_name;
      const accountNumber = has("accountNumber") ? str(body.accountNumber, "accountNumber", 40) : cur.account_number;
      const iban = has("iban") ? this.iban(body.iban, cur.kind) : cur.iban;
      const isActive = bool(body?.isActive, "isActive") ?? cur.is_active;
      const isDefault = bool(body?.isDefault, "isDefault");
      const isTrust = bool(body?.isTrust, "isTrust") ?? cur.is_trust;
      if (isTrust !== cur.is_trust) {
        if (cur.kind !== "bank") throw new BadRequestException({ error: "BAD_INPUT", message: "Only a bank account can be a trust account" });
        const u = await c.query(`select ${USED_SQL} as used from bank_accounts b where b.id = $1`, [id]);
        if (u.rows[0]?.used) throw new ConflictException({ error: "BANK_ACCOUNT_IN_USE", message: "A used account cannot change between trust and own money" });
      }
      if (!isActive && (cur.is_default || isDefault)) {
        throw new ConflictException({ error: "BANK_ACCOUNT_IS_DEFAULT", message: "اختر حساباً افتراضياً آخر أولاً · Make another account the default first" });
      }
      if (isDefault === false && cur.is_default) {
        throw new ConflictException({ error: "BANK_ACCOUNT_IS_DEFAULT", message: "اختر حساباً افتراضياً آخر بدلاً من إلغاء الافتراضي · Make another account the default instead" });
      }
      try {
        await c.query(
          `update bank_accounts set name_ar = $3, name_en = $4, bank_name = $5, account_number = $6, iban = $7, is_active = $8,
                  is_trust = $9, is_default = case when $9 <> is_trust then false else is_default end, updated_at = now()
            where id = $1 and user_id = $2`,
          [id, scope, nameAr, nameEn, bankName, accountNumber, iban, isActive, isTrust],
        );
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException({ error: "IBAN_EXISTS", message: "هذا الآيبان مسجّل مسبقاً · This IBAN is already registered" });
        throw err;
      }
      if (!cur.is_template) await c.query(`update accounts set name_ar = $2, name_en = $3 where id = $1`, [cur.gl_account_id, nameAr, nameEn ?? nameAr]);
      if (isDefault === true && isActive) await this.makeDefault(c, scope, id, cur.kind, isTrust);
      await auditRow(c, scope, actorId, "finance_bank_account", id, `/finance/v2/bank-accounts/${id}`, "PATCH");
      return this.get(scope, id, c);
    });
  }

  /** Only an unused, non-default account; its GL leaf goes with it unless it is a template account. */
  async remove(scope: number, actorId: number, id: number): Promise<{ ok: true }> {
    return withTx(this.pool, async (c) => {
      const r = await c.query(
        `select b.id, b.is_default, b.gl_account_id, a.is_template, ${USED_SQL} as used
           from bank_accounts b join accounts a on a.id = b.gl_account_id where b.id = $1 and b.user_id = $2 for update of b`,
        [id, scope],
      );
      const cur = r.rows[0];
      if (!cur) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
      if (cur.is_default) throw new ConflictException({ error: "BANK_ACCOUNT_IS_DEFAULT", message: "اختر حساباً افتراضياً آخر أولاً · Make another account the default first" });
      if (cur.used) throw new ConflictException({ error: "BANK_ACCOUNT_IN_USE", message: "الحساب مستخدم؛ يمكن إيقافه فقط · The account is in use; deactivate it instead" });
      await c.query(`update finance_settings set default_bank_account_id = null where account_user_id = $1 and default_bank_account_id = $2`, [scope, id]);
      await c.query(`update finance_settings set default_cash_account_id = null where account_user_id = $1 and default_cash_account_id = $2`, [scope, id]);
      await c.query(`delete from bank_import_profiles where user_id = $1 and bank_account_id = $2`, [scope, id]);
      await c.query(`delete from bank_accounts where id = $1 and user_id = $2`, [id, scope]);
      if (!cur.is_template) await c.query(`delete from accounts where id = $1 and user_id = $2`, [cur.gl_account_id, scope]);
      else await c.query(`update accounts set bank_account_id = null where id = $1 and user_id = $2`, [cur.gl_account_id, scope]);
      await auditRow(c, scope, actorId, "finance_bank_account", id, `/finance/v2/bank-accounts/${id}`, "DELETE");
      return { ok: true as const };
    });
  }

  /** The IBAN check as an endpoint helper (the web validates as the user types). */
  validateIban(raw: unknown) {
    if (typeof raw !== "string" || !raw.trim()) return { valid: false, reason: "format", iban: null, bankCode: null, bank: null };
    const r = checkSaudiIban(raw);
    if (r.ok === false) return { valid: false, reason: (r as { reason: string }).reason, iban: null, bankCode: null, bank: null };
    const ok = r as Extract<typeof r, { ok: true }>;
    return { valid: true, reason: null, iban: ok.iban, bankCode: ok.bankCode, bank: ok.bank };
  }

  private iban(raw: unknown, kind: string): string | null {
    if (raw === undefined || raw === null || raw === "") return null;
    if (kind !== "bank") throw new BadRequestException({ error: "BAD_INPUT", message: "A cash box has no IBAN" });
    if (typeof raw !== "string") throw new BadRequestException({ error: "BAD_IBAN", message: "iban must be a string" });
    const r = checkSaudiIban(raw);
    if (r.ok === false) {
      const reason = (r as { reason: string }).reason;
      throw new BadRequestException({
        error: "BAD_IBAN", reason,
        message: reason === "checksum" ? "رقم الآيبان غير صحيح (خانة التحقق) · The IBAN check digits are wrong" : "الآيبان السعودي: SA ثم 22 خانة · A Saudi IBAN is SA followed by 22 characters",
      });
    }
    return (r as Extract<typeof r, { ok: true }>).iban;
  }

  private async makeDefault(c: Fv2Client, scope: number, id: number, kind: string, isTrust: boolean) {
    await c.query(`update bank_accounts set is_default = false, updated_at = now() where user_id = $1 and kind = $2 and is_trust = $3 and id <> $4 and is_default`, [scope, kind, isTrust, id]);
    await c.query(`update bank_accounts set is_default = true, updated_at = now() where id = $1 and user_id = $2`, [id, scope]);
    if (!isTrust) {
      await c.query(
        `update finance_settings set ${kind === "cash" ? "default_cash_account_id" : "default_bank_account_id"} = $2, updated_at = now() where account_user_id = $1`,
        [scope, id],
      );
    }
  }

  private selectSql(where: string): string {
    return `select b.id, b.kind, b.name_ar, b.name_en, b.bank_name, b.iban, b.account_number, b.currency, b.is_trust, b.is_default, b.is_active,
                   b.gl_account_id, a.code as gl_code, b.opening_balance::text as opening_balance, b.created_at,
                   (select coalesce(sum(l.debit - l.credit), 0)::text from journal_lines l where l.user_id = b.user_id and l.account_id = b.gl_account_id and l.entry_date <= $2::date) as balance,
                   ${USED_SQL} as used
              from bank_accounts b join accounts a on a.id = b.gl_account_id
             where ${where}
             order by b.kind, b.is_trust, b.is_default desc, b.id`;
  }

  private shape(x: any): BankAccountOut {
    const code = x.iban ? String(x.iban).slice(4, 6) : null;
    return {
      id: Number(x.id), kind: x.kind, nameAr: x.name_ar, nameEn: x.name_en ?? null, name: x.name_ar,
      bankName: x.bank_name ?? null, bankCode: code, bankLabel: code ? SA_BANKS[code] ?? null : null,
      iban: x.iban ?? null, accountNumber: x.account_number ?? null, currency: String(x.currency ?? "SAR").trim(),
      isTrust: x.is_trust === true, isDefault: x.is_default === true, isActive: x.is_active === true,
      glAccountId: Number(x.gl_account_id), glCode: x.gl_code,
      openingBalance: x.opening_balance == null ? null : fromHalalas(toHalalas(x.opening_balance)),
      balance: fromHalalas(toHalalas(x.balance)), used: x.used === true,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
    };
  }
}
