import { decideStatus, type AiVerdict } from "./news.ai";
import { authority, sameStory, storyKey, type StoryKey } from "./news.dedupe";
import { detectManipulation, heldReason } from "./news.guard";
import { keywordVerdict } from "./news.keyword-filter";
import type { NewsCategory, NewsItemStatus } from "./news.types";

/**
 * Re-score: run the CURRENT keyword filter again over recent items it judged
 * before, so a lexicon change reaches stored items (QA v2 open issue 2).
 *
 * Pure planning — the controller loads the rows and writes the plan (or, on a
 * dry run, only returns it). The rules:
 *   - only items the keyword filter judged (`filter_kind = 'keyword'`), never
 *     one an admin moderated (`moderated_at` set) or pinned — the caller's
 *     query excludes those, and the write re-checks it;
 *   - the verdict → status rule is the runner's: `decideStatus` at the
 *     schedule's `min_score`, then the untrusted-post guard (held = hidden);
 *   - story dedupe, as in a run: an item that would newly publish is checked
 *     against what is already on the feed and against the other items this
 *     re-score publishes. A match is kept `hidden` as "duplicate of <id>", so
 *     a story rescued by the new lexicon from two outlets shows once. The
 *     canonical copy is the most authoritative, then the earliest.
 */

export const RESCORE_DEFAULT_DAYS = 14;
export const RESCORE_MAX_DAYS = 60;

/** A stored item the re-score may change. */
export interface RescoreRow {
  id: string;
  externalId: string;
  text: string;
  url: string | null;
  authorHandle: string | null;
  lang: string | null;
  postedAt: Date | null;
  createdAt: Date;
  status: string;
  aiScore: number | null;
  aiCategory: string | null;
  aiReason: string | null;
}

/** An item already on the feed that is not being re-scored (moderated, pinned, Claude-judged, or older). */
export interface FeedRow {
  externalId: string;
  text: string;
}

export interface RescoreUpdate {
  id: string;
  status: NewsItemStatus;
  aiRelevant: boolean;
  aiScore: number;
  aiCategory: NewsCategory;
  aiTitleAr: string | null;
  aiTitleEn: string | null;
  aiSummaryAr: string | null;
  aiSummaryEn: string | null;
  aiTags: string[];
  aiReason: string;
}

export interface RescoreChange {
  id: string;
  title: string;
  from: string;
  to: NewsItemStatus;
  oldScore: number | null;
  newScore: number;
  /** Set when the item would publish but is the same story as one on the feed. */
  duplicateOf: string | null;
  reason: string;
}

export interface RescorePlan {
  checked: number;
  newlyPublished: number;
  newlyRejected: number;
  /** Would publish, but the story is already on the feed: kept hidden. */
  duplicates: number;
  /** Held by the untrusted-post guard. */
  held: number;
  /** Status changes only, newest verdicts first by score. */
  changes: RescoreChange[];
  /** Every row whose stored verdict differs from the new one (status or not). */
  updates: RescoreUpdate[];
}

function headline(v: AiVerdict, text: string): string {
  return v.titleAr || v.titleEn || (text ?? "").split("\n")[0].slice(0, 200);
}

export function planRescore(rows: ReadonlyArray<RescoreRow>, feed: ReadonlyArray<FeedRow>, minScore: number): RescorePlan {
  type Judged = { row: RescoreRow; v: AiVerdict; status: NewsItemStatus; reason: string; duplicateOf: string | null };
  const judged: Judged[] = rows.map((row) => {
    const v = keywordVerdict({
      id: row.externalId, url: row.url ?? "", text: row.text, lang: row.lang,
      postedAt: row.postedAt?.toISOString() ?? null, authorHandle: row.authorHandle ?? "",
      authorName: null, authorAvatarUrl: null, media: [], metrics: null,
    });
    let status: NewsItemStatus = decideStatus(v, minScore);
    let reason = v.reason;
    const held = detectManipulation(row.text);
    if (held) {
      status = "hidden";
      reason = heldReason(held, v.reason);
    }
    return { row, v, status, reason, duplicateOf: null };
  });

  // The feed as it will stand: published items outside the re-score, plus
  // re-scored items that were published and stay published.
  const pool: Array<{ key: StoryKey; canonical: string }> = feed.map((f) => ({ key: storyKey(f.externalId, f.text), canonical: f.externalId }));
  for (const j of judged) {
    if (j.row.status === "published" && j.status === "published") {
      pool.push({ key: storyKey(j.row.externalId, j.row.text), canonical: j.row.externalId });
    }
  }
  const incoming = judged
    .filter((j) => j.status === "published" && j.row.status !== "published")
    .sort((a, b) =>
      authority({ url: b.row.url ?? "", authorHandle: b.row.authorHandle ?? "" })
        - authority({ url: a.row.url ?? "", authorHandle: a.row.authorHandle ?? "" })
      || (a.row.postedAt?.getTime() ?? a.row.createdAt.getTime()) - (b.row.postedAt?.getTime() ?? b.row.createdAt.getTime()));
  for (const j of incoming) {
    const key = storyKey(j.row.externalId, j.row.text);
    const hit = pool.find((p) => sameStory(key, p.key));
    if (hit) {
      j.status = "hidden";
      j.duplicateOf = hit.canonical;
      j.reason = `duplicate of ${hit.canonical}`;
      pool.push({ key, canonical: hit.canonical });
    } else {
      pool.push({ key, canonical: j.row.externalId });
    }
  }

  const plan: RescorePlan = { checked: rows.length, newlyPublished: 0, newlyRejected: 0, duplicates: 0, held: 0, changes: [], updates: [] };
  for (const j of judged) {
    const { row, v, status } = j;
    const changed = status !== row.status;
    if (changed) {
      if (status === "published") plan.newlyPublished++;
      else if (status === "rejected") plan.newlyRejected++;
      else if (j.duplicateOf) plan.duplicates++;
      else plan.held++;
      plan.changes.push({
        id: row.id, title: headline(v, row.text), from: row.status, to: status,
        oldScore: row.aiScore, newScore: v.score, duplicateOf: j.duplicateOf, reason: j.reason,
      });
    }
    if (changed || v.score !== row.aiScore || v.category !== row.aiCategory || j.reason !== row.aiReason) {
      plan.updates.push({
        id: row.id, status,
        // A stored duplicate is "not relevant" like the runner's near-duplicates.
        aiRelevant: j.duplicateOf ? false : v.relevant,
        aiScore: v.score, aiCategory: v.category,
        aiTitleAr: v.titleAr || null, aiTitleEn: v.titleEn || null,
        aiSummaryAr: v.summaryAr || null, aiSummaryEn: v.summaryEn || null,
        aiTags: v.tags, aiReason: j.reason,
      });
    }
  }
  plan.changes.sort((a, b) => b.newScore - a.newScore);
  return plan;
}
