/**
 * Fixed-asset posting rules (DESIGN §8.5; the accountant's rules row
 * "إهلاك (شهري)"). Same in both accounting modes (Owner mode also registers
 * and depreciates its buildings). Every line carries the asset's linked
 * property as its property dimension, so the depreciation reaches the
 * property's profitability.
 *
 *  FA01 acquired (acquisition paid from a bank/cash account):
 *       Dr asset (cost account) / Cr BANK.
 *  FA02 depreciation for one month (dated the month end):
 *       Dr depreciation expense / Cr accumulated depreciation.
 *  FA03 disposal: the disposal month's charge up to the date, then the asset
 *       leaves the books:
 *       Dr expense / Cr accumulated            (that month's charge, if any)
 *       Dr accumulated (everything booked)     Dr BANK (proceeds, if any)
 *       Cr asset (cost), and the difference to gain (Cr) or loss (Dr).
 *
 * Accounts are referenced by id (the register stores them), except the bank.
 */
import { toHalalas } from "../money";
import { RuleError, type BankRef, type Dims, type RuleLine, type RuleOutput } from "./types";

export interface AssetAcquiredFacts {
  date: string;
  assetId: number;
  amount: string;
  assetAccountId: number;
  bank: BankRef;
  dims: Dims;
  memo?: string | null;
}

export interface AssetDepreciationFacts {
  date: string;
  assetId: number;
  month: string;
  amount: string;
  expenseAccountId: number;
  accumAccountId: number;
  dims: Dims;
  memo?: string | null;
}

export interface AssetDisposalFacts {
  date: string;
  assetId: number;
  cost: string;
  /** The disposal month's charge up to the date. */
  partial: string;
  /** Accumulated depreciation removed, the partial charge included. */
  accumulated: string;
  proceeds: string;
  assetAccountId: number;
  accumAccountId: number | null;
  expenseAccountId: number | null;
  gainAccountId: number;
  lossAccountId: number;
  bank: BankRef;
  dims: Dims;
  memo?: string | null;
}

const line = (id: number, debit: number, credit: number, dims: Dims, memo: string | null = null): RuleLine =>
  ({ account: { id }, debit, credit, dims, memo });

const need = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new RuleError("BAD_FACTS", `${what} is required`, true);
  return n;
};

export function assetAcquired(f: AssetAcquiredFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return { lines: [], warnings: [], skip: "zero_amount", effects: [], date: f.date };
  const dims = f.dims ?? {};
  return {
    lines: [line(need(f.assetAccountId, "assetAccountId"), x, 0, dims), { account: { bank: f.bank ?? {} }, debit: 0, credit: x, dims }],
    warnings: [], effects: [], date: f.date, memo: f.memo ?? null,
  };
}

export function assetDepreciation(f: AssetDepreciationFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return { lines: [], warnings: [], skip: "zero_amount", effects: [], date: f.date };
  const dims = f.dims ?? {};
  return {
    lines: [line(need(f.expenseAccountId, "expenseAccountId"), x, 0, dims), line(need(f.accumAccountId, "accumAccountId"), 0, x, dims)],
    warnings: [], effects: [], date: f.date, memo: f.memo ?? null,
  };
}

export function assetDisposal(f: AssetDisposalFacts): RuleOutput {
  const cost = toHalalas(f.cost);
  const partial = toHalalas(f.partial);
  const acc = toHalalas(f.accumulated);
  const proceeds = toHalalas(f.proceeds);
  if (cost <= 0 || partial < 0 || acc < partial || proceeds < 0 || acc > cost) {
    throw new RuleError("BAD_FACTS", "disposal figures are inconsistent", true);
  }
  const dims = f.dims ?? {};
  const lines: RuleLine[] = [];
  if (partial > 0) {
    lines.push(line(need(f.expenseAccountId, "expenseAccountId"), partial, 0, dims, "depreciation to the disposal date"));
    lines.push(line(need(f.accumAccountId, "accumAccountId"), 0, partial, dims, "depreciation to the disposal date"));
  }
  if (acc > 0) lines.push(line(need(f.accumAccountId, "accumAccountId"), acc, 0, dims, "accumulated depreciation removed"));
  if (proceeds > 0) lines.push({ account: { bank: f.bank ?? {} }, debit: proceeds, credit: 0, dims, memo: "disposal proceeds" });
  lines.push(line(need(f.assetAccountId, "assetAccountId"), 0, cost, dims, "cost removed"));
  const gain = proceeds - (cost - acc);
  if (gain > 0) lines.push(line(need(f.gainAccountId, "gainAccountId"), 0, gain, dims, "gain on disposal"));
  if (gain < 0) lines.push(line(need(f.lossAccountId, "lossAccountId"), -gain, 0, dims, "loss on disposal"));
  return { lines, warnings: [], effects: [], date: f.date, memo: f.memo ?? null };
}
