/**
 * Pure classification helpers the facts loaders share (DESIGN §4.1 "What
 * counts as a charge, and in which VAT category", §4.3, §9 E7). No database,
 * no clock: the loaders read rows and hand them here.
 */
import { rentVatFromUsage } from "../../../common/usage-vat";
import { allocate, fromHalalas, jsonbHalalas, toHalalas } from "../money";
import type { DocGroup, Nature, Usage, VatCategory } from "../rules";

/** Legacy markers written by the existing code paths (string-identical). */
export const DEPOSIT_DESC = "تأمين (وديعة)";
export const ADVANCE_NOTE = "إيجار مدفوع مقدماً";
/** contracts.module.ts terminate: a deposit voucher turned into a landlord collection. */
export const CONVERSION_NOTE = "تأمين محوّل إلى إيراد عند إنهاء العقد";
/**
 * Ejar import writes this onto RENT rows (ejar.module.ts attachEjarInvoices,
 * `ejarInvoiceDescription`). Rows imported before the stamp always began with
 * "فاتورة إيجار" carry only the dates when Ejar gave no invoice number
 * ("تاريخ الإصدار …" / "تاريخ التأخر …"): those are rent too (issue 11i).
 */
const EJAR_RENT_DESC = /^(فاتورة إيجار|تاريخ الإصدار |تاريخ التأخر )/;

/**
 * What an installment row is. Rent rows have a null description, except that
 * the Ejar import stamps "فاتورة إيجار رقم …" onto rent rows (DISCOVERY §1.2.1);
 * the legacy deposit row carries DEPOSIT_DESC; every other description is an
 * additional fee (`appendFees` writes the fee name).
 */
export function installmentNature(description: string | null | undefined): Nature | "deposit" {
  const d = (description ?? "").trim();
  if (!d || EJAR_RENT_DESC.test(d)) return "rent";
  if (d === DEPOSIT_DESC) return "deposit";
  return "fee";
}

/** Residential or commercial from the property/unit usage keys (usage-vat.ts); null when usage does not decide. */
export function usageOf(propertyUsageKey: string | null | undefined, unitUsageKey?: string | null): Usage | null {
  const taxable = rentVatFromUsage(propertyUsageKey, unitUsageKey);
  if (taxable === null) return null;
  return taxable ? "commercial" : "residential";
}

/**
 * The VAT category of an installment charge (§4.1):
 *  - `vat_enabled` → S at 15% (warning `vat_unregistered_seller` when the seller has no VAT number);
 *  - residential → E when the seller is VAT-registered, O when not;
 *  - otherwise O (warning `commercial_without_vat` when the seller is registered).
 */
export function installmentVat(i: { vatEnabled: boolean; usage: Usage | null; sellerRegistered: boolean }):
  { category: VatCategory; rate: number; warnings: string[] } {
  if (i.vatEnabled) return { category: "S", rate: 15, warnings: i.sellerRegistered ? [] : ["vat_unregistered_seller"] };
  if (i.usage === "residential") return { category: i.sellerRegistered ? "E" : "O", rate: 0, warnings: [] };
  return { category: "O", rate: 0, warnings: i.sellerRegistered ? ["commercial_without_vat"] : [] };
}

export interface DocItem {
  description?: unknown;
  amount?: unknown;
  vat?: unknown;
  vatCategory?: unknown;
}

const CATS = new Set(["S", "Z", "E", "O"]);

/**
 * Does a document line's description name one of the covered fee installments?
 * Either exactly, or the fee name followed by a separator and a qualifier: a
 * per-installment invoice reads "<fee> — <month>", and a hand-edited line
 * "<fee> - Q1" or "<fee> (يناير)". A longer word that merely starts with the
 * fee name is not that fee.
 */
