/**
 * ZATCA code lists for the VAT side of an e-invoice, transcribed from the
 * Fatoora SDK's own validation rules (R3.4.8, `20210819_ZATCA_E-invoice_
 * Validation_Rules.xsl`) — the rule set the production endpoints enforce, not
 * the 2023 PDF, which has not been reissued and is missing three codes.
 *
 * Why this file exists: the builder used to label EVERY exempt subtotal
 * `VATEX-SA-30` ("real estate transactions, Article 30"), because this is a
 * property product and rent was the only exempt supply anyone had in mind. A
 * water recharge a landlord ticked "no VAT" on then went to ZATCA as an
 * Article-30 real-estate exemption — a false statement, and one the sandbox
 * accepts without a word. The reason is now a property of the LINE, chosen
 * where the line is created, and nothing below guesses one.
 */

export type VatCategory = "S" | "Z" | "E" | "O";
export const VAT_CATEGORIES: readonly VatCategory[] = ["S", "Z", "E", "O"];

export interface ExemptionReason {
  category: Exclude<VatCategory, "S">;
  /** BT-120 text. ZATCA's SDK samples print it bilingual; the rule only demands non-empty. */
  text: string;
}

/**
 * BR-KSA-CL-04 (SDK R3.4.8): the allowed BT-121 codes per BT-118 category.
 * E and O have not changed since 2021; Z gained DUTYFREE (3.3.4) and
 * ROYALDECREE / 32(bis) (3.4.2). Texts follow the SDK's own sample documents.
 */
export const EXEMPTION_REASONS: Readonly<Record<string, ExemptionReason>> = {
  // ── E: exempt ────────────────────────────────────────────────────────────
  "VATEX-SA-29":   { category: "E", text: "Financial services mentioned in Article 29 of the VAT Regulations | الخدمات المالية" },
  "VATEX-SA-29-7": { category: "E", text: "Life insurance services mentioned in Article 29 of the VAT Regulations | عقد تأمين على الحياة" },
  "VATEX-SA-30":   { category: "E", text: "Real estate transactions mentioned in Article 30 of the VAT Regulations | التوريدات العقارية المعفاة من الضريبة" },
  // ── Z: zero-rated ────────────────────────────────────────────────────────
  "VATEX-SA-32":   { category: "Z", text: "Export of goods | صادرات السلع من المملكة" },
  "VATEX-SA-33":   { category: "Z", text: "Export of services | صادرات الخدمات من المملكة" },
  "VATEX-SA-34-1": { category: "Z", text: "The international transport of Goods | النقل الدولي للسلع" },
  "VATEX-SA-34-2": { category: "Z", text: "international transport of passengers | النقل الدولي للركاب" },
  "VATEX-SA-34-3": { category: "Z", text: "services directly connected and incidental to a Supply of international passenger transport | الخدمات المرتبطة مباشرة بالنقل الدولي للركاب" },
  "VATEX-SA-34-4": { category: "Z", text: "Supply of a qualifying means of transport | توريد وسائل النقل المؤهلة" },
  "VATEX-SA-34-5": { category: "Z", text: "Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations | خدمات النقل المرتبطة بالسلع أو الركاب" },
  "VATEX-SA-35":   { category: "Z", text: "Medicines and medical equipment | الأدوية والمعدات الطبية" },
  "VATEX-SA-36":   { category: "Z", text: "Qualifying metals | المعادن المؤهلة" },
  "VATEX-SA-EDU":  { category: "Z", text: "Private education to citizen | التعليم الأهلي للمواطنين" },
  "VATEX-SA-HEA":  { category: "Z", text: "Private healthcare to citizen | الرعاية الصحية الأهلية للمواطنين" },
  "VATEX-SA-MLTRY": { category: "Z", text: "supply of qualified military goods | توريد السلع العسكرية المؤهلة" },
  "VATEX-SA-DIPLOMAT": { category: "Z", text: "Supply to diplomatic missions | التوريد للبعثات الدبلوماسية" },
  "VATEX-SA-DUTYFREE": { category: "Z", text: "Duty free supply | التوريد في الأسواق الحرة" },
  "VATEX-SA-ROYALDECREE": { category: "Z", text: "Supply on which the Government bears the VAT | توريد تتحمل الدولة ضريبته" },
  "VATEX-SA-32(bis)": { category: "Z", text: "Supply under Customs Suspension Arrangement | توريد تحت وضع تعليق الرسوم الجمركية" },
  // ── O: out of scope (free text; this is the default) ─────────────────────
  "VATEX-SA-OOS":  { category: "O", text: "Services outside scope of tax / Not subject to VAT | التوريدات غير الخاضعة للضريبة" },
};

