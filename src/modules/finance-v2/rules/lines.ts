import type { AccountRef, Dims, RuleLine, TaxRole, Treatment, VatCategory, DocClass } from "./types";
import { SYS, type SystemKey } from "./system-keys";

export const sys = (k: SystemKey): AccountRef => ({ sys: k });

export interface LineExtra {
  memo?: string | null;
  vatCategory?: VatCategory | null;
  vatRate?: string | null;
  vatBase?: number | null;
  taxRole?: TaxRole | null;
  sellerKey?: string | null;
  docClass?: DocClass | null;
  dims?: Dims;
}

/**
 * A line from a SIGNED amount: positive = debit, negative = credit, zero = no
 * line. Rules build entries from these so a negative input (a refund, a
 * credit) flips sides instead of producing a negative debit.
 */
export function signed(account: AccountRef, amount: number, dims: Dims, extra: LineExtra = {}): RuleLine[] {
  if (!Number.isSafeInteger(amount)) throw new Error(`fv2: rule amount must be integer halalas, got ${amount}`);
  if (amount === 0) return [];
  const { dims: extraDims, ...rest } = extra;
  return [{
    account,
    debit: amount > 0 ? amount : 0,
    credit: amount < 0 ? -amount : 0,
    dims: { ...dims, ...(extraDims ?? {}) },
    ...rest,
  }];
}

export const dr = (a: AccountRef, amt: number, dims: Dims, x: LineExtra = {}) => signed(a, amt, dims, x);
export const cr = (a: AccountRef, amt: number, dims: Dims, x: LineExtra = {}) => signed(a, -amt, dims, x);

/** AR for a tenant flow: 1121 principal, 1122 agent (§4.3). */
export const arOf = (t: Treatment): AccountRef => sys(t === "agent" ? SYS.arAgency : SYS.ar);

/** `seller_key` (§4.3): 'account' for the account's own supplies, 'owner:<id>' for an agent landlord's. */
export function sellerKeyOf(t: Treatment, ownerId: number | null | undefined): string {
  if (t === "principal") return "account";
  return ownerId ? `owner:${ownerId}` : "owner:unresolved";
}

/** Rent revenue account by the line's nature (§3 "Accounts the engine resolves"). */
export function revenueKey(nature: "rent" | "fee" | "other", usage: "residential" | "commercial" | null | undefined, category: VatCategory): SystemKey {
  if (nature === "fee") return SYS.revService;
  if (nature === "other") return SYS.revOther;
  return usage === "residential" || category === "E" ? SYS.revResidential : SYS.revCommercial;
}

export const rateStr = (category: VatCategory, rate: number): string => (category === "S" ? String(rate) : "0");

/** Σ debit and Σ credit of lines, halalas. */
export function totals(lines: RuleLine[]): { debit: number; credit: number } {
  return lines.reduce((t, l) => ({ debit: t.debit + l.debit, credit: t.credit + l.credit }), { debit: 0, credit: 0 });
}
