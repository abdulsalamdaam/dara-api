import { DARA_LOCKUP_SVG, DARA_PATTERN_TILE_DATA_URI } from "../../common/brand-assets";

/**
 * The tax invoice Dara issues to a customer for their own subscription.
 *
 * Not to be confused with `invoice-template.ts`, which renders the LANDLORD's
 * invoice to their tenant. This one runs the other way round: Dara is the
 * seller, the account holder is the buyer, and the single line is the plan they
 * paid for. Different parties, different numbering series, different template.
 *
 * Rendered by `PdfService.htmlToPdf`, i.e. headless Chrome — which is why this
 * is HTML rather than a PDF library. Two consequences worth knowing:
 *
 *  · There is no network. Every asset is inline: the lockup and the pattern are
 *    baked SVG (`common/brand-assets.ts`), and the type is a system font stack
 *    resolved against the fonts the image installs. A remote webfont would
 *    silently fall back to boxes for the Arabic.
 *  · Colours must be explicit. A PDF has one ground; nothing here reacts to a
 *    viewer theme.
 *
 * The document addresses the customer BY NAME and nothing more. There is an
 * "invoice to" block carrying the company's registered name (or the person's)
 * and, when the account has one, an address — and that is all either party
 * gets. No seller block, and no registration numbers for anybody: no buyer
 * VAT, no seller VAT, no CR. Dara is identified by the lockup at the top and
 * the contact line at the bottom.
 *
 * That is the design as specified, and the omissions are decisions rather than
 * oversights — do not "fix" them by adding fields back. It does mean the
 * document is a receipt rather than a compliant KSA tax invoice despite its
 * heading; making it compliant is a design change to raise, not a field to
 * slip in. Tests assert both the name being present and the numbers being
 * absent.
 *
 * The one place the seller's VAT number does appear is inside the ZATCA
 * Phase-1 QR, which mandates it (tag 2) along with the seller name (tag 1).
 * That is encoded, not printed, and no QR is emitted at all when the number is
 * unconfigured — a QR scanning to an empty VAT number looks official and
 * certifies nothing.
 */

/** Everything the document states. Assembled by the caller — this only renders. */
export interface SubscriptionInvoiceData {
  /** Dara's own invoice number for this payment, e.g. `SUB-000042`. */
  invoiceNumber: string;
  /** Issue date, already formatted for print (`YYYY/M/D`). */
  issueDate: string;
  /**
   * Dara, as it appears in the footer — the contact row and the website bar.
   * There is no seller BLOCK on this document: the reference design carries
   * one party only, and everything the reader needs to identify us is the
   * lockup at the top and the contact line at the bottom.
   */
  /**
   * Who the invoice is addressed to — the company's registered name, or the
   * person's, and optionally an address. `addressLines` may be empty: plenty
   * of accounts have never filled one in, and an empty address must simply not
   * print rather than leave a gap or a placeholder.
   */
  buyer: {
    name: string;
    addressLines: string[];
  };
  seller: {
    addressLines: string[];
    email: string | null;
    phone: string | null;
    website: string | null;
  };
  lines: Array<{
    description: string;
    quantity: number;
    /** Unit price EXCLUDING VAT. */
    unitPrice: number;
    /** quantity × unitPrice, excluding VAT. */
    amount: number;
  }>;
  /** Sum of line amounts, excluding VAT. */
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  currencyLabel: string;
  /**
   * The ZATCA Phase-1 QR, already rendered as inline SVG. Empty or absent when
   * the seller's VAT number is not configured — see `daraSeller()`.
   */
  qrSvg?: string | null;
  /** Stamped across the document when this is not a paid invoice. */
  watermark?: string | null;
}

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Money, always in Latin digits with two decimals.
 *
 * Arabic-Indic digits are correct Arabic typography and wrong on an invoice:
 * the figure is copied into bank transfers and accounting systems, and a reader
 * comparing it against a statement should not have to transliterate. The rest
 * of the document is Arabic; the numbers are not.
 */
const money = (n: number): string =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Sky-blue glyphs in the footer contact row, matching the reference layout. */
const ICON = {
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="#58C3F1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="#58C3F1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="#58C3F1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>`,
};

