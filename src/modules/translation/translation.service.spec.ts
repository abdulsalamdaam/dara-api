import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PgDialect } from "drizzle-orm/pg-core";

import {
  TranslationService, itemDescriptionFields, itemDescriptionField, normalizeSource, translationKey,
} from "./translation.service";

/**
 * Nothing in this file goes near OpenAI or a database. `fetch` is stubbed and
 * asserted on, and the "database" is a recorder — because the three properties
 * worth pinning are all about calls that must NOT happen:
 *
 *   · no API key configured (which is the state production is in right now)
 *     must be a silent no-op, never a throw and never a broken save;
 *   · an unchanged source must never be paid for twice;
 *   · a string with no language must never reach the provider at all.
 *
 * A test that actually called OpenAI would prove none of them and cost money
 * to run.
 */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The smallest thing that answers the Drizzle chains this service builds.
 *
 * `where()` receives an opaque SQL object it cannot usefully interpret, so
 * SELECT results are seeded per test and writes are recorded rather than
 * applied. That is enough: every assertion here is about which calls were made,
 * not about what a real Postgres would return.
 */
function fakeDb(selectRows: any[] = []) {
  const ops = { selects: 0, deletes: 0, upserts: [] as any[], statements: [] as string[] };
  const done = (value: any) => ({ then: (res: any, rej: any) => Promise.resolve(value).then(res, rej) });
  const dialect = new PgDialect();
  return {
    ops,
    rows: selectRows,
    select: () => ({ from: () => ({ where: () => { ops.selects += 1; return done(selectRows); } }) }),
    delete: () => ({ where: () => { ops.deletes += 1; return done(undefined); } }),
    insert: () => ({
      values: (v: any) => ({ onConflictDoUpdate: () => { ops.upserts.push(v); return done(undefined); } }),
    }),
    // The sweep's statements cannot be RUN here (the only reachable database is
    // production), so they are rendered and read — the same trick as
    // `key-access.spec.ts`. A raw fragment that does not parse would otherwise
    // fail in production or not at all.
    execute: async (q: any) => { ops.statements.push(dialect.sqlToQuery(q).sql); return []; },
  };
}

/** Every `fetch` the code under test made, so "was the provider called" is a real assertion. */
let calls: Array<{ url: string; init: any }> = [];
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
const realModel = process.env.OPENAI_MODEL;

function stubFetch(reply: { ok: boolean; status?: number; body?: any; text?: string }) {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.body,
      text: async () => reply.text ?? "",
    } as any;
  }) as any;
}

/** A well-formed chat-completions reply carrying one translation. */
const replyWith = (text: string) => ({ ok: true, body: { choices: [{ message: { content: text } }] } });

