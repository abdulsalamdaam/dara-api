import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { COA_TEMPLATE, TOP_UP_CODES } from "./coa-template";
import { fromHalalas, toHalalas } from "./money";
import { auditRow } from "./audit";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export interface AccountRow {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  normalBalance: "debit" | "credit";
  parentId: number | null;
  systemKey: string | null;
  isGroup: boolean;
  isActive: boolean;
  isTemplate: boolean;
  bankAccountId: number | null;
  description: string | null;
  /** The account's code in the external accounting system (كود النظام الخارجي), for the journal export. */
  externalCode?: string | null;
  /** Signed in the account's normal direction; only with `asOf`. */
  balance?: string;
}

const COLS = `id, code, name_ar as "nameAr", name_en as "nameEn", type, normal_balance as "normalBalance",
  parent_id as "parentId", system_key as "systemKey", is_group as "isGroup", is_active as "isActive",
  is_template as "isTemplate", bank_account_id as "bankAccountId", description`;

const CODE_RE = /^[0-9]{4,8}$/;
/** External codes are free text from another package (e.g. `EXT-1111`, `1-01-001`): printable, no control characters. */
const EXT_RE = /^[^\u0000-\u001f\u007f]{1,50}$/;

/** `externalCode` from a request body: undefined = unchanged, null = clear. */
export function cleanExternalCode(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new BadRequestException({ error: "BAD_EXTERNAL_CODE", message: "externalCode must be a string" });
  const s = v.trim();
  if (!s) return null;
  if (!EXT_RE.test(s)) throw new BadRequestException({ error: "BAD_EXTERNAL_CODE", message: "externalCode must be 1–50 printable characters" });
  return s;
}

function cleanName(v: unknown, field: string, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new BadRequestException(`${field} must be a string`);
  const s = v.trim();
  if (!s || s.length > 200) throw new BadRequestException(`${field} must be 1–200 characters`);
  return s;
}

/** A DB guard refusal (the triggers raise 55000/23514) as an HTTP error. */
function mapDbError(err: any): never {
  if (err?.code === "55000") throw new ConflictException(String(err.message).replace(/^fv2: /, ""));
  if (err?.code === "23514" || err?.code === "23503") throw new BadRequestException(String(err.message).replace(/^fv2: /, ""));
  if (err?.code === "23505") throw new ConflictException("An account with this code already exists");
  throw err;
}

/**
 * The chart of accounts (DESIGN §2.3.2, §3): the template seed, and the user's
 * add / rename / deactivate / delete. The hard rules (no retype after
 * postings, groups take no postings, parent must be a same-type group without
 * a system key, no cycles, no delete of template or posted accounts) are DB
 * triggers, so they hold for every writer; this service adds readable errors.
 */
