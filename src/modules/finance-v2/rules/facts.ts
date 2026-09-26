/**
 * Facts frozen into `ledger_outbox.payload.facts` at enqueue (DESIGN §5.2).
 * Amounts are decimal STRINGS ('1234.50'); rules convert them to halalas.
 * Dimensions and the principal/agent treatment are resolved once, at enqueue,
 * and never re-derived (§4.2, §4.3).
 */
import type { AccountRef, BankRef, Dims, Nature, Treatment, Usage, VatCategory } from "./types";

interface Base {
  /** Business date of the event, YYYY-MM-DD (Riyadh). */
  date: string;
  treatment: Treatment;
  dims: Dims;
  /** Warnings decided at enqueue (e.g. landlord_unresolved, dimension_ambiguous). */
  warnings?: string[];
  memo?: string | null;
}

/** One VAT-category group of a document (documents are never re-split, §2.1). */
export interface DocGroup {
  category: VatCategory;
  /** Integer percent; 0 unless S. */
  rate: number;
  net: string;
  vat: string;
  nature: Nature;
  usage?: Usage | null;
}

/** E01, E06, E07, E08, E15, E17, E36. */
export interface DocumentFacts extends Base {
  documentId: number;
  groups: DocGroup[];
  /** Installments the document covers, with their gross amounts (weights for per-installment 2131). */
  coverage: Array<{ paymentId: number; amount: string }>;
  /** `defer_rent_straight_line` at enqueue (§4.1). */
  deferRent: boolean;
}

/** E02, E05, E33: one installment. */
export interface InstallmentFacts extends Base {
  paymentId: number;
  gross: string;
  category: VatCategory;
  rate: number;
  nature: Nature;
  usage?: Usage | null;
  deferRent: boolean;
  /** E33 only: the amount Ejar reported settled (defaults to the charge). */
  amount?: string | null;
}

/** E35: a monthly straight-line release. */
export interface ReleaseFacts extends Base {
  paymentId: number;
  /** YYYY-MM */
  month: string;
  /** Coverage window, inclusive (§4.1). */
  windowStart: string;
  windowEnd: string;
  category: VatCategory;
  usage?: Usage | null;
}

export type CollectionClass =
  | "rent"
  | "deposit_installment"
  | "deposit_conversion"
  | "deposit_offset"
  | "commission_cash"
  | "commission_deduction";

/** E03, E04, E09C, E12, E12B, E16, E34. */
export interface CollectionFacts extends Base {
  collectionId: number;
  /** Signed: a terminate refund is negative (E04). */
  amount: string;
  cls: CollectionClass;
  bank: BankRef;
  paymentId?: number | null;
  /** The installment's VAT category/rate (E34 advance VAT). */
  category?: VatCategory | null;
  rate?: number | null;
  /** E12: settings.deposit_forfeit_vat at enqueue. */
  forfeitVat?: "O" | "S" | "E";
  /** E16 backfill: deduction assumed (warning `assumed_deduction`). */
  assumed?: boolean;
}

/** E09 (voucher), E10. */
export interface DepositMoneyFacts extends Base {
  documentId: number;
  /** E09: the voucher's unlinked amount; E10: the refunded amount. */
  amount: string;
  bank: BankRef;
  /** E10 legacy: date inferred from updated_at (warning `inferred_date`). */
  inferredDate?: boolean;
}

/** E11. */
export interface ForfeitFacts extends Base {
  amount: string;
  forfeitVat: "O" | "S" | "E";
}

/** E18. */
export interface ExpenseFacts extends Base {
  expenseId: number;
  revision: number;
  gross: string;
  net: string;
  vat: string;
  category: VatCategory;
  rate: number;
  recoverable: boolean;
  chargeTo: "company" | "landlord";
  /** Resolved at enqueue: detail override → category map → 5190/5290 (§3). */
  expenseAccount: AccountRef;
  bank: BankRef;
}

/** One line of a supplier bill (E38). */
export interface BillLineFacts {
  /** Resolved at enqueue: line override → supplier default → 5190 (with a property) / 5290. */
  account: AccountRef;
  net: string;
  vat: string;
  category: VatCategory;
  /** Integer percent; 0 unless S. */
  rate: number;
  recoverable: boolean;
  memo?: string | null;
}

/** E38: supplier bill approved (tier 3, DESIGN §8.4). */
export interface BillFacts extends Base {
  billId: number;
  supplierId: number;
  chargeTo: "company" | "landlord";
  /** Σ (net + vat) of the lines. */
  total: string;
  lines: BillLineFacts[];
}

/** E19, E20, E24, E39. */
export interface MoneyFacts extends Base {
  amount: string;
  bank?: BankRef;
  paymentIds?: number[];
}

/** E21. */
export interface CreditApplyFacts extends Base {
  amount: string;
  targetDims: Dims;
  sameContract: boolean;
  sameLandlord: boolean;
}

/** E28. */
export interface ManualFacts {
  date: string;
  memo?: string | null;
  lines: Array<{ accountId: number; debit: string; credit: string; memo?: string | null; dims?: Dims }>;
}

/** E37. */
export interface VatSettlementFacts {
  date: string;
  /** Box 6 output VAT, signed. */
  outputVat: string;
  /** Input VAT booked on 1151 in the period (recoverable), signed. */
  inputVat: string;
  /**
   * §8.2(b) apportionment of overhead input VAT, signed: positive = more is
   * recoverable than was booked (Cr 5500), negative = less (Dr 5500). Box 12
   * VAT = inputVat + apportionment.
   */
  apportionment?: string;
  /** Box 15: VAT credit carried forward from earlier returns (sits on 1152), ≥ 0. */
  carriedForward?: string;
  /** Box 14: corrections from previous periods (±5,000). Not posted: its counter-entry depends on the error. */
  corrections?: string;
}
