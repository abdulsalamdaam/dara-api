import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ShellService } from "./shell.service";
import { renderInvoiceHtml, type RenderContext } from "./invoice-template";

/**
 * A one-page A4 document with inline assets and no network renders in about a
 * second. Sixty is a wedged Chrome, not a slow one — and the caller on the
 * subscription path is fire-and-forget, so without a limit the process, its
 * tab and its temp directory simply leak. `ShellService` kills it and throws.
 */
const CHROME_RENDER_TIMEOUT_MS = 60_000;

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

@Injectable()
export class PdfService {
  constructor(private readonly shell: ShellService) {}

  async findChrome(): Promise<string | null> {
    if (process.env.CHROME_PATH) {
      try {
        await fs.access(process.env.CHROME_PATH);
        return process.env.CHROME_PATH;
      } catch {
        /* fall through to search list */
      }
    }
    for (const p of CHROME_PATHS) {
      try {
        await fs.access(p);
        return p;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /**
   * Render the invoice HTML and return both the HTML and the PDF bytes.
   * Throws if no headless browser is installed and `pdf` is requested.
   */
  async renderHtml(ctx: RenderContext): Promise<string> {
    return renderInvoiceHtml(ctx);
  }

  async renderPdf(ctx: RenderContext): Promise<Buffer> {
    return this.htmlToPdf(renderInvoiceHtml(ctx));
  }

  /** Render an arbitrary HTML string to a PDF (used by the invoice/voucher
   *  exporter so the file matches the web's printed document exactly). */
  async htmlToPdf(html: string): Promise<Buffer> {
    const chrome = await this.findChrome();
    if (!chrome) {
      throw new Error(
        "No headless browser found. Install Google Chrome / Chromium / Edge to enable PDF export, or set CHROME_PATH env var.",
      );
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "doc-pdf-"));
    const htmlPath = path.join(tmp, "doc.html");
    const pdfPath = path.join(tmp, "doc.pdf");
    try {
      await fs.writeFile(htmlPath, html, "utf8");
      await this.shell.mustRun(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        // Containers get a 64 MB /dev/shm by default. Chrome puts its shared
        // renderer memory there, runs out, and the tab dies mid-render — which
        // surfaces as a zero-byte or missing PDF rather than as an error about
        // memory. This moves that allocation to /tmp, and is the standard flag
        // for exactly this.
        "--disable-dev-shm-usage",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ], { timeoutMs: CHROME_RENDER_TIMEOUT_MS });
      return await fs.readFile(pdfPath);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}
