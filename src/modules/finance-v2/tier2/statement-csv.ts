/**
 * Bank statement CSV parsing (DESIGN §8.3 a). Pure: no DB, no clock.
 *
 *  - The client uploads CSV TEXT (at most 2 MB, 10,000 data rows) plus a
 *    profile naming the columns (by header name, or by 1-based index).
 *  - Arabic-Indic digits are normalised; amounts become integer halalas.
 *  - Dates are Gregorian only. A Hijri-looking date (year 1300-1500) is
 *    rejected with a clear message, never guessed.
 *  - Each line gets a fingerprint: sha256 over (bank account, date, amount,
 *    reference, description, balance, occurrence), where occurrence counts
 *    identical lines within the file, so two genuinely identical bank lines
 *    both import while a re-import of an overlapping statement skips them.
 */
import { createHash } from "node:crypto";
import { asciiDigits } from "../tier1/iban";
import { toHalalas } from "../money";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "YYYY/MM/DD", "DD.MM.YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface ImportProfile {
  delimiter: string;
  skipRows: number;
  dateCol: string;
  dateFormat: DateFormat;
  descCol?: string | null;
  refCol?: string | null;
  /** One signed amount column … */
  amountCol?: string | null;
  /** … or separate debit (money out) and credit (money in) columns. */
  debitCol?: string | null;
  creditCol?: string | null;
  balanceCol?: string | null;
}

export interface ParsedLine {
  lineNo: number;
  txnDate: string;
  description: string | null;
  reference: string | null;
  /** Signed halalas: + money in, − money out. */
  amount: number;
  runningBalance: number | null;
}

export interface ParseError {
  lineNo: number;
  error: string;
  message: string;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, a BOM. */
export function splitCsv(text: string, delimiter = ","): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** A statement amount → signed halalas. Accepts thousands separators, (brackets), a trailing minus, "SAR". */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = asciiDigits(String(raw)).replace(/[٫]/g, ".").replace(/[٬,\s]/g, "").replace(/SAR|ر\.?س\.?/gi, "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`not an amount: ${raw}`);
  const h = toHalalas(s);
  return neg ? -h : h;
}

/** A statement date in `format` → YYYY-MM-DD. Throws with code HIJRI_DATE or BAD_DATE. */
export function parseStatementDate(raw: string, format: DateFormat): string {
  const s = asciiDigits(String(raw ?? "")).trim().split(/[ T]/)[0];
  const parts = s.split(/[-/.]/);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) throw Object.assign(new Error(`not a date: ${raw}`), { code: "BAD_DATE" });
  let y: number, m: number, d: number;
  switch (format) {
    case "YYYY-MM-DD": case "YYYY/MM/DD": [y, m, d] = parts.map(Number); break;
    case "MM/DD/YYYY": [m, d, y] = parts.map(Number); break;
    default: [d, m, y] = parts.map(Number);
  }
  if (y >= 1300 && y <= 1500) throw Object.assign(new Error(`Hijri dates are not accepted: ${raw}`), { code: "HIJRI_DATE" });
  if (y < 1990 || y > 2100) throw Object.assign(new Error(`year out of range: ${raw}`), { code: "BAD_DATE" });
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) throw Object.assign(new Error(`not a date: ${raw}`), { code: "BAD_DATE" });
  return iso;
}

/** Resolve a profile column (header name, case/space-insensitive, or a 1-based index) to an index. */
export function columnIndex(header: string[] | null, col: string | null | undefined): number | null {
  if (col == null || String(col).trim() === "") return null;
  const c = String(col).trim();
  if (/^\d+$/.test(c)) return Number(c) - 1;
  if (!header) return null;
  const norm = (x: string) => x.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");
  const i = header.findIndex((h) => norm(h) === norm(c));
  return i >= 0 ? i : null;
}

export interface ParseResult {
  lines: ParsedLine[];
  errors: ParseError[];
  /** Lines with a zero amount (informational rows the bank prints); not imported. */
  zero: number;
}

/**
 * Parse CSV text with a profile. The first row after `skipRows` is the header
 * when any profile column is a name; with purely numeric columns there is no header.
 */
export function parseStatement(text: string, p: ImportProfile): ParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) throw Object.assign(new Error("The file is larger than 2 MB"), { code: "FILE_TOO_LARGE" });
  const rows = splitCsv(text, p.delimiter || ",").slice(Math.max(0, p.skipRows || 0));
  const cols = [p.dateCol, p.descCol, p.refCol, p.amountCol, p.debitCol, p.creditCol, p.balanceCol].filter((x): x is string => !!x && String(x).trim() !== "");
  const hasHeader = cols.some((c) => !/^\d+$/.test(String(c).trim()));
  const header = hasHeader ? rows[0] ?? [] : null;
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length > MAX_CSV_ROWS) throw Object.assign(new Error(`More than ${MAX_CSV_ROWS} rows`), { code: "TOO_MANY_ROWS" });
  const idx = {
    date: columnIndex(header, p.dateCol), desc: columnIndex(header, p.descCol), ref: columnIndex(header, p.refCol),
    amount: columnIndex(header, p.amountCol), debit: columnIndex(header, p.debitCol), credit: columnIndex(header, p.creditCol),
    balance: columnIndex(header, p.balanceCol),
  };
  if (idx.date == null) throw Object.assign(new Error(`date column not found: ${p.dateCol}`), { code: "BAD_PROFILE" });
  if (idx.amount == null && idx.debit == null && idx.credit == null) throw Object.assign(new Error("no amount, debit or credit column found"), { code: "BAD_PROFILE" });
  const out: ParseResult = { lines: [], errors: [], zero: 0 };
  const firstLineNo = (p.skipRows || 0) + (hasHeader ? 2 : 1);
  data.forEach((r, i) => {
    const lineNo = firstLineNo + i;
    const cell = (k: number | null) => (k == null ? null : (r[k] ?? "").trim() || null);
    try {
      const txnDate = parseStatementDate(cell(idx.date) ?? "", p.dateFormat);
      let amount: number;
      if (idx.amount != null) amount = parseAmount(cell(idx.amount)) ?? 0;
      else amount = Math.abs(parseAmount(cell(idx.credit)) ?? 0) - Math.abs(parseAmount(cell(idx.debit)) ?? 0);
      if (amount === 0) {
        out.zero++;
        return;
      }
      out.lines.push({
        lineNo, txnDate, amount,
        description: cell(idx.desc)?.slice(0, 500) ?? null,
        reference: cell(idx.ref)?.slice(0, 200) ?? null,
        runningBalance: parseAmount(cell(idx.balance)),
      });
    } catch (err: any) {
      out.errors.push({ lineNo, error: err?.code ?? "BAD_LINE", message: String(err?.message ?? err) });
    }
  });
  return out;
}

/** Fingerprints for a parsed file: identical lines get occurrence 1, 2, … (see header). */
export function fingerprints(bankAccountId: number, lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [bankAccountId, l.txnDate, l.amount, l.reference ?? "", (l.description ?? "").replace(/\s+/g, " "), l.runningBalance ?? ""].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex");
  });
}