beforeEach(() => {
  calls = [];
  // Anything left set by the real environment would silently turn these into
  // live calls, which is the one thing this file must never do.
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  globalThis.fetch = (async () => {
    throw new Error("a test made a real network call — stub fetch first");
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  if (realModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = realModel;
});

describe("TranslationService — with no OPENAI_API_KEY", () => {
  /**
   * The state the production containers are in today. A key is not configured
   * and may not be for some time, so "no key" is a supported mode, not an
   * outage: every save must still work and every read must still answer.
   */
  it("translate() returns null instead of throwing, and calls nothing", async () => {
    const svc = new TranslationService(fakeDb() as never);
    assert.equal(svc.isConfigured(), false);
    assert.equal(await svc.translate("إيجار شهر مارس", "ar", "en"), null);
    assert.equal(calls.length, 0, "no provider call may be attempted without a key");
  });

  it("ensureTranslation() records the source and stops — no call, no throw", async () => {
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    const outcome = await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(outcome, "pending");
    assert.equal(calls.length, 0);
    // The source language and hash ARE written even with no key. That is what
    // makes configuring one later a single sweep rather than a re-save of every
    // invoice in the database.
    assert.equal(db.ops.upserts.length, 1);
    assert.equal(db.ops.upserts[0].status, "pending");
    assert.equal(db.ops.upserts[0].sourceLang, "ar");
    assert.equal(db.ops.upserts[0].lang, "en");
    assert.equal(db.ops.upserts[0].sourceHash, sha256("إيجار شهر مارس"));
  });

  it("queue() returns synchronously and swallows a database that is broken", async () => {
    // The whole point of the write path: a save must not slow down, and must
    // certainly not 500, because translation storage is unavailable.
    const broken = {
      select: () => ({ from: () => ({ where: () => { throw new Error("relation \"translations\" does not exist"); } }) }),
    };
    const svc = new TranslationService(broken as never);
    assert.equal(svc.queue("simple_invoices", 5, { notes: "شكراً" }), undefined);
    // Let the fire-and-forget work settle, then confirm nothing escaped.
    await new Promise((r) => setImmediate(r));
    assert.equal(await svc.ensureTranslation("simple_invoices", 5, "notes", "شكراً"), "error");
  });
});

describe("TranslationService — cost control", () => {
  it("never asks the provider twice for the same source text", async () => {
    // The single most important property here. Without the hash check, every
    // read, save and sweep of an unchanged invoice would be a fresh bill.
    const text = "إيجار شهر مارس";
    const db = fakeDb([
      { id: 1, entityType: "invoice_lines", entityId: 12, field: "name", lang: "en",
        sourceLang: "ar", sourceHash: sha256(text), text: "March rent", status: "done" },
    ]);
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));

    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", text), "cached");
    assert.equal(calls.length, 0, "an unchanged source must cost nothing");
    assert.equal(db.ops.upserts.length, 0, "and must not even rewrite the row");
  });

  it("ignores leading and trailing whitespace when deciding the source changed", async () => {
    // The web sends what the user typed; a trailing space is not an edit.
    const db = fakeDb([
      { id: 1, entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("إيجار"), text: "Rent", status: "done" },
    ]);
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("Rent"));
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "  إيجار \n"), "cached");
    assert.equal(calls.length, 0);
  });

  it("drops the stale row and re-translates when the text really did change", async () => {
    // A translation that outlives its source is the dangerous failure: it does
    // not look broken, it looks like a different line item.
    const db = fakeDb([
      { id: 1, entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("إيجار مارس"), text: "March rent", status: "done" },
    ]);
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("April rent"));

    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار أبريل"), "done");
    assert.equal(db.ops.deletes, 1, "the row for the old text must be deleted, not left behind");
    assert.equal(calls.length, 1);
    assert.equal(db.ops.upserts.at(-1).text, "April rent");
    assert.equal(db.ops.upserts.at(-1).status, "done");
  });
});

describe("TranslationService — nothing worth translating", () => {
  /**
   * `detectLanguage` returning null has to be a hard stop, not a hint. These
   * are the values that appear on the majority of invoice lines, so sending
   * them would dominate the bill while producing nothing a reader could use.
   */
  for (const text of ["2", "SAR 1,200", "—", "", "   ", "١٢٣", "👍"]) {
    it(`never calls the provider for ${JSON.stringify(text)}`, async () => {
      const db = fakeDb([]);
      process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
      stubFetch(replyWith("should never be used"));

      const svc = new TranslationService(db as never);
      assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", text), "skipped");
      assert.equal(calls.length, 0);
      // Recorded as settled rather than left absent, so the sweep does not
      // re-examine the same untranslatable line on every run for ever.
      assert.equal(db.ops.upserts.length, 1);
      assert.equal(db.ops.upserts[0].status, "skipped");
      assert.equal(db.ops.upserts[0].lang, "und");
    });
  }

  it("never calls the provider for a non-string value out of jsonb", async () => {
    const db = fakeDb([]);
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("should never be used"));
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("simple_invoices", 3, "notes", null), "skipped");
    assert.equal(await svc.ensureTranslation("simple_invoices", 3, "notes", 1200 as never), "skipped");
    assert.equal(calls.length, 0);
  });
});

