import type { NormalisedTweet } from "../news.types";

/**
 * Shared text clean-up: t.co links → the URL they stand for, and the t.co link
 * X appends for attached media removed (the media itself is carried in
 * `media`). Plain string replacement rather than the entity indices — X counts
 * indices in code points and twitterapi.io in UTF-16 units, and a replace by
 * value cannot get either wrong.
 */
export function expandUrls(
  text: string,
  urls: Array<{ url?: string; expanded_url?: string; media_key?: string }> | undefined,
  mediaTcos: string[] = [],
): string {
  let out = text ?? "";
  for (const u of urls ?? []) {
    if (!u?.url) continue;
    const isMedia = !!u.media_key || /\/(?:photo|video)\/\d+$/.test(u.expanded_url ?? "");
    out = out.split(u.url).join(isMedia || !u.expanded_url ? "" : u.expanded_url);
  }
  for (const t of mediaTcos) if (t) out = out.split(t).join("");
  return decodeEntities(out).replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

/** X returns `&amp;`, `&lt;`, `&gt;` escaped in tweet text. */
export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** `…/abc_normal.jpg` → `…/abc_400x400.jpg` — the 48px default looks bad on a card. */
export function largerAvatar(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/_normal(\.\w+)$/, "_400x400$1");
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function tweetUrl(handle: string, id: string): string {
  return `https://x.com/${handle}/status/${id}`;
}

export type { NormalisedTweet };
