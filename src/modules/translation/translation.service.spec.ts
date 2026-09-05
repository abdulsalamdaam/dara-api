import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { TranslationService, itemDescriptionFields, translationKey } from "./translation.service";

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
  const ops = { selects: 0, deletes: 0, upserts: [] as any[] };
  const done = (value: any) => ({ then: (res: any, rej: any) => Promise.resolve(value).then(res, rej) });
  return {
    ops,
    rows: selectRows,
    select: () => ({ from: () => ({ where: () => { ops.selects += 1; return done(selectRows); } }) }),
    delete: () => ({ where: () => { ops.deletes += 1; return done(undefined); } }),
    insert: () => ({
      values: (v: any) => ({ onConflictDoUpdate: () => { ops.upserts.push(v); return done(undefined); } }),
    }),
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

  it("getFor returns only finished translations, keyed and sided", async () => {
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar", text: "March rent", status: "done" },
      { entityId: 13, field: "name", lang: "ar", sourceLang: "en", text: "صيانة", status: "done" },
    ]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", [12, 13], ["name"]);
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "ar", ar: null, en: "March rent" });
    assert.deepEqual(map["invoice_lines:13:name"], { sourceLang: "en", ar: "صيانة", en: null });
  });

  it("getFor asks nothing and answers {} for an empty page", async () => {
    const db = fakeDb([]);
    const map = await new TranslationService(db as never).getFor("invoice_lines", []);
    assert.deepEqual(map, {});
    assert.equal(db.ops.selects, 0, "an empty id list must not produce a query");
  });

  it("getFor answers {} rather than throwing when the table is unreachable", async () => {
    // A read of this table must not be able to break the invoice it decorates:
    // an empty map is exactly the pre-translation behaviour.
    const broken = { select: () => ({ from: () => ({ where: () => { throw new Error("no such table"); } }) }) };
    assert.deepEqual(await new TranslationService(broken as never).getFor("invoice_lines", [1]), {});
  });

  it("attachSource fills the side the user typed with the original text", async () => {
    // Only the MISSING language is stored; the other one is on the entity
    // itself, so the handler holding the row completes the pair and the UI
    // receives a whole { ar, en } without knowing which way round it was.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar", text: "March rent", status: "done" },
    ]);
    const svc = new TranslationService(db as never);
    const map = await svc.getFor("invoice_lines", [12], ["name"]);
    svc.attachSource(map, "invoice_lines", 12, "name", "إيجار شهر مارس");
    assert.deepEqual(map["invoice_lines:12:name"], {
      sourceLang: "ar", ar: "إيجار شهر مارس", en: "March rent",
    });
  });

  it("attachSource still names the language when there is no stored translation", async () => {
    const svc = new TranslationService(fakeDb([]) as never);
    const map = {};
    svc.attachSource(map, "invoice_lines", 12, "name", "Rent for March");
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "en", ar: null, en: "Rent for March" });
  });

  it("attachSource drops a translation whose source has been retyped in the other language", async () => {
    // The live text is the authority. A landlord who rewrites an Arabic line in
    // English leaves a stored "Arabic translation" that is a translation of
    // something else — and it reads as a plausible line item, which is the
    // worst way to be wrong. Better to show the original until the queued
    // re-translation lands.
    const db = fakeDb([
      { entityId: 12, field: "name", lang: "en", sourceLang: "ar", text: "March rent", status: "done" },
    ]);
    const svc = new TranslationService(db as never);
    const map = await svc.getFor("invoice_lines", [12], ["name"]);
    svc.attachSource(map, "invoice_lines", 12, "name", "Rent for April");
    assert.deepEqual(map["invoice_lines:12:name"], { sourceLang: "en", ar: null, en: "Rent for April" });
  });

  it("attachSource adds nothing for a value with no language", () => {
    const svc = new TranslationService(fakeDb([]) as never);
    const map = {};
    svc.attachSource(map, "invoice_lines", 12, "name", "SAR 1,200");
    svc.attachSource(map, "invoice_lines", 12, "name", null);
    assert.deepEqual(map, {});
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
