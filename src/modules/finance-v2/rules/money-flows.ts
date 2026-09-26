/**
 * Cash and tenant-balance rules (DESIGN §4.4): collections (E03/E04, E09
 * collection variant, E12, E12b, E16), advance VAT (E34), deposit voucher
 * (E09), deposit refund (E10), forfeit (E11), expense (E18), landlord payout
 * (E19), tenant credit refund/apply (E20/E21), write-off (E24), manual journal
 * (E28) and VAT settlement (E37). The collection classifier (§4.4.1) lives here
 * so live posting and catch-up share it.
 */
import { toHalalas, vatSplit } from "../money";
import type {
  CollectionClass, CollectionFacts, CreditApplyFacts, DepositMoneyFacts, ExpenseFacts, ForfeitFacts, ManualFacts, MoneyFacts, VatSettlementFacts,
} from "./facts";
import { arOf, cr, dr, rateStr, sellerKeyOf, sys, signed } from "./lines";
import { SYS } from "./system-keys";
import { RuleError, type Dims, type PostState, type RuleLine, type RuleOutput, type Treatment } from "./types";

const out = (lines: RuleLine[], f: { date: string; warnings?: string[]; memo?: string | null }, extra: Partial<RuleOutput> = {}): RuleOutput =>
  ({ lines, warnings: [...(f.warnings ?? [])], effects: [], date: f.date, memo: f.memo ?? null, ...extra });
const skip = (reason: string, f: { date: string; warnings?: string[] }): RuleOutput =>
  ({ lines: [], warnings: [...(f.warnings ?? [])], skip: reason, effects: [], date: f.date });

/**
 * A tenant-money movement of signed X into AR (X > 0 = cash in, credits AR).
 * Agent: also moves the landlord's share from uncollected (2122) to
 * collected (2121), keeping 1122 = −2122 (§4.2).
 */
function tenantCash(t: Treatment, x: number, cash: RuleLine[], dims: Dims): RuleLine[] {
  const lines = [...cash, ...signed(arOf(t), -x, dims)];
  if (t === "agent") lines.push(...signed(sys(SYS.lpu), x, dims), ...signed(sys(SYS.lp), -x, dims));
  return lines;
}

// ─── Collections ────────────────────────────────────────────────────────────

/** E03 (X > 0) / E04 (X < 0): Dr BANK / Cr AR, agent also Dr 2122 / Cr LP. */
export function collection(f: CollectionFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x === 0) return skip("zero_amount", f);
  const dims = { ...f.dims, paymentId: f.paymentId ?? f.dims.paymentId ?? null };
  const bank = signed({ bank: { ...f.bank, agency: f.treatment === "agent" } }, x, dims);
  return out(tenantCash(f.treatment, x, bank, dims), f);
}

/** E09 collection variant: a collection on a legacy deposit installment. + Dr BANK / Cr DEP; − the reverse. */
export function depositInstallmentCollection(f: CollectionFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x === 0) return skip("zero_amount", f);
  const dims = { ...f.dims, paymentId: f.paymentId ?? null };
  return out([...signed({ bank: f.bank }, x, dims), ...signed(sys(SYS.dep), -x, dims)], f);
}

/** E12b: deposit applied to arrears. Dr DEP / Cr AR (agent: plus Dr 2122 / Cr LP). */
export function depositOffset(f: CollectionFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  const dims = { ...f.dims, paymentId: f.paymentId ?? null };
  return out(tenantCash(f.treatment, x, dr(sys(SYS.dep), x, dims), dims), f);
}

/** E16: commission document collected. Agent + cash: Dr BANK / Cr LP; deduction: skip. */
export function commissionCollected(f: CollectionFacts): RuleOutput {
  if (f.treatment === "principal") return skip("self_commission", f);
  if (f.cls !== "commission_cash") {
    const r = skip("settled_by_deduction", f);
    if (f.assumed) r.warnings.push("assumed_deduction");
    return r;
  }
  const x = toHalalas(f.amount);
  if (x === 0) return skip("zero_amount", f);
  return out([...signed({ bank: f.bank }, x, f.dims), ...signed(sys(SYS.lp), -x, f.dims)], f);
}

