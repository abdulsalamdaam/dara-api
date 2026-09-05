import { createHash } from "node:crypto";
import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { translationsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { appLog } from "../../common/logging/app-log.service";
import { detectLanguage, type DetectedLanguage } from "../../common/detect-language";

/* ── Configuration ──────────────────────────────────────────────────────── */

/**
 * A small, cheap model by default. Free-text invoice lines are a handful of
 * words each and the task is the most ordinary one a language model does;
 * paying frontier prices for it would turn a bounded cost into a silly one.
 * Override with `OPENAI_MODEL` if a specific one is ever wanted.
 */
const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Node's `fetch` has NO default request timeout — only undici's 300-second
 * headers timeout. Nothing here is on a request's critical path, but an
 * un-timed-out call still pins a socket and, in the sweep, would hold an admin
 * request open for minutes. Same reasoning and the same shape as
 * `email.service.ts`: give up and record a failure the sweep can retry.
 */
const TRANSLATE_TIMEOUT_MS = 20_000;

/**
 * Longer than this and we do not translate at all.
 *
 * Not a safety limit — a cost one. These fields are line-item names and short
 * notes; a 40 KB value in one is a paste accident or a machine writing into a
 * human field, and translating it would cost more than every real line on the
 * invoice put together. A truncated translation is worse than none (it reads as
 * a complete sentence and is not one), so such a field is marked `skipped`
 * rather than clipped.
 */
const MAX_SOURCE_CHARS = 4_000;

/**
 * The reply budget, sized from the source rather than fixed.
 *
 * A flat 1,000 tokens was a silent corruption: Arabic runs well under two
 * characters per token, so a 4,000-character note came back clipped mid-word
 * and was stored as a finished translation. The comment above says a truncated
 * translation is worse than none, and it has to be enforced rather than hoped
 * for — so the budget scales with the input (generously, two tokens per source
 * character plus a little slack) AND a reply that hits the ceiling anyway is
 * treated as a failure, never as a result. See `finish_reason` in
 * `callProvider`.
 */
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 8_192;
function outputBudget(sourceChars: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, sourceChars * 2 + 64));
}

/**
 * How many times one source text may be sent to the provider before we stop.
 *
 * Without a ceiling a `failed` row is asked again on every save and every
 * sweep, for ever, at full price — an outage or a refusal becomes a standing
 * order. Three attempts covers a transient 5xx, a rate limit and a timeout;
 * past that the row keeps its error and costs nothing until the SOURCE TEXT
 * changes, which drops the row and starts a fresh count.
 *
 * A refusal that cannot succeed on a retry (a 4xx that is not a rate limit, a
 * reply that was truncated) does not get three goes: it is recorded straight at
 * the ceiling.
 */
const MAX_ATTEMPTS = 3;

/**
 * Process-wide cap on concurrent translations, shared by the write path and the
 * sweep.
 *
 * `queue()` is fire-and-forget, so without a cap a 200-line invoice detached
 * 200 `ensureTranslation`s at once: 200 connection-pool checkouts and up to 200
 * concurrent 20-second fetches, all AFTER the response had been sent, where
 * nothing throttles them and nobody is watching. One shared semaphore rather
 * than one per lane, because the pool and the provider's rate limit are
 * process-wide too.
 */
const CONCURRENCY = 4;

/**
 * The most fields that may be waiting for a slot on the write path.
 *
 * A backlog is memory, and this runs after the response; anything dropped here
 * is not lost, it is simply left for `POST /admin/translations/sweep`, which
 * exists precisely to find work that never got done.
 */
const MAX_QUEUED = 2_000;

/* ── The shape a UI consumes ────────────────────────────────────────────── */

/**
 * One translatable field, in both languages.
 *
 * `sourceLang` is the one the user actually typed; that side holds the original
 * text verbatim and the other side holds the translation, or `null` when there
 * is not one yet (never produced, provider down, no API key configured).
 *
 * A reader therefore never needs to know which way round it was:
 *
 *     const t = res.translations["invoice_lines:12:name"];
 *     const shown = t?.[uiLang] ?? line.name;
 *
 * The `?? line.name` fallback is not optional — a field with no row at all
 * (never swept, nothing to translate, an amount) is absent from the map.
 */
export interface TranslationEntry {
  sourceLang: DetectedLanguage;
  ar: string | null;
  en: string | null;
}

/**
 * `{ "<entity_type>:<entity_id>:<field>": TranslationEntry }`.
 *
 * Flat and string-keyed rather than nested per entity, so a list response can
 * carry ONE map covering every row on the page and a component that has a line
 * in hand can look its own key up without walking a tree.
 */
export type TranslationMap = Record<string, TranslationEntry>;

