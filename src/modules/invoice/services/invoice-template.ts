import type { Invoice, InvoiceLine, ZatcaResponse } from "@dara/database";
import { qrSvg } from "../../../common/zatca-qr";

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
 * The QR is rendered by `qrcode-generator`, via common/zatca-qr.
 *
 * This file used to carry its own ~300-line Reed-Solomon encoder, and it could
 * not encode a real B2C invoice: its alignment-pattern table stopped at version
 * 10 and the fallback formula for anything larger was wrong. A simplified
 * invoice's signed 9-tag QR is a ~516-character string — version 15 — so every
 * B2C tax invoice answered 500 from /html and /pdf with "Cannot read properties
 * of undefined". Standard invoices carry a ~96-char Phase-1 QR (version 4) and
 * rendered fine, which is what hid it.
 */

export function renderInvoiceHtml(ctx: RenderContext): string {
  const { invoice, lines, brand } = ctx;
  const language = (ctx.language ?? invoice.language ?? "ar") as "ar" | "en";
  const t = STRINGS[language];
  const dir = language === "ar" ? "rtl" : "ltr";
  const brandColor = brand?.color ?? "#042698";
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

  // Readex Pro is the Dara brand face and covers Arabic and Latin, so both
  // languages share one stack and one webfont request.
  //
  // Tahoma sits early in the Arabic fallback chain because it is one of the
  // few widely installed faces that shapes Arabic correctly — without it a
  // renderer missing the webfont produces disconnected, overlapping glyphs.
  const fontStack = language === "ar"
    ? `'Readex Pro', 'Noto Sans Arabic', 'Tajawal', Tahoma, -apple-system, 'Helvetica Neue', Arial, sans-serif`
    : `'Readex Pro', -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  // The PDF renderer has no access to the portal's self-hosted fonts, so the
  // document must fetch its own. @import has to be the first rule.
  const fontImport =
    `@import url('https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700&display=swap');`;
  // letter-spacing and uppercase are Latin typography. Applied to Arabic they
  // pull apart the cursive joins, and any renderer that splits text per
  // character to honour the tracking loses contextual shaping entirely.
  const latinOnlyTracking = language === "ar" ? "" : "text-transform: uppercase; letter-spacing: 0.05em;";

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
    color: #010f35;
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
  .party h3 { font-size: 11px; color: #64748b; ${latinOnlyTracking} margin-bottom: 6px; }
  .party .name { font-weight: 600; font-size: 13px; }
  .party .row { color: #334155; font-size: 11px; }
  table.lines { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.lines th, table.lines td {
    border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: ${dir === "rtl" ? "right" : "left"};
  }
  table.lines th { background: #f8fafc; color: #64748b; font-size: 10px; ${language === "ar" ? "" : "text-transform: uppercase;"} }
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