export function isVatCategory(v: unknown): v is VatCategory {
  return typeof v === "string" && (VAT_CATEGORIES as readonly string[]).includes(v);
}

/** The reason code is one ZATCA lists FOR THAT CATEGORY (BR-KSA-CL-04). */
export function isExemptionReasonFor(category: VatCategory, code: unknown): code is string {
  if (typeof code !== "string" || category === "S") return false;
  return EXEMPTION_REASONS[code]?.category === category;
}

/**
 * The reason a line carries, or null. Only `O` has a default: VATEX-SA-OOS is
 * the ONLY out-of-scope code, so stating it adds nothing a caller could get
 * wrong. E and Z each have several, and picking one for the caller is exactly
 * the mistake this module exists to stop.
 */
export function exemptionReasonFor(category: VatCategory, code: unknown): string | null {
  if (category === "S") return null;
  if (isExemptionReasonFor(category, code)) return code;
  if (category === "O" && (code == null || code === "")) return "VATEX-SA-OOS";
  return null;
}

/**
 * Names of the lines that are not standard-rated and carry no valid reason —
 * the lines ZATCA would refuse (BR-KSA-23/69/24) or, worse, that we used to
 * file under an invented one. Empty means the document can be built.
 */
export function unexplainedExemptLines(
  lines: ReadonlyArray<{ name: string; vatCategory?: string; exemptionReasonCode?: string | null }>,
): string[] {
  return lines
    .filter((l) => isVatCategory(l.vatCategory) && l.vatCategory !== "S" && exemptionReasonFor(l.vatCategory, l.exemptionReasonCode) == null)
    .map((l) => l.name);
}

/** BT-120 as a landlord may write it: the most we keep of their own wording. */
export const EXEMPTION_REASON_TEXT_MAX = 300;

/**
 * Whether a line of this category may carry its own BT-120 wording. Only `O`:
 * VATEX-SA-OOS is the one code ZATCA leaves as taxpayer free text ("state why
 * the supply is outside the scope"). For E and Z the text IS the code's
 * official description — a landlord's paraphrase of "Article 30 real estate"
 * that says something else is a false statement on a signed document (and,
 * per the compliance review, the SDK's rules hold a text-matches-code check,
 * commented out for now).
 */
export function acceptsCustomExemptionText(category: unknown): boolean {
  return category === "O";
}

/**
 * A landlord's own BT-120 wording, cleaned for a signed XML document, or
 * undefined when there is nothing left of it. Control characters are not legal
 * XML 1.0 (the builder escapes `& < >` but cannot escape those), line breaks
 * become spaces — it is one sentence on the document — and the cap counts
 * code points so an Arabic or emoji character is never cut in half.
 */
export function normalizeExemptionReasonText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return Array.from(clean).slice(0, EXEMPTION_REASON_TEXT_MAX).join("").trim();
}

/**
 * The BT-120 text a line's reason will print as. For `O`, its own wording or
 * the canonical OOS text — the builder's own rule (`exemptionReasonText?.trim()
 * || canonical`), so the conflict check compares exactly what would be
 * written. For E and Z, always the canonical text: callers never pass wording
 * for those (see `acceptsCustomExemptionText`).
 */
export function effectiveExemptionReasonText(category: VatCategory, code: string, custom?: string | null): string {
  const own = acceptsCustomExemptionText(category) && typeof custom === "string" ? custom.trim() : "";
  return own || EXEMPTION_REASONS[code]?.text || "";
}

/**
 * Categories whose lines disagree about the reason. EN16931 keeps ONE VAT
 * breakdown per category (BR-E-08 sums every exempt line into it), so a
 * document cannot say "this exempt line is real estate and that one is
 * financial services" — the second ground needs its own document. Returns
 * `["E: rent, loan fee"]`-style descriptions; empty means consistent.
 *
 * The same holds for the out-of-scope TEXT (BT-120), the one free-text
 * reason. The breakdown carries one text, and the builder takes it from the
 * first line of the category — so two O lines with different wording would
 * print only the first, silently, and which survived would depend on line
 * order. O lines therefore agree on the text as it will be PRINTED: a line's
 * own wording, or the canonical OOS text when it has none. "Own wording on one
 * line, none on another" is a conflict too, deliberately: either way one line's
 * statement would be lost, and which wording is right is the landlord's call.
 * E and Z lines are compared by code alone — their text is always the official
 * one, whatever a caller sent.
 */