/**
 * The LIVE text of each field, per entity id: `{ 12: { name: "إيجار مارس" } }`.
 *
 * This is what `getFor` takes instead of a bare list of ids, and the reason is
 * correctness rather than convenience — see the note on `getFor`. A caller
 * always has these values in hand: it is decorating a row it just read.
 */
export type SourceTexts = Record<string | number, Record<string, unknown>>;

/** The key `getFor` builds and the UI reads. Exported so nobody has to guess the separator. */
export function translationKey(entityType: string, entityId: number, field: string): string {
  return `${entityType}:${entityId}:${field}`;
}

/* ── Statuses ───────────────────────────────────────────────────────────── */

/** `lang` / `source_lang` on a row that has no language — BCP-47's "undetermined". */
const UNDETERMINED = "und";

export interface SweepResult {
  limit: number;
  /** Whether an `OPENAI_API_KEY` was present. False means the sweep only recorded sources. */
  configured: boolean;
  /** Fields examined. */
  scanned: number;
  /** Fields that gained a translation on this run. */
  translated: number;
  /** Fields with nothing to translate (an amount, a number, an empty value). */
  skipped: number;
  /** Fields the provider refused or could not be reached for — retried until `MAX_ATTEMPTS`. */
  failed: number;
}

/* ── Service ────────────────────────────────────────────────────────────── */

/**
 * Stores the second language of user-typed free text.
 *
 * Four rules govern everything in here:
 *
 *  1. **Nothing blocks a request.** `queue()` returns `void` and the work
 *     happens after the response has gone. `ensureTranslation` never throws,
 *     whatever the provider or the database does — the same discipline as
 *     `safeLog` in `ejar.client.service.ts` and `AppLogService.record`. An
 *     OpenAI outage must never turn a working save into a 500.
 *  2. **The provider is asked once per distinct source text, and at most
 *     `MAX_ATTEMPTS` times.** `source_hash` is the cost-control story:
 *     re-saving an invoice, re-opening it, or sweeping it a hundred times costs
 *     one indexed SELECT each and no model call. The attempt count is the other
 *     half — a failure that repeats is not a reason to keep paying.
 *  3. **A stale translation is never served.** The hash is checked on the READ
 *     path, against the text the caller is holding right now, so correctness
 *     does not depend on a background write having landed. A row whose source
 *     has changed underneath it is treated exactly like a row that does not
 *     exist.
 *  4. **No key is a working state, not an error.** `OPENAI_API_KEY` is not set
 *     today. Every path here has to behave correctly without it: sources are
 *     still recorded, reads still work, nothing throws, and the day a key is
 *     added `POST /admin/translations/sweep` fills in the backlog.
 */
@Injectable()
export class TranslationService {
  private readonly log = new Logger("Translation");
  /** So a missing key is reported once at the first attempt, not on every field of every invoice. */
  private warnedUnconfigured = false;
  /** So a missing unique index — which breaks every write — is reported once, loudly. */
  private warnedNoUniqueIndex = false;
  /** So a full write-path backlog is reported once rather than per dropped field. */
  private warnedBacklog = false;

  /** Fields waiting for or holding a concurrency slot on the write path. */
  private queued = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /**
   * Work in flight, keyed by entity/field/hash.
   *
   * Two concurrent saves of the same new text would otherwise each miss the
   * cache and each pay for a model call — no duplicate row (the unique index
   * prevents that) but a duplicate bill. Sharing the promise makes the second
   * caller free. Only within one process; two containers saving the same field
   * in the same second still pay twice, which is rare enough to be worth less
   * than a distributed lock.
   */
  private readonly inFlight = new Map<string, Promise<TranslationOutcome>>();

  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  private get apiKey(): string {
    return (process.env.OPENAI_API_KEY ?? "").trim();
  }

  private get model(): string {
    return (process.env.OPENAI_MODEL ?? "").trim() || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /* ── Concurrency ──────────────────────────────────────────────────────── */

  /**
   * Run `fn` holding one of `CONCURRENCY` process-wide slots.
   *
   * A finishing job HANDS its slot to the next waiter rather than releasing it
   * and waking one: releasing first leaves a gap in which a caller arriving
   * synchronously takes the free slot, and then the woken waiter takes one too.
   * The count would drift up by one every time that raced.
   */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= CONCURRENCY) await new Promise<void>((res) => this.waiting.push(res));
    else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  /* ── Provider ─────────────────────────────────────────────────────────── */

  /**
   * Translate one string. Returns null when it could not be done — including
   * when no API key is configured, which is a no-op and NOT an error.
   *
   * Never throws. Callers treat null as "not yet", never as a failure to
   * propagate.
   */
  async translate(text: string, from: DetectedLanguage, to: DetectedLanguage): Promise<string | null> {
    return (await this.callProvider(text, from, to)).text;
  }

