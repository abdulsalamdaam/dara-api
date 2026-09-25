import type { NewsCategory, NormalisedTweet } from "./news.types";
import { LEX_CATEGORIES } from "./news.lexicon";
import { compileTerm, normaliseForMatch, TASHKEEL } from "./news.text";

/**
 * Two kinds of duplicate, both dropped before the AI sees anything (it is the
 * expensive step):
 *
 *  1. The same tweet again — same `id`. Across runs this is the norm (the
 *     lookback window overlaps the previous run) and is caught by the caller
 *     against `news_items.external_id`; within a run it happens when one
 *     account is listed twice or a provider pages overlap.
 *  2. The same story from several sources — ministries, the regulator and
 *     news sites posting one announcement in different words, and Google
 *     News re-listing it from ten outlets. Caught by story clustering (shared
 *     figure + entity, token containment, or whole-text Jaccard — see
 *     `sameStory`), against this batch AND items stored in the last 72 h. The
 *     canonical copy is the most authoritative, then the earliest.
 *
 * Deliberately cheap. A missed near-duplicate costs one extra card; a false
 * positive hides a distinct story (still in the admin's Hidden tab), so the
 * rules want two signals, and conflicting figures veto a merge.
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

// ── story clustering (short headlines) ─────────────────────────────────────
//
// Whole-text Jaccard misses one story reworded across short headlines. On
// 26 Sep 2026 the REDF deposit was 5 of 8 published items: «الصندوق العقاري
// يودع 1.098 مليار ريال…», «السعودية تودع 1.098 مليار ريال…», «1.1 مليار ريال من
// صندوق التنمية العقارية…», «…يُودع مليارًا و98 مليون ريال…». Two headlines are the
// same story when:
//   A. they share a distinctive figure (1.098 مليار ~ 1.1 مليار ~ «مليارا و98
//      مليون») AND at least one lexicon entity term («الصندوق العقاري»); or
//   B. their content tokens overlap ≥ 50% of the shorter headline (≥ 3 shared,
//      both ≥ 4 tokens); or
//   C. the whole-text Jaccard is ≥ 0.6 (the v1 rule).
// Veto for B and C: when both carry distinctive figures and share none, they
// are not the same story. The same template with another figure is another
// report (next month's deposit, a different index reading).

/** A figure as written: absolute value, kind, and the rounding it allows. */
export interface Figure {
  value: number;
  kind: "abs" | "pct";
  /** Half a unit of the last written digit: 1.1 مليار → ±0.05 مليار. */
  tol: number;
}

const UNIT: Array<[RegExp, number]> = [
  [/^(?:مليار|billion|bn$)/, 1e9],
  [/^(?:مليون|ملايين|million|mn$|m$)/, 1e6],
  [/^(?:الف|الاف|thousand|k$)/, 1e3],
];

/** Digits to ASCII, decimal marks kept, tashkeel off, alef unified, lowercase. */
function figureText(text: string): string {
  return (text ?? "")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(/٪/g, "%")
    .replace(TASHKEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .toLowerCase();
}

function parseNum(raw: string): { n: number; decimals: number; digits: number } | null {
  let t = raw;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(t)) t = t.replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const decimals = t.includes(".") ? t.split(".")[1].length : 0;
  return { n: Number(t), decimals, digits: t.replace(".", "").replace(/^0+/, "").length };
}

/**
 * The distinctive figures in a headline: two or more significant digits, and
 * a unit (مليار/مليون/ألف, billion, %), a decimal, or an integer ≥ 100 that is
 * not a bare year. «4 مناطق», «1 مليار» and «2026» say nothing about the story.
 */