describe("TranslationService — the provider call", () => {
  it("sends the field's text and nothing else", async () => {
    // Redaction, asserted rather than asserted-in-a-comment. What leaves the
    // process is one user-typed value; the invoice number, the parties, the
    // amounts and the account id are not in the request and must not become so.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    const svc = new TranslationService(fakeDb([]) as never);
    await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.equal(body.messages[1].content, "إيجار شهر مارس");
    // The entity it came from is used to key the ROW, never to build the prompt.
    assert.ok(!calls[0].init.body.includes("invoice_lines"));
    assert.ok(!calls[0].init.body.includes("\"12\""));
  });

  it("pins temperature to zero so the same line never reworks itself", async () => {
    // The answer is cached under a hash; a second sampling of the same source
    // would be a different string for no reason and the wording would appear to
    // change under the user.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    const svc = new TranslationService(fakeDb([]) as never);
    await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(JSON.parse(calls[0].init.body).temperature, 0);
  });

  it("defaults to a small model and honours OPENAI_MODEL", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    let svc = new TranslationService(fakeDb([]) as never);
    await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(JSON.parse(calls[0].init.body).model, "gpt-4o-mini");

    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    svc = new TranslationService(fakeDb([]) as never);
    await svc.ensureTranslation("invoice_lines", 13, "name", "إيجار شهر أبريل");
    assert.equal(JSON.parse(calls[1].init.body).model, "gpt-4.1-mini");
  });

  it("carries a timeout, because Node's fetch has none", async () => {
    // Without this a hung provider holds the socket for undici's 300 seconds,
    // and in the sweep it holds the admin's request open with it.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    const svc = new TranslationService(fakeDb([]) as never);
    await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.ok(calls[0].init.signal, "an AbortSignal.timeout must be attached");
  });

  it("translates the other way round for English source text", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("إيجار شهر مارس"));
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    await svc.ensureTranslation("invoice_lines", 12, "name", "Rent for March");
    assert.equal(db.ops.upserts.at(-1).sourceLang, "en");
    assert.equal(db.ops.upserts.at(-1).lang, "ar");
    assert.equal(db.ops.upserts.at(-1).text, "إيجار شهر مارس");
  });

  it("strips quotes a model wraps a short answer in", async () => {
    // Models do this often enough that the quotes would be printed on invoices.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith('"March rent"'));
    const db = fakeDb([]);
    await new TranslationService(db as never).ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(db.ops.upserts.at(-1).text, "March rent");
  });
});

describe("TranslationService — a provider that is down", () => {
  /**
   * An OpenAI outage must never turn a working save into a 500. It leaves a
   * `failed` row with the reason, which the next sweep retries — the same
   * discipline as `safeLog` in `ejar.client.service.ts`.
   */
  it("records the failure and returns rather than throwing, on a non-2xx", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch({ ok: false, status: 429, text: "rate limited" });
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "failed");
    assert.equal(db.ops.upserts.at(-1).status, "failed");
    assert.match(db.ops.upserts.at(-1).error, /429/);
  });

  it("does the same when the connection itself throws", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    globalThis.fetch = (async () => { throw new Error("ETIMEDOUT"); }) as any;
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "failed");
    assert.match(db.ops.upserts.at(-1).error, /ETIMEDOUT/);
  });

  it("treats an empty reply as a failure rather than storing a blank line item", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("   "));
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "failed");
  });
});