/**
 * E34: advance VAT at the earliest tax point (§4.1). A positive collection on
 * an UNCHARGED S installment books vat(X): principal Dr AR / Cr 2151, agent
 * Dr 1122 / Cr 2122. A negative collection reverses up to what is booked.
 */
export function advanceVat(f: CollectionFacts, s: PostState): RuleOutput {
  const p = f.paymentId;
  if (!p) return skip("no_installment", f);
  if (f.category !== "S") return skip("not_standard_rated", f);
  const x = toHalalas(f.amount);
  if (x === 0) return skip("zero_amount", f);
  const dims = { ...f.dims, paymentId: p };
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);
  const vatAcc = f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.outputVat);
  const rate = f.rate ?? 15;
  let vat: number;
  let base: number;
  if (x > 0) {
    if (s.charges[p]) return skip("already_charged", f);
    ({ vat, net: base } = vatSplit(x, rate));
  } else {
    const sp = vatSplit(-x, rate);
    vat = -Math.min(sp.vat, s.vatBooked[p] ?? 0);
    base = -Math.min(sp.net, s.baseBooked[p] ?? 0);
  }
  if (vat === 0) return skip("nothing_booked", f);
  const lines = [
    ...signed(arOf(f.treatment), vat, dims, { docClass: "advance" }),
    ...signed(vatAcc, -vat, dims, { vatCategory: "S", vatRate: rateStr("S", rate), vatBase: base, taxRole: "output", sellerKey: seller, docClass: "advance" }),
  ];
  const r = out(lines, f);
  r.warnings.push("vat_without_tax_invoice");
  if (vat > 0) r.effects.push({ kind: "vatPoint", collectionId: f.collectionId, paymentId: p, vat, bookedOn: f.date });
  return r;
}

export interface ClassifyInput {
  amount: number;
  metaClassification?: "deposit_offset" | "deposit_conversion" | "commission_cash" | null;
  settledByDeduction?: boolean;
  /** kind of the document `invoice_id` points at, if any. */
  documentKind?: string | null;
  paymentId?: number | null;
  paymentIsDeposit?: boolean;
  /** History: the terminate note text plus a date after the voucher's issue date. */
  looksLikeTerminateConversion?: boolean;
}

export interface Classified {
  rule: "E03" | "E04" | "E09C" | "E12" | "E12B" | "E16" | null;
  cls: CollectionClass | null;
  /** E34 is emitted too when the caller finds an uncharged S installment. */
  advanceVatCandidate: boolean;
  warnings: string[];
}

/** §4.4.1, in order. `rule: null` = the collection posts nothing (its amount is inside the voucher's E09). */
export function classifyCollection(c: ClassifyInput): Classified {
  const none: Classified = { rule: null, cls: null, advanceVatCandidate: false, warnings: [] };
  if (c.metaClassification === "deposit_offset") return { ...none, rule: "E12B", cls: "deposit_offset" };
  if (c.metaClassification === "deposit_conversion") return { ...none, rule: "E12", cls: "deposit_conversion" };
  if (c.metaClassification === "commission_cash") return { ...none, rule: "E16", cls: "commission_cash" };
  if (c.documentKind === "deposit") {
    if (c.paymentId) {
      if (c.paymentIsDeposit) return { ...none, rule: "E09C", cls: "deposit_installment" };
      return { ...none, rule: c.amount < 0 ? "E04" : "E03", cls: "rent", advanceVatCandidate: c.amount > 0 };
    }
    if (c.looksLikeTerminateConversion) return { ...none, rule: "E12", cls: "deposit_conversion", warnings: ["inferred_classification"] };
    return none;
  }
  if (c.documentKind === "commission") return { ...none, rule: "E16", cls: "commission_deduction" };
  if (c.paymentId && c.paymentIsDeposit) return { ...none, rule: "E09C", cls: "deposit_installment" };
  return { ...none, rule: c.amount < 0 ? "E04" : "E03", cls: "rent", advanceVatCandidate: c.amount > 0 && !!c.paymentId };
}