  /**
   * `translate`, plus the reason it failed and whether that reason can change.
   *
   * `permanent` is what stops a refusal costing money for ever: a 400 for
   * unsupported content, a 401 for a bad key, a reply that was truncated —
   * asking again with the same input gets the same answer, so the row is
   * recorded at the attempt ceiling rather than given two more goes. A 429, a
   * 5xx and every network error are the opposite and stay retryable.
   *
   * Private because the reason is only ever written to our own table.
   */
  private async callProvider(
    text: string, from: DetectedLanguage, to: DetectedLanguage,
  ): Promise<{ text: string | null; error: string | null; permanent: boolean }> {
    const key = this.apiKey;
    if (!key) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.log.warn("OPENAI_API_KEY not set — translations are recorded but not produced");
      }
      return { text: null, error: null, permanent: false };
    }

    try {
      // ── What leaves this process ───────────────────────────────────────
      // `text` and nothing else: the value of ONE user-typed field, as the
      // user typed it. Not the row it came from, not the invoice number, the
      // parties, the amounts or the account it belongs to; not a request
      // header, a token or an id; and never anything out of `app_logs`, which
      // exists precisely because it holds the things that must not travel.
      // The prompt below is a constant. If a caller ever wants to "give the
      // model more context", that is a decision to send a customer's business
      // data to a third party and it does not belong in this function.
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          // Zero, because there is one right answer and we cache it under a
          // hash: a second sample of the same line would be a different string
          // for no reason, and the user would see the wording change under them.
          temperature: 0,
          max_tokens: outputBudget(text.length),
          messages: [
            { role: "system", content: systemPrompt(from, to) },
            { role: "user", content: text },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          text: null,
          error: `HTTP ${res.status} ${body.slice(0, 300)}`,
          // 408/409/425/429 are "try later"; every other 4xx is the request
          // itself being wrong, and it will be just as wrong next time.
          permanent: res.status >= 400 && res.status < 500 && ![408, 409, 425, 429].includes(res.status),
        };
      }
      const json: any = await res.json();
      // A reply that ran out of room is NOT a translation. It is a sentence cut
      // mid-word that reads as a complete one, printed on an invoice — the
      // exact failure the source-length limit above exists to avoid. Refuse it.
      if (json?.choices?.[0]?.finish_reason === "length") {
        return { text: null, error: "truncated reply (hit max_tokens)", permanent: true };
      }
      const out = cleanReply(json?.choices?.[0]?.message?.content);
      if (!out) return { text: null, error: "empty reply", permanent: false };
      return { text: out, error: null, permanent: false };
    } catch (err: any) {
      // Includes the AbortSignal timeout and every network failure. A failed
      // row is retried by the next sweep, so there is nothing to escalate.
      return { text: null, error: String(err?.message ?? err).slice(0, 300), permanent: false };
    }
  }

  /* ── Write path ───────────────────────────────────────────────────────── */

  /**
   * Fire-and-forget several fields of one entity. **Returns immediately** —
   * this is what a controller calls on a write, and it is the reason a save
   * cannot be slowed down or broken by translation.
   *
   *     this.translations.queue("simple_invoices", doc.id, {
   *       notes: doc.notes,
   *       "items.0.description": "إيجار مارس",
   *     });
   *
   * Detached, but not unbounded: every field waits for one of `CONCURRENCY`
   * slots, and a backlog over `MAX_QUEUED` is dropped for the sweep to pick up
   * rather than held in memory.
   */
  queue(entityType: string, entityId: number | null | undefined, fields: Record<string, unknown>): void {
    if (!Number.isInteger(entityId)) return;
    for (const [field, value] of Object.entries(fields)) {
      if (this.queued >= MAX_QUEUED) {
        if (!this.warnedBacklog) {
          this.warnedBacklog = true;
          this.log.warn(`translation backlog over ${MAX_QUEUED} — dropping fields for the sweep to pick up`);
        }
        return;
      }
      this.queued += 1;
      // `ensureTranslation` already swallows everything; the catch is here so
      // that a rejection escaping a future edit cannot become an unhandled one.
      void this.withSlot(() => this.ensureTranslation(entityType, entityId as number, field, value))
        .catch(() => {})
        .finally(() => { this.queued -= 1; });
    }
  }

  /**
   * Make sure the other language of one field exists, and is the translation of
   * the text that is there NOW.
   *
   * Idempotent and safe to call as often as anything likes: an unchanged source
   * costs one indexed SELECT and asks the provider nothing. Never throws.
   *
   * Returns the outcome so the sweep can count; callers on a write path ignore it.
   */
  ensureTranslation(
    entityType: string, entityId: number, field: string, sourceText: unknown,
  ): Promise<TranslationOutcome> {
    const raw = normalizeSource(sourceText);
    const hash = sha256(raw);
    // Keyed by the hash as well as the field: a second save of the SAME text
    // joins the call already in flight, while a save that changed the text
    // starts its own.
    const dedupeKey = `${entityType}:${entityId}:${field}:${hash}`;
    const running = this.inFlight.get(dedupeKey);
    if (running) return running;

    const work = this.runEnsure(entityType, entityId, field, raw, hash)
      .finally(() => { this.inFlight.delete(dedupeKey); });
    this.inFlight.set(dedupeKey, work);
    return work;
  }

  private async runEnsure(
    entityType: string, entityId: number, field: string, raw: string, hash: string,
  ): Promise<TranslationOutcome> {
    try {
      const existing = await this.db
        .select()
        .from(translationsTable)
        .where(and(
          eq(translationsTable.entityType, entityType),
          eq(translationsTable.entityId, entityId),
          eq(translationsTable.field, field),
        ));

      // A translation must never outlive the text it translated. The moment a
      // landlord edits a line item, the English the tenant is shown is wrong —
      // and it is wrong in the most dangerous way, by looking right. Anything
      // whose hash no longer matches goes, before anything else is decided.
      // This is the tidy-up, NOT the guarantee: the guarantee is on the read
      // path, which compares the hash itself and so does not care whether this
      // delete ever ran.
      const stale = existing.filter((r) => r.sourceHash !== hash);
      if (stale.length) {
        await this.db.delete(translationsTable).where(inArray(translationsTable.id, stale.map((r) => r.id)));
      }

      const from = detectLanguage(raw);
      if (!from || raw.length > MAX_SOURCE_CHARS) {
        // Recorded rather than left absent: the sweep counts settled rows to
        // decide what is left to do, so an untranslatable line has to say so
        // once or it is re-examined on every sweep for ever.
        await this.upsert({
          entityType, entityId, field, sourceLang: UNDETERMINED, sourceHash: hash,
          lang: UNDETERMINED, text: null, status: "skipped", attempts: 0,
          error: raw.length > MAX_SOURCE_CHARS ? `source too long (${raw.length} chars)` : null,
        });
        return "skipped";
      }

      const to: DetectedLanguage = from === "ar" ? "en" : "ar";
      const current = existing.find((r) => r.lang === to && r.sourceHash === hash);
      // THE cost control. Same text, already translated — do not pay again.
      if (current?.status === "done" && current.text) return "cached";

      const attempts = Number((current as any)?.attempts ?? 0);
      // The other half of it. A provider that refused this text three times is
      // not going to accept it on the fourth save of the same invoice.
      if (current?.status === "failed" && attempts >= MAX_ATTEMPTS) return "exhausted";

      // Written before the call, not after: if the container dies mid-request
      // the row is left `pending` with the right hash, and the sweep finishes
      // the job. `text` is deliberately not cleared — while a re-translation is
      // in flight a reader keeps seeing the previous one rather than nothing.
      await this.upsert({
        entityType, entityId, field, sourceLang: from, sourceHash: hash,
        lang: to, status: "pending", error: null, attempts,
      });

      if (!this.isConfigured()) return "pending";

      const { text, error, permanent } = await this.callProvider(raw, from, to);
      if (!text) {
        await this.upsert({
          entityType, entityId, field, sourceLang: from, sourceHash: hash,
          lang: to, status: "failed", error: error ?? "no translation returned",
          // A permanent refusal is recorded straight at the ceiling so it is
          // never asked again for this text — by a save, or by a sweep.
          attempts: permanent ? MAX_ATTEMPTS : attempts + 1,
        });
        return "failed";
      }
      await this.upsert({
        entityType, entityId, field, sourceLang: from, sourceHash: hash,
        lang: to, text, status: "done", error: null, attempts: attempts + 1,
        provider: "openai", model: this.model,
      });
      return "done";
    } catch (err: any) {
      // The last line of defence. This runs after a response has been sent, so
      // an escaping rejection would be an unhandled one — and the one thing
      // that must never happen is a translation breaking a save.
      //
      // 42P10 is the exception to "warn and move on". It means the unique index
      // the upsert conflicts on is not there, so NOTHING is being stored and
      // nothing ever will be — a configuration failure wearing a per-row
      // hiccup's clothes. Say so once, at error level, with the fix in the text.
      if (err?.code === "42P10") this.reportMissingUniqueIndex(err);
      else {
        this.log.warn(`ensureTranslation(${entityType}:${entityId}:${field}) failed: ${err?.message ?? err}`);
        appLog()?.event("translation_failed", { entityType, entityId, field }, {
          level: "warn", context: "Translation", error: err,
        });
      }
      return "error";
    }
  }

  /**
   * The upsert has no index to conflict on, which means every write in this
   * module is failing and no translation is being stored anywhere. Loud, once.
   */
  private reportMissingUniqueIndex(err: any): void {
    if (this.warnedNoUniqueIndex) return;
    this.warnedNoUniqueIndex = true;
    const message =
      "translations_entity_field_lang_idx is MISSING — every translation write is failing (Postgres 42P10). " +
      "Nothing is being stored. Create it: create unique index concurrently translations_entity_field_lang_idx " +
      "on translations (entity_type, entity_id, field, lang)";
    this.log.error(message);
    appLog()?.event("translation_index_missing", { hint: message }, {
      level: "error", context: "Translation", error: err,
    });
  }

  /** Insert or refresh one row, keyed by the unique (entity_type, entity_id, field, lang) index. */
  private async upsert(values: typeof translationsTable.$inferInsert): Promise<void> {
    const { entityType, entityId, field, lang, text, provider, model, ...rest } = values;
    await this.db
      .insert(translationsTable)
      .values(values)
      .onConflictDoUpdate({
        // The four columns of the unique index, which are therefore the four
        // that must NOT appear in `set` — they are what identified the row.
        target: [
          translationsTable.entityType, translationsTable.entityId,
          translationsTable.field, translationsTable.lang,
        ],
        set: {
          ...rest,
          // Only overwrite the translation itself when this call produced one,
          // so a `pending` refresh does not blank a still-valid answer while a
          // re-translation is in flight.
          ...(text !== undefined ? { text } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          updatedAt: new Date(),
        },
      });
  }

  /* ── Read path ────────────────────────────────────────────────────────── */

  /**
   * Every stored translation for a page of rows, in ONE query, checked against
   * the text the caller is holding.
   *
   * `sources` is `{ <entity id>: { <field>: <live text> } }` — the values as
   * they are in the row right now. It is not a convenience; it is the
   * correctness argument. A translation is only returned when its `source_hash`
   * matches the hash of the live text, so:
   *
   *   · a field edited within the same language shows the ORIGINAL until the
   *     new translation lands, instead of the previous one's;
   *   · a field that has been emptied, or changed to something with no
   *     language, shows nothing rather than the translation of what used to be
   *     there;
   *   · and none of that depends on the fire-and-forget prune in
   *     `ensureTranslation` having run. A mismatch is treated exactly like "no
   *     translation yet", which is a state every caller already handles.
   *
   * Built for a list view: pass the whole page rather than calling this per row.
   *
   * The map also carries the ORIGINAL text on the side the user typed it. The
   * table stores only the language that was MISSING — the other one is on the
   * entity itself and a second copy would be a second thing to keep in sync —
   * so the half we already have is filled in here and the UI receives a
   * complete `{ ar, en }` without having to ask which way round it was stored.
   */
  async getFor(entityType: string, sources: SourceTexts): Promise<TranslationMap> {
    const live = new Map<string, { id: number; field: string; text: string; hash: string }>();
    const ids = new Set<number>();
    const fields = new Set<string>();
    for (const [rawId, byField] of Object.entries(sources ?? {})) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || !byField) continue;
      for (const [field, value] of Object.entries(byField)) {
        const text = normalizeSource(value);
        if (!text) continue;
        ids.add(id);
        fields.add(field);
        live.set(translationKey(entityType, id, field), { id, field, text, hash: sha256(text) });
      }
    }
    if (live.size === 0) return {};

    const map: TranslationMap = {};
    try {
      const rows = await this.db
        .select()
        .from(translationsTable)
        .where(and(
          eq(translationsTable.entityType, entityType),
          inArray(translationsTable.entityId, [...ids]),
          inArray(translationsTable.field, [...fields]),
          eq(translationsTable.status, "done"),
        ));
      for (const r of rows as any[]) {
        if (r.lang !== "ar" && r.lang !== "en") continue;
        if (!r.text) continue;
        const key = translationKey(entityType, r.entityId, r.field);
        const source = live.get(key);
        // No live text for this field any more (blanked, or the item is gone),
        // or the live text is not what was translated. Either way the row is
        // about a string that no longer exists and must not be served.
        if (!source || source.hash !== r.sourceHash) continue;
        const entry = map[key] ?? (map[key] = { sourceLang: r.sourceLang, ar: null, en: null });
        entry[r.lang as DetectedLanguage] = r.text;
      }
    } catch (err: any) {
      // A read of this table must not be able to break the invoice it decorates.
      // The originals below are the pre-translation behaviour: the UI shows the
      // text the user typed, which is what it has always done.
      if (err?.code === "42P10") this.reportMissingUniqueIndex(err);
      else this.log.warn(`getFor(${entityType}) failed: ${err?.message ?? err}`);
    }

    for (const { id, field, text } of live.values()) {
      this.attachSource(map, entityType, id, field, text);
    }
    return map;
  }

  /**
   * Put the ORIGINAL text into the map, on the side the user typed it.
   *
   * Called by `getFor` for every field it was given; public because a caller
   * that has no stored translations at all (an entity this layer does not
   * translate) can still hand the UI a properly-sided pair for free.
   */
  attachSource(map: TranslationMap, entityType: string, entityId: number, field: string, sourceText: unknown): void {
    const text = normalizeSource(sourceText);
    if (!text) return;
    const key = translationKey(entityType, entityId, field);
    const from = detectLanguage(text);
    if (!from) return;
    const entry = map[key];
    // The live text is the authority on which language it is in, not the row.
    // If they disagree the text was edited into the other language and the
    // stored translation is now of something else — dropping it here shows the
    // original rather than a confident lie, until the queued re-translation
    // lands.
    if (entry && entry.sourceLang === from) {
      entry[from] = sourceText as string;
      return;
    }
    map[key] = { sourceLang: from, ar: null, en: null, [from]: sourceText } as TranslationEntry;
  }

  /**
   * Put a translation a HUMAN wrote into the map, and let it win.
   *
   * Some fields already have their second language in the schema —
   * `invoice_lines.name_ar` is filled in by the seller and is what the PDF
   * prints (`invoice-template.ts`: `l.nameAr || l.name`). Paying a model to
   * produce Arabic somebody already typed would be spending money to make the
   * screen and the PDF disagree, so wherever such a column exists it is the
   * answer and the machine is not asked. This is how it reaches the map.
   *
   * Overwrites a stored machine translation for the same side, deliberately.
   */
  attachHuman(
    map: TranslationMap, entityType: string, entityId: number, field: string,
    lang: DetectedLanguage, text: unknown,
  ): void {
    const value = normalizeSource(text);
    if (!value) return;
    const key = translationKey(entityType, entityId, field);
    const entry = map[key];
    if (!entry) return; // No original in hand: a lone side would have no `sourceLang` to mean anything.
    if (entry.sourceLang === lang) return; // That side already holds what the user typed.
    entry[lang] = value;
  }

  /* ── Backfill ─────────────────────────────────────────────────────────── */

  /**
   * The free-text fields this layer covers, and where each one lives.
   *
   * **Only fields a screen actually renders.** The first cut also translated
   * `invoices.notes`, `invoices.instruction_note` and `invoice_lines.name` on
   * every e-invoice issued; nothing in the portal ever looked any of them up
   * (`pickText` is only ever called with `TRANSLATION_ENTITY.simpleInvoices`),
   * so that was a model call per line of every ZATCA document in exchange for
   * nothing — and, being first in this list, it spent the sweep's budget before
   * reaching the fields that ARE shown. `invoice_lines` was the worse half
   * still: `name_ar` is right there on the row, written by a human, and it is
   * what the PDF prints. See `attachHuman`.
   *
   * `column` is the database column; `field` is the name the JSON response uses
   * and therefore the key a UI looks up.
   *
   * The identifiers here are compiled-in constants interpolated with
   * `sql.raw`, never anything off a request.
   */
  private static readonly PLAIN_TEXT_SOURCES: ReadonlyArray<{
    table: string; entityType: string; column: string; field: string; extraWhere?: string;
  }> = [
    // The billing document's own free text. The line items it carries are jsonb
    // and are swept separately, below.
    { table: "simple_invoices", entityType: "simple_invoices", column: "notes", field: "notes", extraWhere: "deleted_at is null" },
  ];

  /**
   * Fill in what is missing, bounded by `limit`.
   *
   * This is how existing data is backfilled — there is no migration that could
   * do it, because the work is a network call per row — and how a batch that
   * failed against a provider outage is retried. Everything it calls is
   * idempotent, so running it twice is free and interrupting it loses nothing.
   *
   * **`limit` bounds FIELDS, not documents.** It used to bound rows and then
   * fan each row out into one job per line item, so `limit=500` over ten-line
   * invoices was five thousand model calls inside one admin HTTP request. The
   * jsonb sweep now selects individual items, so one row of the result is one
   * unit of work and the number the caller passes is the number they get.
   *
   * **What "outstanding" means — the convergence rule.** A field is selected
   * only when there is no translations row for it that is both CURRENT (its
   * `source_hash` equals the hash of the live text, computed in SQL the same
   * way `ensureTranslation` computes it) and TERMINAL — meaning it cannot make
   * progress on this run:
   *
   *   · `done` or `skipped`  — there is nothing left to do;
   *   · `pending` while no `OPENAI_API_KEY` is configured — it cannot progress
   *     until a key exists, which is the state production is in today;
   *   · `failed` with `attempts >= MAX_ATTEMPTS` — the retry budget is spent.
   *
   * So every sweep strictly reduces the outstanding set, and the same row is
   * never handed back on the next run for no reason — while everything that
   * could still progress stays reachable: configure a key and every `pending`
   * row becomes outstanding again; a transient failure has attempts left; and
   * an edit to the source changes the hash, which makes the row not-current and
   * therefore outstanding whatever its status. That last clause is also what
   * lets a sweep REPAIR a `done` row whose text was edited while the write
   * path's prune did not land.
   *
   * The old rule counted `done`/`skipped` rows against `jsonb_array_length`,
   * which could not converge at all: an item with an amount and no description
   * — an ordinary shape, see `normalizeItems` in `billing.module.ts` — yields
   * no job and so can never settle, and the document was re-selected on every
   * sweep for ever. Being newest-first, it starved everything older.
   *
   * Newest rows first: a document somebody is looking at this week matters more
   * than one from last year, and an interrupted sweep should have spent its
   * budget on the useful end.
   */
  async sweep(limit: number): Promise<SweepResult> {
    const budget = Math.max(1, Math.min(500, Math.floor(limit) || 0));
    const configured = this.isConfigured();
    const terminal = terminalSql(configured);
    const jobs: Array<{ entityType: string; entityId: number; field: string; text: unknown }> = [];

    for (const src of TranslationService.PLAIN_TEXT_SOURCES) {
      if (jobs.length >= budget) break;
      const rows = await this.rows(sql`
        select s.id as id, s.${sql.raw(src.column)} as text
        from ${sql.raw(src.table)} s
        where s.${sql.raw(src.column)} is not null
          and btrim(s.${sql.raw(src.column)}, ${sql.raw(TRIM_SQL)}) <> ''
          ${src.extraWhere ? sql`and s.${sql.raw(src.extraWhere)}` : sql``}
          and not exists (
            select 1 from translations t
            where t.entity_type = ${src.entityType}
              and t.entity_id = s.id
              and t.field = ${src.field}
              and t.source_hash = ${sql.raw(hashSql(`s.${src.column}`))}
              and ${sql.raw(terminal)}
          )
        order by s.id desc
        limit ${budget - jobs.length}
      `);
      for (const r of rows) {
        jobs.push({ entityType: src.entityType, entityId: Number(r.id), field: src.field, text: r.text });
      }
    }

    // `simple_invoices.items` is a jsonb array, so its fields are
    // `items.0.description`, `items.1.description`, … — a shape no join on a
    // column can express. Expanded with ordinality so that ONE result row is
    // one item, which is what makes `limit` mean what it says and what lets an
    // item with no description simply not appear rather than keep its document
    // outstanding for ever.
    //
    // The `case` is not decoration: `jsonb_array_elements` RAISES on a scalar,
    // and a lateral is free to run before the WHERE that would have excluded
    // the row, so one legacy document holding `items: {}` would take the whole
    // sweep down. An empty array drops the row instead.
    if (jobs.length < budget) {
      const rows = await this.rows(sql`
        select s.id as id, (e.ord - 1)::int as idx, e.item->>'description' as text
        from simple_invoices s
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(s.items) = 'array' then s.items else '[]'::jsonb end
        ) with ordinality as e(item, ord)
        where s.deleted_at is null
          and btrim(coalesce(e.item->>'description', ''), ${sql.raw(TRIM_SQL)}) <> ''
          and not exists (
            select 1 from translations t
            where t.entity_type = 'simple_invoices'
              and t.entity_id = s.id
              and t.field = ${sql.raw(ITEM_FIELD_SQL)}
              and t.source_hash = ${sql.raw(hashSql("e.item->>'description'"))}
              and ${sql.raw(terminal)}
          )
        order by s.id desc, e.ord
        limit ${budget - jobs.length}
      `);
      for (const r of rows) {
        jobs.push({
          entityType: "simple_invoices", entityId: Number(r.id),
          field: itemDescriptionField(Number(r.idx)), text: r.text,
        });
      }
    }

    const result: SweepResult = {
      limit: budget, configured,
      scanned: jobs.length, translated: 0, skipped: 0, failed: 0,
    };

    // Through the same semaphore the write path uses, so an admin sweep and a
    // burst of saves cannot add up to twice the intended concurrency.
    await Promise.all(jobs.map((job) => this.withSlot(async () => {
      const outcome = await this.ensureTranslation(job.entityType, job.entityId, job.field, job.text);
      if (outcome === "done") result.translated += 1;
      else if (outcome === "skipped") result.skipped += 1;
      else if (outcome === "failed" || outcome === "exhausted" || outcome === "error") result.failed += 1;
    })));

    return result;
  }

  /** `db.execute` answers with an array on some drivers and `{ rows }` on others. */
  private async rows(query: any): Promise<any[]> {
    const res: any = await this.db.execute(query);
    return Array.isArray(res) ? res : (res?.rows ?? []);
  }
}