describe("the shape a UI reads", () => {
  it("keys entries as entity_type:id:field", () => {
    assert.equal(translationKey("invoice_lines", 12, "name"), "invoice_lines:12:name");
    assert.equal(
      translationKey("simple_invoices", 7, "items.0.description"),
      "simple_invoices:7:items.0.description",
    );
  });

  it("getFor returns a finished translation, keyed, sided, and with the original alongside", async () => {
    const ar = "إيجار شهر مارس";
    const en = "Maintenance";
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256(ar), text: "March rent", status: "done" },
      { entityId: 13, field: "name", lang: "ar", sourceLang: "en",
        sourceHash: sha256(en), text: "صيانة", status: "done" },
    ]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", {
      12: { name: ar },
      13: { name: en },
    });
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "ar", ar, en: "March rent" });
    assert.deepEqual(map["invoice_lines:13:name"], { sourceLang: "en", ar: "صيانة", en });
  });

  it("getFor refuses a translation whose source text has since been edited", async () => {
    // THE stale-read guard, and the reason `getFor` is handed the live text
    // rather than a list of ids. The prune in `ensureTranslation` is
    // fire-and-forget and swallows its errors, so it may simply not have run —
    // a container recycled mid-deploy is enough. If the read path trusted the
    // row, the old English would be served against the new Arabic for ever,
    // and it would LOOK right: a plausible line item that is not this one.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("إيجار مارس"), text: "March rent", status: "done" },
    ]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", {
      12: { name: "إيجار أبريل" },
    });
    // The original, and nothing on the other side — exactly the shape of a
    // field that has never been translated, which every caller already handles.
    assert.deepEqual(map["invoice_lines:12:name"], {
      sourceLang: "ar", ar: "إيجار أبريل", en: null,
    });
  });

  it("getFor drops a translation for a field that has since been emptied", async () => {
    // The other half of the same defect. `attachSource` returns early on blank
    // text, so a stored row used to survive a field being cleared and the API
    // went on serving a translation of text that is no longer anywhere.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("إيجار مارس"), text: "March rent", status: "done" },
    ]);
    const svc = new TranslationService(db as never);
    assert.deepEqual(await svc.getFor("invoice_lines", { 12: { name: "   " } }), {});
    assert.deepEqual(await svc.getFor("invoice_lines", { 12: { name: null } }), {});
    assert.equal(db.ops.selects, 0, "nothing to decorate is nothing to query");
  });

  it("getFor drops a translation whose language is no longer the source's", async () => {
    // A landlord who rewrites an Arabic line in English leaves a stored
    // "translation" of something else. Show the original until the queued
    // re-translation lands.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("Rent for April"), text: "March rent", status: "done" },
    ]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", {
      12: { name: "Rent for April" },
    });
    assert.deepEqual(map["invoice_lines:12:name"], {
      sourceLang: "en", ar: null, en: "Rent for April",
    });
  });

  it("getFor asks nothing and answers {} for an empty page", async () => {
    const db = fakeDb([]);
    assert.deepEqual(await new TranslationService(db as never).getFor("invoice_lines", {}), {});
    assert.equal(db.ops.selects, 0, "an empty page must not produce a query");
  });

  it("getFor still answers with the originals when the table is unreachable", async () => {
    // A read of this table must not be able to break the invoice it decorates.
    const broken = { select: () => ({ from: () => ({ where: () => { throw new Error("no such table"); } }) }) };
    const map = await new TranslationService(broken as never).getFor("invoice_lines", {
      12: { name: "Rent for March" },
    });
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "en", ar: null, en: "Rent for March" });
  });

  it("ignores whitespace on both sides of the hash comparison", async () => {
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar",
        sourceHash: sha256("إيجار"), text: "Rent", status: "done" },
    ]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", {
      12: { name: "  إيجار \n" },
    });
    assert.equal(map["invoice_lines:12:name"].en, "Rent", "a trailing space is not an edit");
  });

  it("attachSource fills the side the user typed with the original text", () => {
    const svc = new TranslationService(fakeDb([]) as never);
    const map = {};
    svc.attachSource(map, "invoice_lines", 12, "name", "Rent for March");
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "en", ar: null, en: "Rent for March" });
  });

  it("attachSource adds nothing for a value with no language", () => {
    const svc = new TranslationService(fakeDb([]) as never);
    const map = {};
    svc.attachSource(map, "invoice_lines", 12, "name", "SAR 1,200");
    svc.attachSource(map, "invoice_lines", 12, "name", null);
    assert.deepEqual(map, {});
  });

  it("attachHuman lets a human-written column beat a machine translation", async () => {
    // `invoice_lines.name_ar` is filled in by the seller and is what the PDF
    // prints. A model translation of the same line would be money spent to make
    // the PDF and the screen disagree.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "ar", sourceLang: "en",
        sourceHash: sha256("March rent"), text: "إيجار الشهر الثالث", status: "done" },
    ]);
    const svc = new TranslationService(db as never);
    const map = await svc.getFor("invoice_lines", { 12: { name: "March rent" } });
    svc.attachHuman(map, "invoice_lines", 12, "name", "ar", "إيجار شهر مارس");
    assert.deepEqual(map["invoice_lines:12:name"], {
      sourceLang: "en", ar: "إيجار شهر مارس", en: "March rent",
    });
  });

  it("attachHuman never overwrites the side the user actually typed", () => {
    const svc = new TranslationService(fakeDb([]) as never);
    const map = {};
    svc.attachSource(map, "invoice_lines", 12, "name", "إيجار شهر مارس");
    svc.attachHuman(map, "invoice_lines", 12, "name", "ar", "something else entirely");
    assert.equal(map["invoice_lines:12:name"].ar, "إيجار شهر مارس");
  });
});