// ─── Deposits ───────────────────────────────────────────────────────────────

/** E09: deposit voucher confirmed; posts only its unlinked amount. Dr BANK / Cr DEP. */
export function depositReceived(f: DepositMoneyFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("fully_linked", f);
  const dims = { ...f.dims, documentId: f.documentId };
  return out([...dr({ bank: f.bank }, x, dims), ...cr(sys(SYS.dep), x, dims)], f);
}

/** E10: deposit refunded. Dr DEP / Cr BANK. */
export function depositRefunded(f: DepositMoneyFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  const dims = { ...f.dims, documentId: f.documentId };
  const r = out([...dr(sys(SYS.dep), x, dims), ...cr({ bank: f.bank }, x, dims)], f);
  if (f.inferredDate) r.warnings.push("inferred_date");
  return r;
}

/**
 * E11 / E12: deposit forfeited or turned into revenue (no cash). Principal:
 * Dr DEP / Cr 4310 net (+ Cr VAT when S). Agent: Dr DEP / Cr LP (the
 * landlord's; VAT attributes for the landlord's return when S).
 */
export function depositForfeited(f: ForfeitFacts | (CollectionFacts & { forfeitVat?: "O" | "S" | "E" })): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  const cat = f.forfeitVat ?? "O";
  const { net, vat } = cat === "S" ? vatSplit(x, 15) : { net: x, vat: 0 };
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);
  const creditAcc = f.treatment === "agent" ? sys(SYS.lp) : sys(SYS.depositForfeit);
  const vatAcc = f.treatment === "agent" ? sys(SYS.lp) : sys(SYS.outputVat);
  const report = cat !== "S";
  const lines = [
    ...dr(sys(SYS.dep), x, f.dims),
    ...cr(creditAcc, net, f.dims, { vatCategory: cat, vatRate: rateStr(cat, 15), sellerKey: seller, docClass: "other", ...(report ? { taxRole: "output" as const, vatBase: net } : {}) }),
    ...cr(vatAcc, vat, f.dims, { vatCategory: "S", vatRate: "15", vatBase: net, taxRole: "output", sellerKey: seller, docClass: "other" }),
  ];
  return out(lines, f);
}

// ─── Expenses, payouts, tenant credit, write-off ───────────────────────────

/**
 * E18: expense revision. Company: Dr EXP net / Dr 1151 (recoverable) or 5500
 * VAT / Cr BANK gross. Landlord-charged (agent): Dr LP net / Dr LP VAT / Cr BANK.
 */
export function expense(f: ExpenseFacts): RuleOutput {
  const gross = toHalalas(f.gross);
  const net = toHalalas(f.net);
  const vat = toHalalas(f.vat);
  if (net + vat !== gross) throw new RuleError("BAD_FACTS", `expense ${f.expenseId}: net + vat <> gross`, true);
  if (gross <= 0) return skip("zero_amount", f);
  const landlord = f.chargeTo === "landlord" && f.treatment === "agent";
  const seller = landlord ? sellerKeyOf("agent", f.dims.ownerId) : "account";
  const role = f.recoverable ? ("input" as const) : ("input_nonrecoverable" as const);
  const report = f.category !== "S";
  const lines: RuleLine[] = [
    ...dr(landlord ? sys(SYS.lp) : f.expenseAccount, net, f.dims, {
      vatCategory: f.category, vatRate: rateStr(f.category, f.rate), sellerKey: seller, docClass: "expense",
      ...(report ? { taxRole: role, vatBase: net } : {}),
    }),
    ...dr(landlord ? sys(SYS.lp) : sys(f.recoverable ? SYS.inputVat : SYS.vatNonRecoverable), vat, f.dims, {
      vatCategory: "S", vatRate: rateStr("S", f.rate), vatBase: net, taxRole: role, sellerKey: seller, docClass: "expense",
    }),
    ...cr({ bank: f.bank }, gross, f.dims),
  ];
  return out(lines, f);
}

