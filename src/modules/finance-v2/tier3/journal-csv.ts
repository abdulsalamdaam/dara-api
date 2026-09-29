/**
 * The journal CSV format (docs/finance-v2/JOURNAL-EXPORT.md). Pure.
 *
 *  - UTF-8 with a byte-order mark, RFC 4180 quoting, CRLF line ends.
 *  - One row per journal line; amounts are 2-decimal strings with a dot and no
 *    thousands separator; exactly one of debit / credit is non-zero.
 *  - A text cell that starts with = + - @ TAB or CR is prefixed with an
 *    apostrophe, so a spreadsheet never evaluates it (CSV injection). Amount
 *    and date cells are never altered.
 */

export const BOM = "﻿";

export interface ExportLine {
  date: string;
  entryNo: string;
  lineNo: number;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string;
  debit: string;
  credit: string;
  memo: string | null;
  entryMemo: string | null;
  owner: string | null;
  property: string | null;
  unit: string | null;
  tenant: string | null;
  contract: string | null;
  sourceType: string;
  sourceRef: string;
  origin: string;
  status: string;
  originalDate: string;
  vatCategory: string | null;
  vatRate: string | null;
  taxRole: string | null;
}

export type Preset = "standard" | "simple";
export type DateFormat = "iso" | "dmy";

interface Column {
  key: string;
  numeric?: boolean;
  get: (l: ExportLine, lang: "ar" | "en") => string | number | null;
}

const STANDARD: Column[] = [
  { key: "date", numeric: true, get: (l) => l.date },
  { key: "entry_no", get: (l) => l.entryNo },
  { key: "line_no", numeric: true, get: (l) => l.lineNo },
  { key: "account_code", get: (l) => l.accountCode },
  { key: "account_name_ar", get: (l) => l.accountNameAr },
  { key: "account_name_en", get: (l) => l.accountNameEn },
  { key: "debit", numeric: true, get: (l) => l.debit },
  { key: "credit", numeric: true, get: (l) => l.credit },
  { key: "memo", get: (l) => l.memo ?? l.entryMemo },
  { key: "owner", get: (l) => l.owner },
  { key: "property", get: (l) => l.property },
  { key: "unit", get: (l) => l.unit },
  { key: "tenant", get: (l) => l.tenant },
  { key: "contract", get: (l) => l.contract },
  { key: "source_type", get: (l) => l.sourceType },
  { key: "source_ref", get: (l) => l.sourceRef },
  { key: "entry_memo", get: (l) => l.entryMemo },
  { key: "origin", get: (l) => l.origin },
  { key: "status", get: (l) => l.status },
  { key: "original_date", numeric: true, get: (l) => l.originalDate },
  { key: "vat_category", get: (l) => l.vatCategory },
  { key: "vat_rate", numeric: true, get: (l) => l.vatRate },
  { key: "tax_role", get: (l) => l.taxRole },
];

const SIMPLE: Column[] = [
  { key: "date", numeric: true, get: (l) => l.date },
  { key: "entry_no", get: (l) => l.entryNo },
  { key: "account_code", get: (l) => l.accountCode },
  { key: "account_name", get: (l, lang) => (lang === "en" ? l.accountNameEn || l.accountNameAr : l.accountNameAr) },
  { key: "debit", numeric: true, get: (l) => l.debit },
  { key: "credit", numeric: true, get: (l) => l.credit },
  { key: "memo", get: (l) => l.memo ?? l.entryMemo },
];

export const PRESETS: Record<Preset, readonly string[]> = {
  standard: STANDARD.map((c) => c.key),
  simple: SIMPLE.map((c) => c.key),
};

/** Quote per RFC 4180 when needed; neutralise a formula prefix on text cells. */
export function csvCell(v: string | number | null | undefined, numeric = false): string {
  if (v == null) return "";
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatDate(iso: string, f: DateFormat): string {
  if (f === "iso") return iso;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** The whole file: BOM, header row, one row per line, CRLF, trailing CRLF. */
export function journalCsv(lines: ExportLine[], opts: { preset?: Preset; lang?: "ar" | "en"; dateFormat?: DateFormat } = {}): string {
  const cols = (opts.preset ?? "standard") === "simple" ? SIMPLE : STANDARD;
  const lang = opts.lang ?? "ar";
  const df = opts.dateFormat ?? "iso";
  const out: string[] = [cols.map((c) => c.key).join(",")];
  for (const l of lines) {
    const row = { ...l, date: formatDate(l.date, df), originalDate: formatDate(l.originalDate, df) };
    out.push(cols.map((c) => csvCell(c.get(row, lang), c.numeric)).join(","));
  }
  return BOM + out.join("\r\n") + "\r\n";
}
