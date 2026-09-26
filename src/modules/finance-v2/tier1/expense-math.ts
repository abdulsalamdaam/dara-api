/**
 * Expense VAT arithmetic and the recoverability default (DESIGN §8.2 b). Pure,
 * integer halalas.
 */
import { mulDivRound, vatSplit } from "../money";
import type { Usage, VatCategory } from "../rules";

export interface ExpenseAmounts {
  gross: number;
  net: number;
  vat: number;
  rate: number;
}

/**
 * Gross entry: S splits the gross at the rate (the same split the rest of the
 * engine uses). Net entry: VAT = round-half-up(net × rate / 100), gross = net +
 * VAT. Z / E / O carry no VAT: net = gross.
 */
export function expenseAmounts(mode: "gross" | "net", amount: number, category: VatCategory, rate: number): ExpenseAmounts {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("fv2: expense amount must be positive halalas");
  if (category !== "S") return { gross: amount, net: amount, vat: 0, rate: 0 };
  if (!Number.isInteger(rate) || rate <= 0 || rate > 100) throw new Error("fv2: a standard-rated expense needs a positive integer rate");
  if (mode === "gross") {
    const { net, vat } = vatSplit(amount, rate);
    return { gross: amount, net, vat, rate };
  }
  const vat = mulDivRound(amount, rate, 100);
  return { gross: amount + vat, net: amount, vat, rate };
}

export interface RecoverInput {
  category: VatCategory;
  chargeTo: "company" | "landlord";
  /** The account (managing company) has a VAT number. */
  accountRegistered: boolean;
  /** No property: an overhead (apportioned by ratio in the VAT return). */
  hasProperty: boolean;
  /** Property usage; null = mixed or unknown. */
  usage: Usage | null;
}

export type RecoverReason =
  | "not_standard_rated"
  | "charged_to_landlord"
  | "account_not_registered"
  | "residential_property"
  | "mixed_or_unknown_usage"
  | "overhead_apportioned"
  | "recoverable"
  /** Recoverable by the rules above, but the expense has no supplier VAT number (no tax invoice). */
  | "no_supplier_vat";

/**
 * Recoverable only if ALL hold: the category is S; the VAT registrant is known
 * (charged to the company and the account has a VAT number — a landlord-charged
 * expense defaults to non-recoverable, VAT IR Art. 49, unless the user says the
 * invoice is addressed to a registered landlord); and the property is not
 * residential (exempt letting, Art. 49-51). Mixed or unknown usage defaults to
 * non-recoverable with a hint. An overhead (no property) is recoverable here and
 * apportioned in the VAT return (§8.2 b, direct_plus_ratio).
 */
export function recoverDefault(i: RecoverInput): { recoverable: boolean; reason: RecoverReason } {
  if (i.category !== "S") return { recoverable: false, reason: "not_standard_rated" };
  if (i.chargeTo === "landlord") return { recoverable: false, reason: "charged_to_landlord" };
  if (!i.accountRegistered) return { recoverable: false, reason: "account_not_registered" };
  if (!i.hasProperty) return { recoverable: true, reason: "overhead_apportioned" };
  if (i.usage === "residential") return { recoverable: false, reason: "residential_property" };
  if (i.usage == null) return { recoverable: false, reason: "mixed_or_unknown_usage" };
  return { recoverable: true, reason: "recoverable" };
}

export const SUPPLIER_VAT_RE = /^3[0-9]{13}3$/;