describe("TranslationService — the retry ceiling", () => {
  /**
   * A `failed` row used to be asked again on every save and every sweep, for
   * ever, with no counter and no backoff. An outage became a standing order and
   * a refusal the model will never accept became a subscription.
   */
  const failedRow = (attempts: number) => ({
    id: 1, entityId: 12, field: "name", lang: "en", sourceLang: "ar",
    sourceHash: sha256("إيجار شهر مارس"), text: null, status: "failed", attempts,
  });

  it("stops calling the provider once the attempts are spent", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    const db = fakeDb([failedRow(3)]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "exhausted");
    assert.equal(calls.length, 0, "a refusal that repeated three times must stop costing money");
    assert.equal(db.ops.upserts.length, 0);
  });

  it("still retries while there are attempts left, and counts the attempt", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch({ ok: false, status: 503, text: "upstream down" });
    const db = fakeDb([failedRow(1)]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "failed");
    assert.equal(calls.length, 1);
    assert.equal(db.ops.upserts.at(-1).attempts, 2);
  });

  it("spends the whole budget at once on a refusal a retry cannot fix", async () => {
    // A 400 is the request being wrong, and it will be just as wrong next time.
    // A 429 is not — that one keeps its retries.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch({ ok: false, status: 400, text: "unsupported content" });
    const permanent = fakeDb([]);
    assert.equal(
      await new TranslationService(permanent as never).ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"),
      "failed",
    );
    assert.equal(permanent.ops.upserts.at(-1).attempts, 3, "no second and third go at a 400");

    stubFetch({ ok: false, status: 429, text: "slow down" });
    const transient = fakeDb([]);
    await new TranslationService(transient as never).ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(transient.ops.upserts.at(-1).attempts, 1, "a rate limit keeps its retries");
  });

  it("gives a new source text a fresh budget", async () => {
    // The ceiling is per source text, not per field: an edited line has never
    // been asked about and must not inherit the old one's exhaustion.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("April rent"));
    const db = fakeDb([failedRow(3)]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار أبريل"), "done");
    assert.equal(calls.length, 1);
  });
});

