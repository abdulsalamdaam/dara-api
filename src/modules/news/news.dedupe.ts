import type { NormalisedTweet } from "./news.types";

/**
 * Two kinds of duplicate, both dropped before the AI sees anything (it is the
 * expensive step):
 *
 *  1. The same tweet again — same `id`. Across runs this is the norm (the
 *     lookback window overlaps the previous run) and is caught by the caller
 *     against `news_items.external_id`; within a run it happens when one
 *     account is listed twice or a provider pages overlap.
 *  2. The same story from several accounts — ministries, the regulator and
 *     three news sites all posting the same announcement in slightly different
 *     words. Caught cheaply by word-set Jaccard similarity on a normalised
 *     text; the earliest post is kept (usually the original source).
 *
 * Deliberately not clever. A missed near-duplicate costs one extra card; a
 * false positive hides a distinct story, so the threshold leans high.
 */
export const NEAR_DUP_THRESHOLD = 0.6;
/** Too few words to judge ("عاجل" + a link) — never called a near-duplicate. */
const MIN_TOKENS = 5;

/** Lowercase, drop URLs/mentions/diacritics/punctuation, unify Arabic letter forms. */
export function normaliseForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/#/g, " ")
    .replace(/[ً-ٰٟـ]/g, "") // harakat, dagger alef, tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(text: string): Set<string> {
  return new Set(normaliseForCompare(text).split(" ").filter((w) => w.length > 1));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isNearDuplicate(a: Set<string>, b: Set<string>, threshold = NEAR_DUP_THRESHOLD): boolean {
  if (a.size < MIN_TOKENS || b.size < MIN_TOKENS) return false;
  return jaccard(a, b) >= threshold;
}

export interface DedupeResult {
  kept: NormalisedTweet[];
  /** Same id seen twice in this batch, or already stored. */
  exactDuplicates: NormalisedTweet[];
  /** Same story as a kept tweet (or as a recently stored item). */
  nearDuplicates: Array<{ tweet: NormalisedTweet; duplicateOf: string }>;
}

/**
 * @param existingIds ids already in `news_items`.
 * @param recentTexts recently stored items (id → text) to compare stories against.
 */
export function dedupeTweets(
  tweets: NormalisedTweet[],
  existingIds: ReadonlySet<string> = new Set(),
  recentTexts: ReadonlyArray<{ id: string; text: string }> = [],
): DedupeResult {
  const exactDuplicates: NormalisedTweet[] = [];
  const nearDuplicates: DedupeResult["nearDuplicates"] = [];
  const seen = new Set<string>();

  // Earliest first, so the kept one of a near-duplicate pair is the original.
  const ordered = [...tweets].sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));

  const pool: Array<{ id: string; tokens: Set<string> }> = recentTexts.map((r) => ({ id: r.id, tokens: tokenSet(r.text) }));
  const kept: NormalisedTweet[] = [];

  for (const t of ordered) {
    if (existingIds.has(t.id) || seen.has(t.id)) {
      exactDuplicates.push(t);
      continue;
    }
    seen.add(t.id);
    const tokens = tokenSet(t.text);
    const match = pool.find((p) => isNearDuplicate(tokens, p.tokens));
    if (match) {
      nearDuplicates.push({ tweet: t, duplicateOf: match.id });
      continue;
    }
    pool.push({ id: t.id, tokens });
    kept.push(t);
  }
  return { kept, exactDuplicates, nearDuplicates };
}