export function exemptionReasonConflicts(
  lines: ReadonlyArray<{ name: string; vatCategory?: string; exemptionReasonCode?: string | null; exemptionReasonText?: string | null }>,
): string[] {
  const byCat = new Map<string, Map<string, string[]>>();
  for (const l of lines) {
    if (!isVatCategory(l.vatCategory) || l.vatCategory === "S") continue;
    const reason = exemptionReasonFor(l.vatCategory, l.exemptionReasonCode);
    if (!reason) continue;
    const key = `${reason}\u0000${effectiveExemptionReasonText(l.vatCategory, reason, l.exemptionReasonText)}`;
    const m = byCat.get(l.vatCategory) ?? new Map<string, string[]>();
    m.set(key, [...(m.get(key) ?? []), l.name]);
    byCat.set(l.vatCategory, m);
  }
  return [...byCat.entries()]
    .filter(([, m]) => m.size > 1)
    .map(([cat, m]) => `${cat}: ${[...m.values()].flat().join(", ")}`);
}

// ── Party identification schemes ────────────────────────────────────────────

/** BR-KSA-08: what a SELLER may identify with. No NAT, no IQA — an individual's national ID goes under OTH. */
export const SELLER_ID_SCHEMES = ["CRN", "MOM", "MLS", "700", "SAG", "OTH"] as const;
/** BR-KSA-14: what a BUYER may identify with. */
export const BUYER_ID_SCHEMES = ["TIN", "CRN", "MOM", "MLS", "700", "SAG", "NAT", "GCC", "IQA", "PAS", "OTH"] as const;

export type SellerIdScheme = (typeof SELLER_ID_SCHEMES)[number];
export type BuyerIdScheme = (typeof BUYER_ID_SCHEMES)[number];

/**
 * Format rules the SDK checks per scheme (BR-KSA-F-07…F-11, R3.4.4+), and the
 * shapes Saudi identifiers actually have: a CR is 10 digits; the unified
 * national number for establishments is 10 digits starting with 7; a national
 * ID starts with 1, an iqama with 2. Returns the complaint, or null.
 */
export function idFormatError(scheme: string, id: string): string | null {
  const v = (id ?? "").trim();
  if (!v) return "empty";
  if (/\s/.test(v)) return "contains spaces";
  if (!/^[A-Za-z0-9()\-]{1,50}$/.test(v)) return "must be alphanumeric";
  switch (scheme) {
    case "CRN": return /^\d{10}$/.test(v) ? null : "a commercial registration is exactly 10 digits";
    case "700": return /^7\d{9}$/.test(v) ? null : "a 700 number is 10 digits starting with 7";
    case "TIN": return /^3\d{9}$/.test(v) ? null : "a TIN is 10 digits starting with 3";
    case "NAT": return /^1\d{9}$/.test(v) ? null : "a national ID is 10 digits starting with 1";
    case "IQA": return /^2\d{9}$/.test(v) ? null : "an iqama number is 10 digits starting with 2";
    default: return null;
  }
}

/**
 * Which scheme a SELLER's identifier is filed under when the account did not
 * say. Read off the number itself, because the number's shape is a fact and
 * the old default ("CRN") was not: it published individual landlords'
 * national IDs as commercial registrations.
 */
export function inferSellerIdScheme(id: string | null | undefined): SellerIdScheme {
  const v = (id ?? "").trim();
  if (/^7\d{9}$/.test(v)) return "700";
  if (/^[12]\d{9}$/.test(v)) return "OTH";   // national ID / iqama: OTH is the only seller scheme for them
  return "CRN";
}

/**
 * Which scheme a BUYER's identifier is filed under. The buyer list is wider
 * than the seller's — NAT and IQA exist there — and ZATCA orders the
 * candidates (CRN before 700 before NAT before IQA before OTH), so the choice
 * follows the number's shape first and the party's type second:
 *
 *  - 7xxxxxxxxx  → 700   (unified establishment number — NOT a CR, whatever the type says)
 *  - company     → CRN
 *  - 1xxxxxxxxx  → NAT, 2xxxxxxxxx → IQA   (a registered individual)
 *  - anything else → OTH
 *
 * Null when there is no identifier: the builder must then omit the element,
 * which for a VAT-registered buyer is allowed (BR-KSA-81).
 */
export function buyerIdScheme(id: string | null | undefined, type: string | null | undefined): BuyerIdScheme | null {
  const v = (id ?? "").trim();
  if (!v) return null;
  if (/^7\d{9}$/.test(v)) return "700";
  if (type === "company") return "CRN";
  if (/^1\d{9}$/.test(v)) return "NAT";
  if (/^2\d{9}$/.test(v)) return "IQA";
  return "OTH";
}
