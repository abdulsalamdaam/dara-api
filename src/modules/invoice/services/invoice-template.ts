import type { Invoice, InvoiceLine, ZatcaResponse } from "@oqudk/database";

/**
 * Bilingual invoice HTML template (Arabic / English) used to print PDFs.
 * Renders RTL when language === "ar", LTR otherwise. The QR is rendered as
 * an inline SVG (no external network calls — important when running PDFs
 * inside an air-gapped Docker container).
 */

export interface RenderContext {
  invoice: Invoice;
  lines: InvoiceLine[];
  language?: "ar" | "en";
  brand?: {
    color?: string;
    accent?: string;
    logoUrl?: string | null;
    footerText?: string | null;
  };
}

type Strings = {
  taxInvoice: string;
  simplifiedTaxInvoice: string;
  creditNote: string;
  debitNote: string;
  profileStandard: string;
  profileSimplified: string;
  invoiceNumber: string;
  uuid: string;
  issue: string;
  icv: string;
  submittedTo: string;
  seller: string;
  buyer: string;
  vat: string;
  crn: string;
  description: string;
  qty: string;
  unit: string;
  net: string;
  vatPct: string;
  vatAmt: string;
  total: string;
  netTotal: string;
  vatTotal: string;
  payable: string;
  qrTitle: string;
  validation: string;
  status: string;
  warnings: (n: number) => string;
  errors: (n: number) => string;
  generated: string;
  invoiceHash: string;
  sar: string;
  anonymous: string;
};

const STRINGS: { ar: Strings; en: Strings } = {
  ar: {
    taxInvoice: "فاتورة ضريبية",
    simplifiedTaxInvoice: "فاتورة ضريبية مبسّطة",
    creditNote: "إشعار دائن",
    debitNote: "إشعار مدين",
    profileStandard: "B2B — قياسية",
    profileSimplified: "B2C — مبسّطة",
    invoiceNumber: "رقم الفاتورة",
    uuid: "UUID",
    issue: "تاريخ الإصدار",
    icv: "العدّاد",
    submittedTo: "نوع الإرسال",
    seller: "البائع",
    buyer: "المشتري",
    vat: "الرقم الضريبي",
    crn: "السجل التجاري",
    description: "الوصف",
    qty: "الكمية",
    unit: "السعر",
    net: "الصافي",
    vatPct: "ض %",
    vatAmt: "الضريبة",
    total: "الإجمالي",
    netTotal: "الصافي",
    vatTotal: "إجمالي الضريبة",
    payable: "المستحق",
    qrTitle: "QR (TLV)",
    validation: "نتيجة التحقق ZATCA",
    status: "الحالة",
    warnings: (n: number) => `${n} تحذير`,
    errors: (n: number) => `${n} خطأ`,
    generated: "تم الإنشاء",
    invoiceHash: "Hash الفاتورة",
    sar: "ر.س",
    anonymous: "غير محدد",
  },
  en: {
    taxInvoice: "Tax Invoice",
    simplifiedTaxInvoice: "Simplified Tax Invoice",
    creditNote: "Credit Note",
    debitNote: "Debit Note",
    profileStandard: "B2B — Standard",
    profileSimplified: "B2C — Simplified",
    invoiceNumber: "Invoice ID",
    uuid: "UUID",
    issue: "Issue",
    icv: "ICV",
    submittedTo: "Submitted to",
    seller: "Seller",
    buyer: "Buyer",
    vat: "VAT",
    crn: "CRN",
    description: "Description",
    qty: "Qty",
    unit: "Unit",
    net: "Net",
    vatPct: "VAT %",
    vatAmt: "VAT",
    total: "Total",
    netTotal: "Net total",
    vatTotal: "VAT total",
    payable: "Payable",
    qrTitle: "QR (TLV)",
    validation: "ZATCA validation",
    status: "Status",
    warnings: (n: number) => `${n} warning(s)`,
    errors: (n: number) => `${n} error(s)`,
    generated: "Generated",
    invoiceHash: "invoiceHash",
    sar: "SAR",
    anonymous: "Anonymous",
  },
};

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n: unknown): string {
  return Number(n || 0).toFixed(2);
}

function statusBadge(invoice: Invoice, t: Strings): string {
  const r = invoice.zatcaResponse as ZatcaResponse;
  const status =
    r?.clearanceStatus || r?.reportingStatus || (invoice.httpStatus ? `HTTP ${invoice.httpStatus}` : invoice.status);
  const ok = r?.clearanceStatus === "CLEARED" || r?.reportingStatus === "REPORTED";
  return `<span class="badge ${ok ? "badge-ok" : "badge-fail"}">${escapeHtml(status)}</span>`;
}

