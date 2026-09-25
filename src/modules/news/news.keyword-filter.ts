import type { AiVerdict, ParsedAiOutput } from "./news.ai";
import {
  BLOCK_RE_SOURCES, DATA_RE_SOURCE, FOREIGN_GEO, LEX_CATEGORIES, LEX_CATEGORY_ORDER, LEX_SCORING, NEGATIVE,
  PAGE_RE_SOURCE, SAUDI_GEO, TITLE_PREFIX_RE, type LexTerm,
} from "./news.lexicon";
import { compilePyRegex, compileTerm, normaliseForMatch } from "./news.text";
import type { NewsCategory, NormalisedTweet } from "./news.types";
import { detectLang } from "./providers/html-text";

/**
 * The free filter: a deterministic keyword score instead of a Claude call.
 *
 * A 1:1 port of the business spec's reference scorer (lexicon.md §3, `kw.py`);
 * its worked examples are the unit-test fixtures. Same output as the AI
 * (`AiVerdict`), so the runner, the guard and the min_score rule treat both
 * alike. It does not write: the title is the publisher's own headline and the
 * summary the first ~220 characters of the cleaned description, both in the
 * language they were written in (the other language stays empty → NULL).
 */
export const KEYWORD_TITLE_MAX = 200;
export const KEYWORD_SUMMARY_MAX = 220;
const S = LEX_SCORING;

// ── compiled once, at module load ──────────────────────────────────────────
interface CTerm { re: RegExp; t: string; w: number; tag: string | null; sa: boolean; cat: NewsCategory }
const CTERMS: CTerm[] = LEX_CATEGORY_ORDER.flatMap((cat) =>
  (LEX_CATEGORIES[cat] ?? []).map((x: LexTerm) => ({ re: compileTerm(x.t), t: x.t, w: x.w, tag: x.tag ?? null, sa: !!x.sa, cat })));
const SAUDI_P = SAUDI_GEO.map(compileTerm);
const FOREIGN_P = FOREIGN_GEO.map((t) => ({ re: compileTerm(t), t }));
const NEG_P = NEGATIVE.map(([t, w]) => ({ re: compileTerm(t), t, w }));
const BLOCK_P = BLOCK_RE_SOURCES.map((src) => ({ re: compilePyRegex(src), src }));
const DATA_P = compilePyRegex(DATA_RE_SOURCE);
const PAGE_P = compilePyRegex(PAGE_RE_SOURCE);

/** Round half to even — Python's round(), which the reference scores used. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Google News " - Publisher" suffix and wire-service «عام / » prefixes off a headline. */
export function cleanTitle(title: string, source?: string | null): string {
  let t = title ?? "";
  if (source && t.endsWith(` - ${source}`)) t = t.slice(0, -` - ${source}`.length);
  return t.replace(TITLE_PREFIX_RE, "");
}

export interface KeywordScore {
  score: number;
  category: NewsCategory;
  tags: string[];
  reason: string;
  /** Terms kept after the overlap dedupe, heaviest first. */
  matched: string[];
}

/**
 * Pure scoring (lexicon.md §3). `title` raw or cleaned; `desc` is plain text
 * (only its first 400 characters count, as in the reference); `source` = the
 * Google News publisher, to strip its suffix.
 */
