/**
 * Feed text → plain text. Feeds put HTML in their descriptions (often escaped
 * as entities or wrapped in CDATA); the portal renders text only, so tags are
 * removed and entities decoded here. Output is never treated as HTML anywhere.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", hellip: "…",
  bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£",
  times: "×", divide: "÷", zwnj: String.fromCharCode(0x200c), zwj: String.fromCharCode(0x200d), lrm: "", rlm: "", shy: "",
};

/** Decode named (common set) and numeric entities. Unknown names are left as-is. */
export function decodeHtmlEntities(s: string): string {
  return (s ?? "").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    const v = NAMED[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** LRM/RLM and the bidi embedding/isolate controls — invisible, and they break matching. */
const BIDI_CONTROLS = new RegExp(`[${String.fromCharCode(0x200e, 0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, "g");

/**
 * HTML fragment → one clean line of text: script/style/comments dropped,
 * block tags become spaces, every other tag removed, entities decoded,
 * whitespace collapsed.
 */
export function htmlToText(html: string): string {
  let s = String(html ?? "");
  // An entity-escaped fragment ("&lt;p&gt;…") is HTML one level down.
  if (!/<[a-z!/]/i.test(s) && /&lt;\s*\/?[a-z]/i.test(s)) s = decodeHtmlEntities(s);
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|table|blockquote|section|article|figure|figcaption)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/<[a-z/!][^>]*$/i, ""); // a tag cut off by truncation
  s = decodeHtmlEntities(s);
  return s.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
}

/** The first `<img src>` in an HTML fragment (http/https only). */
export function firstImageSrc(html: string): string | null {
  const s = /<[a-z]/i.test(html ?? "") ? html : decodeHtmlEntities(html ?? "");
  const m = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(s);
  return m ? httpUrl(decodeHtmlEntities(m[1])) : null;
}

/** `v` if it is an absolute http(s) URL, else null. Never javascript:, data:, etc. */
export function httpUrl(v: unknown, base?: string): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = base ? new URL(v.trim(), base) : new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `ar` when more than 30% of the letters are Arabic, else `en`; null when there are no letters. */
export function detectLang(text: string): "ar" | "en" | null {
  const ar = (text.match(/(?=\p{Script=Arabic})\p{L}/gu) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (!letters) return null;
  return ar / letters > 0.3 ? "ar" : "en";
}
