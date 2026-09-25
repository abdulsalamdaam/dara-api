import { AI_BATCH_SIZE, AiTruncatedError, describeAiError, type ParsedAiOutput } from "./news.ai";
import type { NormalisedTweet } from "./news.types";

/**
 * How the runner feeds its queue to the AI, kept free of the database so the
 * spend rules can be tested on their own:
 *
 *  - at most `maxItems` posts go to the AI per run; the rest stay hidden and
 *    unjudged, and the next run picks them up (without counting an attempt);
 *  - a batch cut off at `max_tokens` is split in half and each half tried once
 *    — never the same batch again, which would fail and bill the same way;
 *  - after `maxConsecutiveFailures` failed calls the remaining batches are not
 *    sent at all this run.
 *
 * Every post the AI was actually asked about and gave nothing usable for is
 * reported through `onFailure(..., attempted = true)`; the caller counts that
 * as one attempt and gives the post up after AI_MAX_ATTEMPTS.
 */

/** A post the AI failed on this many times is given up: left hidden, never retried. */
export const AI_MAX_ATTEMPTS = 3;
export const AI_MAX_CONSECUTIVE_FAILURES = 2;

export function capQueue<T>(queue: readonly T[], maxItems: number): { send: T[]; deferred: T[] } {
  const n = Math.max(0, Math.floor(maxItems));
  return { send: queue.slice(0, n), deferred: queue.slice(n) };
}

export interface BatchHandlers {
  classify(batch: NormalisedTweet[]): Promise<ParsedAiOutput & { usage: { input: number; output: number } }>;
  onResult(batch: NormalisedTweet[], out: ParsedAiOutput & { usage: { input: number; output: number } }, label: string): Promise<void>;
  /** `attempted` = the AI was called for these posts (counts toward AI_MAX_ATTEMPTS). */
  onFailure(ids: string[], reason: string, attempted: boolean): Promise<void>;
  log(level: "info" | "warn" | "error", message: string): void;
  /** After every batch (progress flush). */
  afterBatch?(): Promise<void>;
}

export interface BatchSummary {
  calls: number;
  failedCalls: number;
  splits: number;
  notAttempted: number;
}

export async function processAiQueue(
  queue: readonly NormalisedTweet[],
  h: BatchHandlers,
  opts: { batchSize?: number; maxConsecutiveFailures?: number } = {},
): Promise<BatchSummary> {
  const size = opts.batchSize ?? AI_BATCH_SIZE;
  const maxFail = opts.maxConsecutiveFailures ?? AI_MAX_CONSECUTIVE_FAILURES;
  const work: Array<{ items: NormalisedTweet[]; label: string; split: boolean }> = [];
  for (let i = 0; i < queue.length; i += size) {
    work.push({ items: queue.slice(i, i + size), label: String(i / size + 1), split: false });
  }
  const s: BatchSummary = { calls: 0, failedCalls: 0, splits: 0, notAttempted: 0 };
  let consecutiveFailures = 0;

  while (work.length) {
    const b = work.shift()!;
    const ids = b.items.map((t) => t.id);
    if (consecutiveFailures >= maxFail) {
      s.notAttempted += ids.length;
      h.log("error", `AI skipped for ${ids.length} item(s) after repeated failures — kept hidden, will retry next run`);
      await h.onFailure(ids, "AI not attempted after repeated failures; will retry next run", false);
      continue;
    }
    s.calls++;
    try {
      const out = await h.classify(b.items);
      consecutiveFailures = 0;
      await h.onResult(b.items, out, b.label);
    } catch (err) {
      if (err instanceof AiTruncatedError && b.items.length > 1 && !b.split) {
        // Not a failure of the service: the answer was too long. Two halves,
        // each tried once, at the front of the queue.
        s.splits++;
        const mid = Math.ceil(b.items.length / 2);
        h.log("warn", `AI batch ${b.label} truncated at max_tokens — retrying as two halves of ${mid} and ${b.items.length - mid}`);
        work.unshift(
          { items: b.items.slice(0, mid), label: `${b.label}a`, split: true },
          { items: b.items.slice(mid), label: `${b.label}b`, split: true },
        );
        continue;
      }
      s.failedCalls++;
      consecutiveFailures++;
      const msg = describeAiError(err);
      h.log("error", `${msg} — ${ids.length} item(s) kept hidden`);
      await h.onFailure(ids, `AI failed: ${msg}`, true);
    }
    await h.afterBatch?.();
  }
  return s;
}
