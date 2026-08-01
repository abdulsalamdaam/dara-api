#!/usr/bin/env node
/**
 * Render the new public/logo.svg (from dara-web) into an email-optimized
 * base64 PNG and update src/modules/email/email-assets.ts in place.
 *
 * Email constraints:
 *  - Inline base64 because many mail clients block remote images. Keep it
 *    small enough that Gmail won't clip the message (~102 KB body limit
 *    after which Gmail collapses with "View entire message").
 *  - PNG (not SVG) since Outlook + many older clients won't render SVG
 *    in <img>. WebP is also poorly supported.
 *  - Target display size in the template is 160px wide × auto height.
 *    Render at 2x (320 wide) for retina sharpness.
 */
import fs from "node:fs";
import path from "node:path";

const SHARP_PATH = "/Users/aldawsari/Desktop/Rent--  Project/dara-web/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js";
const { default: sharp } = await import(SHARP_PATH);

const SVG_SRC   = "/Users/aldawsari/Desktop/Rent--  Project/dara-web/public/logo.svg";
const ASSETS_TS = path.resolve("src/modules/email/email-assets.ts");

if (!fs.existsSync(SVG_SRC)) {
  console.error("Missing source SVG:", SVG_SRC);
  process.exit(1);
}

const svgBuf = fs.readFileSync(SVG_SRC);

// Render at 320 wide (2× the email's 160px display); auto height keeps the
// SVG's aspect ratio. Palette PNG keeps the file small without artifacts on
// the solid brand-blue glyphs.
const pngBuf = await sharp(svgBuf, { density: 600 })
  .resize({ width: 320 })
  .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true })
  .toBuffer();

const meta = await sharp(pngBuf).metadata();
const b64 = pngBuf.toString("base64");
console.log(`PNG: ${meta.width}×${meta.height}, ${(pngBuf.length / 1024).toFixed(1)} KB, base64 ${(b64.length / 1024).toFixed(1)} KB`);

const dataUri = `data:image/png;base64,${b64}`;

// Splice the new data URI into the existing const in email-assets.ts so the
// file's comment + structure stay intact.
const ts = fs.readFileSync(ASSETS_TS, "utf8");
const updated = ts.replace(
  /export const LOGO_DATA_URI = "[^"]*";/,
  `export const LOGO_DATA_URI = "${dataUri}";`,
);
if (updated === ts) {
  console.error("Couldn't find LOGO_DATA_URI in email-assets.ts");
  process.exit(1);
}
fs.writeFileSync(ASSETS_TS, updated);
console.log("Updated:", path.relative(process.cwd(), ASSETS_TS));
