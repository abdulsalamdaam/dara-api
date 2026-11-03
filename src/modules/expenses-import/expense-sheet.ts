import ExcelJS from "exceljs";
import { asciiDigits } from "../finance-v2/tier1/iban";
import { SUPPLIER_VAT_RE } from "../finance-v2/tier1/expense-math";

/**
 * The expenses spreadsheet (customer request, Nov 2026: "enter many expenses
 * by uploading an Excel sheet in a template the platform provides"). Pure:
 * the column layout shared by the template and the parser, cell → value
 * parsing, and one row → the body the single-expense create takes. Nothing
 * here touches the database; landlords and properties come in as lists.
 */

export type ImportMode = "v2" | "legacy";

export type Field =
  | "expenseDate" | "category" | "amount" | "ownerId" | "propertyId"
  | "chargeTo" | "amountMode" | "vatCategory" | "supplierName" | "supplierVatNumber" | "supplierInvoiceNo" | "notes";

export interface ColDef { key: Field; header: string; required?: boolean; v2Only?: boolean; width: number }

export const MAIN_SHEET = "المصروفات";
export const LISTS_SHEET = "القوائم";
export const HELP_SHEET = "تعليمات";
export const MAX_ROWS = 1000;
export const MAX_BYTES = 2 * 1024 * 1024;
/** An example row carries this in its notes; the parser skips it, so leaving it in is harmless. */
export const EXAMPLE_NOTE = "مثال — احذف هذا الصف";

export const COLUMNS: readonly ColDef[] = [
  { key: "expenseDate", header: "التاريخ", required: true, width: 14 },
  { key: "category", header: "البند", required: true, width: 22 },
  { key: "amount", header: "المبلغ", required: true, width: 14 },
  { key: "ownerId", header: "المؤجر", width: 30 },
  { key: "propertyId", header: "العقار", width: 30 },
  { key: "chargeTo", header: "يتحمّلها", v2Only: true, width: 12 },
  { key: "amountMode", header: "طريقة المبلغ", v2Only: true, width: 18 },
  { key: "vatCategory", header: "نوع الضريبة", v2Only: true, width: 16 },
  { key: "supplierName", header: "اسم المورد", v2Only: true, width: 22 },
  { key: "supplierVatNumber", header: "الرقم الضريبي للمورد", v2Only: true, width: 20 },
  { key: "supplierInvoiceNo", header: "رقم فاتورة المورد", v2Only: true, width: 18 },
  { key: "notes", header: "ملاحظات", width: 34 },
];

export const columnsFor = (mode: ImportMode): ColDef[] => COLUMNS.filter((c) => mode === "v2" || !c.v2Only);
export const headerText = (c: ColDef): string => (c.required ? `${c.header}*` : c.header);

/** The fixed choices: the label in the sheet's dropdown, and the aliases also accepted. */
export const CHARGE_TO: readonly { label: string; value: "company" | "landlord"; aliases: string[] }[] = [
  { label: "المكتب", value: "company", aliases: ["الشركة", "company", "office"] },
  { label: "المؤجر", value: "landlord", aliases: ["المالك", "landlord"] },
];
export const AMOUNT_MODE: readonly { label: string; value: "gross" | "net"; aliases: string[] }[] = [
  { label: "شامل الضريبة", value: "gross", aliases: ["شامل", "gross"] },
  { label: "غير شامل الضريبة", value: "net", aliases: ["غير شامل", "قبل الضريبة", "net"] },
];
export const VAT_CATEGORY: readonly { label: string; value: "S" | "Z" | "E" | "O"; aliases: string[] }[] = [
  { label: "خاضعة 15%", value: "S", aliases: ["خاضعة", "خاضع", "خاضع (أساسي)", "15%", "s"] },
  { label: "صفرية", value: "Z", aliases: ["نسبة صفرية", "0%", "z"] },
  { label: "معفاة", value: "E", aliases: ["معفى", "e"] },
  { label: "خارج النطاق", value: "O", aliases: ["o"] },
];