export function extractFigures(text: string): Figure[] {
  let s = figureText(text);
  const out: Figure[] = [];
  // «مليارا و98 مليون» or «2 مليار و300 مليون» is one figure, not two.
  for (const m of [...s.matchAll(/(?:(\d+(?:\.\d+)?)\s*)?مليار\p{L}*\s+و\s*(\d+)\s*مليون/gu)]) {
    const b = m[1] ? Number(m[1]) : 1;
    out.push({ value: b * 1e9 + Number(m[2]) * 1e6, kind: "abs", tol: 0.5e6 });
    s = s.replace(m[0], " ");
  }
  for (const m of s.matchAll(/(\d[\d.,]*\d|\d)\s*(%|\p{L}+)?/gu)) {
    const p = parseNum(m[1]);
    if (!p || p.digits < 2) continue;
    const unit = (m[2] ?? "").replace(/^(?:بال|ب|ال)(?=\p{L}{3})/u, "");
    if (unit === "%") {
      out.push({ value: p.n, kind: "pct", tol: 0.5 * 10 ** -p.decimals });
      continue;
    }
    const mult = UNIT.find(([re]) => re.test(unit))?.[1] ?? 1;
    const isYear = mult === 1 && p.decimals === 0 && p.n >= 1900 && p.n <= 2100;
    if (!isYear && (mult > 1 || p.decimals > 0 || p.n >= 100)) {
      out.push({ value: p.n * mult, kind: "abs", tol: 0.5 * 10 ** -p.decimals * mult });
    }
  }
  return out;
}

/** The same figure, where one may be a rounding of the other (1.1 مليار ~ 1.098 مليار). */
export function sameFigure(a: Figure, b: Figure): boolean {
  return a.kind === b.kind && Math.abs(a.value - b.value) <= Math.max(a.tol, b.tol) * (1 + 1e-9);
}