/** What one field's `ensureTranslation` did. `exhausted` is a `failed` row past its retry ceiling. */
export type TranslationOutcome =
  "done" | "skipped" | "failed" | "exhausted" | "pending" | "cached" | "error";

/* ── Helpers ────────────────────────────────────────────────────────────── */

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The one normalisation the hash is taken over.
 *
 * A deliberately narrow set of whitespace — the four ASCII blanks plus form
 * feed and vertical tab — rather than `String.trim()`, because Postgres has to
 * compute the identical hash for the sweep's "is this row still current?" test
 * and `btrim` takes an explicit character list. `trim()` also strips NBSP,
 * U+2028 and the BOM, none of which `btrim` would, and a hash the two sides
 * disagree about would make the sweep re-select the same row for ever.
 *
 * Anything that is not a string — a jsonb number, a null — is empty text.
 */
const TRIM_JS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
/** The same character list, as a Postgres escape string. */
const TRIM_SQL = "E' \\t\\n\\r\\f\\v'";

export function normalizeSource(value: unknown): string {
  return typeof value === "string" ? value.replace(TRIM_JS, "") : "";
}

/**
 * `source_hash` as Postgres computes it, for a text expression.
 *
 * `sha256()` is a Postgres 11 builtin (no pgcrypto), and `convert_to(…,'UTF8')`
 * makes the digest byte-for-byte what Node's `createHash('sha256')` produces
 * over the same string.
 */