/** For matching typed text: digits to ASCII, no diacritics / tatweel, single spaces, lower case. */
export function norm(s: string): string {
  return asciiDigits(s).replace(/[ً-ْـ]/g, "").replace(/[*\s]+/g, " ").trim().toLowerCase();
}

function choice<T extends string>(raw: string, list: readonly { label: string; value: T; aliases: string[] }[]): T | undefined {
  const n = norm(raw);
  return list.find((c) => norm(c.label) === n || c.aliases.some((a) => norm(a) === n))?.value;
}

export type Cell = string | number | Date | null;

/** An exceljs cell value → a plain value: rich text joined, a formula's result, a hyperlink's text, an error cell empty. */
export function cellValue(v: unknown): Cell {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return cellValue((o.richText as { text?: string }[]).map((r) => r.text ?? "").join(""));
    if ("result" in o) return cellValue(o.result);
    if ("formula" in o || "sharedFormula" in o) return null;
    if ("text" in o) return cellValue(o.text);
    if ("error" in o) return null;
  }
  return null;
}

const text = (v: Cell): string => (v == null ? "" : v instanceof Date ? isoOf(v) ?? "" : String(v).trim());

function isoOf(d: Date): string | null {
  // exceljs reads a date cell as that calendar day at 00:00 UTC; round off a float serial's few milliseconds first.
  const t = Math.round(d.getTime() / 60000) * 60000;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function ymd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100) return null; // a Hijri year (1447) or a typo, not a Gregorian expense date
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** An Excel date, an Excel serial number, `YYYY-MM-DD` (or `/`), or `DD/MM/YYYY` (or `-` / `.`), any digits → `YYYY-MM-DD`. */
export function parseDate(v: Cell): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const iso = isoOf(v);
    return iso ? ymd(...(iso.split("-").map(Number) as [number, number, number])) : null;
  }
  if (typeof v === "number") {
    if (!Number.isInteger(Math.round(v)) || v < 1 || v > 100000) return null;
    return parseDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000));
  }
  const s = asciiDigits(v).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  return null;
}

/** A positive amount with at most two decimals → `"1234.50"`. Arabic-Indic digits, `٫` / `٬`, thousands commas and a currency word are accepted. */
export function parseAmount(v: Cell): string | null {
  if (v == null || v instanceof Date) return null;
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return null;
    s = (Math.round(v * 100) / 100).toFixed(2);
  } else {
    s = asciiDigits(v).replace(/٫/g, ".").replace(/[٬,\s ]/g, "").replace(/(ر\.?س\.?|ريال|sar)/gi, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > 999_999_999.99) return null;
  return n.toFixed(2);
}

export interface Ref { id: number; name: string }
export interface PropertyRef extends Ref { ownerId: number | null }

/** `Name (#12)` — the label the template's lists use, unique even when two names are the same. */
export const refLabel = (r: Ref): string => `${r.name.trim()} (#${r.id})`;