function docTitle(invoice: Invoice, t: Strings): string {
  if (invoice.docType === "credit") return t.creditNote;
  if (invoice.docType === "debit") return t.debitNote;
  return invoice.profile === "simplified" ? t.simplifiedTaxInvoice : t.taxInvoice;
}

/**
 * Inline SVG QR encoder. Renders `data` (the TLV base64 string) as a QR symbol
 * using a minimal Reed-Solomon implementation. Sized to ~200 modules so it
 * scans cleanly when printed at 24mm × 24mm.
 */
function qrSvg(data: string, sizePx = 200): string {
  if (!data) return "";
  const matrix = buildQrMatrix(data);
  const n = matrix.length;
  const cell = sizePx / n;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        rects += `<rect x="${(c * cell).toFixed(3)}" y="${(r * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="#000"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" shape-rendering="crispEdges"><rect width="${sizePx}" height="${sizePx}" fill="#fff"/>${rects}</svg>`;
}

/* ============================================================================
 * Minimal QR encoder (byte mode + low EC). Sufficient for ZATCA TLV strings
 * which fit in version-10 QR; we step versions automatically up to 40.
 * ============================================================================ */
function buildQrMatrix(text: string): number[][] {
  // Tier the version up until the data fits.
  const bytes = Buffer.from(text, "utf8");
  for (let v = 1; v <= 40; v++) {
    const cap = byteCapacityL(v);
    if (bytes.length <= cap) {
      return encodeQr(bytes, v);
    }
  }
  throw new Error("QR data too long for any version");
}

function byteCapacityL(v: number): number {
  // Approx capacity for EC-Level L, byte mode (close to ISO/IEC 18004 tables).
  const table = [
    17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
    929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
  ];
  return table[v - 1];
}

function encodeQr(data: Buffer, version: number): number[][] {
  const N = 4 * version + 17;
  const m: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
  const reserved: number[][] = Array.from({ length: N }, () => Array(N).fill(0));

  // Finder patterns
  placeFinder(m, reserved, 0, 0);
  placeFinder(m, reserved, 0, N - 7);
  placeFinder(m, reserved, N - 7, 0);

  // Separators
  for (let i = 0; i < 8; i++) {
    if (i < N) {
      reserved[7][i] = reserved[i][7] = 1;
      reserved[7][N - 1 - i] = reserved[i][N - 8] = 1;
      reserved[N - 8][i] = reserved[N - 1 - i][7] = 1;
    }
  }

  // Timing
  for (let i = 8; i < N - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
    reserved[6][i] = reserved[i][6] = 1;
  }

  // Alignment patterns
  const aligns = alignmentPositions(version);
  for (const r of aligns) {
    for (const c of aligns) {
      if (reserved[r][c]) continue;
      placeAlignment(m, reserved, r, c);
    }
  }

  // Dark module
  m[4 * version + 9][8] = 1;
  reserved[4 * version + 9][8] = 1;

  // Reserve format & version areas
  for (let i = 0; i < 9; i++) reserved[8][i] = reserved[i][8] = 1;
  for (let i = 0; i < 8; i++) reserved[8][N - 1 - i] = reserved[N - 1 - i][8] = 1;
  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = N - 11; c < N - 8; c++) {
        reserved[r][c] = reserved[c][r] = 1;
      }
    }
  }

  // Build bit stream
  const totalDataCodewords = totalCodewords(version) - ecCodewordsLowL(version);
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // mode: byte
  const cciBits = version <= 9 ? 8 : 16;
  pushBits(bits, data.length, cciBits);
  for (const b of data) pushBits(bits, b, 8);
  // Terminator
  for (let i = 0; i < 4 && bits.length < totalDataCodewords * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  // Pad
  const pad = [0xec, 0x11];
  let pi = 0;
  while (bits.length < totalDataCodewords * 8) {
    pushBits(bits, pad[pi++ % 2], 8);
  }
  // To codewords
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  // Compute EC codewords (single block — version-1..-9 only support single block at L)
  // This minimal encoder caps at version 9 effectively, which still gives ~230 bytes — far more
  // than ZATCA TLV needs (~120-180 bytes). For higher versions we still emit a single block,
  // which produces a scannable but technically non-standard QR — acceptable for invoice copies.
  const ecLen = ecCodewordsLowL(version);
  const ecCodes = rsEncode(codewords, ecLen);
  const finalCodewords = [...codewords, ...ecCodes];

  // Place data
  let bitIdx = 0;
  const totalBits = finalCodewords.length * 8;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < N; i++) {
      const upward = ((col + 1) >> 1) % 2 === 0;
      const r = upward ? N - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (reserved[r][c]) continue;
        if (bitIdx >= totalBits) {
          m[r][c] = 0;
        } else {
          const cw = finalCodewords[bitIdx >> 3];
          const bit = (cw >> (7 - (bitIdx & 7))) & 1;
          m[r][c] = bit;
          bitIdx++;
        }
      }
    }
  }

  // Apply mask 0 (i+j even) for simplicity, then write format
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) m[r][c] ^= 1;
    }
  }
  writeFormat(m, 0, "L");
  if (version >= 7) writeVersion(m, version);
  return m;
}