function hashSql(expr: string): string {
  return `encode(sha256(convert_to(btrim(${expr}, ${TRIM_SQL}), 'UTF8')), 'hex')`;
}

/**
 * "This row cannot make progress on this run" — the sweep's convergence
 * predicate, written against an alias `t`. Every value in it is a compile-time
 * constant; nothing off a request goes near it.
 */
function terminalSql(configured: boolean): string {
  return "(t.status in ('done', 'skipped')"
    + ` or (t.status = 'pending' and ${configured ? "false" : "true"})`
    + ` or (t.status = 'failed' and t.attempts >= ${MAX_ATTEMPTS}))`;
}

/** `items.N.description` as Postgres builds it, from `jsonb_array_elements … with ordinality`. */
const ITEM_FIELD_SQL = "'items.' || (e.ord - 1)::text || '.description'";

const LANGUAGE_NAMES: Record<DetectedLanguage, string> = { ar: "Arabic", en: "English" };

/**
 * Deliberately narrow. The model is being used as a dictionary, not as an
 * assistant: anything it adds — a note, a transliteration, a pair of quotes —
 * is rendered verbatim into an invoice line and looks like something the
 * landlord typed. Numbers and codes are pinned because a "helpful" model will
 * otherwise localise digits or convert a currency, on a tax document.
 */
