import { Injectable, Logger } from "@nestjs/common";
import { PDFDocument, PDFName, PDFString, PDFNumber, AFRelationship, PDFDict } from "pdf-lib";
import { SRGB_ICC_BASE64 } from "../assets/srgb-icc";

/**
 * Wrap a rendered invoice PDF as PDF/A-3 with the cleared XML embedded.
 *
 * ZATCA lets an e-invoice be shared with the buyer as XML **or** as PDF/A-3
 * carrying that XML inside it. This builds the second form out of the two
 * artefacts we already have: the PDF the portal rendered, and the exact bytes
 * ZATCA returned from clearance.
 *
 * The XML is embedded verbatim. It is never re-generated or re-serialised —
 * it is the stamped document, and a byte that changes is a document that no
 * longer matches what ZATCA cleared.
 */
@Injectable()
export class PdfA3Service {
  private readonly log = new Logger(PdfA3Service.name);

  async build(args: {
    pdf: Buffer;
    xml: Buffer;
    /** Invoice number — the document title and the attachment's filename. */
    number: string;
    issuedAt?: Date | null;
  }): Promise<Buffer> {
    const doc = await PDFDocument.load(args.pdf);
    const when = args.issuedAt ?? new Date();
    const safeName = args.number.replace(/[^A-Za-z0-9._-]/g, "_") || "invoice";

    // ── 1. The cleared XML, as an embedded file ────────────────────────────
    // AFRelationship /Alternative declares it as an alternative representation
    // of the visible page — this invoice, machine-readable — rather than an
    // unrelated attachment that happens to ride along.
    await doc.attach(args.xml, `${safeName}.xml`, {
      mimeType: "text/xml",
      description: "ZATCA cleared invoice (UBL 2.1)",
      creationDate: when,
      modificationDate: when,
      afRelationship: AFRelationship.Alternative,
    });

    // ── 2. Drop font declarations nothing draws with ───────────────────────
    // The page is a single rasterised image and paints no text, but jsPDF
    // still emits the 14 standard fonts into every page's /Resources with no
    // /FontFile. PDF/A forbids a font that is not embedded, so those unused
    // dictionaries alone would fail validation. Removing them is safe here
    // precisely because no content stream references them.
    let dropped = 0;
    for (const page of doc.getPages()) {
      const res = page.node.Resources();
      const fonts = res?.lookup(PDFName.of("Font"));
      if (fonts instanceof PDFDict) {
        for (const key of fonts.keys()) { fonts.delete(key); dropped += 1; }
        if (fonts.keys().length === 0) res!.delete(PDFName.of("Font"));
      }
    }

    // ── 3. OutputIntent ───────────────────────────────────────────────────
    // PDF/A needs colour to be unambiguous, which means carrying the profile
    // itself and not merely naming it.
    const icc = Buffer.from(SRGB_ICC_BASE64, "base64");
    const iccRef = doc.context.register(doc.context.flateStream(icc, { N: PDFNumber.of(3) }));
    doc.catalog.set(
      PDFName.of("OutputIntents"),
      doc.context.obj([
        doc.context.obj({
          Type: "OutputIntent",
          S: "GTS_PDFA1",
          OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
          Info: PDFString.of("sRGB IEC61966-2.1"),
          RegistryName: PDFString.of("http://www.color.org"),
          DestOutputProfile: iccRef,
        }),
      ]),
    );

    // ── 4. XMP claiming PDF/A-3B ──────────────────────────────────────────
    // Without this a reader sees an attachment and a profile but no claim of
    // conformance to check the file against.
    const iso = when.toISOString().replace(/\.\d{3}Z$/, "Z");
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(args.number)}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>${iso}</xmp:CreateDate>
      <xmp:ModifyDate>${iso}</xmp:ModifyDate>
      <xmp:CreatorTool>Dara</xmp:CreatorTool>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Dara</pdf:Producer>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    doc.catalog.set(
      PDFName.of("Metadata"),
      doc.context.register(doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" })),
    );

    doc.setTitle(args.number);
    doc.setProducer("Dara");
    doc.setCreator("Dara");
    doc.setCreationDate(when);
    doc.setModificationDate(when);

    this.log.debug(`PDF/A-3 ${args.number}: ${args.xml.length}B xml embedded, ${dropped} unused font dict(s) dropped`);
    return Buffer.from(await doc.save());
  }
}
