import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Fv2Pool } from "../db";
import { toHalalas } from "../money";

/** Shared parsing helpers of the sub-ledger reports (DESIGN §7.5–7.8, §7.10). */

export type Lang = "ar" | "en";

export const bad = (error: string, message: string) => new BadRequestException({ error, message });

export function langOf(v: unknown): Lang {
  return v === "en" ? "en" : "ar";
}

/** A numeric(…) string (or null) → halalas. */
export function h(v: unknown): number {
  return v == null ? 0 : toHalalas(String(v));
}

export function optId(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad("BAD_ID", `${name} must be an id`);
  return n;
}

export function reqId(v: unknown, name: string): number {
  const n = optId(v, name);
  if (n === undefined) throw bad("ID_REQUIRED", `${name} is required`);
  return n;
}

export type DimKey = "ownerId" | "propertyId" | "tenantId" | "contractId";

const DIM_SQL: Record<DimKey, string> = {
  ownerId: `select 1 from owners where id = $1 and user_id = $2`,
  propertyId: `select 1 from properties where id = $1 and user_id = $2`,
  tenantId: `select 1 from tenants where id = $1 and user_id = $2`,
  contractId: `select 1 from contracts where id = $1 and user_id = $2`,
};

/** Load an id with the scope in the same `where`; a miss is 404 (§10.2). */
export async function scopedId(pool: Fv2Pool, scope: number, key: DimKey, id: number): Promise<number> {
  const r = await pool.query(DIM_SQL[key], [id, scope]);
  if (!r.rowCount) throw new NotFoundException({ error: "DIMENSION_NOT_FOUND", message: `${key} not found` });
  return id;
}

export async function scopedFilters(pool: Fv2Pool, scope: number, q: Record<string, any>, keys: DimKey[]) {
  const f: Partial<Record<DimKey, number>> = {};
  for (const k of keys) {
    const id = optId(q[k], k);
    if (id !== undefined) f[k] = await scopedId(pool, scope, k, id);
  }
  return f;
}

export async function settingsOf(pool: Fv2Pool, scope: number) {
  const r = await pool.query(
    `select accounting_mode as mode, fiscal_year_start_month as sm, vat_filing_frequency as freq, input_vat_method as ivm,
            to_char(ledger_go_live_date, 'YYYY-MM-DD') as go_live
       from finance_settings where account_user_id = $1`, [scope]);
  const s = r.rows[0] ?? {};
  return {
    mode: (s.mode ?? null) as "owner" | "manager" | null,
    startMonth: Number(s.sm ?? 1),
    frequency: (s.freq ?? "quarterly") as "monthly" | "quarterly",
    inputVatMethod: (s.ivm ?? "direct_plus_ratio") as "direct_plus_ratio" | "direct_only",
    goLive: (s.go_live ?? null) as string | null,
  };
}

/**
 * Contract → tenant, landlord and property, resolved as the posting hooks do
 * (§4.3): `finance_contract_dims` first, then the first `contract_units` unit's
 * property and its owner.
 */
export const CONTRACT_DIMS_SQL = `
  select c.id, c.tenant_id, c.contract_number, c.tenant_name, c.status::text as status, c.deleted_at is not null as deleted,
         coalesce(d.owner_id, pu.owner_id) as owner_id, coalesce(d.property_id, pu.property_id) as property_id,
         to_char(d.ended_on, 'YYYY-MM-DD') as ended_on
    from contracts c
    left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
    left join lateral (
      select pr.id as property_id, pr.owner_id from contract_units cu
        join units u on u.id = cu.unit_id join properties pr on pr.id = u.property_id and pr.user_id = c.user_id
       where cu.contract_id = c.id order by cu.id limit 1) pu on true
   where c.user_id = $1`;

export interface ContractDims {
  id: number;
  tenantId: number | null;
  number: string | null;
  tenantName: string | null;
  status: string;
  deleted: boolean;
  ownerId: number | null;
  propertyId: number | null;
  endedOn: string | null;
}

export async function contractDims(pool: Fv2Pool, scope: number): Promise<Map<number, ContractDims>> {
  const r = await pool.query(CONTRACT_DIMS_SQL, [scope]);
  return new Map(r.rows.map((x: any) => [x.id, {
    id: x.id, tenantId: x.tenant_id, number: x.contract_number, tenantName: x.tenant_name, status: x.status, deleted: x.deleted,
    ownerId: x.owner_id, propertyId: x.property_id, endedOn: x.ended_on,
  }]));
}

export async function namesOf(pool: Fv2Pool, scope: number, table: "tenants" | "owners" | "properties", ids: number[]) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map<number, string>();
  const r = await pool.query(`select id, name from ${table} where user_id = $1 and id = any($2::int[])`, [scope, list]);
  return new Map<number, string>(r.rows.map((x: any) => [x.id, x.name]));
}

/** The deposit installment's description (contracts.module.ts), which is a deposit, not rent. */
export { DEPOSIT_DESC } from "../hooks/classify";