export function renderSubscriptionInvoiceHtml(d: SubscriptionInvoiceData): string {
  const rows = d.lines.map((l) => `
        <tr>
          <td class="qty">${esc(l.quantity)}</td>
          <td class="desc">${esc(l.description)}</td>
          <td class="num">${money(l.unitPrice)}</td>
          <td class="num">${money(l.amount)}</td>
        </tr>`).join("");

  const contact: Array<[string, string]> = [];
  const addr = d.seller.addressLines.filter(Boolean).join("، ");
  if (addr) contact.push([ICON.pin, addr]);
  if (d.seller.phone) contact.push([ICON.phone, d.seller.phone]);
  if (d.seller.email) contact.push([ICON.mail, d.seller.email]);

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${esc(d.invoiceNumber)}</title>
<style>
  /* The image installs fonts-noto-core; Noto Sans Arabic is what actually
     shapes the Arabic here. The rest of the stack is a fallback for a local
     render outside the container. */
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Noto Sans Arabic", "Noto Naskh Arabic", "DejaVu Sans", "Segoe UI", Tahoma, sans-serif;
    color: #15192E;
    font-size: 11px;
    line-height: 1.6;
    background: #FFFFFF;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { position: relative; width: 210mm; min-height: 297mm; padding: 15mm 14mm 0; }

  /* ── Header ───────────────────────────────────────────────────────────
     The pattern is a masked block rather than a background image so it can
     fade out downward, the way the brand utility does on the web. */
  .pattern {
    position: absolute; top: 0; inset-inline: 0; height: 44mm;
    background-color: #2B378C; opacity: .13;
    -webkit-mask-image: url("${DARA_PATTERN_TILE_DATA_URI}"), linear-gradient(to bottom, #000 30%, transparent 100%);
    -webkit-mask-repeat: repeat, no-repeat;
    -webkit-mask-size: 26mm 30mm, 100% 100%;
    mask-image: url("${DARA_PATTERN_TILE_DATA_URI}"), linear-gradient(to bottom, #000 30%, transparent 100%);
    mask-repeat: repeat, no-repeat;
    mask-size: 26mm 30mm, 100% 100%;
  }
  /* Logo on the right, title on the left — as on the reference. */
  .head { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10mm; min-height: 30mm; }
  .head h1 { margin: 0; font-size: 34px; font-weight: 800; color: #193C5B; letter-spacing: -.5px; }
  .lockup { width: 46mm; flex: none; }
  .lockup svg { width: 100%; height: auto; display: block; }

  .rule { margin-top: 8mm; height: 2px; background: #58C3F1; }

  /* ── Meta pill ────────────────────────────────────────────────────── */
  .meta { display: flex; justify-content: flex-start; margin-top: 9mm; }
  .pill {
    background: #58C3F1; color: #FFFFFF; border-radius: 40px;
    padding: 2.8mm 8mm; font-size: 12px; font-weight: 700;
    display: flex; gap: 7mm;
  }
  .pill .v { font-weight: 600; }


  /* ── Recipient ────────────────────────────────────────────────────── */
  .parties { display: flex; justify-content: flex-start; margin-top: 8mm; }
  .party { max-width: 90mm; }
  .party .lbl { color: #6B7A90; font-size: 11px; margin-bottom: 1mm; }
  .party .nm { font-weight: 800; font-size: 13.5px; color: #15192E; }
  .party .ln { color: #46566B; }

  /* ── Items ────────────────────────────────────────────────────────── */
  /* Inset from the text column, as on the reference. Full width left the
     description cell holding all the leftover space, which made a one-line
     item look lost in it. */
  table { width: 152mm; margin: 12mm auto 0; border-collapse: separate; border-spacing: 0; }
  thead th {
    background: #2B378C; color: #FFFFFF; font-weight: 700; font-size: 12px;
    padding: 3.4mm 4mm; text-align: center;
  }
  thead th:first-child { border-start-start-radius: 6mm; border-end-start-radius: 6mm; }
  thead th:last-child  { border-start-end-radius: 6mm;   border-end-end-radius: 6mm; }
  tbody td { padding: 4mm; border-bottom: 1px solid #C9D2DE; text-align: center; vertical-align: middle; }
  tbody tr:first-child td { padding-top: 5mm; }
  tbody td.desc { text-align: center; color: #2B3648; }
  tbody td.qty { width: 16mm; color: #46566B; }
  tbody td.num { width: 30mm; font-variant-numeric: tabular-nums; direction: ltr; color: #2B3648; }

  /* ── Totals ───────────────────────────────────────────────────────── */
  /* flex-end is the LEFT edge in RTL, which is where the reference puts them. */
  .summary {
    display: flex; justify-content: space-between; align-items: flex-start;
    width: 152mm; margin: 8mm auto 0;
  }
  .qr { width: 27mm; flex: none; }
  .qr svg { width: 100%; height: auto; display: block; }
  .totals { display: flex; justify-content: flex-end; }
  .totals table { width: 72mm; margin: 0; }
  .totals td { border: 0; padding: 1.5mm 0; }
  .totals .k { color: #2B7FC4; font-size: 11px; font-weight: 700; text-align: start; }
  .totals .v { text-align: end; direction: ltr; font-variant-numeric: tabular-nums; color: #2B3648; }
  .totals tr.grand td { padding-top: 2.8mm; border-top: 1.4px solid #58C3F1; }
  .totals tr.grand .k { color: #2B7FC4; font-weight: 800; font-size: 11.5px; }
  .totals tr.grand .v { color: #15192E; font-weight: 800; font-size: 14px; }

  .note { margin-top: 11mm; color: #7C8AA0; font-size: 10px; }

  /* ── Footer ───────────────────────────────────────────────────────── */
  .foot { position: absolute; inset-inline: 14mm; bottom: 11mm; }
  .foot .row {
    display: flex; justify-content: center; align-items: center; gap: 10mm; flex-wrap: wrap;
    color: #46566B; font-size: 10.5px; padding-bottom: 4mm;
  }
  .foot .row span { display: inline-flex; align-items: center; gap: 2mm; }
  .foot .row svg { width: 3.6mm; height: 3.6mm; flex: none; }
  .foot .line { height: 1.4px; background: #58C3F1; }
  .foot .ends {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 3.4mm; font-size: 11px; color: #193C5B; direction: ltr;
  }
  .foot .ends .num { font-variant-numeric: tabular-nums; color: #46566B; }

  .watermark {
    position: absolute; top: 42%; inset-inline-start: 0; width: 100%;
    text-align: center; font-size: 62px; font-weight: 800;
    color: rgba(43, 55, 140, .10); transform: rotate(-22deg); letter-spacing: 4px;
  }
</style>
</head>
<body>
  <div class="page">
    <div class="pattern"></div>
    ${d.watermark ? `<div class="watermark">${esc(d.watermark)}</div>` : ""}

    <div class="head">
      <div class="lockup">${DARA_LOCKUP_SVG}</div>
      <h1>فاتورة ضريبية</h1>
    </div>
    <div class="rule"></div>

    <div class="meta">
      <div class="pill">
        <span>رقم الفاتورة: <span class="v">${esc(d.invoiceNumber)}</span></span>
        <span>التاريخ: <span class="v">${esc(d.issueDate)}</span></span>
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <div class="lbl">فاتورة إلى</div>
        <div class="nm">${esc(d.buyer.name)}</div>
        ${d.buyer.addressLines.filter(Boolean).map((l) => `<div class="ln">${esc(l)}</div>`).join("")}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>الكمية</th>
          <th>الوصف</th>
          <th>السعر</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="summary">
      <!-- Right (RTL start): the QR. Kept in the DOM even when empty so the
           totals stay pinned to the left edge either way. -->
      <div class="qr">${d.qrSvg || ""}</div>
      <div class="totals">
      <table>
        <tr><td class="k">المجموع:</td><td class="v">${money(d.subtotal)}</td></tr>
        <tr><td class="k">ضريبة القيمة المضافة (${esc(d.vatRate)}%):</td><td class="v">${money(d.vatAmount)}</td></tr>
        <tr class="grand"><td class="k">الإجمالي:</td><td class="v">${money(d.total)} ${esc(d.currencyLabel)}</td></tr>
      </table>
      </div>
    </div>

    <div class="note">
      فاتورة ضريبية عن اشتراكك في منصة دارا. المبالغ بالريال السعودي وشاملة ضريبة القيمة المضافة.
    </div>

    <div class="foot">
      <div class="row">${contact.map(([icon, text]) => `<span>${icon}<span dir="auto">${esc(text)}</span></span>`).join("")}</div>
      <div class="line"></div>
      <div class="ends">
        <span>${esc(d.seller.website ?? "")}</span>
        <span class="num">${esc(d.invoiceNumber)}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}
