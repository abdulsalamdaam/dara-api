import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiTruncatedError, type AiVerdict } from "./news.ai";
import { capQueue, processAiQueue, type BatchHandlers } from "./news.batches";
import { readMaxAiItems, readNewsConfig, DEFAULT_MAX_AI_ITEMS } from "./news.config";
import type { NormalisedTweet } from "./news.types";

const tweet = (id: string): NormalisedTweet => ({
  id, url: "", text: `post ${id}`, lang: "en", postedAt: null, authorHandle: "a", authorName: null,
  authorAvatarUrl: null, media: [], metrics: { likes: 0, retweets: 0, replies: 0, views: null },
});
const tweets = (n: number) => Array.from({ length: n }, (_, i) => tweet(String(i + 1)));
const verdict = { relevant: true, score: 80, category: "market" } as AiVerdict;

function harness(classify: BatchHandlers["classify"]) {
  const calls: string[][] = [];
  const results: string[][] = [];
  const failures: Array<{ ids: string[]; attempted: boolean }> = [];
  const logs: string[] = [];
  const h: BatchHandlers = {
    classify: async (b) => { calls.push(b.map((t) => t.id)); return classify(b); },
    onResult: async (b) => { results.push(b.map((t) => t.id)); },
    onFailure: async (ids, _r, attempted) => { failures.push({ ids, attempted }); },
    log: (_l, m) => logs.push(m),
  };
  return { h, calls, results, failures, logs };
}
const ok: BatchHandlers["classify"] = async (b) => ({
  verdicts: new Map(b.map((t) => [t.id, verdict])), missing: [], problems: [], usage: { input: 1, output: 1 },
});

describe("processAiQueue", () => {
  it("sends the queue in batches", async () => {
    const x = harness(ok);
    const s = await processAiQueue(tweets(25), x.h, { batchSize: 10 });
    assert.deepEqual(x.calls.map((c) => c.length), [10, 10, 5]);
    assert.equal(s.calls, 3);
    assert.equal(x.failures.length, 0);
  });

  it("splits a truncated batch in half and tries each half once", async () => {
    const x = harness(async (b) => { if (b.length > 5) throw new AiTruncatedError(b.length); return ok(b); });
    const s = await processAiQueue(tweets(10), x.h, { batchSize: 10 });
    assert.deepEqual(x.calls.map((c) => c.length), [10, 5, 5]);
    assert.deepEqual(x.results.flat().sort(), tweets(10).map((t) => t.id).sort());
    assert.equal(s.splits, 1);
    assert.equal(x.failures.length, 0);
  });

  it("does not split a half again: a truncated half fails as one attempt", async () => {
    const x = harness(async (b) => { throw new AiTruncatedError(b.length); });
    const s = await processAiQueue(tweets(10), x.h, { batchSize: 10, maxConsecutiveFailures: 5 });
    assert.deepEqual(x.calls.map((c) => c.length), [10, 5, 5]);
    assert.equal(s.splits, 1);
    assert.deepEqual(x.failures.map((f) => [f.ids.length, f.attempted]), [[5, true], [5, true]]);
  });

  it("stops calling after repeated failures; the rest are not counted as attempts", async () => {
    const x = harness(async () => { throw new Error("boom"); });
    const s = await processAiQueue(tweets(40), x.h, { batchSize: 10, maxConsecutiveFailures: 2 });
    assert.equal(x.calls.length, 2);
    assert.equal(s.notAttempted, 20);
    assert.deepEqual(x.failures.map((f) => f.attempted), [true, true, false, false]);
  });
});

describe("per-run AI cap", () => {
  it("caps the queue and defers the rest", () => {
    const { send, deferred } = capQueue(tweets(7), 5);
    assert.equal(send.length, 5);
    assert.deepEqual(deferred.map((t) => t.id), ["6", "7"]);
  });

  it("reads NEWS_MAX_AI_ITEMS_PER_RUN with a sane default", () => {
    assert.equal(readMaxAiItems(undefined), DEFAULT_MAX_AI_ITEMS);
    assert.equal(readMaxAiItems("40"), 40);
    assert.equal(readMaxAiItems("0"), DEFAULT_MAX_AI_ITEMS);
    assert.equal(readMaxAiItems("-3"), DEFAULT_MAX_AI_ITEMS);
    assert.equal(readMaxAiItems("abc"), DEFAULT_MAX_AI_ITEMS);
    assert.equal(readMaxAiItems("999999"), 2000);
    assert.equal(readNewsConfig({ NEWS_MAX_AI_ITEMS_PER_RUN: "25" }).maxAiItemsPerRun, 25);
  });
});
