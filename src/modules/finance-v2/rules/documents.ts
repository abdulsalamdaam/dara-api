/**
 * Document rules (DESIGN §4.4): E01 tax invoice, E07 debit note, E08 non-tax
 * rent receipt, E06 credit note, E15 commission invoice, E36 commission
 * credit note, E17 agency-fee invoice. Documents post IN FULL from their own
 * figures (§2.1): the VAT is the document's, never re-split.
 */
import { allocate, toHalalas } from "../money";
import type { DocGroup, DocumentFacts } from "./facts";
import { arOf, cr, dr, rateStr, revenueKey, sellerKeyOf, sys } from "./lines";
import { SYS } from "./system-keys";
import type { DocClass, Effect, PostState, RuleLine, RuleOutput } from "./types";

interface Group { g: DocGroup; net: number; vat: number }

function groupsOf(f: DocumentFacts): Group[] {
  return f.groups.map((g) => ({ g, net: toHalalas(g.net), vat: toHalalas(g.vat) }));
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Split `amount` across the covered installments by their gross amounts. */
function perInstallment(f: DocumentFacts, amount: number): Array<{ paymentId: number; amount: number }> {
  const parts = allocate(amount, f.coverage.map((c) => toHalalas(c.amount)));
  return f.coverage.map((c, i) => ({ paymentId: c.paymentId, amount: parts[i] }));
}

/**
 * E01 / E07 / E08: a charge document. Principal: Dr AR gross / Cr UR (rent,
 * deferred, per covered installment) or REV / Cr VAT. Agent: Dr 1122 / Cr 2122
 * net and VAT lines. Advance VAT already booked on the covered installments
 * (E34) is netted from AR and VAT (§4.1). E01/E08 reverse-and-replace any
 * active due-date charge and mark the covered installments charged.
 */
export function chargeDocument(f: DocumentFacts, s: PostState, docClass: DocClass, opts: { replace: boolean }): RuleOutput {
  const groups = groupsOf(f);
  const warnings = [...(f.warnings ?? [])];
  const dims = { ...f.dims, documentId: f.documentId };
  const gross = sum(groups.map((x) => x.net + x.vat));
  if (gross <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const vatTotal = sum(groups.map((x) => x.vat));
  const sNet = sum(groups.filter((x) => x.g.category === "S").map((x) => x.net));
  const covered = f.coverage.map((c) => c.paymentId);
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);

  // Cutover (§6.7): a charge marker with no entry was re-created from the
  // opening balance, i.e. the installment's AR (and its VAT) is already in the
  // opening entry. A document covering only such installments must not charge
  // them again; the backfill skips the same documents (`covered_by_opening`).
  const fromOpening = (p: number) => {
    const a = s.charges[p];
    return !!a && a.entryId == null && a.chargedBy !== "document";
  };
  if (opts.replace && covered.length && covered.every(fromOpening)) {
    return { lines: [], warnings, skip: "covered_by_opening", effects: [], date: f.date };
  }
  if (opts.replace && covered.some(fromOpening)) warnings.push("partly_covered_by_opening");

  // Advance VAT netting (only E01/E08 charge installments; a debit note is an extra charge).
  let vb = 0;
  let bb = 0;
  if (opts.replace) {
    vb = Math.min(vatTotal, sum(covered.map((p) => s.vatBooked[p] ?? 0)));
    bb = Math.min(sNet, sum(covered.map((p) => s.baseBooked[p] ?? 0)));
    if (sum(covered.map((p) => s.vatBooked[p] ?? 0)) > vb) warnings.push("advance_vat_unmatched");
  }

  const lines: RuleLine[] = [];
  const ar = arOf(f.treatment);
  lines.push(...dr(ar, gross - vb, dims, { docClass }));

  for (const { g, net } of groups) {
    const report = g.category !== "S";
    const vatAttrs = {
      vatCategory: g.category, vatRate: rateStr(g.category, g.rate), sellerKey: seller, docClass,
      ...(report ? { taxRole: "output" as const } : {}),
    };
    if (f.treatment === "agent") {
      lines.push(...cr(sys(SYS.lpu), net, dims, { ...vatAttrs, vatBase: report ? net : null }));
      continue;
    }
    const deferred = g.nature === "rent" && f.deferRent;
    if (deferred && covered.length) {
      for (const part of perInstallment(f, net)) {
        lines.push(...cr(sys(SYS.ur), part.amount, { ...dims, paymentId: part.paymentId }, { ...vatAttrs, vatBase: report ? part.amount : null }));
      }
    } else {
      if (deferred) warnings.push("no_coverage_window");
      lines.push(...cr(sys(revenueKey(g.nature, g.usage, g.category)), net, dims, { ...vatAttrs, vatBase: report ? net : null }));
    }
  }
  if (vatTotal - vb > 0) {
    const vatAcc = f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.outputVat);
    lines.push(...cr(vatAcc, vatTotal - vb, dims, {
      vatCategory: "S", vatRate: rateStr("S", groups.find((x) => x.g.category === "S")?.g.rate ?? 15),
      vatBase: sNet - bb, taxRole: "output", sellerKey: seller, docClass,
    }));
  }

  const effects: Effect[] = [];
  const replaceDueCharges: number[] = [];
  if (opts.replace && covered.length) {
    const arParts = perInstallment(f, gross - vb);
    const vatParts = perInstallment(f, vatTotal - vb);
    covered.forEach((p, i) => {
      const active = s.charges[p];
      if (active?.chargedBy === "document") {
        warnings.push("already_document_charged");
        return;
      }
      if (active) replaceDueCharges.push(p);
      effects.push({ kind: "charge", paymentId: p, chargedBy: "document", documentId: f.documentId, amount: arParts[i].amount, vatAmount: vatParts[i].amount, chargedOn: f.date });
    });
  }
  return { lines, warnings: dedupe(warnings), effects, replaceDueCharges, date: f.date, memo: f.memo ?? null };
}

