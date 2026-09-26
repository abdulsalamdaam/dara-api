/**
 * Installment rules (DESIGN §4.1, §4.4): E02 due-date charge, E05 charge
 * cancelled, E33 settled outside Dara, E35 monthly straight-line release.
 * Charge state (marker, advance VAT, unreleased 2131) comes from PostState,
 * read at post time (§5.3).
 */
import { mulDivRound, toHalalas, vatSplit } from "../money";
import { lastDayOfMonth, parseIsoDate } from "../dates";
import type { InstallmentFacts, ReleaseFacts } from "./facts";
import { arOf, cr, dr, rateStr, revenueKey, sellerKeyOf, sys } from "./lines";
import { SYS } from "./system-keys";
import { RuleError, type PostState, type RuleLine, type RuleOutput } from "./types";
import { dedupe } from "./documents";

function splitOf(f: InstallmentFacts, gross: number): { net: number; vat: number } {
  return f.category === "S" ? vatSplit(gross, f.rate) : { net: gross, vat: 0 };
}

/** E02: installment past due with no covering document. */
export function dueCharge(f: InstallmentFacts, s: PostState): RuleOutput {
  const warnings = [...(f.warnings ?? [])];
  const p = f.paymentId;
  if (s.charges[p]) return { lines: [], warnings, skip: "already_charged", effects: [], date: f.date };
  const gross = toHalalas(f.gross);
  if (gross <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const { net, vat } = splitOf(f, gross);
  const vb = Math.min(vat, s.vatBooked[p] ?? 0);
  const bb = Math.min(net, s.baseBooked[p] ?? 0);
  const dims = { ...f.dims, paymentId: p };
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);
  const report = f.category !== "S";
  const attrs = {
    vatCategory: f.category, vatRate: rateStr(f.category, f.rate), sellerKey: seller, docClass: "charge" as const,
    ...(report ? { taxRole: "output" as const, vatBase: net } : {}),
  };
  const lines: RuleLine[] = [...dr(arOf(f.treatment), gross - vb, dims, { docClass: "charge" })];
  if (f.treatment === "agent") {
    lines.push(...cr(sys(SYS.lpu), net, dims, attrs));
  } else {
    const account = f.nature === "rent" && f.deferRent ? sys(SYS.ur) : sys(revenueKey(f.nature, f.usage, f.category));
    lines.push(...cr(account, net, dims, attrs));
  }
  if (vat - vb > 0) {
    lines.push(...cr(f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.outputVat), vat - vb, dims, {
      vatCategory: "S", vatRate: rateStr("S", f.rate), vatBase: net - bb, taxRole: "output", sellerKey: seller, docClass: "charge",
    }));
  }
  if (vat > 0) warnings.push("vat_without_tax_invoice");
  return {
    lines, warnings: dedupe(warnings), date: f.date, memo: f.memo ?? null,
    effects: [{ kind: "charge", paymentId: p, chargedBy: "due", documentId: null, amount: gross - vb, vatAmount: vat - vb, chargedOn: f.date }],
  };
}

/**
 * E05: a charged installment is cancelled. Reverses what the ACTIVE charge
 * booked: Dr UR (unreleased part) / Dr REV (released part) / Dr VAT / Cr AR.
 * Skipped when the charge is a document (needs a credit note) or the
 * installment is in a write-off.
 */
