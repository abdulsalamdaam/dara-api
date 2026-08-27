/**
 * ZATCA Phase-1 QR for simplified tax invoices (server-side).
 *
 * Mirrors the web's `src/lib/zatca-qr.ts`: builds the TLV (tag-length-value)
 * payload of the five mandatory fields (seller name, VAT number, ISO-8601
 * timestamp, total with VAT, VAT total), base64-encodes it, then renders it as
 * an inline SVG QR via `qrcode-generator` (byte mode + medium ECC) so ZATCA's
 * verifier can read it. Returned to the mobile app, which renders the SVG with
 * react-native-svg.
 */

import qrcode from "qrcode-generator";

export interface Phase1Fields {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string | number;
  vatTotal: string | number;
}

function utf8Bytes(str: string): number[] {
  return Array.from(Buffer.from(str, "utf8"));
}

function tlv(tag: number, value: number[]): number[] {
  // 1-byte tag, 1-byte length (Phase-1 values are always < 256 bytes), value.
  return [tag, value.length, ...value];
}

export function buildPhase1Tlv(f: Phase1Fields): string {
  const bytes = [
    ...tlv(1, utf8Bytes(f.sellerName || "")),
    ...tlv(2, utf8Bytes(f.vatNumber || "")),
    ...tlv(3, utf8Bytes(f.timestamp || "")),
    ...tlv(4, utf8Bytes(String(f.totalWithVat))),
    ...tlv(5, utf8Bytes(String(f.vatTotal))),
  ];
  return Buffer.from(bytes).toString("base64");
}

/** Render the TLV base64 string as an inline SVG QR symbol. */
export function qrSvg(data: string, sizePx = 200): string {
  if (!data) return "";
  const qr = qrcode(0, "M"); // typeNumber 0 = auto-fit smallest version
  qr.addData(data, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const cell = sizePx / n;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        rects += `<rect x="${(c * cell).toFixed(3)}" y="${(r * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="#000"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" shape-rendering="crispEdges"><rect width="${sizePx}" height="${sizePx}" fill="#fff"/>${rects}</svg>`;
}

/** Build the ZATCA Phase-1 QR SVG from invoice numbers, or "" when not a tax invoice. */
export function invoiceQrSvg(opts: {
  sellerName?: string | null;
  vatNumber?: string | null;
  issueDate?: string | Date | null;
  totalWithVat: number;
  vatTotal: number;
  sizePx?: number;
}): string {
  const ts = (opts.issueDate ? new Date(opts.issueDate) : new Date()).toISOString();
  const payload = buildPhase1Tlv({
    sellerName: opts.sellerName || "",
    vatNumber: opts.vatNumber || "",
    timestamp: ts,
    totalWithVat: opts.totalWithVat.toFixed(2),
    vatTotal: opts.vatTotal.toFixed(2),
  });
  return qrSvg(payload, opts.sizePx ?? 220);
}

/**
 * ZATCA's own QR out of a CLEARED standard invoice.
 *
 * Our signer only builds the 9-tag Phase-2 QR for SIMPLIFIED invoices; a
 * standard (B2B) one is signed with a 5-tag Phase-1 QR, because a standard
 * invoice is not self-certified — it goes through clearance and ZATCA returns
 * the cleared document carrying the QR it stamped. That returned QR is the one
 * the buyer's copy has to show, and it was being decoded, stored in
 * `invoices.cleared_xml` and then ignored.
 *
 * Tolerant of namespace prefixes and attribute order, and returns null on
 * anything unexpected — a missing QR must leave the document on its existing
 * fallback, never blank it.
 */
export function clearedInvoiceQr(clearedXml: string | null | undefined): string | null {
  if (!clearedXml || typeof clearedXml !== "string") return null;
  // Each AdditionalDocumentReference is a self-contained block; the QR one is
  // identified by an <ID>QR</ID> child, so isolate blocks and pick that one
  // rather than trusting the document order.
  const blocks = clearedXml.split(/<[A-Za-z0-9]*:?AdditionalDocumentReference[\s>]/).slice(1);
  for (const block of blocks) {
    if (!/<[A-Za-z0-9]*:?ID>\s*QR\s*<\//.test(block)) continue;
    const m = block.match(
      /<[A-Za-z0-9]*:?EmbeddedDocumentBinaryObject[^>]*>([\s\S]*?)<\/[A-Za-z0-9]*:?EmbeddedDocumentBinaryObject>/,
    );
    const qr = m?.[1]?.trim();
    if (qr) return qr;
  }
  return null;
}