/** Function words, newsroom filler, months, currencies and magnitudes: shared by unrelated stories. */
const STOP = new Set([
  "في", "من", "علي", "الي", "عن", "مع", "خلال", "بعد", "قبل", "حتي", "او", "و", "ثم", "هذا", "هذه", "ذلك", "التي", "الذي",
  "الذين", "عبر", "لدي", "بين", "حول", "ضمن", "منذ", "عند", "كل", "ما", "لا", "لم", "لن", "قد", "هو", "هي", "اليوم", "امس",
  "نحو", "ان", "انه", "عاجل", "بالفيديو", "حصري", "فيديو", "تقرير", "بالصور", "شاهد", "لـ",
  "يناير", "فبراير", "مارس", "ابريل", "مايو", "يونيو", "يوليو", "اغسطس", "سبتمبر", "اكتوبر", "نوفمبر", "ديسمبر", "شهر", "لشهر",
  "ريال", "ريالا", "دولار", "مليار", "مليارا", "مليون", "ملايين", "الف", "الاف",
  "سعر", "اسعار", "سهم", "اسهم", "شركه", "شركات",
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "by", "at", "from", "as", "is", "are", "was", "were",
  "be", "its", "it", "this", "that", "new", "says", "said", "amid", "over", "into", "after", "up", "down",
  "sar", "riyals", "billion", "million", "bn", "price", "prices", "stock", "stocks", "shares", "company",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

/** A headline's content tokens: normalised, no stopwords, no figures, the article prefix off. */
export function contentTokens(headline: string): Set<string> {
  const out = new Set<string>();
  for (const w of normaliseForMatch(headline).split(" ")) {
    if (!w || /\d/.test(w) || STOP.has(w)) continue;
    const stem = w.length > 4 ? w.replace(/^(?:وال|بال|فال|كال|لل|ال)/, "") : w;
    if (stem.length >= 2 && !STOP.has(stem)) out.add(stem);
  }
  return out;
}

/**
 * Entities: the lexicon's category terms of weight ≥ 20 (not the generic
 * «عقار*» of `other`), keyed by their tag when they have one, so «الصندوق
 * العقاري» and «صندوق التنمية العقارية» are the same entity (`redf`).
 */
const ENTITY_TERMS = (Object.keys(LEX_CATEGORIES) as NewsCategory[])
  .filter((c) => c !== "other")
  .flatMap((c) => LEX_CATEGORIES[c].filter((t) => t.w >= 20).map((t) => ({ key: t.tag ?? t.t, re: compileTerm(t.t) })));

export function entityTerms(headline: string): Set<string> {
  const n = normaliseForMatch(headline);
  return new Set(ENTITY_TERMS.filter((e) => e.re.test(n)).map((e) => e.key));
}

/** The headline part of a stored text. RSS stores the title before the first blank line. */
export function headlineOf(text: string): string {
  const t = (text ?? "").trim();
  const i = t.indexOf("\n\n");
  return (i > 0 ? t.slice(0, i) : t).slice(0, 300);
}

export interface StoryKey {
  id: string;
  tokens: Set<string>;
  content: Set<string>;
  figures: Figure[];
  entities: Set<string>;
}

export function storyKey(id: string, text: string): StoryKey {
  const h = headlineOf(text);
  return { id, tokens: tokenSet(text), content: contentTokens(h), figures: extractFigures(h), entities: entityTerms(h) };
}

export const CONTAINMENT_THRESHOLD = 0.5;

export type StoryRule = "figure+entity" | "containment" | "jaccard";

/** The rule that makes `a` and `b` one story, or null. */
export function sameStory(a: StoryKey, b: StoryKey): StoryRule | null {
  const shareFigure = a.figures.some((x) => b.figures.some((y) => sameFigure(x, y)));
  if (shareFigure && [...a.entities].some((e) => b.entities.has(e))) return "figure+entity";
  if (a.figures.length && b.figures.length && !shareFigure) return null;
  const small = Math.min(a.content.size, b.content.size);
  if (small >= 4) {
    let overlap = 0;
    for (const w of a.content) if (b.content.has(w)) overlap++;
    if (overlap >= 3 && overlap / small >= CONTAINMENT_THRESHOLD) return "containment";
  }
  return isNearDuplicate(a.tokens, b.tokens) ? "jaccard" : null;
}

/**
 * How far a source can be trusted as the canonical copy of a story. An
 * official .gov.sa publisher ranks first, then a publisher's own feed or an X
 * account, then Google News (a re-listing of someone else's article).
 */
export function authority(t: Pick<NormalisedTweet, "url" | "authorHandle">): number {
  if (/(^|\.)gov\.sa$/i.test(t.authorHandle ?? "")) return 3;
  try {
    return new URL(t.url).hostname === "news.google.com" ? 1 : 2;
  } catch {
    return 2;
  }
}

export interface DedupeResult {
  kept: NormalisedTweet[];
  /** Same id seen twice in this batch, or already stored. */
  exactDuplicates: NormalisedTweet[];
  /** The same story as a kept item or a recently stored one. `rule` says why. */
  nearDuplicates: Array<{ tweet: NormalisedTweet; duplicateOf: string; rule: StoryRule }>;
}

/**
 * @param existingIds ids already in `news_items`.
 * @param recentTexts items stored in the last 72 h (published or hidden). New
 *   items are compared with these canonical copies first.
 */
export function dedupeTweets(
  tweets: NormalisedTweet[],
  existingIds: ReadonlySet<string> = new Set(),
  recentTexts: ReadonlyArray<{ id: string; text: string }> = [],
): DedupeResult {
  const exactDuplicates: NormalisedTweet[] = [];
  const nearDuplicates: DedupeResult["nearDuplicates"] = [];
  const seen = new Set<string>();

  // Canonical first: the most authoritative, then the earliest (usually the original).
  const ordered = [...tweets].sort((a, b) =>
    authority(b) - authority(a) || (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));

  // Single-link clusters: a duplicate's own key joins the pool under its
  // canonical id, so a third wording that only resembles the duplicate (not
  // the canonical copy) still lands in the same story.
  const pool: Array<{ key: StoryKey; canonical: string }> =
    recentTexts.map((r) => ({ key: storyKey(r.id, r.text), canonical: r.id }));
  const kept: NormalisedTweet[] = [];

  for (const t of ordered) {
    if (existingIds.has(t.id) || seen.has(t.id)) {
      exactDuplicates.push(t);
      continue;
    }
    seen.add(t.id);
    const key = storyKey(t.id, t.text);
    let match: { id: string; rule: StoryRule } | null = null;
    for (const p of pool) {
      const rule = sameStory(key, p.key);
      if (rule) {
        match = { id: p.canonical, rule };
        break;
      }
    }
    if (match) {
      nearDuplicates.push({ tweet: t, duplicateOf: match.id, rule: match.rule });
      pool.push({ key, canonical: match.id });
      continue;
    }
    pool.push({ key, canonical: t.id });
    kept.push(t);
  }
  return { kept, exactDuplicates, nearDuplicates };
}
