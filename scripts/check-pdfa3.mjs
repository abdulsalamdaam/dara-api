/**
 * PDF/A-3 conformance gate.
 *
 * Builds an invoice PDF/A-3 exactly as the API does, then hands it to veraPDF
 * and fails the build unless it validates as PDF/A-3B.
 *
 * The metadata inside the file *claims* PDF/A-3B to whoever receives it. This
 * is the thing that makes the claim true, rather than aspirational — without
 * it a refactor could quietly drop the OutputIntent and nobody would find out
 * until a buyer's tax software rejected the invoice.
 *
 * Runs against dist/, so it checks the artefact that actually ships.
 *
 *   VERAPDF=/path/to/verapdf node scripts/check-pdfa3.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import { PdfA3Service } from "../dist/src/modules/invoice/services/pdfa3.service.js";

const VERAPDF = process.env.VERAPDF || "verapdf";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdfa3-"));
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };

/**
 * Stand-in for what the portal uploads: DeviceRGB content, no OutputIntent and
 * no XMP — the traits that make a raw invoice PDF non-conforming.
 *
 * Deliberately draws NO text, because the real document does not: the portal
 * rasterises the whole page to a single JPEG. Drawing text here with a standard
 * font would test a document we never produce, and would fail on font embedding
 * rather than on the two things this gate is actually guarding.
 */
async function sourcePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 40, y: 700, width: 515, height: 80, color: rgb(0.02, 0.15, 0.6) });
  page.drawRectangle({ x: 40, y: 120, width: 515, height: 540, color: rgb(0.97, 0.97, 0.98) });
  return Buffer.from(await doc.save());
}

const XML = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>INV-000001</ID></Invoice>\n`,
  "utf8",
);

function verapdf(file) {
  try {
    const out = execFileSync(VERAPDF, ["--flavour", "3b", "--format", "text", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.includes("PASS ") ? "PASS" : "FAIL";
  } catch (e) {
    const out = `${e.stdout ?? ""}`;
    if (out.includes("FAIL ")) return "FAIL";
    if (out.includes("PASS ")) return "PASS";
    fail(`could not run veraPDF (${VERAPDF}): ${e.message}`);
  }
}

const src = path.join(tmp, "source.pdf");
const out = path.join(tmp, "invoice-pdfa3.pdf");
fs.writeFileSync(src, await sourcePdf());
fs.writeFileSync(out, await new PdfA3Service().build({ pdf: fs.readFileSync(src), xml: XML, number: "INV-000001", issuedAt: new Date("2026-08-25T00:00:00Z") }));

// The negative case first. If a broken veraPDF install passed everything, the
// positive check below would be meaningless — so prove it can still say no.
const before = verapdf(src);
console.log(`source PDF (no OutputIntent, no XMP) : ${before}`);
if (before !== "FAIL") fail("the unwrapped source validated as PDF/A-3B — veraPDF is not discriminating, so this gate proves nothing");

const after = verapdf(out);
console.log(`wrapped PDF/A-3                      : ${after}`);
if (after !== "PASS") {
  fs.copyFileSync(out, "pdfa3-failure.pdf");
  fail("the built PDF/A-3 does NOT validate as PDF/A-3B (saved to pdfa3-failure.pdf)");
}

// Conformance is only half of it: the embedded XML is the e-invoice ZATCA
// stamped, so it has to come back out byte-for-byte. A wrapper that quietly
// re-serialised it would still validate, and still be wrong.
const doc = await PDFDocument.load(fs.readFileSync(out));
const spec = doc.context.lookup(doc.catalog.lookup(PDFName.of("AF")).get(0));
const rel = String(spec.lookup(PDFName.of("AFRelationship")));
const stream = doc.context.lookup(doc.context.lookup(spec.lookup(PDFName.of("EF"))).lookup(PDFName.of("F")));
let data = Buffer.from(stream.contents);
if (String(stream.dict.lookup(PDFName.of("Filter")) ?? "").includes("FlateDecode")) data = zlib.inflateSync(data);
console.log(`embedded XML                         : ${data.length} bytes, AFRelationship ${rel}`);
if (!data.equals(XML)) fail("the embedded XML is not byte-identical to the input");
if (rel !== "/Alternative") fail(`AFRelationship is ${rel}, expected /Alternative`);

console.log("\n\u2713 PDF/A-3B verified by veraPDF, XML embedded verbatim");
fs.rmSync(tmp, { recursive: true, force: true });