@Injectable()
export class ChartService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  /**
   * Seed the template for one account. Idempotent (`on conflict do nothing`),
   * so a re-run fills gaps and never touches renamed or deactivated accounts.
   * Parents come before children in the template, so each parent id resolves.
   * Returns the number of accounts inserted.
   */
  async seedChart(q: Q, userId: number, actorId: number | null = null): Promise<number> {
    let inserted = 0;
    for (const a of COA_TEMPLATE) {
      const r = await q.query(
        `insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id, system_key, is_group, is_template, created_by)
         values ($1, $2, $3, $4, $5, $6, (select id from accounts where user_id = $1 and code = $7), $8, $9, true, $10)
         on conflict (user_id, code) do nothing`,
        [userId, a.code, a.nameAr, a.nameEn, a.type, a.normalBalance, a.parent, a.systemKey, a.isGroup, actorId],
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }

  /**
   * Add the template accounts introduced after an account's chart was seeded
   * (`TOP_UP_CODES`), under their template parent, when the code is free and
   * the parent is still a group. Insert-only: a renamed, deactivated or
   * user-created account is never touched. Returns the number inserted.
   */
  async topUp(q: Q, userId: number): Promise<number> {
    let inserted = 0;
    for (const a of COA_TEMPLATE.filter((x) => TOP_UP_CODES.includes(x.code))) {
      const r = await q.query(
        `insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id, system_key, is_group, is_template)
         select $1, $2, $3, $4, $5, $6, p.id, $8, $9, true
           from accounts p where p.user_id = $1 and p.code = $7 and p.is_group and p.type = $5
         on conflict (user_id, code) do nothing`,
        [userId, a.code, a.nameAr, a.nameEn, a.type, a.normalBalance, a.parent, a.systemKey, a.isGroup],
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }

  private readonly toppedUp = new Set<number>();

  /** `topUp` once per process and account (best effort: a failure never blocks the read). */
  async ensureTopUp(userId: number): Promise<void> {
    if (this.toppedUp.has(userId)) return;
    try {
      const has = await this.pool.query(`select 1 from accounts where user_id = $1 limit 1`, [userId]);
      if (has.rowCount) await this.topUp(this.pool, userId);
      this.toppedUp.add(userId);
    } catch {
      /* retried on the next read */
    }
  }

  /** External codes of the account's chart (0074 side table); empty when the table is missing. */
  async externalCodes(userId: number, q: Q = this.pool): Promise<Map<number, string>> {
    try {
      const r = await q.query(`select account_id, external_code from account_external_codes where user_id = $1`, [userId]);
      return new Map(r.rows.map((x: any) => [Number(x.account_id), x.external_code as string]));
    } catch (err: any) {
      if (err?.code === "42P01") return new Map();
      throw err;
    }
  }

  private async withExternal(userId: number, rows: AccountRow[], q: Q = this.pool): Promise<AccountRow[]> {
    const ext = await this.externalCodes(userId, q);
    return rows.map((r) => ({ ...r, externalCode: ext.get(r.id) ?? null }));
  }

  /** The chart, ordered by code; with `asOf` each account carries its balance (leaf postings only). */
  async list(userId: number, asOf?: string): Promise<AccountRow[]> {
    await this.ensureTopUp(userId);
    if (asOf === undefined) {
      const r = await this.pool.query(`select ${COLS} from accounts where user_id = $1 order by code`, [userId]);
      return this.withExternal(userId, r.rows);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new BadRequestException("asOf must be YYYY-MM-DD");
    const r = await this.pool.query(
      `select ${COLS}, coalesce(b.dr, 0)::text as dr, coalesce(b.cr, 0)::text as cr
         from accounts a
         left join (select account_id, sum(debit) dr, sum(credit) cr from journal_lines
                     where user_id = $1 and entry_date <= $2::date group by account_id) b on b.account_id = a.id
        where a.user_id = $1 order by a.code`,
      [userId, asOf],
    );
    return this.withExternal(userId, r.rows.map(({ dr, cr, ...row }: any) => {
      const net = toHalalas(dr) - toHalalas(cr);
      return { ...row, balance: fromHalalas(row.normalBalance === "debit" ? net : -net) };
    }));
  }

  async get(userId: number, id: number, q: Q = this.pool): Promise<AccountRow> {
    const r = await q.query(`select ${COLS} from accounts where user_id = $1 and id = $2`, [userId, id]);
    if (!r.rows[0]) throw new NotFoundException("Account not found");
    return r.rows[0];
  }

  /**
   * Add a sub-account under `parentId`. Type and normal balance follow the
   * parent. A leaf parent becomes a group, which the DB allows only while it
   * has no postings and no system key (engine accounts never become groups:
   * add a sibling instead). The code defaults to the parent's code plus the
   * next free two-digit suffix.
   */
  async create(userId: number, actorId: number, body: any): Promise<AccountRow> {
    const parentId = Number(body?.parentId);
    if (!Number.isInteger(parentId) || parentId <= 0) throw new BadRequestException("parentId is required");
    const nameAr = cleanName(body?.nameAr, "nameAr", true)!;
    const nameEn = cleanName(body?.nameEn, "nameEn", false) ?? nameAr;
    const description = body?.description == null ? null : String(body.description).slice(0, 1000);
    let code: string | undefined = body?.code == null || body.code === "" ? undefined : String(body.code);
    if (code !== undefined && !CODE_RE.test(code)) throw new BadRequestException("code must be 4–8 digits");

    try {
      return await withTx(this.pool, async (c) => {
        const parent = await this.get(userId, parentId, c);
        await c.query(`select id from accounts where id = $1 for update`, [parent.id]);
        if (!parent.isGroup) {
          if (parent.systemKey) throw new BadRequestException("This account is used by automatic posting; add a sibling account instead");
          const posted = await c.query(`select 1 from journal_lines where account_id = $1 limit 1`, [parent.id]);
          if (posted.rowCount) throw new BadRequestException("This account has postings and cannot take sub-accounts");
          await c.query(`update accounts set is_group = true where id = $1`, [parent.id]);
        }
        if (code === undefined) code = await this.suggestCode(c, userId, parent.code);
        const r = await c.query(
          `insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id, description, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLS}`,
          [userId, code, nameAr, nameEn, parent.type, parent.normalBalance, parent.id, description, actorId],
        );
        await auditRow(c, userId, actorId, "finance_v2_account", r.rows[0].id, "/finance/v2/accounts"); // the interceptor skips POST
        return r.rows[0];
      });
    } catch (err) {
      return mapDbError(err);
    }
  }

  /**
   * Rename, describe, deactivate or reactivate, and set the external code
   * (`externalCode`: a string, or null/"" to clear). Type and system key are
   * not editable here (and locked by trigger).
   */
  async update(userId: number, id: number, body: any, actorId: number | null = null): Promise<AccountRow> {
    const cur = await this.get(userId, id);
    const externalCode = cleanExternalCode(body?.externalCode);
    const nameAr = cleanName(body?.nameAr, "nameAr", false);
    const nameEn = cleanName(body?.nameEn, "nameEn", false);
    const description = body?.description === undefined ? undefined : body.description == null ? null : String(body.description).slice(0, 1000);
    let isActive: boolean | undefined;
    if (body?.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") throw new BadRequestException("isActive must be a boolean");
      isActive = body.isActive;
      if (isActive === false && cur.systemKey) {
        throw new BadRequestException("This account is used by automatic posting and cannot be deactivated");
      }
    }
    try {
      const r = await this.pool.query(
        `update accounts set name_ar = coalesce($3, name_ar), name_en = coalesce($4, name_en),
                description = case when $5::boolean then $6 else description end,
                is_active = coalesce($7, is_active)
          where user_id = $1 and id = $2 returning ${COLS}`,
        [userId, id, nameAr ?? null, nameEn ?? null, description !== undefined, description ?? null, isActive ?? null],
      );
      if (externalCode === null) {
        await this.pool.query(`delete from account_external_codes where user_id = $1 and account_id = $2`, [userId, id]);
      } else if (externalCode !== undefined) {
        await this.pool.query(
          `insert into account_external_codes (account_id, user_id, external_code, updated_by) values ($2, $1, $3, $4)
           on conflict (account_id) do update set external_code = excluded.external_code, updated_by = excluded.updated_by, updated_at = now()
            where account_external_codes.user_id = excluded.user_id`,
          [userId, id, externalCode, actorId],
        );
      }
      return (await this.withExternal(userId, [r.rows[0]]))[0];
    } catch (err) {
      return mapDbError(err);
    }
  }

  /** Only an account without postings that is not a template account (trigger-enforced). */
  async remove(userId: number, id: number): Promise<{ ok: true }> {
    await this.get(userId, id);
    try {
      await this.pool.query(`delete from accounts where user_id = $1 and id = $2`, [userId, id]);
      return { ok: true };
    } catch (err) {
      return mapDbError(err);
    }
  }

  /** Parent code + the next free two-digit suffix (e.g. 511001 under 5110). */
  private async suggestCode(q: Q, userId: number, parentCode: string): Promise<string> {
    if (parentCode.length + 2 > 8) throw new BadRequestException("The chart is too deep here; choose a code");
    const r = await q.query(`select code from accounts where user_id = $1 and code like $2`, [userId, `${parentCode}__`]);
    const used = new Set(r.rows.map((x: any) => x.code));
    for (let i = 1; i <= 99; i++) {
      const c = parentCode + String(i).padStart(2, "0");
      if (!used.has(c)) return c;
    }
    throw new BadRequestException("No free code under this parent; choose one");
  }
}
