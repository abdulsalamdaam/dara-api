/**
 * The rule registry (DESIGN §4.4). An outbox payload is `{ rule, facts,
 * paymentIds? }`; the worker dispatches on `rule`. Rows of §4.4 that never
 * post (E14, E23, E25, E26, E29, E30, E32) are listed in NON_POSTING with the
 * reason, so the table is covered end to end.
 */
import { toHalalas } from "../money";
import { agencyFee, chargeDocument, commissionDocument, creditNote } from "./documents";
import { chargeCancelled, dueCharge, monthlyRelease, settledExternal } from "./installments";
import { commissionTransfer } from "./commission-transfer";
import {
  advanceVat, collection, commissionCollected, creditApply, creditRefund, depositForfeited, depositInstallmentCollection, depositOffset,
  depositReceived, depositRefunded, expense, landlordPayout, manualJournal, supplierBill, supplierPayment, vatSettlement, writeOff,
} from "./money-flows";
import { assetAcquired, assetDepreciation, assetDisposal } from "./assets";
import { RuleError, type AccountingMode, type PostState, type RuleOutput, type Treatment } from "./types";

export type RuleCode =
  | "E01" | "E02" | "E03" | "E04" | "E05" | "E06" | "E07" | "E08" | "E09" | "E09C" | "E10" | "E11" | "E12" | "E12B"
  | "E14" | "E15" | "E16" | "E17" | "E18" | "E19" | "E20" | "E21" | "E24" | "E28" | "E33" | "E34" | "E35" | "E36" | "E37"
  | "E38" | "E39"
  | "E15T" // commission transfer (0070)
  | "FA01" | "FA02" | "FA03"; // fixed assets (§8.5)

export interface OutboxPayload {
  rule: RuleCode;
  facts: any;
  /** Installments this event touches (the §5.3 dependency check and state load). */
  paymentIds?: number[];
  /** Origin of the posted entry when not 'auto' (E28: manual / opening). */
  entryOrigin?: "manual" | "opening";
}

type RuleFn = (facts: any, state: PostState) => RuleOutput;

export const RULES: Record<RuleCode, RuleFn> = {
  E01: (f, s) => chargeDocument(f, s, "invoice", { replace: true }),
  E02: dueCharge,
  E03: (f) => {
    if (toHalalas(f.amount) < 0) throw new RuleError("BAD_FACTS", "E03 needs a positive amount (use E04)", true);
    return collection(f);
  },
  E04: (f) => {
    if (toHalalas(f.amount) > 0) throw new RuleError("BAD_FACTS", "E04 needs a negative amount (use E03)", true);
    return collection(f);
  },
  E05: chargeCancelled,
  E06: creditNote,
  E07: (f, s) => chargeDocument(f, s, "debit", { replace: false }),
  E08: (f, s) => {
    if (f.groups.some((g: any) => g.category !== "O" || toHalalas(g.vat) !== 0)) {
      throw new RuleError("BAD_FACTS", "a rent receipt is out of scope (O) with no VAT", true);
    }
    return chargeDocument(f, s, "rent_receipt", { replace: true });
  },
  E09: depositReceived,
  E09C: depositInstallmentCollection,
  E10: depositRefunded,
  E11: depositForfeited,
  E12: depositForfeited,
  E12B: depositOffset,
  E14: (f) => ({ lines: [], warnings: [], skip: "repoint_no_effect", effects: [], date: f.date }),
  E15: (f) => commissionDocument(f, false),
  E16: commissionCollected,
  E17: agencyFee,
  E18: expense,
  E19: landlordPayout,
  E20: creditRefund,
  E21: creditApply,
  E24: writeOff,
  E28: manualJournal,
  E33: settledExternal,
  E34: advanceVat,
  E35: monthlyRelease,
  E36: (f) => commissionDocument(f, true),
  E37: vatSettlement,
  E38: supplierBill,
  E39: supplierPayment,
  // Fixed assets (§8.5): acquisition, monthly depreciation, disposal.
  FA01: assetAcquired,
  FA02: assetDepreciation,
  FA03: assetDisposal,
  E15T: commissionTransfer,
};

/** §4.4 rows that never produce an outbox event, and why. */
export const NON_POSTING: Record<string, string> = {
  E14: "advance re-pointed to an invoice: skip repoint_no_effect (registered, always skips)",
  E22: "contract rebuild: reversal events (`reversal:<event>`) handled by the engine's reversal path",
  E23: "generate-installments: refused (409) under v2 when rows are charged; otherwise nothing charged is deleted",
  E25: "termination mark-as-paid: refused (409) under v2",
  E26: "Ejar import: becomes settled_external; E02 + E33 post it",
  E27: "settle/revert external: E33 and its reversal",
  E29: "payment confirmation approved: creates a draft only",
  E30: "receipt voucher itself: its collections post E03",
  E31: "confirmed document soft-deleted: `reversal:confirmed` via the reversal path",
  E32: "late-payment penalty: not built (Q10)",
};

/** Rules whose outcome depends on installment charge state (§5.3 ordering). */
export const CHARGE_STATE_RULES: ReadonlySet<RuleCode> = new Set(["E01", "E02", "E05", "E06", "E08", "E33", "E34", "E35"]);

export function runRule(payload: OutboxPayload, state: PostState): RuleOutput {
  const fn = RULES[payload.rule];
  if (!fn) throw new RuleError("UNKNOWN_RULE", `no posting rule ${payload.rule}`, true);
  if (!payload.facts || typeof payload.facts.date !== "string") throw new RuleError("MISSING_FACT", "payload.facts.date is required", true);
  return fn(payload.facts, state);
}

/**
 * Principal or agent for one landlord (§4.2). Owner mode: always principal
 * (its precondition makes every landlord the account holder's own identity).
 * Manager mode: the account-holder landlord is principal, every other agent;
 * an unresolved landlord is agent with `landlord_unresolved`.
 */
export function resolveTreatment(
  mode: AccountingMode,
  landlord: { id: number; isAccountHolder: boolean } | null | undefined,
): { treatment: Treatment; ownerId: number | null; warnings: string[] } {
  if (mode === "owner") return { treatment: "principal", ownerId: landlord?.id ?? null, warnings: [] };
  if (!landlord) return { treatment: "agent", ownerId: null, warnings: ["landlord_unresolved"] };
  return { treatment: landlord.isAccountHolder ? "principal" : "agent", ownerId: landlord.id, warnings: [] };
}

export * from "./types";
export * from "./facts";
export { SYS } from "./system-keys";
export { classifyCollection } from "./money-flows";
export { releaseAmount, daysBetween } from "./installments";
