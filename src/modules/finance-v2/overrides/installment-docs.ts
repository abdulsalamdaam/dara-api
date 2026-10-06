/**
 * The installments screen under Finance v2 (accountant test, 5 Oct 2026):
 *
 *  - #3 "Create invoice" for a landlord with NO VAT number. Such a landlord
 *    cannot issue a tax invoice, so the legacy create (which demands the
 *    seller's VAT number) is the wrong document. `documentRoutes` tells the
 *    web which document each contract's installments take — the v2 non-tax
 *    rent receipt (RR-, DESIGN §9 E9) or the unchanged tax invoice — using
 *    the same seller decision as the reports path and the daily auto-invoice
 *    (`sellerOf`: the contract's frozen landlord and his VAT number).
 *  - #6 Manager mode: rent collected for a third-party landlord is client
 *    money and belongs in a trust (أمانات) bank account. `collectContext`
 *    tells the collect dialog whether that applies and which account to
 *    preselect; `trustRefusal` is the server-side half — a collection that
 *    would land in a non-trust account is refused (409) unless the user
 *    explicitly confirmed it (`trustOverride: true`).
 *  - #7 `collectContext.residential`: the dialog warns (never blocks) that
 *    residential rent is paid through Ejar's digital channels when the
 *    method is cash.
 *
 * Read-only apart from `captureDims` (idempotent; every v2 read of a
 * contract's dimensions does it). Nothing here reaches ZATCA.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { contractCtx, loadSettings } from "../hooks/facts-loader";
import { sellerOf } from "./documents-v2";
import type { Sql } from "../hooks/sql";

export type InstallmentDocRoute = "rent_receipt" | "tax_invoice";

export interface DocumentRouteRow {
  contractId: number;
  route: InstallmentDocRoute;
  ownerId: number | null;
  vatRegistered: boolean;
}

/** Contract ids from `?contractIds=1,2,3` (at most 200, positive integers). */
export function parseIds(raw: unknown, max = 200): number[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const ids = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length > max) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: `${max} ids at most per request` });
  return ids;
}

/**
 * Which document "create invoice" issues for each contract: the rent receipt
 * when the contract's landlord is known and has no VAT number, else the
 * legacy tax invoice (unchanged — including a contract whose landlord is not
 * resolved, which keeps the legacy readiness gate). Contracts outside the
 * scope are simply absent.
 */
export async function documentRoutes(q: Sql, scope: number, contractIds: number[]): Promise<DocumentRouteRow[]> {
  if (!contractIds.length) return [];
  const own = await q.rows(`select id from contracts where user_id = $1 and id = any($2::int[]) and deleted_at is null order by id`, [scope, contractIds]);
  const out: DocumentRouteRow[] = [];
  for (const r of own) {
    const s = await sellerOf(q, scope, Number(r.id));
    out.push({
      contractId: Number(r.id),
      route: s.ownerId != null && !s.vatRegistered ? "rent_receipt" : "tax_invoice",
      ownerId: s.ownerId,
      vatRegistered: s.vatRegistered,
    });
  }
  return out;
}

export interface TrustAccount {
  id: number;
  nameAr: string;
  nameEn: string | null;
  isDefault: boolean;
}

export interface CollectContext {
  paymentId: number;
  contractId: number | null;
  mode: "owner" | "manager";
  treatment: "principal" | "agent" | null;
  /** Manager mode, a third-party landlord's rent, and the account has a trust account: the money goes to trust. */
  trustRequired: boolean;
  /** The account to preselect (the default trust account, else the first active one). */
  trustAccountId: number | null;
  trustAccounts: TrustAccount[];
  /** Whether a collection with no account named ("Default") lands in trust, by method (cash / anything else). */
  defaultInTrust: { cash: boolean; other: boolean };
  /** The contract's unit is residential: rent is paid through Ejar's channels (cash gets a warning). */
  residential: boolean;
}

async function activeTrustAccounts(q: Sql, scope: number): Promise<TrustAccount[]> {
  const rows = await q.rows(
    `select id, name_ar, name_en, is_default from bank_accounts
      where user_id = $1 and kind = 'bank' and is_trust and is_active order by is_default desc, id`,
    [scope],
  );
  return rows.map((b: any) => ({ id: Number(b.id), nameAr: b.name_ar, nameEn: b.name_en ?? null, isDefault: b.is_default === true }));
}