function namesFee(desc: string, feeNames: ReadonlySet<string> | undefined): boolean {
  if (!feeNames?.size) return false;
  if (feeNames.has(desc)) return true;
  for (const name of feeNames) {
    if (name && desc.startsWith(name) && /^\s*[—–\-(:،,|/]/.test(desc.slice(name.length))) return true;
  }
  return false;
}

/**
 * A document's VAT groups, from its own items, subtotal and total (§4.1,
 * §2.1: documents are never re-split).
 *
 * Category per item, as the DOCUMENT itself states it (the same reading the
 * ZATCA mirror makes, billing.module.ts `zatcaLinesFromDoc`):
 *  - `vatCategory` when the line carries one;
 *  - else the legacy `vat` flag: true → S; false → E, the exemption the
 *    document prints and files, for a VAT-registered seller. A seller with no
 *    VAT number makes no exempt supplies, so its no-VAT line is O. The
 *    account's own fees (commission, agency fee: `ownFee`) are O.
 *    A no-VAT RENT line of a registered seller's commercial unit is still E as
 *    printed, flagged `commercial_without_vat` (commercial rent is taxable).
 *
 * Nature: `nature` when forced; else `fee` when the item's description names a
 * covered fee installment (exactly, or followed by a qualifier, `namesFee`),
 * else `defaultNature` (`rent`, unless the caller knows the document bills no
 * rent: a free invoice, a debit note → `other`). VAT = total − subtotal, all on
 * the S groups (split by their nets). Σ items is reconciled to `subtotal` on
 * the largest group, with a warning, so the entry always posts the document's
 * own figures.
 */
export function documentGroups(
  doc: { items: DocItem[] | null | undefined; subtotal: string; total: string },
  opts: {
    feeNames?: ReadonlySet<string>; usage?: Usage | null; nature?: Nature; defaultNature?: Nature;
    /** The account's own fee document (commission, agency fee): a no-VAT line is O, never exempt. */
    ownFee?: boolean; sellerRegistered?: boolean;
  } = {},
): { groups: DocGroup[]; warnings: string[] } {
  const warnings: string[] = [];
  const baseNature: Nature = opts.nature ?? opts.defaultNature ?? "rent";
  const buckets = new Map<string, { category: VatCategory; nature: Nature; net: number }>();
  for (const it of Array.isArray(doc.items) ? doc.items : []) {
    if (it == null || it.amount == null) continue;
    const { halalas, rounded } = jsonbHalalas(it.amount);
    if (rounded) warnings.push("jsonb_precision");
    const explicit = typeof it.vatCategory === "string" && CATS.has(it.vatCategory) ? (it.vatCategory as VatCategory) : null;
    const vatFlag = it.vat == null ? true : !!it.vat;
    const desc = String(it.description ?? "").trim();
    const nature: Nature = opts.nature ?? (desc && namesFee(desc, opts.feeNames) ? "fee" : baseNature);
    let category: VatCategory;
    if (explicit) category = explicit;
    else if (vatFlag) category = "S";
    else if (opts.ownFee) category = "O"; // the account's own fee (commission, agency fee): never exempt
    else if (opts.sellerRegistered !== true) category = "O"; // only a taxable person makes exempt supplies
    else {
      category = "E"; // what the document prints and files for a no-VAT line (zatcaLinesFromDoc)
      if (nature === "rent" && opts.usage === "commercial") warnings.push("commercial_without_vat");
    }
    const key = `${category}|${nature}`;
    const b = buckets.get(key) ?? { category, nature, net: 0 };
    b.net += halalas;
    buckets.set(key, b);
  }
  const subtotal = toHalalas(doc.subtotal);
  const total = toHalalas(doc.total);
  let list = [...buckets.values()];
  if (!list.length) {
    list = [{ category: total > subtotal ? "S" : "O", nature: baseNature, net: subtotal }];
    warnings.push("document_without_items");
  }
  const sumNet = list.reduce((s, g) => s + g.net, 0);
  if (sumNet !== subtotal) {
    const biggest = list.reduce((a, b) => (Math.abs(b.net) > Math.abs(a.net) ? b : a));
    biggest.net += subtotal - sumNet;
    warnings.push("items_subtotal_mismatch");
  }
  const vatTotal = total - subtotal;
  let sGroups = list.filter((g) => g.category === "S");
  if (vatTotal !== 0 && !sGroups.length) {
    list.push({ category: "S", nature: baseNature, net: 0 });
    sGroups = list.filter((g) => g.category === "S");
    warnings.push("vat_without_standard_line");
  }
  const vats = sGroups.length ? allocate(vatTotal, sGroups.map((g) => Math.max(1, g.net))) : [];
  const vatOf = new Map(sGroups.map((g, i) => [g, vats[i]]));
  const groups: DocGroup[] = list.map((g) => ({
    category: g.category,
    rate: g.category === "S" ? 15 : 0,
    net: fromHalalas(g.net),
    vat: fromHalalas(vatOf.get(g) ?? 0),
    nature: g.nature,
    usage: opts.usage ?? null,
  }));
  return { groups, warnings: [...new Set(warnings)] };
}

/** An Ejar invoice row as the preview hands it to the import (ejar.map.ts `EjarInvoiceRow`). */
export interface EjarInvoiceLike {
  number?: string | null;
  dueDate?: string | null;
  issueDate?: string | null;
  lateDate?: string | null;
  amount?: string | null;
  remaining?: string | null;
  status?: string | null;
}

/** What Ejar's own words and figures say about one invoice (shared by the v2 and legacy mappings). */
function ejarPaidState(inv: EjarInvoiceLike): { state: "paid" | "partial" | "unpaid"; paidAmount: string | null } {
  const text = inv.status || "";
  const unpaidWord = /unpaid|غير مدفوع/i.test(text);
  const paidWord = /paid|مدفوع/i.test(text) && !unpaidWord;
  // "مدفوعة جزئياً" / "Partially paid" contain the paid word: they were read as fully paid (issue 11b).
  const partialWord = /partial|جزئ/i.test(text);
  let amountH: number | null = null;
  let remainingH: number | null = null;
  try { amountH = jsonbHalalas(inv.amount).halalas; } catch { amountH = null; }
  try { remainingH = inv.remaining == null || String(inv.remaining).trim() === "" ? null : jsonbHalalas(inv.remaining).halalas; } catch { remainingH = null; }
  // Ejar's remaining figure decides a part payment whatever the wording says.
  if (amountH != null && remainingH != null && remainingH > 0 && remainingH < amountH) {
    return { state: "partial", paidAmount: fromHalalas(amountH - remainingH) };
  }
  if (partialWord && !unpaidWord && !(remainingH != null && remainingH <= 0)) return { state: "partial", paidAmount: null };
  if (paidWord && !(remainingH != null && amountH != null && remainingH >= amountH && amountH > 0)) {
    return { state: "paid", paidAmount: amountH != null ? fromHalalas(amountH) : null };
  }
  return { state: "unpaid", paidAmount: null };
}

/**
 * Ejar invoice status under v2 (§9 E7, E26): what Ejar reports PAID becomes
 * `settled_external` (real rent settled through Ejar, charged at its due date
 * and settled by E33); a partial payment leaves the row pending, with the
 * reported figure kept in `finance_ejar_settlements` — it counts as settled
 * outside Dara (the remaining stays open, E33 settles only the reported part).
 * Nothing becomes `paid` or `partially_paid` without a collection. A partial
 * wording ("مدفوعة جزئياً", "Partially paid") is never fully paid, and Ejar's
 * remaining figure, when it has one, decides the paid part.
 */
export function mapEjarStatusV2(inv: EjarInvoiceLike):
  { status: "settled_external" | null; reported: "paid" | "partially_paid" | null; reportedAmount: string | null } {
  const s = ejarPaidState(inv);
  if (s.state === "paid") return { status: "settled_external", reported: "paid", reportedAmount: s.paidAmount };
  if (s.state === "partial") return { status: null, reported: "partially_paid", reportedAmount: s.paidAmount };
  return { status: null, reported: null, reportedAmount: null };
}

/** The flag-off (legacy) stored status for an imported installment: the same reading of Ejar, as the legacy statuses. */
export function mapEjarStatusLegacy(inv: EjarInvoiceLike): "paid" | "partially_paid" | null {
  const s = ejarPaidState(inv).state;
  return s === "paid" ? "paid" : s === "partial" ? "partially_paid" : null;
}

/**
 * The description an Ejar invoice stamps onto its RENT installment. Always
 * begins with "فاتورة إيجار", with or without a number, so the row stays rent
 * everywhere the description classifies it (issue 11i).
 */
export function ejarInvoiceDescription(inv: EjarInvoiceLike): string {
  return [
    inv.number ? `فاتورة إيجار رقم ${inv.number}` : "فاتورة إيجار",
    inv.issueDate && `تاريخ الإصدار ${inv.issueDate}`,
    inv.lateDate && `تاريخ التأخر ${inv.lateDate}`,
  ].filter(Boolean).join(" — ");
}

/**
 * Pair Ejar's invoices with the generated installments, by due date. Ejar
 * invoices are RENT: a fee installment is never matched, even when it falls on
 * the same date (issue 11a), and each invoice is used once.
 */
export function matchEjarInvoices<R extends { id: number; dueDate: string; description?: string | null }, I extends EjarInvoiceLike>(
  rows: R[], invoices: I[],
): Array<{ row: R; inv: I }> {
  const byDue = new Map<string, I[]>();
  for (const inv of invoices) {
    const key = String(inv?.dueDate ?? "").slice(0, 10);
    if (!key) continue;
    const list = byDue.get(key) ?? [];
    list.push(inv);
    byDue.set(key, list);
  }
  const out: Array<{ row: R; inv: I }> = [];
  for (const row of rows) {
    if (installmentNature(row.description ?? null) !== "rent") continue;
    const inv = byDue.get(String(row.dueDate).slice(0, 10))?.shift();
    if (inv) out.push({ row, inv });
  }
  return out;
}

function decimalOrNull(v: unknown): string | null {
  try {
    return fromHalalas(jsonbHalalas(v).halalas);
  } catch {
    return null;
  }
}

/** A legacy free-text business date (`expenses.expense_date`, `landlord_payouts.transfer_date`) → YYYY-MM-DD, or null. */
export function parseBusinessDate(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