export function scoreKeywords(title: string, desc = "", source?: string | null): KeywordScore {
  const T = normaliseForMatch(cleanTitle(title, source));
  const D = normaliseForMatch((desc ?? "").slice(0, S.descMaxChars));
  const none = (reason: string): KeywordScore => ({ score: 0, category: "other", tags: [], reason, matched: [] });

  if (PAGE_P.test(T)) return none("blocked: index page");
  for (const b of BLOCK_P) if (b.re.test(T) || (D && b.re.test(D))) return none(`blocked: ${b.src}`);

  // First match per term: title at full weight, else description at half.
  type Hit = { w: number; term: CTerm; field: "T" | "D"; a: number; b: number };
  const hits: Hit[] = [];
  for (const term of CTERMS) {
    let m = term.re.exec(T);
    if (m) {
      hits.push({ w: term.w, term, field: "T", a: m.index, b: m.index + m[0].length });
      continue;
    }
    m = D ? term.re.exec(D) : null;
    if (m) hits.push({ w: term.w * S.descFactor, term, field: "D", a: m.index, b: m.index + m[0].length });
  }
  // Heaviest first (stable); drop a hit overlapping an already-kept one in the same field.
  hits.sort((x, y) => y.w - x.w);
  const kept: Hit[] = [];
  for (const h of hits) {
    if (kept.some((k) => k.field === h.field && h.a < k.b && k.a < h.b)) continue;
    kept.push(h);
  }

  const catSum = new Map<NewsCategory, number>(LEX_CATEGORY_ORDER.map((c) => [c, 0]));
  const tags: string[] = [];
  let saudiEntity = false;
  for (const h of kept) {
    catSum.set(h.term.cat, (catSum.get(h.term.cat) ?? 0) + h.w);
    if (h.term.tag && !tags.includes(h.term.tag)) tags.push(h.term.tag);
    if (h.term.sa) saudiEntity = true;
  }
  const P = kept.reduce((sum, h, i) => sum + h.w * (i < S.dim.length ? S.dim[i] : S.dimRest), 0);

  const both = `${T} ${D}`;
  const saudi = saudiEntity || SAUDI_P.some((re) => re.test(both));
  const foreign = FOREIGN_P.filter((f) => f.re.test(T)).map((f) => f.t);
  const G = foreign.length && !saudi ? S.foreignPenalty : saudi ? S.saudiBonus : S.noGeoPenalty;
  const data = DATA_P.test(T) ? S.dataBonus : 0;

  let N = 0;
  const negs: string[] = [];
  for (const n of NEG_P) {
    if (n.re.test(T) || (D && n.re.test(D))) {
      N += n.w;
      negs.push(n.t);
    }
  }
  if (T.split(" ").filter(Boolean).length < S.shortTitleWords) {
    N += S.shortTitlePenalty;
    negs.push("<4 words");
  }

  const score = kept.length ? Math.max(0, Math.min(100, pyRound(P + G + data - N))) : 0;
  let category: NewsCategory = "other";
  if (kept.length) {
    let best = -Infinity;
    for (const c of LEX_CATEGORY_ORDER) {
      const v = catSum.get(c) ?? 0;
      if (v > best) {
        best = v;
        category = c;
      }
    }
  }
  const matched = kept.map((h) => h.term.t);
  const reason = `matched: ${matched.slice(0, 5).join(", ")}`
    + (negs.length ? ` | neg: ${negs.join(", ")}` : "")
    + (foreign.length && !saudi ? ` | foreign: ${foreign.join(",")}` : "");
  return { score, category, tags: tags.slice(0, 5), reason, matched };
}

/** Cut at a word boundary and mark the cut. */
export function clip(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s،,.:;–—-]+$/, "")}…`;
}

/** Headline + body. RSS keeps them apart; X posts / stored rows split at the first blank line. */
export function splitTitle(t: Pick<NormalisedTweet, "text" | "title" | "summary">): { title: string; body: string } {
  if (t.title != null || t.summary != null) return { title: (t.title ?? "").trim(), body: (t.summary ?? "").trim() };
  const text = (t.text ?? "").trim();
  const i = text.indexOf("\n\n");
  if (i > 0) return { title: text.slice(0, i).trim(), body: text.slice(i + 2).trim() };
  return { title: text, body: "" };
}

/** One item → the same verdict shape the AI produces. */
export function keywordVerdict(t: NormalisedTweet): AiVerdict {
  const { title: rawTitle, body } = splitTitle(t);
  const title = cleanTitle(rawTitle).trim();
  const k = scoreKeywords(title, body);
  const headline = clip(title || body, KEYWORD_TITLE_MAX);
  const summary = body ? clip(body, KEYWORD_SUMMARY_MAX) : "";
  const lang = detectLang(title || body) ?? (t.lang === "en" ? "en" : "ar");
  return {
    relevant: k.score >= S.relevantMin,
    score: k.score,
    category: k.category,
    titleAr: lang === "ar" ? headline : "",
    titleEn: lang === "en" ? headline : "",
    summaryAr: lang === "ar" ? summary : "",
    summaryEn: lang === "en" ? summary : "",
    tags: k.tags,
    reason: `keyword ${k.score}: ${k.reason}`.slice(0, 500),
    duplicateOf: null,
    // The headline is the publisher's own, not a fallback: it may auto-publish.
    titleFallback: !headline,
  };
}

/** Drop-in for NewsAiFilter.classify — never throws, costs nothing. */
export class KeywordFilter {
  async classify(batch: ReadonlyArray<NormalisedTweet>): Promise<ParsedAiOutput & { usage: { input: number; output: number } }> {
    const verdicts = new Map<string, AiVerdict>();
    for (const t of batch) verdicts.set(t.id, keywordVerdict(t));
    return { verdicts, missing: [], problems: [], usage: { input: 0, output: 0 } };
  }
}
