/**
 * E15T تحويل عمولات (the accountant's workbook, sheet "قواعد القيود"): the
 * commission the office has booked out of the landlords' money (E15, less
 * E36/E16) is moved from the client-money (trust) bank account to the
 * operating account. Dr operating bank / Cr trust bank. A pure transfer
 * between two of the account's own boxes: no landlord dimension, no VAT, and
 * the landlord payable (2121) is not touched — the commission already left it
 * at E15 — so the landlord statement is unaffected.
 */
import { toHalalas } from "../money";
import { RuleError, type RuleOutput } from "./types";

export interface CommissionTransferFacts {
  date: string;
  amount: string;
  fromBankAccountId: number;
  toBankAccountId: number;
  memo?: string | null;
  warnings?: string[];
}

export function commissionTransfer(f: CommissionTransferFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (!(x > 0)) throw new RuleError("BAD_FACTS", "a commission transfer needs a positive amount", true);
  if (!f.fromBankAccountId || !f.toBankAccountId || f.fromBankAccountId === f.toBankAccountId) {
    throw new RuleError("BAD_FACTS", "a commission transfer needs two different bank accounts", true);
  }
  return {
    lines: [
      { account: { bank: { bankAccountId: f.toBankAccountId } }, debit: x, credit: 0, dims: {} },
      { account: { bank: { bankAccountId: f.fromBankAccountId } }, debit: 0, credit: x, dims: {} },
    ],
    warnings: [...(f.warnings ?? [])],
    effects: [],
    date: f.date,
    memo: f.memo ?? null,
  };
}