describe("TranslationService — a reply that ran out of room", () => {
  /**
   * The budget used to be a flat 1,000 output tokens and `finish_reason` was
   * never read, so a long Arabic note came back clipped mid-word and was stored
   * `done`. A truncated translation is the worst kind of wrong: it reads as a
   * finished sentence and is printed on an invoice.
   */
  const truncated = {
    ok: true,
    body: { choices: [{ finish_reason: "length", message: { content: "March rent for the apartment on the" } }] },
  };

  it("is a failure, not a translation", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(truncated);
    const db = fakeDb([]);
    const svc = new TranslationService(db as never);
    assert.equal(await svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"), "failed");
    assert.equal(db.ops.upserts.at(-1).status, "failed");
    assert.equal(db.ops.upserts.at(-1).text, undefined, "the clipped text must not be stored");
    assert.match(db.ops.upserts.at(-1).error, /truncated/);
  });

  it("is not retried, because the same request would clip in the same place", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(truncated);
    const db = fakeDb([]);
    await new TranslationService(db as never).ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.equal(db.ops.upserts.at(-1).attempts, 3);
  });

  it("asks for a budget that scales with the source, so ordinary text never clips", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("…"));
    const long = "إيجار ".repeat(600); // ~3,600 characters, inside MAX_SOURCE_CHARS
    await new TranslationService(fakeDb([]) as never).ensureTranslation("simple_invoices", 3, "notes", long);
    const asked = JSON.parse(calls[0].init.body).max_tokens;
    assert.ok(asked > 1_000, `a ${long.length}-character note asked for only ${asked} tokens`);
  });
});

describe("TranslationService — the write path's fan-out", () => {
  it("never has more than four translations in flight, however many fields it is given", async () => {
    // `queue()` detaches its work with a bare `void`. A 200-line invoice used to
    // detach 200 of them at once — 200 pool checkouts and up to 200 concurrent
    // 20-second fetches, after the response had gone and with nobody watching.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    const FIELDS = 40;
    let inFlight = 0;
    let peak = 0;
    let finished = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      finished += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "Rent" } }] }),
        text: async () => "",
      } as any;
    }) as any;

    const fields: Record<string, string> = {};
    for (let i = 0; i < FIELDS; i += 1) fields[itemDescriptionField(i)] = `إيجار الوحدة ${i}`;

    const svc = new TranslationService(fakeDb([]) as never);
    assert.equal(svc.queue("simple_invoices", 7, fields), undefined, "the write path must not be awaited");
    // Every field is either running or parked on the semaphore; drain them all.
    while (finished < FIELDS) await new Promise((r) => setTimeout(r, 5));
    assert.equal(peak, 4, `${FIELDS} detached fields reached ${peak} concurrent provider calls`);
  });

  it("charges once when the same new text is saved twice at the same moment", async () => {
    // Two concurrent saves both missed the cache and both paid. No duplicate
    // row — the unique index sees to that — but a duplicate bill.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    stubFetch(replyWith("March rent"));
    const svc = new TranslationService(fakeDb([]) as never);
    const [a, b] = await Promise.all([
      svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"),
      svc.ensureTranslation("invoice_lines", 12, "name", "إيجار شهر مارس"),
    ]);
    assert.equal(a, "done");
    assert.equal(b, "done");
    assert.equal(calls.length, 1, "the second save must join the call already in flight");
  });
});