/** GET /finance/v2/installments/:paymentId/collect-context. Null when the installment is not in scope. */
export async function collectContext(q: Sql, scope: number, paymentId: number): Promise<CollectContext | null> {
  const [p] = await q.rows(`select id, contract_id from payments where id = $1 and user_id = $2 and deleted_at is null`, [paymentId, scope]);
  if (!p) return null;
  const s = await loadSettings(q, scope);
  const mode = s?.mode ?? "manager";
  const contractId = p.contract_id == null ? null : Number(p.contract_id);
  const ctx = contractId != null && s ? await contractCtx(q, scope, mode, contractId) : null;
  const trust = await activeTrustAccounts(q, scope);
  const treatment = ctx?.treatment ?? null;
  const trustRequired = mode === "manager" && treatment === "agent" && trust.length > 0;
  return {
    paymentId, contractId, mode, treatment, trustRequired,
    trustAccountId: trustRequired ? trust[0].id : null,
    trustAccounts: trustRequired ? trust : [],
    defaultInTrust: trustRequired
      ? { cash: await landsInTrust(q, scope, null, "cash"), other: await landsInTrust(q, scope, null, "bank_transfer") }
      : { cash: false, other: false },
    residential: ctx?.usage === "residential",
  };
}

export const TRUST_REQUIRED = {
  error: "FINANCE_V2_TRUST_REQUIRED",
  message: "إيجار المؤجر أمانة لديك في وضع مدير الأملاك: سجّل التحصيل في حساب الأمانات، أو أكّد التسجيل في حساب آخر · "
    + "In Manager mode a landlord's rent is client money: record it into the trust account, or confirm another account",
} as const;

/**
 * The account a collection would post to (mirrors `PostingEngine.resolveLines`'
 * `bankFor`): the named active account; else, for client money with
 * `agency_collections_to_trust` on, the default trust account; else the
 * default cash box (cash) or bank account (anything else); else the chart's
 * cash/bank group — never a trust account. Returns whether it is a trust account.
 */
async function landsInTrust(q: Sql, scope: number, bankAccountId: unknown, method: unknown): Promise<boolean> {
  const id = Number(bankAccountId);
  if (bankAccountId != null && bankAccountId !== "" && Number.isInteger(id) && id > 0) {
    const [b] = await q.rows(`select is_trust from bank_accounts where id = $1 and user_id = $2 and is_active`, [id, scope]);
    if (b) return b.is_trust === true;
  }
  const [st] = await q.rows(
    `select default_cash_account_id as dc, default_bank_account_id as db, agency_collections_to_trust as trust
       from finance_settings where account_user_id = $1`,
    [scope],
  );
  if (st?.trust) {
    const [t] = await q.rows(`select 1 from bank_accounts where user_id = $1 and is_trust and is_default and is_active and kind = 'bank' limit 1`, [scope]);
    if (t) return true;
  }
  const def = String(method ?? "").toLowerCase() === "cash" ? st?.dc : st?.db;
  if (def) {
    const [b] = await q.rows(`select is_trust from bank_accounts where id = $1 and user_id = $2 and is_active`, [def, scope]);
    if (b) return b.is_trust === true;
  }
  return false;
}

/**
 * #6, the guard on POST /payments/:id/collections (flag on only, before any
 * write): null when the collection may proceed, else the 409 to throw. It
 * applies only where `collectContext.trustRequired`; an explicit
 * `trustOverride: true` (the dialog's confirmation) lets it through.
 */
export async function trustRefusal(q: Sql, scope: number, paymentId: number, body: any): Promise<ConflictException | null> {
  if (!Number.isInteger(paymentId) || paymentId <= 0) return null;
  const ctx = await collectContext(q, scope, paymentId);
  if (!ctx || !ctx.trustRequired) return null;
  if (body?.trustOverride === true) return null;
  if (await landsInTrust(q, scope, body?.bankAccountId, body?.method)) return null;
  return new ConflictException({ ...TRUST_REQUIRED, trustAccountId: ctx.trustAccountId });
}

/** 404 helper for the controller. */
export function notFound(what: string): never {
  throw new NotFoundException(`${what} not found`);
}