function systemPrompt(from: DetectedLanguage, to: DetectedLanguage): string {
  return [
    `Translate the user's message from ${LANGUAGE_NAMES[from]} to ${LANGUAGE_NAMES[to]}.`,
    "It is a short free-text field from a Saudi property-management application:",
    "an invoice line item, or a note on a billing document.",
    "",
    "Return ONLY the translation. No quotes, no explanation, no alternatives,",
    "no transliteration, no notes about what you did.",
    "Keep every number, date, percentage, currency amount, currency code and",
    "reference code (e.g. INV-000123) exactly as it appears, in the same digits.",
    "Preserve the original punctuation and capitalisation style.",
    "If the text is a proper name, a code, or has no meaningful translation,",
    "return it unchanged.",
  ].join("\n");
}

/**
 * Tidy a reply. Models wrap short answers in quotes often enough that the
 * quotes would end up printed on invoices.
 */
function cleanReply(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let out = raw.trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    const pairs: Record<string, string> = { '"': '"', "'": "'", "«": "»", "“": "”" };
    if (pairs[first] === last) out = out.slice(1, -1).trim();
  }
  return out || null;
}

/**
 * The response-JSON path of one jsonb line item's description.
 *
 * One function, because the write path, the read path and the sweep's SQL all
 * have to agree on this string exactly — a name built twice is a name that
 * drifts, and the symptom would be translations stored under keys nothing reads.
 */
export function itemDescriptionField(index: number): string {
  return `items.${index}.description`;
}

/**
 * The translatable fields of a `simple_invoices.items` jsonb array, keyed by
 * the path a UI would use to reach the same value in the response.
 *
 * Exported because the billing controller needs the identical mapping on both
 * the write path (what to queue) and the read path (what to look up), and the
 * two drifting apart would mean translations stored under keys nothing reads.
 */
export function itemDescriptionFields(items: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(items)) return out;
  items.forEach((it: any, i: number) => {
    const d = it?.description;
    if (typeof d === "string" && d.trim()) out[itemDescriptionField(i)] = d;
  });
  return out;
}

/**
 * `@Global` so that any module can inject `TranslationService` without first
 * importing a module — same reasoning as `LoggingModule`. The point of an
 * entity-agnostic layer is that pointing it at contracts or maintenance is one
 * constructor parameter and two call sites, not a module graph change.
 */
@Global()
@Module({
  providers: [TranslationService],
  exports: [TranslationService],
})
export class TranslationModule {}
