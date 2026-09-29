/**
 * Posting-rule types (DESIGN §4.3, §4.4, §5.2). Rules are PURE functions of
 * (facts frozen at enqueue, ledger state read at post time) -> lines in
 * integer halalas. They never touch the DB; the engine resolves account refs,
 * dates and periods and writes the entry.
 *
 * VAT attribute convention (read by the VAT report, §7.5):
 *  - `taxRole` marks the VAT-REPORT lines. Each carries `vatBase` (signed:
 *    + for a supply/purchase, − for a credit/cancellation/reversal).
 *  - For category S the report line is the VAT line itself: its amount is the
 *    VAT and its `vatBase` the base that VAT relates to. The S net line carries
 *    `vatCategory` only (no base, no role), so the base is never counted twice.
 *  - For Z/E/O (no VAT line) the net line is the report line: it carries
 *    `taxRole`, `vatCategory` and `vatBase`; its amount is the net, not VAT.
 *  So: base = Σ vatBase where taxRole is set; VAT = Σ signed amount where
 *  taxRole is set and vatCategory = 'S'.
 */
import type { SystemKey } from "./system-keys";

export type Treatment = "principal" | "agent";
export type AccountingMode = "owner" | "manager";
export type VatCategory = "S" | "Z" | "E" | "O";
export type Nature = "rent" | "fee" | "other";
export type Usage = "residential" | "commercial";
export type TaxRole = "output" | "input" | "input_nonrecoverable";
export type DocClass = "invoice" | "debit" | "credit" | "charge" | "charge_cancel" | "advance" | "rent_receipt" | "expense" | "other";

/** Dimensions stamped on every line of an automatic entry (§4.3). */
export interface Dims {
  ownerId?: number | null;
  propertyId?: number | null;
  unitId?: number | null;
  tenantId?: number | null;
  contractId?: number | null;
  paymentId?: number | null;
  documentId?: number | null;
}

/** Which cash or bank account a money line uses (§3 "Cash or bank"). */
export interface BankRef {
  bankAccountId?: number | null;
  method?: string | null;
  /** Agent collection: use the default trust account when `agency_collections_to_trust` is on. */
  agency?: boolean;
}

export type AccountRef = { sys: SystemKey } | { bank: BankRef } | { id: number };

export interface RuleLine {
  account: AccountRef;
  /** Integer halalas; exactly one side > 0. */
  debit: number;
  credit: number;
  memo?: string | null;
  dims: Dims;
  vatCategory?: VatCategory | null;
  vatRate?: string | null;
  vatBase?: number | null;
  taxRole?: TaxRole | null;
  sellerKey?: string | null;
  docClass?: DocClass | null;
}

/** An installment's active charge marker (finance_installment_charges, reversed_at is null). */
export interface ActiveCharge {
  generation: number;
  chargedBy: "due" | "document" | "settled_external";
  documentId: number | null;
  /** AR debited by the charge (gross net of advance VAT), halalas. */
  amount: number;
  /** Output VAT credited by the charge, halalas. */
  vatAmount: number;
  /** The base on the charge's VAT line (S), halalas; null when none. */
  vatBase: number | null;
  entryId: number | null;
  /** The VAT category of the charge's own rent line (2131 / revenue), so a release credits the same revenue account. */
  category?: VatCategory | null;
}

/** Ledger state read at POST time by the serial worker (§5.1 point 2, §5.3). */
export interface PostState {
  charges: Record<number, ActiveCharge | undefined>;
  /** Advance VAT booked per installment (E34, net of reversals), halalas. */
  vatBooked: Record<number, number>;
  /** The base of that advance VAT, halalas. */
  baseBooked: Record<number, number>;
  /** Unreleased 2131 per installment (credit − debit), halalas. */
  unreleased: Record<number, number>;
  /** Installments listed in a write-off. */
  writtenOff: number[];
}

export const EMPTY_STATE: PostState = Object.freeze({ charges: {}, vatBooked: {}, baseBooked: {}, unreleased: {}, writtenOff: [] }) as PostState;

export type Effect =
  | { kind: "charge"; paymentId: number; chargedBy: "due" | "document"; documentId: number | null; amount: number; vatAmount: number; chargedOn: string }
  | { kind: "uncharge"; paymentId: number; reason: string }
  | { kind: "vatPoint"; collectionId: number; paymentId: number; vat: number; bookedOn: string }
  /** Advance VAT reversed (a refund on an uncharged installment, or E05 cancelling the charge that netted it): the points shrink, latest first. */
  | { kind: "vatUnpoint"; paymentId: number; vat: number };

export interface RuleOutput {
  lines: RuleLine[];
  warnings: string[];
  /** Nothing to post: the outbox row becomes `skipped` with this reason. */
  skip?: string;
  effects: Effect[];
  /** Installments whose active DUE-DATE charge is reversed first (reverse-and-replace, §4.1). */
  replaceDueCharges?: number[];
  /** Business date of the event (YYYY-MM-DD, Riyadh); the engine routes it to a period (§4.7). */
  date: string;
  memo?: string | null;
}

/**
 * A rule refusal. `permanent` errors fail the outbox row at once (no retry
 * can fix bad facts); others are retried with backoff (§5.3).
 */
export class RuleError extends Error {
  constructor(public readonly code: string, message: string, public readonly permanent = false) {
    super(message);
    this.name = "RuleError";
  }
}