/** E19: landlord payout. Principal: Dr 3400 drawings; agent: Dr LP. Cr BANK. */
export function landlordPayout(f: MoneyFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  return out([...dr(sys(f.treatment === "agent" ? SYS.lp : SYS.drawings), x, f.dims), ...cr({ bank: f.bank ?? {} }, x, f.dims)], f);
}

/** E20: tenant credit refunded. Dr AR / Cr BANK (agent: plus Dr LP / Cr 2122). */
export function creditRefund(f: MoneyFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  return out(tenantCash(f.treatment, -x, cr({ bank: f.bank ?? {} }, x, f.dims), f.dims), f);
}

/**
 * E21: tenant credit carried to another contract. Same contract and
 * landlord: allocation only. Across landlords under agency: refused.
 * The credit sits on the SOURCE as a negative AR; applying it debits the
 * source (its credit shrinks) and credits the target (its debt shrinks):
 * Dr AR (source dims) / Cr AR (target dims); agent also Cr 2122 (source) /
 * Dr 2122 (target), keeping 1122 = −2122 per contract. (DESIGN §4.4 row E21
 * printed the sides the other way round, which would have doubled the credit.)
 */
export function creditApply(f: CreditApplyFacts): RuleOutput {
  if (f.sameContract && f.sameLandlord) return skip("allocation_only", f);
  if (f.treatment === "agent" && !f.sameLandlord) {
    throw new RuleError("CROSS_LANDLORD", "a tenant credit cannot move between landlords under agency", true);
  }
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  const ar = arOf(f.treatment);
  const lines = [...dr(ar, x, f.dims), ...cr(ar, x, f.targetDims)];
  if (f.treatment === "agent") lines.push(...cr(sys(SYS.lpu), x, f.dims), ...dr(sys(SYS.lpu), x, f.targetDims));
  return out(lines, f);
}

/** E24: write-off. Principal: Dr 5330 / Cr AR; agent: Dr 2122 / Cr 1122 (the landlord bears it). */
export function writeOff(f: MoneyFacts): RuleOutput {
  const x = toHalalas(f.amount);
  if (x <= 0) return skip("zero_amount", f);
  const debit = f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.badDebt);
  return out([...dr(debit, x, f.dims), ...cr(arOf(f.treatment), x, f.dims)], f);
}

/** E28: manual journal / opening balance, as drafted (accounts by id). */
export function manualJournal(f: ManualFacts): RuleOutput {
  const lines: RuleLine[] = f.lines.map((l, i) => {
    const d = toHalalas(l.debit || "0");
    const c = toHalalas(l.credit || "0");
    if (d < 0 || c < 0 || (d > 0) === (c > 0)) throw new RuleError("BAD_FACTS", `manual line ${i + 1} needs exactly one positive side`, true);
    return { account: { id: l.accountId }, debit: d, credit: c, memo: l.memo ?? null, dims: l.dims ?? {} };
  });
  return { lines, warnings: [], effects: [], date: f.date, memo: f.memo ?? null };
}

/**
 * E37: VAT return locked for seller 'account'. Dr 2151 box-6 VAT / Cr 1151
 * input VAT booked / Cr 5500 (or Dr 5500) the §8.2(b) apportionment
 * adjustment / Cr 2152 net payable (or Dr 1152 when a refund), where net =
 * box 6 VAT − (booked + adjustment) = box 13. No tax_role (so it is exempt
 * from the VAT lock).
 */
export function vatSettlement(f: VatSettlementFacts): RuleOutput {
  const o = toHalalas(f.outputVat);
  const i = toHalalas(f.inputVat);
  const adj = f.apportionment == null ? 0 : toHalalas(f.apportionment);
  const netPayable = o - i - adj;
  const lines = [
    ...signed(sys(SYS.outputVat), o, {}),
    ...signed(sys(SYS.inputVat), -i, {}),
    ...signed(sys(SYS.vatNonRecoverable), -adj, {}),
    ...(netPayable >= 0 ? signed(sys(SYS.vatSettlement), -netPayable, {}) : signed(sys(SYS.vatRefundable), -netPayable, {})),
  ];
  if (!lines.length) return skip("zero_amount", f);
  return out(lines, f);
}