/**
 * E06: credit note. Principal: Dr UR up to the covered installments'
 * unreleased balance, the rest Dr REV / Dr VAT / Cr AR gross. Agent: Dr 2122
 * net and VAT / Cr 1122 gross. Negative VAT bases (an adjustment, §7.5).
 */
export function creditNote(f: DocumentFacts, s: PostState): RuleOutput {
  const groups = groupsOf(f);
  const warnings = [...(f.warnings ?? [])];
  const dims = { ...f.dims, documentId: f.documentId };
  const gross = sum(groups.map((x) => x.net + x.vat));
  if (gross <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const vatTotal = sum(groups.map((x) => x.vat));
  const sNet = sum(groups.filter((x) => x.g.category === "S").map((x) => x.net));
  const seller = sellerKeyOf(f.treatment, f.dims.ownerId);
  const docClass: DocClass = "credit";
  const lines: RuleLine[] = [];

  // Remaining unreleased 2131 per covered installment, consumed as rent lines are credited.
  const unrel = new Map(f.coverage.map((c) => [c.paymentId, Math.max(0, s.unreleased[c.paymentId] ?? 0)]));

  for (const { g, net } of groups) {
    const report = g.category !== "S";
    const attrs = (amt: number) => ({
      vatCategory: g.category, vatRate: rateStr(g.category, g.rate), sellerKey: seller, docClass,
      ...(report ? { taxRole: "output" as const, vatBase: -amt } : {}),
    });
    if (f.treatment === "agent") {
      lines.push(...dr(sys(SYS.lpu), net, dims, attrs(net)));
      continue;
    }
    let left = net;
    if (g.nature === "rent") {
      for (const part of perInstallment(f, net)) {
        const avail = unrel.get(part.paymentId) ?? 0;
        const take = Math.min(avail, part.amount);
        if (take > 0) {
          lines.push(...dr(sys(SYS.ur), take, { ...dims, paymentId: part.paymentId }, attrs(take)));
          unrel.set(part.paymentId, avail - take);
          left -= take;
        }
      }
    }
    lines.push(...dr(sys(revenueKey(g.nature, g.usage, g.category)), left, dims, attrs(left)));
  }
  if (vatTotal > 0) {
    const vatAcc = f.treatment === "agent" ? sys(SYS.lpu) : sys(SYS.outputVat);
    lines.push(...dr(vatAcc, vatTotal, dims, {
      vatCategory: "S", vatRate: rateStr("S", groups.find((x) => x.g.category === "S")?.g.rate ?? 15),
      vatBase: -sNet, taxRole: "output", sellerKey: seller, docClass,
    }));
  }
  lines.push(...cr(arOf(f.treatment), gross, dims, { docClass }));
  return { lines, warnings: dedupe(warnings), effects: [], date: f.date, memo: f.memo ?? null };
}

/**
 * E15 commission invoice (agent landlord): Dr LP gross / Cr 4210 net / Cr VAT.
 * E36 commission credit note is its mirror. Principal: skip `self_commission`.
 */
export function commissionDocument(f: DocumentFacts, credit: boolean): RuleOutput {
  const warnings = [...(f.warnings ?? [])];
  if (f.treatment === "principal") return { lines: [], warnings, skip: "self_commission", effects: [], date: f.date };
  const groups = groupsOf(f);
  const dims = { ...f.dims, documentId: f.documentId };
  const gross = sum(groups.map((x) => x.net + x.vat));
  if (gross <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const sgn = credit ? -1 : 1;
  const docClass: DocClass = credit ? "credit" : "invoice";
  const lines: RuleLine[] = [];
  lines.push(...dr(sys(SYS.lp), sgn * gross, dims, { docClass }));
  let sNet = 0;
  let vatTotal = 0;
  for (const { g, net, vat } of groups) {
    const report = g.category !== "S";
    if (g.category === "S") sNet += net;
    vatTotal += vat;
    lines.push(...cr(sys(SYS.commission), sgn * net, dims, {
      vatCategory: g.category, vatRate: rateStr(g.category, g.rate), sellerKey: "account", docClass,
      ...(report ? { taxRole: "output" as const, vatBase: sgn * net } : {}),
    }));
  }
  lines.push(...cr(sys(SYS.outputVat), sgn * vatTotal, dims, {
    vatCategory: "S", vatRate: "15", vatBase: sgn * sNet, taxRole: "output", sellerKey: "account", docClass,
  }));
  return { lines, warnings, effects: [], date: f.date, memo: f.memo ?? null };
}

/** E17 agency fee: always the account's own revenue. Dr 1121 / Cr 4220 net / Cr VAT. */
export function agencyFee(f: DocumentFacts): RuleOutput {
  const groups = groupsOf(f);
  const dims = { ...f.dims, documentId: f.documentId };
  const gross = sum(groups.map((x) => x.net + x.vat));
  const warnings = [...(f.warnings ?? [])];
  if (gross <= 0) return { lines: [], warnings, skip: "zero_amount", effects: [], date: f.date };
  const lines: RuleLine[] = [...dr(sys(SYS.ar), gross, dims, { docClass: "invoice" })];
  let sNet = 0;
  let vatTotal = 0;
  for (const { g, net, vat } of groups) {
    const report = g.category !== "S";
    if (g.category === "S") sNet += net;
    vatTotal += vat;
    lines.push(...cr(sys(SYS.agencyFee), net, dims, {
      vatCategory: g.category, vatRate: rateStr(g.category, g.rate), sellerKey: "account", docClass: "invoice",
      ...(report ? { taxRole: "output" as const, vatBase: net } : {}),
    }));
  }
  lines.push(...cr(sys(SYS.outputVat), vatTotal, dims, { vatCategory: "S", vatRate: "15", vatBase: sNet, taxRole: "output", sellerKey: "account", docClass: "invoice" }));
  return { lines, warnings, effects: [], date: f.date, memo: f.memo ?? null };
}

export function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