export function chargeCancelled(f: InstallmentFacts, s: PostState): RuleOutput {
  const warnings = [...(f.warnings ?? [])];
  const p = f.paymentId;
  const c = s.charges[p];
  const skip = (reason: string): RuleOutput => ({ lines: [], warnings, skip: reason, effects: [], date: f.date });
  if (s.writtenOff.includes(p)) return skip("written_off");
  if (!c) return skip("not_charged");
  if (c.chargedBy === "document") return skip("cancelled_but_invoiced");
  const net = c.amount - c.vatAmount;
  const dims = { ...f.dims, paymentId: p };
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);
  const report = f.category !== "S";
  const attrs = (amt: number) => ({
    vatCategory: f.category, vatRate: rateStr(f.category, f.rate), sellerKey: seller, docClass: "charge_cancel" as const,
    ...(report ? { taxRole: "output" as const, vatBase: -amt } : {}),
  });
  const lines: RuleLine[] = [];
  if (f.treatment === "agent") {
    lines.push(...dr(sys(SYS.lpu), net, dims, attrs(net)));
  } else {
    const fromUr = f.nature === "rent" ? Math.min(Math.max(0, s.unreleased[p] ?? 0), net) : 0;
    lines.push(...dr(sys(SYS.ur), fromUr, dims, attrs(fromUr)));
    lines.push(...dr(sys(revenueKey(f.nature, f.usage, f.category)), net - fromUr, dims, attrs(net - fromUr)));
  }
  lines.push(...dr(f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.outputVat), c.vatAmount, dims, {
    vatCategory: "S", vatRate: rateStr("S", f.rate), vatBase: -(c.vatBase ?? 0), taxRole: "output", sellerKey: seller, docClass: "charge_cancel",
  }));
  lines.push(...cr(arOf(f.treatment), c.amount, dims, { docClass: "charge_cancel" }));
  return { lines, warnings, date: f.date, memo: f.memo ?? null, effects: [{ kind: "uncharge", paymentId: p, reason: "cancelled" }] };
}

/**
 * E33: an installment Ejar reports paid, after it is charged. Principal: Dr
 * 1116 cash in transit / Cr AR. Agent: Dr 2122 / Cr 1122 (the landlord was
 * paid directly). Not charged yet → retried (the charge is queued first).
 */
export function settledExternal(f: InstallmentFacts, s: PostState): RuleOutput {
  const p = f.paymentId;
  const c = s.charges[p];
  if (!c) throw new RuleError("NOT_CHARGED", `installment ${p} is not charged yet`);
  const amount = f.amount != null ? toHalalas(f.amount) : c.amount;
  const warnings = [...(f.warnings ?? [])];
  if (amount <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const dims = { ...f.dims, paymentId: p };
  const lines = f.treatment === "agent"
    ? [...dr(sys(SYS.lpu), amount, dims), ...cr(sys(SYS.arAgency), amount, dims)]
    : [...dr(sys(SYS.cashInTransit), amount, dims), ...cr(sys(SYS.ar), amount, dims)];
  return { lines, warnings, effects: [], date: f.date, memo: f.memo ?? null };
}

/** Inclusive day count between two ISO dates (0 when b < a). */
export function daysBetween(a: string, b: string): number {
  const d = (x: string) => {
    const { y, m, day } = parseIsoDate(x);
    return Date.UTC(y, m - 1, day) / 86_400_000;
  };
  return Math.max(0, d(b) - d(a) + 1);
}

const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);

/**
 * The E35 release for one month (§4.1): the REMAINING unreleased balance is
 * spread over the REMAINING days of the window; the month holding the window's
 * last day takes the rest, so releases sum exactly to the net charge.
 */
export function releaseAmount(unreleased: number, month: string, windowStart: string, windowEnd: string): { amount: number; date: string } | null {
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
  const from = maxIso(monthStart, windowStart);
  const to = minIso(monthEnd, windowEnd);
  if (unreleased <= 0 || from > to) return null;
  const date = to;
  if (windowEnd <= monthEnd) return { amount: unreleased, date };
  const inMonth = daysBetween(from, to);
  const remaining = daysBetween(from, windowEnd);
  return { amount: mulDivRound(unreleased, inMonth, remaining), date };
}

/** E35: Dr UR / Cr REV for one month of a principal rent installment. */
export function monthlyRelease(f: ReleaseFacts, s: PostState): RuleOutput {
  const warnings = [...(f.warnings ?? [])];
  if (f.treatment === "agent") return { lines: [], warnings, skip: "agent_not_deferred", effects: [], date: f.date };
  const r = releaseAmount(s.unreleased[f.paymentId] ?? 0, f.month, f.windowStart, f.windowEnd);
  if (!r || r.amount <= 0) return { lines: [], warnings, skip: "nothing_to_release", effects: [], date: f.date };
  const dims = { ...f.dims, paymentId: f.paymentId };
  const lines = [
    ...dr(sys(SYS.ur), r.amount, dims),
    ...cr(sys(revenueKey("rent", f.usage, f.category)), r.amount, dims),
  ];
  return { lines, warnings, effects: [], date: r.date, memo: f.memo ?? null };
}