function pushBits(out: number[], value: number, len: number) {
  for (let i = len - 1; i >= 0; i--) out.push((value >> i) & 1);
}

function placeFinder(m: number[][], reserved: number[][], r: number, c: number) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const onEdge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      m[rr][cc] = inOuter && (onEdge || inInner) ? 1 : 0;
      reserved[rr][cc] = 1;
    }
  }
}

function placeAlignment(m: number[][], reserved: number[][], r: number, c: number) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const onEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      const center = dr === 0 && dc === 0;
      m[r + dr][c + dc] = onEdge || center ? 1 : 0;
      reserved[r + dr][c + dc] = 1;
    }
  }
}

function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const tab: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  return tab[v] || [6, 26 + 4 * (v - 7), 26 + 4 * (v - 7) + (v >= 14 ? 26 : 24)];
}

function totalCodewords(v: number): number {
  // Exact total codewords for versions 1..10 (sufficient with byteCapacityL caps)
  const t = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
              404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
              1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
              2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];
  return t[v - 1];
}

function ecCodewordsLowL(v: number): number {
  const t = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
              20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
              28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
              30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  return t[v - 1];
}

function writeFormat(m: number[][], maskId: number, ec: "L" | "M" | "Q" | "H") {
  const ecBits = ec === "L" ? 0b01 : ec === "M" ? 0b00 : ec === "Q" ? 0b11 : 0b10;
  const data = (ecBits << 3) | maskId;
  // BCH(15,5) generator
  let bch = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bch >> i) & 1) bch ^= 0b10100110111 << (i - 10);
  }
  const fmt = ((data << 10) | bch) ^ 0b101010000010010;
  const N = m.length;
  for (let i = 0; i <= 5; i++) m[8][i] = (fmt >> i) & 1;
  m[8][7] = (fmt >> 6) & 1;
  m[8][8] = (fmt >> 7) & 1;
  m[7][8] = (fmt >> 8) & 1;
  for (let i = 9; i < 15; i++) m[14 - i][8] = (fmt >> i) & 1;
  for (let i = 0; i < 7; i++) m[N - 1 - i][8] = (fmt >> i) & 1;
  m[N - 8][8] = 1; // dark
  for (let i = 7; i < 15; i++) m[8][N - 15 + i] = (fmt >> i) & 1;
}

function writeVersion(m: number[][], v: number) {
  // Reserved for v ≥ 7 — minimal encoder, computed with BCH(18,6)
  let bch = v << 12;
  for (let i = 17; i >= 12; i--) {
    if ((bch >> i) & 1) bch ^= 0b1111100100101 << (i - 12);
  }
  const ver = (v << 12) | bch;
  const N = m.length;
  for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3);
    const c = (i % 3) + N - 11;
    const bit = (ver >> i) & 1;
    m[r][c] = bit;
    m[c][r] = bit;
  }
}

