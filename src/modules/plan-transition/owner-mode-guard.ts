import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Sql } from "../finance-v2/hooks/sql";
import { reportOwnerModeConflict, requestModeMigration } from "./plan-transition-signal";

/**
 * Two guards that stop the plan-change problems from reappearing without a plan change.
 *
 * 1. COMMISSION_ON_OWN_LANDLORD (B5). A management fee is the office billing a landlord. On the account holder's
 *    own landlord row, or a property that row owns, it would be the office billing itself; the legacy pairing keys
 *    on the property fee and would issue that COM-. A fee > 0 being SET there is 400; re-sending the stored value
 *    (a form that saves every field) or clearing it passes, as COMMISSION_NOT_IN_PLAN does.
 *
 * 2. OWNER_MODE_THIRD_PARTY (B2). An Owner-mode ledger posts every landlord as the account itself. Linking a
 *    property that has an active contract to a landlord who is not the account holder (owner-mode precondition
 *    semantics: not the holder row, nor carrying the holder's VAT / ID number) would post that landlord's rent as
 *    the office's income. The automatic Owner→Manager migration is asked first (it runs when the plan includes
 *    accounting and nothing blocks it); when it does not happen the request is refused 409 and the admin queue
 *    gets an item.
 */

export const COMMISSION_ON_OWN_LANDLORD = {
  statusCode: 400,
  code: "COMMISSION_ON_OWN_LANDLORD",
  error: "COMMISSION_ON_OWN_LANDLORD",
  message: "لا تُحتسب عمولة إدارة على المؤجر صاحب الحساب أو على عقاراته · No management fee on the account holder's own landlord record or its properties",
} as const;

export const OWNER_MODE_THIRD_PARTY_MESSAGE =
  "محاسبة حسابك تعمل بوضع «المالك»، ولا يمكن ربط مؤجر آخر بعقار عليه عقد نشط. تواصل مع دعم دارا لتحويل المحاسبة إلى وضع «مكتب إدارة أملاك» · "
  + "Your accounting runs in Owner mode, so another landlord cannot be linked to a property with an active contract. Contact Dara support to switch your accounting to office (Manager) mode.";

const toNum = (v: unknown): number => (v == null || v === "" ? 0 : Number(v));

/** 400 when a positive fee is being set (a change, not a re-send) on the holder's own landlord / property. */
export function assertNoCommissionOnHolder(isHolder: boolean, next: unknown, prior: unknown): void {
  if (!isHolder) return;
  const n = toNum(next);
  if (!(n > 0)) return;
  if (prior != null && toNum(prior) === n) return;
  throw new BadRequestException(COMMISSION_ON_OWN_LANDLORD);
}

async function tableExists(q: Sql, table: string): Promise<boolean> {
  const [r] = await q.rows(`select to_regclass($1) is not null as ok`, [table]);
  return r?.ok === true;
}

/**
 * Whether a landlord row counts as the account holder for Owner mode (admin.service.ts `ownerModeViolations`
 * semantics): the holder row itself, or one carrying the holder's VAT number (when the holder has none, its ID/CR).
 */
export async function ownerActsAsHolder(q: Sql, scope: number, ownerId: number): Promise<boolean> {
  const [r] = await q.rows(
    `with holder as (
       select nullif(trim(tax_number), '') as vat, nullif(trim(id_number), '') as idn
         from owners where user_id = $1 and is_account_holder and deleted_at is null order by id limit 1
     )
     select o.is_account_holder
            or coalesce(h.vat is not null and nullif(trim(o.tax_number), '') = h.vat, false)
            or coalesce(h.vat is null and h.idn is not null and nullif(trim(o.id_number), '') = h.idn, false) as holder
       from owners o left join holder h on true
      where o.id = $2 and o.user_id = $1`,
    [scope, ownerId],
  );
  return r?.holder === true;
}

/** Landlords other than the holder (owner-mode semantics) that have a property with an active contract. */
export async function thirdPartyActiveLandlords(q: Sql, scope: number): Promise<number[]> {
  const rows = await q.rows(
    `with holder as (
       select nullif(trim(tax_number), '') as vat, nullif(trim(id_number), '') as idn
         from owners where user_id = $1 and is_account_holder and deleted_at is null order by id limit 1
     ), active_owners as (
       select distinct p.owner_id
         from contracts c
         join contract_units cu on cu.contract_id = c.id
         join units u on u.id = cu.unit_id
         join properties p on p.id = u.property_id
        where c.user_id = $1 and c.status = 'active' and c.deleted_at is null and p.owner_id is not null
     )
     select o.id from owners o join active_owners a on a.owner_id = o.id
       left join holder h on true
      where not o.is_account_holder
        and not coalesce(h.vat is not null and nullif(trim(o.tax_number), '') = h.vat, false)
        and not coalesce(h.vat is null and h.idn is not null and nullif(trim(o.id_number), '') = h.idn, false)
      order by o.id`,
    [scope],
  );
  return rows.map((r: any) => Number(r.id));
}

/** Whether a property has an active (not deleted) contract on any of its units. */
export async function propertyHasActiveContract(q: Sql, scope: number, propertyId: number): Promise<boolean> {
  const [r] = await q.rows(
    `select exists (
       select 1 from contracts c join contract_units cu on cu.contract_id = c.id join units u on u.id = cu.unit_id
        where u.property_id = $1 and c.user_id = $2 and c.status = 'active' and c.deleted_at is null
     ) as yes`,
    [propertyId, scope],
  );
  return r?.yes === true;
}

/** The account's stored accounting mode, or null (never set up, or Finance v2 not migrated). */
export async function accountingMode(q: Sql, scope: number): Promise<"owner" | "manager" | null> {
  if (!(await tableExists(q, "finance_settings"))) return null;
  const [r] = await q.rows(`select accounting_mode from finance_settings where account_user_id = $1`, [scope]);
  return r?.accounting_mode === "owner" ? "owner" : r?.accounting_mode === "manager" ? "manager" : null;
}

/**
 * 409 OWNER_MODE_THIRD_PARTY when linking `ownerId` to property `propertyId` would put a third-party landlord's
 * active contract under an Owner-mode ledger — after asking for the automatic migration, which lets the request
 * through when it switched the ledger to Manager mode.
 */
export async function assertOwnerModeAllowsLandlord(q: Sql, scope: number, ownerId: number | null, propertyId: number | null): Promise<void> {
  if (ownerId == null || propertyId == null) return;
  if ((await accountingMode(q, scope)) !== "owner") return;
  if (await ownerActsAsHolder(q, scope, ownerId)) return;
  if (!(await propertyHasActiveContract(q, scope, propertyId))) return;

  const m = await requestModeMigration(scope, "third_party_landlord");
  if (m && (m.outcome === "migrated" || m.outcome === "migrated_not_started")) return;
  if ((await accountingMode(q, scope)) !== "owner") return; // migrated by someone else meanwhile

  await reportOwnerModeConflict(scope, {
    ownerId, propertyId, outcome: m?.outcome ?? "unavailable", blockers: (m?.blockers ?? []).map((b) => b.code),
  });
  throw new ConflictException({
    statusCode: 409,
    code: "OWNER_MODE_THIRD_PARTY",
    error: "OWNER_MODE_THIRD_PARTY",
    message: OWNER_MODE_THIRD_PARTY_MESSAGE,
    migration: m?.outcome ?? null,
    blockers: (m?.blockers ?? []).map((b) => b.code),
    supportEmail: "info@dara-sa.com",
  });
}