/** A cell → one of `list`: by its `(#id)` label, else by a unique exact name. */
export function resolveRef<T extends Ref>(raw: string, list: readonly T[], what: string): { ref?: T; error?: string } {
  const m = /\(\s*#\s*(\d+)\s*\)\s*$/.exec(asciiDigits(raw));
  if (m) {
    const ref = list.find((r) => r.id === Number(m[1]));
    return ref ? { ref } : { error: `${what} غير موجود في هذا الحساب` };
  }
  const n = norm(raw);
  const hits = list.filter((r) => norm(r.name) === n);
  if (hits.length === 1) return { ref: hits[0] };
  if (hits.length > 1) return { error: `يوجد أكثر من ${what} بهذا الاسم؛ اختره من القائمة (مع رقمه)` };
  return { error: `${what} غير موجود في هذا الحساب` };
}

export type RawRow = { row: number } & Partial<Record<Field, Cell>>;
export interface RowError { field: Field | "row"; message: string }
export interface RowPreview {
  expenseDate: string | null;
  category: string | null;
  amount: string | null;
  ownerId: number | null;
  ownerName: string | null;
  propertyId: number | null;
  propertyName: string | null;
  notes: string | null;
  chargeTo?: "company" | "landlord";
  amountMode?: "gross" | "net";
  vatCategory?: "S" | "Z" | "E" | "O";
  supplierName?: string | null;
  supplierVatNumber?: string | null;
  supplierInvoiceNo?: string | null;
  /** v2, once the row passes the service's own checks. */
  net?: string;
  vat?: string;
  gross?: string;
}
export interface MappedRow { row: number; body: Record<string, unknown>; errors: RowError[]; preview: RowPreview }

export interface MapCtx { mode: ImportMode; owners: readonly Ref[]; properties: readonly PropertyRef[] }

/**
 * One sheet row → the single create's body, or the reasons it cannot be one.
 * Every check that needs no database runs here; landlord / property ids come
 * only from the account's own lists, so a foreign id never reaches a write.
 */
export function mapRow(raw: RawRow, ctx: MapCtx): MappedRow {
  const errors: RowError[] = [];
  const err = (field: RowError["field"], message: string) => errors.push({ field, message });

  const dateText = text(raw.expenseDate ?? null);
  const expenseDate = parseDate(raw.expenseDate ?? null);
  if (!dateText) err("expenseDate", "التاريخ مطلوب");
  else if (!expenseDate) err("expenseDate", "التاريخ غير صالح؛ استخدم تاريخاً ميلادياً بصيغة YYYY-MM-DD أو DD/MM/YYYY");

  const category = text(raw.category ?? null);
  if (!category) err("category", "البند مطلوب");
  else if (category.length > 200) err("category", "البند أطول من 200 حرف");

  const amountText = text(raw.amount ?? null);
  const amount = parseAmount(raw.amount ?? null);
  if (!amountText) err("amount", "المبلغ مطلوب");
  else if (!amount) err("amount", "المبلغ غير صالح؛ رقم موجب بخانتين عشريتين على الأكثر");

  let owner: Ref | undefined;
  const ownerText = text(raw.ownerId ?? null);
  if (ownerText) {
    const r = resolveRef(ownerText, ctx.owners, "المؤجر");
    if (r.error) err("ownerId", r.error);
    owner = r.ref;
  }
  let property: PropertyRef | undefined;
  const propertyText = text(raw.propertyId ?? null);
  if (propertyText) {
    const r = resolveRef(propertyText, ctx.properties, "العقار");
    if (r.error) err("propertyId", r.error);
    property = r.ref;
  }
  if (owner && property && property.ownerId != null && property.ownerId !== owner.id) {
    err("propertyId", "العقار لا يتبع هذا المؤجر");
  }
  // A property alone names its landlord, as the single create does.
  if (!owner && !ownerText && property?.ownerId != null) owner = ctx.owners.find((o) => o.id === property!.ownerId);
  if (ctx.mode === "legacy") {
    if (!ownerText && !owner) err("ownerId", "المؤجر مطلوب");
    if (!propertyText) err("propertyId", "العقار مطلوب");
  }

  const notesText = text(raw.notes ?? null);
  if (notesText.length > 2000) err("notes", "الملاحظات أطول من 2000 حرف");

  const preview: RowPreview = {
    expenseDate: expenseDate ?? (dateText || null), category: category || null, amount: amount ?? (amountText || null),
    ownerId: owner?.id ?? null, ownerName: owner?.name ?? (ownerText || null),
    propertyId: property?.id ?? null, propertyName: property?.name ?? (propertyText || null), notes: notesText || null,
  };
  const body: Record<string, unknown> = {
    expenseDate, category, amount, ownerId: owner?.id ?? null, propertyId: property?.id ?? null, notes: notesText || null,
  };

  if (ctx.mode === "v2") {
    const pick = <T extends string>(field: Field, list: readonly { label: string; value: T; aliases: string[] }[], fallback: T, label: string): T => {
      const t = text(raw[field] ?? null);
      if (!t) return fallback;
      const v = choice(t, list);
      if (!v) err(field, `${label}: اختر من القائمة (${list.map((c) => c.label).join(" / ")})`);
      return v ?? fallback;
    };
    const chargeTo = pick("chargeTo", CHARGE_TO, "company", "يتحمّلها");
    const amountMode = pick("amountMode", AMOUNT_MODE, "gross", "طريقة المبلغ");
    const vatCategory = pick("vatCategory", VAT_CATEGORY, "O", "نوع الضريبة");
    const supplierName = text(raw.supplierName ?? null);
    if (supplierName.length > 200) err("supplierName", "اسم المورد أطول من 200 حرف");
    const supplierVatNumber = asciiDigits(text(raw.supplierVatNumber ?? null)).replace(/\s/g, "");
    if (supplierVatNumber && !SUPPLIER_VAT_RE.test(supplierVatNumber)) err("supplierVatNumber", "الرقم الضريبي للمورد: 15 رقماً يبدأ وينتهي بـ 3");
    const supplierInvoiceNo = text(raw.supplierInvoiceNo ?? null);
    if (supplierInvoiceNo.length > 100) err("supplierInvoiceNo", "رقم فاتورة المورد أطول من 100 حرف");
    Object.assign(body, {
      chargeTo, amountMode, vatCategory, vatRate: vatCategory === "S" ? 15 : undefined,
      supplierName: supplierName || null, supplierVatNumber: supplierVatNumber || null, supplierInvoiceNo: supplierInvoiceNo || null,
    });
    Object.assign(preview, {
      chargeTo, amountMode, vatCategory,
      supplierName: supplierName || null, supplierVatNumber: supplierVatNumber || null, supplierInvoiceNo: supplierInvoiceNo || null,
    });
  }
  return { row: raw.row, body, errors, preview };
}

export class SheetError extends Error {
  constructor(public readonly code: "BAD_FILE" | "BAD_TEMPLATE" | "EMPTY" | "TOO_MANY_ROWS", message: string) {
    super(message);
  }
}

/**
 * The workbook's expense rows. Columns are found by their header (the `*`
 * and diacritics ignored), so a reordered or trimmed sheet still reads; blank
 * rows and the template's example rows are skipped.
 */
export async function readSheet(buf: Buffer): Promise<{ rows: RawRow[]; skipped: number }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new SheetError("BAD_FILE", "تعذّرت قراءة الملف؛ ارفع ملف Excel بصيغة .xlsx من القالب");
  }
  const ws = wb.getWorksheet(MAIN_SHEET) ?? wb.worksheets.find((w) => w.name !== LISTS_SHEET && w.name !== HELP_SHEET);
  if (!ws) throw new SheetError("BAD_TEMPLATE", `لم يُعثر على ورقة «${MAIN_SHEET}» في الملف`);

  const byHeader = new Map(COLUMNS.map((c) => [norm(c.header), c.key]));
  const colOf = new Map<Field, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = byHeader.get(norm(text(cellValue(cell.value))));
    if (key && !colOf.has(key)) colOf.set(key, col);
  });
  const missing = COLUMNS.filter((c) => c.required && !colOf.has(c.key)).map((c) => c.header);
  if (missing.length) throw new SheetError("BAD_TEMPLATE", `أعمدة مطلوبة غير موجودة في الصف الأول: ${missing.join("، ")}`);

  const rows: RawRow[] = [];
  let skipped = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw: RawRow = { row: r };
    let any = false;
    for (const [key, col] of colOf) {
      const v = cellValue(row.getCell(col).value);
      raw[key] = v;
      if (v != null) any = true;
    }
    if (!any) continue;
    if (typeof raw.notes === "string" && raw.notes.startsWith(EXAMPLE_NOTE)) { skipped++; continue; }
    rows.push(raw);
    if (rows.length > MAX_ROWS) throw new SheetError("TOO_MANY_ROWS", `الحد الأقصى ${MAX_ROWS} مصروف في الملف الواحد؛ قسّم الملف`);
  }
  if (!rows.length) throw new SheetError("EMPTY", "الملف لا يحتوي على مصروفات");
  return { rows, skipped };
}