describe("the sweep's convergence rule", () => {
  /**
   * The sweep has to shrink its own backlog. The first cut could not: it
   * counted `done`/`skipped` rows against `jsonb_array_length(items)`, so a
   * line with an amount and no description — an ordinary shape — yielded no job
   * and could never settle, and the document came back on every run. Newest
   * first, it starved everything older. And with no API key every row lands
   * `pending`, which was not settled either, so nothing ever converged at all.
   *
   * The statements cannot be run here, so they are rendered and read.
   */
  const rendered = async (configured: boolean) => {
    if (configured) process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    const db = fakeDb([]);
    await new TranslationService(db as never).sweep(50);
    return db.ops.statements.join("\n\n");
  };

  it("treats a pending row as settled ONLY while there is no key to progress it", async () => {
    const noKey = await rendered(false);
    assert.match(noKey, /t\.status = 'pending' and true/,
      "with no key, a recorded source is as done as it can get — do not select it again");

    const withKey = await rendered(true);
    assert.match(withKey, /t\.status = 'pending' and false/,
      "the moment a key exists, every pending row is work again");
  });

  it("treats a failed row as settled only once its attempts are spent", async () => {
    assert.match(await rendered(false), /t\.status = 'failed' and t\.attempts >= 3/);
  });

  it("re-selects a row whose source text no longer hashes to what was translated", async () => {
    // What lets a sweep REPAIR a `done` row the write path's prune missed.
    const sql = await rendered(false);
    assert.match(sql, /t\.source_hash = encode\(sha256\(convert_to\(btrim\(/);
    assert.match(sql, /t\.status in \('done', 'skipped'\)/);
  });

  it("expands the jsonb items so that one result row is one unit of work", async () => {
    // `limit` used to bound DOCUMENTS and then fan each one out into a job per
    // line: limit=500 over ten-line invoices was 5,000 model calls inside one
    // admin HTTP request.
    const sql = await rendered(false);
    assert.match(sql, /cross join lateral jsonb_array_elements\(/);
    assert.match(sql, /with ordinality as e\(item, ord\)/);
    assert.match(sql, /'items\.' \|\| \(e\.ord - 1\)::text \|\| '\.description'/);
    // An item with an amount and no description contributes nothing, rather
    // than keeping its document outstanding for ever.
    assert.match(sql, /btrim\(coalesce\(e\.item->>'description', ''\), E' /);
  });

  it("sweeps only the fields a screen renders", async () => {
    // `invoices.notes`, `invoices.instruction_note` and `invoice_lines.name`
    // were translated on every e-invoice and read by nothing; being first in
    // the list, they spent the budget before it reached the line items the
    // portal actually shows.
    const sql = await rendered(false);
    assert.ok(!/from invoice_lines/.test(sql), "invoice_lines has name_ar and no reader");
    assert.ok(!/instruction_note/.test(sql), "nothing renders it");
    assert.match(sql, /from simple_invoices/);
  });

  it("bounds the work by the number the caller asked for", async () => {
    const db = fakeDb([]);
    const result = await new TranslationService(db as never).sweep(50);
    assert.equal(result.limit, 50);
    for (const statement of db.ops.statements) assert.match(statement, /limit \$\d+/);
  });
});

describe("normalizeSource", () => {
  /**
   * The one normalisation the hash is taken over — and Postgres has to agree
   * with it exactly, or the sweep re-selects the same row for ever. Hence a
   * deliberately narrow character list rather than `String.trim()`, which also
   * eats NBSP and the BOM where `btrim` would not.
   */
  it("trims exactly the characters btrim is asked for", () => {
    assert.equal(normalizeSource("  إيجار \t\n"), "إيجار");
    assert.equal(normalizeSource("\u00a0إيجار"), "\u00a0إيجار", "NBSP is not whitespace to btrim");
  });

  it("treats everything that is not a string as empty", () => {
    assert.equal(normalizeSource(null), "");
    assert.equal(normalizeSource(1200), "");
    assert.equal(normalizeSource(undefined), "");
  });
});

describe("itemDescriptionFields", () => {
  /**
   * `simple_invoices.items` is jsonb, so its fields have no row of their own
   * and are addressed by path. The write path and the read path both call this
   * one function — two lists that drifted apart would store translations under
   * keys nothing ever looks up.
   */
  it("maps each description to the path the response uses", () => {
    assert.deepEqual(
      itemDescriptionFields([{ description: "إيجار" }, { description: "تأمين" }]),
      { "items.0.description": "إيجار", "items.1.description": "تأمين" },
    );
  });

  it("keeps the index of the item it came from, gaps included", () => {
    // Index 1 is skipped, so index 2 must still be `items.2.description` —
    // renumbering would point the UI at the wrong line.
    assert.deepEqual(
      itemDescriptionFields([{ description: "إيجار" }, { description: "  " }, { description: "تأمين" }]),
      { "items.0.description": "إيجار", "items.2.description": "تأمين" },
    );
  });

  it("survives the shapes jsonb actually holds", () => {
    assert.deepEqual(itemDescriptionFields(null), {});
    assert.deepEqual(itemDescriptionFields(undefined), {});
    assert.deepEqual(itemDescriptionFields("not an array"), {});
    assert.deepEqual(itemDescriptionFields([{}, { description: 5 }, null]), {});
  });
});
