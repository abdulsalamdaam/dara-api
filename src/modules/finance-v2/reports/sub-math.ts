import { fromHalalas, mulDivRound } from "../money";

/**
 * Pure helpers of the sub-ledger reports (DESIGN §7.5 VAT return, §7.6 AR
 * aging, §8.2(b) input-VAT apportionment). Integer halalas only.
 */

// ───────────────────────────── §7.6 aging ─────────────────────────────

export const BUCKETS = ["notDue", "d0_30", "d31_60", "d61_90", "d90p"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Days past due → bucket. The due date itself is day 0 (0–30); 91+ is 90+. */
export function bucketOf(daysPastDue: number): Bucket {
  if (!Number.isInteger(daysPastDue)) throw new Error(`fv2: days must be an integer, got ${daysPastDue}`);
  if (daysPastDue < 0) return "notDue";
  if (daysPastDue <= 30) return "d0_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90p";
}

/** The open amount of an item: amount less everything applied to it (all halalas). */
export function remainingOf(amount: number, ...applied: number[]): number {
  return applied.reduce((r, x) => r - x, amount);
}

// ───────────────────────────── §7.5 VAT boxes ─────────────────────────────

export type VatCat = "S" | "Z" | "E" | "O";

/** One aggregate of VAT-attributed journal lines (seller and period already filtered). */
export interface VatAgg {
  taxRole: "output" | "input" | "input_nonrecoverable";
  category: VatCat;
  docClass: string | null;
  /** The line belongs to a reversal entry (an edited or deleted revision). */
  reversal: boolean;
  /** Σ vat_base, signed. */
  base: number;
  /** Σ amount in the role's direction: output credit − debit; input debit − credit. */
  amount: number;
}

/** ZATCA's "Adjustments" column on the sales side (§7.5). */
const SALES_ADJUSTMENT = new Set(["credit", "charge_cancel", "debit"]);

export interface BoxH { box: number; key: string; amount: number; adjustment: number; vat: number | null }

export interface VatBoxesH {
  boxes: BoxH[];
  outOfScopeSales: { amount: number; adjustment: number };
  outOfScopePurchases: { amount: number; adjustment: number };
  nonRecoverable: { base: number; vat: number };
  outputVat: number;
  /** Σ recoverable input VAT booked on the lines (before any apportionment adjustment). */
  inputVatBooked: number;
}

/**
 * The return layout from line aggregates. Output: the S base and VAT come from
 * the output VAT lines (which carry `vat_base`), the Z/E/O bases from the net
 * lines that carry `tax_role`. Input: box 7 is recoverable S purchases (VAT
 * column = input VAT claimed), boxes 10/11 zero-rated / exempt purchases.
 * Adjustments: credit notes, charge cancellations and debit notes on the sales
 * side; reversed or edited revisions on the purchase side. `apportionment` is
 * the §8.2(b) adjustment to the input VAT claimed (box 7 and 12 VAT).
 */
export function vatBoxes(rows: VatAgg[], apportionment = 0): VatBoxesH {
  const sales = (cat: VatCat) => {
    let amount = 0;
    let adjustment = 0;
    for (const r of rows) {
      if (r.taxRole !== "output" || r.category !== cat) continue;
      if (SALES_ADJUSTMENT.has(r.docClass ?? "")) adjustment += r.base;
      else amount += r.base;
    }
    return { amount, adjustment };
  };
  const purchases = (cats: VatCat[], roles: VatAgg["taxRole"][]) => {
    let amount = 0;
    let adjustment = 0;
    let vat = 0;
    for (const r of rows) {
      if (!roles.includes(r.taxRole) || !cats.includes(r.category)) continue;
      if (r.reversal) adjustment += r.base;
      else amount += r.base;
      vat += r.amount;
    }
    return { amount, adjustment, vat };
  };
  const outputVat = rows.filter((r) => r.taxRole === "output" && r.category === "S").reduce((s, r) => s + r.amount, 0);
  const b1 = sales("S");
  const b3 = sales("Z");
  const b5 = sales("E");
  const b7 = purchases(["S"], ["input"]);
  const b10 = purchases(["Z"], ["input", "input_nonrecoverable"]);
  const b11 = purchases(["E"], ["input", "input_nonrecoverable"]);
  const nr = purchases(["S"], ["input_nonrecoverable"]);
  const oosP = purchases(["O"], ["input", "input_nonrecoverable"]);
  const inputClaimed = b7.vat + apportionment;
  const zero = (box: number, key: string, vat: number | null = 0): BoxH => ({ box, key, amount: 0, adjustment: 0, vat });
  const box6: BoxH = { box: 6, key: "total_sales", amount: b1.amount + b3.amount + b5.amount, adjustment: b1.adjustment + b3.adjustment + b5.adjustment, vat: outputVat };
  const box12: BoxH = { box: 12, key: "total_purchases", amount: b7.amount + b10.amount + b11.amount, adjustment: b7.adjustment + b10.adjustment + b11.adjustment, vat: inputClaimed };
  return {
    boxes: [
      { box: 1, key: "standard_rated_sales", ...b1, vat: outputVat },
      zero(2, "sales_to_citizens"),
      { box: 3, key: "zero_rated_sales", ...b3, vat: null },
      zero(4, "exports", null),
      { box: 5, key: "exempt_sales", ...b5, vat: null },
      box6,
      { box: 7, key: "standard_rated_purchases", amount: b7.amount, adjustment: b7.adjustment, vat: inputClaimed },
      zero(8, "imports_customs"),
      zero(9, "imports_reverse_charge"),
      { box: 10, key: "zero_rated_purchases", amount: b10.amount, adjustment: b10.adjustment, vat: null },
      { box: 11, key: "exempt_purchases", amount: b11.amount, adjustment: b11.adjustment, vat: null },
      box12,
    ],
    outOfScopeSales: sales("O"),
    outOfScopePurchases: { amount: oosP.amount, adjustment: oosP.adjustment },
    nonRecoverable: { base: nr.amount + nr.adjustment, vat: nr.vat },
    outputVat,
    inputVatBooked: b7.vat,
  };
}

/** Box 13 = box 6 VAT − box 12 VAT; box 16 = 13 + 14 − 15. */
export function netBoxes(outputVat: number, inputClaimed: number, box14: number, box15: number) {
  const box13 = outputVat - inputClaimed;
  return { box13, box16: box13 + box14 - box15 };
}

// ───────────────────────────── §8.2(b) apportionment ─────────────────────────────

export interface ApportionInput {
  method: "direct_plus_ratio" | "direct_only";
  /** Taxable supplies of the basis period (standard + zero-rated bases). */
  taxable: number;
  /** Exempt supplies of the basis period. */
  exempt: number;
  /** Input VAT on overheads (no property) in the return period, recoverable and not. */
  overheadVat: number;
  /** Of which booked as recoverable (1151). */
  overheadBookedRecoverable: number;
}

export interface ApportionOut {
  applies: boolean;
  reason: string | null;
  /** Percent with two decimals, e.g. "62.50"; null when there is no basis. */
  ratioPercent: string | null;
  /** round(overheadVat × ratio). */
  recoverableAtRatio: number;
  /** recoverableAtRatio − booked: added to the input VAT claimed (negative: claimed less). */
  adjustment: number;
}

/** "62.50" from basis points (6250). */
export function percentOf(num: number, den: number): string | null {
  if (den <= 0) return null;
  const bp = mulDivRound(num, 10_000, den);
  return fromHalalas(bp);
}

/**
 * Input VAT on overheads of an account with both taxable and exempt supplies
 * is recoverable at taxable ÷ (taxable + exempt) (VAT IR Art. 51; DESIGN
 * §8.2(b)). The adjustment is the difference between that and what the lines
 * booked as recoverable, so it is zero once the posting already applied the
 * ratio. Nothing applies with `direct_only`, or when the account makes only
 * one kind of supply (the per-expense choice then stands).
 */
export function apportion(a: ApportionInput): ApportionOut {
  const total = a.taxable + a.exempt;
  const ratioPercent = percentOf(a.taxable, total);
  const none = (reason: string): ApportionOut => ({ applies: false, reason, ratioPercent, recoverableAtRatio: a.overheadBookedRecoverable, adjustment: 0 });
  if (a.method === "direct_only") return none("direct_only");
  if (total <= 0) return none("no_supplies");
  if (a.taxable <= 0 || a.exempt <= 0) return none("single_kind_of_supply");
  if (a.overheadVat === 0) return none("no_overhead_vat");
  const recoverableAtRatio = mulDivRound(a.overheadVat, a.taxable, total);
  return { applies: true, reason: null, ratioPercent, recoverableAtRatio, adjustment: recoverableAtRatio - a.overheadBookedRecoverable };
}