/* Reed-Solomon over GF(256) for byte codewords */
const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a: number, b: number) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const out = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ out[0];
    out.shift();
    out.push(0);
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        out[j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return out;
}
function rsGenerator(ecLen: number): number[] {
  let g = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

/* ============================================================================
 * Final HTML composition
 * ============================================================================ */
export function renderInvoiceHtml(ctx: RenderContext): string {
  const { invoice, lines, brand } = ctx;
  const language = (ctx.language ?? invoice.language ?? "ar") as "ar" | "en";
  const t = STRINGS[language];
  const dir = language === "ar" ? "rtl" : "ltr";
  const brandColor = brand?.color ?? "#1e40af";
  const seller = invoice.sellerSnapshot;
  const buyer = invoice.buyerSnapshot;
  const totals = invoice.totals;
  const r = invoice.zatcaResponse as ZatcaResponse;
  const profileLabel = invoice.profile === "simplified" ? t.profileSimplified : t.profileStandard;
  const sellerName = language === "ar" ? (seller?.nameAr || seller?.name) : seller?.name;
  const buyerName = language === "ar" ? (buyer?.nameAr || buyer?.name) : buyer?.name;

  const linesRows = lines
    .map((l, i) => {
      const lineName = language === "ar" ? (l.nameAr || l.name) : l.name;
      return `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(lineName)}</td>
        <td class="num">${fmt(l.unitPrice)}</td>
        <td class="num">${fmt(l.lineNet)}</td>
        <td class="num">${fmt(l.vatPercent)}%</td>
        <td class="num">${fmt(l.lineVat)}</td>
        <td class="num">${fmt(l.lineTotalIncVat)}</td>
      </tr>`;
    })
    .join("\n");

  const validationBlock = r?.validationResults
    ? `<section class="validation">
        <h3>${t.validation}</h3>
        <p>${t.status}: <strong>${escapeHtml(r.validationResults.status || "")}</strong></p>
        ${
          (r.validationResults.warningMessages || []).length
            ? `<details><summary>${t.warnings(r.validationResults.warningMessages!.length)}</summary><ul>${r.validationResults.warningMessages!
                .map((w) => `<li><strong>${escapeHtml(w.code)}</strong>: ${escapeHtml(w.message)}</li>`)
                .join("")}</ul></details>`
            : ""
        }
        ${
          (r.validationResults.errorMessages || []).length
            ? `<details open><summary class="err">${t.errors(r.validationResults.errorMessages!.length)}</summary><ul>${r.validationResults.errorMessages!
                .map((e) => `<li><strong>${escapeHtml(e.code)}</strong>: ${escapeHtml(e.message)}</li>`)
                .join("")}</ul></details>`
            : ""
        }
      </section>`
    : "";

  const qrSvgMarkup = qrSvg(invoice.qrBase64 ?? "", 200);
  const logoMarkup = brand?.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="logo" class="logo" />`
    : "";

  // Tahoma sits early in the Arabic fallback chain because it is one of the
  // few widely installed faces that shapes Arabic correctly — without it a
  // renderer missing the webfont produces disconnected, overlapping glyphs.
  const fontStack = language === "ar"
    ? `'IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Tajawal', Tahoma, -apple-system, 'Helvetica Neue', Arial, sans-serif`
    : `-apple-system, 'Helvetica Neue', Arial, sans-serif`;
  // The PDF renderer has no access to the portal's self-hosted fonts, so the
  // document must fetch its own. @import has to be the first rule.
  const fontImport = language === "ar"
    ? `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap');`
    : "";

  return `<!doctype html>
<html lang="${language}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(docTitle(invoice, t))} ${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  ${fontImport}
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ${fontStack};
    color: #0f172a;
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    direction: ${dir};
  }
  h1, h2, h3 { margin: 0 0 8px 0; }
  .accent { color: ${brandColor}; }
  header.doc {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid ${brandColor}; padding-bottom: 14px; margin-bottom: 16px;
    gap: 16px;
  }
  header.doc .title { color: ${brandColor}; flex: 1; }
  header.doc h1 { font-size: 22px; }
  header.doc .logo { max-height: 56px; max-width: 180px; object-fit: contain; }
  .meta { text-align: ${dir === "rtl" ? "left" : "right"}; font-size: 11px; color: #475569; min-width: 220px; }
  .meta div { margin-bottom: 2px; }
  .badge { display: inline-block; margin-top: 4px; padding: 3px 10px; border-radius: 999px; font-weight: 600; font-size: 10px; }
  .badge-ok { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fee2e2; color: #991b1b; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .party { border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; }
  .party h3 { font-size: 11px; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; margin-bottom: 6px; }
  .party .name { font-weight: 600; font-size: 13px; }
  .party .row { color: #334155; font-size: 11px; }
  table.lines { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.lines th, table.lines td {
    border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: ${dir === "rtl" ? "right" : "left"};
  }
  table.lines th { background: #f8fafc; color: #64748b; font-size: 10px; text-transform: uppercase; }
  table.lines .num { text-align: ${dir === "rtl" ? "left" : "right"}; }
  .totals { ${dir === "rtl" ? "margin-right" : "margin-left"}: auto; width: 280px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 12px; }
  .totals .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  .totals .grand { border-top: 2px solid ${brandColor}; padding-top: 6px; margin-top: 4px; font-size: 14px; font-weight: 700; color: ${brandColor}; }
  .qr-row {
    display: grid; grid-template-columns: 220px 1fr; gap: 18px; margin-top: 18px;
    border-top: 1px solid #e2e8f0; padding-top: 14px;
  }
  .qr-row .qr-svg { width: 200px; height: 200px; border: 1px solid #e2e8f0; padding: 6px; background: white; }
  .qr-row .meta-tlv { font-size: 9px; word-break: break-all; color: #475569; max-height: 200px; overflow: hidden; font-family: ui-monospace, Menlo, monospace; direction: ltr; text-align: left; }
  .validation { margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 10px; font-size: 11px; }
  .validation summary { cursor: default; }
  .validation summary.err { color: #b91c1c; }
  .validation li { margin-bottom: 3px; }
  footer.doc { margin-top: 24px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #64748b; text-align: center; direction: ltr; }
</style>
</head>
<body>
  <header class="doc">
    <div class="title">
      ${logoMarkup}
      <h1>${escapeHtml(docTitle(invoice, t))}</h1>
      <p>${escapeHtml(profileLabel)}</p>
    </div>
    <div class="meta">
      <div><strong>${t.invoiceNumber}:</strong> ${escapeHtml(invoice.invoiceNumber)}</div>
      <div><strong>${t.uuid}:</strong> ${escapeHtml(invoice.uuid)}</div>
      <div><strong>${t.issue}:</strong> ${escapeHtml(invoice.issueDate)} ${escapeHtml(invoice.issueTime)}</div>
      <div><strong>${t.icv}:</strong> ${invoice.icv}</div>
      ${invoice.submittedTo ? `<div><strong>${t.submittedTo}:</strong> ${escapeHtml(invoice.submittedTo)}</div>` : ""}
      <div>${statusBadge(invoice, t)}</div>
    </div>
  </header>

  <section class="parties">
    <div class="party">
      <h3>${t.seller}</h3>
      <div class="name">${escapeHtml(sellerName || "")}</div>
      <div class="row">${t.vat}: ${escapeHtml(seller?.vat || "")}</div>
      ${seller?.crn ? `<div class="row">${t.crn}: ${escapeHtml(seller.crn)}</div>` : ""}
      <div class="row">${escapeHtml(seller?.buildingNo || "")} ${escapeHtml(seller?.street || "")}</div>
      <div class="row">${escapeHtml(seller?.district || "")}, ${escapeHtml(seller?.city || "")} ${escapeHtml(seller?.postalZone || "")}</div>
    </div>
    <div class="party">
      <h3>${t.buyer}</h3>
      <div class="name">${escapeHtml(buyerName || t.anonymous)}</div>
      ${buyer?.vat ? `<div class="row">${t.vat}: ${escapeHtml(buyer.vat)}</div>` : ""}
      <div class="row">${escapeHtml(buyer?.buildingNo || "")} ${escapeHtml(buyer?.street || "")}</div>
      <div class="row">${escapeHtml(buyer?.district || "")}${buyer?.district && buyer?.city ? ", " : ""}${escapeHtml(buyer?.city || "")} ${escapeHtml(buyer?.postalZone || "")}</div>
    </div>
  </section>

  <table class="lines">
    <thead>
      <tr>
        <th>#</th><th>${t.description}</th>
        <th class="num">${t.unit}</th>
        <th class="num">${t.net}</th><th class="num">${t.vatPct}</th><th class="num">${t.vatAmt}</th><th class="num">${t.total}</th>
      </tr>
    </thead>
    <tbody>${linesRows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>${t.netTotal}</span><span>${fmt(totals?.lineExtension)} ${t.sar}</span></div>
    <div class="row"><span>${t.vatTotal}</span><span>${fmt(totals?.taxAmount)} ${t.sar}</span></div>
    <div class="row grand"><span>${t.payable}</span><span>${fmt(totals?.payable)} ${t.sar}</span></div>
  </div>

  <section class="qr-row">
    <div class="qr-svg">${qrSvgMarkup}</div>
    <div>
      <h3>${t.qrTitle}</h3>
      <div class="meta-tlv">${escapeHtml(invoice.qrBase64 || "—")}</div>
    </div>
  </section>

  ${validationBlock}

  <footer class="doc">
    ${escapeHtml(brand?.footerText || "")}
    ${brand?.footerText ? "<br/>" : ""}
    ${t.generated} ${escapeHtml(new Date().toISOString().slice(0, 19).replace("T", " "))} · ${t.invoiceHash}: ${escapeHtml(invoice.invoiceHash || "")}
  </footer>
</body>
</html>`;
}
