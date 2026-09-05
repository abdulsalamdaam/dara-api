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

/** Bounds the reply as well as the request — a translation cannot be much longer than its source. */
const MAX_OUTPUT_TOKENS = 1_000;

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

/** The key `getFor` builds and the UI reads. Exported so nobody has to guess the separator. */
export function translationKey(entityType: string, entityId: number, field: string): string {
  return `${entityType}:${entityId}:${field}`;
}

/* ── Statuses ───────────────────────────────────────────────────────────── */

/**
 * Nothing more to do for this field until its source text changes.
 *
 * A SQL literal rather than a bound parameter because the sweep's `left join`
 * needs it inside a raw fragment, and `status = any($1)` there gives Postgres
 * no type to infer the array from. It is a compile-time constant; nothing off
 * a request goes near it.
 */
const SETTLED_SQL = "('done', 'skipped')";
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
  /** Fields the provider refused or could not be reached for — retried by the next sweep. */
  failed: number;
}

/* ── Service ────────────────────────────────────────────────────────────── */

/**
 * Stores the second language of user-typed free text.
 *
 * Three rules govern everything in here:
 *
 *  1. **Nothing blocks a request.** `queue()` returns `void` and the work
 *     happens after the response has gone. `ensureTranslation` never throws,
 *     whatever the provider or the database does — the same discipline as
 *     `safeLog` in `ejar.client.service.ts` and `AppLogService.record`. An
 *     OpenAI outage must never turn a working save into a 500.
 *  2. **The provider is asked once per distinct source text.** `source_hash`
 *     is the whole cost-control story: re-saving an invoice, re-opening it, or
 *     sweeping it a hundred times costs one indexed SELECT each and no model
 *     call. Without it this is an unbounded bill.
 *  3. **No key is a working state, not an error.** `OPENAI_API_KEY` is not set
 *     today. Every path here has to behave correctly without it: sources are
 *     still recorded, reads still work, nothing throws, and the day a key is
 *     added `POST /admin/translations/sweep` fills in the backlog.
 */
@Injectable()
export class TranslationService {
  private readonly log = new Logger("Translation");
  /** So a missing key is reported once at the first attempt, not on every field of every invoice. */
  private warnedUnconfigured = false;

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
   * `translate`, plus the reason it failed — which the row's `error` column
   * needs and a `string | null` return cannot carry. Private because the reason
   * is only ever written to our own table.
   */
  private async callProvider(
    text: string, from: DetectedLanguage, to: DetectedLanguage,
  ): Promise<{ text: string | null; error: string | null }> {
    const key = this.apiKey;
    if (!key) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.log.warn("OPENAI_API_KEY not set — translations are recorded but not produced");
      }
      return { text: null, error: null };
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
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: "system", content: systemPrompt(from, to) },
            { role: "user", content: text },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { text: null, error: `HTTP ${res.status} ${body.slice(0, 300)}` };
      }
      const json: any = await res.json();
      const out = cleanReply(json?.choices?.[0]?.message?.content);
      if (!out) return { text: null, error: "empty reply" };
      return { text: out, error: null };
    } catch (err: any) {
      // Includes the AbortSignal timeout and every network failure. A failed
      // row is retried by the next sweep, so there is nothing to escalate.
      return { text: null, error: String(err?.message ?? err).slice(0, 300) };
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
   */
  queue(entityType: string, entityId: number | null | undefined, fields: Record<string, unknown>): void {
    if (!Number.isInteger(entityId)) return;
    for (const [field, value] of Object.entries(fields)) {
      // `ensureTranslation` already swallows everything; the catch is here so
      // that a rejection escaping a future edit cannot become an unhandled one.
      void this.ensureTranslation(entityType, entityId as number, field, value).catch(() => {});
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
  async ensureTranslation(
    entityType: string, entityId: number, field: string, sourceText: unknown,
  ): Promise<"done" | "skipped" | "failed" | "pending" | "cached" | "error"> {
    try {
      const raw = typeof sourceText === "string" ? sourceText.trim() : "";
      const hash = sha256(raw);

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
          lang: UNDETERMINED, text: null, status: "skipped",
          error: raw.length > MAX_SOURCE_CHARS ? `source too long (${raw.length} chars)` : null,
        });
        return "skipped";
      }

      const to: DetectedLanguage = from === "ar" ? "en" : "ar";
      const current = existing.find((r) => r.lang === to && r.sourceHash === hash);
      // THE cost control. Same text, already translated — do not pay again.
      if (current?.status === "done" && current.text) return "cached";

      // Written before the call, not after: if the container dies mid-request
      // the row is left `pending` with the right hash, and the sweep finishes
      // the job. `text` is deliberately not cleared — while a re-translation is
      // in flight a reader keeps seeing the previous one rather than nothing.
      await this.upsert({
        entityType, entityId, field, sourceLang: from, sourceHash: hash,
        lang: to, status: "pending", error: null,
      });

      if (!this.isConfigured()) return "pending";

      const { text, error } = await this.callProvider(raw, from, to);
      if (!text) {
        await this.upsert({
          entityType, entityId, field, sourceLang: from, sourceHash: hash,
          lang: to, status: "failed", error: error ?? "no translation returned",
        });
        return "failed";
      }
      await this.upsert({
        entityType, entityId, field, sourceLang: from, sourceHash: hash,
        lang: to, text, status: "done", error: null,
        provider: "openai", model: this.model,
      });
      return "done";
    } catch (err: any) {
      // The last line of defence. This runs after a response has been sent, so
      // an escaping rejection would be an unhandled one — and the one thing
      // that must never happen is a translation breaking a save.
      this.log.warn(`ensureTranslation(${entityType}:${entityId}:${field}) failed: ${err?.message ?? err}`);
      appLog()?.event("translation_failed", { entityType, entityId, field }, {
        level: "warn", context: "Translation", error: err,
      });
      return "error";
    }
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
   * Every stored translation for a page of rows, in ONE query.
   *
   * Built for a list view: pass the ids of the whole page rather than calling
   * this per row. `fields` narrows it; omit it for every field of those
   * entities, which is what a document with jsonb line items needs because its
   * field names (`items.0.description`, …) depend on the row.
   *
   * Only `done` rows are returned. Pending, failed and untranslatable rows are
   * bookkeeping — a UI has nothing to show for them and falls back to the
   * original text, which is exactly today's behaviour.
   */
  async getFor(entityType: string, entityIds: number[], fields?: string[]): Promise<TranslationMap> {
    const ids = [...new Set((entityIds ?? []).filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return {};
    try {
      const rows = await this.db
        .select()
        .from(translationsTable)
        .where(and(
          eq(translationsTable.entityType, entityType),
          inArray(translationsTable.entityId, ids),
          eq(translationsTable.status, "done"),
          fields?.length ? inArray(translationsTable.field, fields) : undefined,
        ));
      const map: TranslationMap = {};
      for (const r of rows as any[]) {
        if (r.lang !== "ar" && r.lang !== "en") continue;
        const key = translationKey(entityType, r.entityId, r.field);
        const entry = map[key] ?? (map[key] = { sourceLang: r.sourceLang, ar: null, en: null });
        entry[r.lang as DetectedLanguage] = r.text;
      }
      return map;
    } catch (err: any) {
      // A read of this table must not be able to break the invoice it decorates.
      // An empty map is the pre-translation behaviour: the UI shows the
      // original text, which is what it has always done.
      this.log.warn(`getFor(${entityType}) failed: ${err?.message ?? err}`);
      return {};
    }
  }

  /**
   * Put the ORIGINAL text into the map, on the side the user typed it.
   *
   * The table stores only the language that was missing — the other one is on
   * the entity itself and duplicating it would be a second copy to keep in
   * sync. So the handler that has the row in hand fills its side in, and the UI
   * receives a complete `{ ar, en }` and never has to ask which way round the
   * pair was stored.
   *
   * Also creates a bare entry when the map has no row yet, so a key that exists
   * in one language is at least present.
   */
  attachSource(map: TranslationMap, entityType: string, entityId: number, field: string, sourceText: unknown): void {
    if (typeof sourceText !== "string" || !sourceText.trim()) return;
    const key = translationKey(entityType, entityId, field);
    const from = detectLanguage(sourceText);
    if (!from) return;
    const entry = map[key];
    // The live text is the authority on which language it is in, not the row.
    // If they disagree the text was edited into the other language and the
    // stored translation is now of something else — dropping it here shows the
    // original rather than a confident lie, until the queued re-translation
    // lands.
    if (entry && entry.sourceLang === from) {
      entry[from] = sourceText;
      return;
    }
    map[key] = { sourceLang: from, ar: null, en: null, [from]: sourceText } as TranslationEntry;
  }

  /* ── Backfill ─────────────────────────────────────────────────────────── */

  /**
   * The free-text fields this layer covers, and where each one lives.
   *
   * `column` is the database column; `field` is the name the JSON response uses
   * and therefore the key a UI looks up. They differ wherever Drizzle
   * camel-cases (`instruction_note` → `instructionNote`), and the JSON name is
   * the one that is stored — the reader has the JSON, not the schema.
   *
   * The identifiers here are compiled-in constants interpolated with
   * `sql.raw`, never anything off a request.
   */
  private static readonly PLAIN_TEXT_SOURCES: ReadonlyArray<{
    table: string; entityType: string; column: string; field: string; extraWhere?: string;
  }> = [
    // The invoice line item a landlord types — the field this whole layer was built for.
    { table: "invoice_lines", entityType: "invoice_lines", column: "name", field: "name" },
    // The billing document's own free text.
    { table: "simple_invoices", entityType: "simple_invoices", column: "notes", field: "notes", extraWhere: "deleted_at is null" },
    // Its ZATCA sibling: the note on the e-invoice, and the reason on a credit/debit note.
    { table: "invoices", entityType: "invoices", column: "notes", field: "notes", extraWhere: "deleted_at is null" },
    { table: "invoices", entityType: "invoices", column: "instruction_note", field: "instructionNote", extraWhere: "deleted_at is null" },
  ];

  /**
   * Fill in what is missing, bounded by `limit`.
   *
   * This is how existing data is backfilled — there is no migration that could
   * do it, because the work is a network call per row — and how a batch that
   * failed against a provider outage is retried. Everything it calls is
   * idempotent, so running it twice is free and interrupting it loses nothing.
   *
   * Newest rows first: a document somebody is looking at this week matters more
   * than one from last year, and an interrupted sweep should have spent its
   * budget on the useful end.
   *
   * Work is done with a small amount of concurrency rather than serially, so a
   * modest limit still returns inside a proxy's timeout; and serially per row,
   * so a large limit cannot open hundreds of sockets at once.
   */
  async sweep(limit: number): Promise<SweepResult> {
    const budget = Math.max(1, Math.min(500, Math.floor(limit) || 0));
    const jobs: Array<{ entityType: string; entityId: number; field: string; text: unknown }> = [];

    for (const src of TranslationService.PLAIN_TEXT_SOURCES) {
      if (jobs.length >= budget) break;
      const remaining = budget - jobs.length;
      const rows = await this.rows(sql`
        select s.id as id, s.${sql.raw(src.column)} as text
        from ${sql.raw(src.table)} s
        left join translations t
          on t.entity_type = ${src.entityType}
         and t.entity_id = s.id
         and t.field = ${src.field}
         and t.status in ${sql.raw(SETTLED_SQL)}
        where t.id is null
          and s.${sql.raw(src.column)} is not null
          and s.${sql.raw(src.column)} <> ''
          ${src.extraWhere ? sql`and s.${sql.raw(src.extraWhere)}` : sql``}
        order by s.id desc
        limit ${remaining}
      `);
      for (const r of rows) {
        jobs.push({ entityType: src.entityType, entityId: Number(r.id), field: src.field, text: r.text });
      }
    }

    // `simple_invoices.items` is a jsonb array, so its fields are `items.0.
    // description`, `items.1.description`, … — a shape no left join can express.
    // A document is outstanding when it has FEWER settled `items.*` rows than
    // it has items, which is also what makes it converge: an item whose
    // description is a bare number settles as `skipped` and stops being counted
    // as work.
    if (jobs.length < budget) {
      const rows = await this.rows(sql`
        select s.id as id, s.items as items
        from simple_invoices s
        where s.deleted_at is null
          and s.items is not null
          and jsonb_typeof(s.items) = 'array'
          and jsonb_array_length(s.items) > 0
          and (
            select count(*) from translations t
            where t.entity_type = 'simple_invoices'
              and t.entity_id = s.id
              and t.field like 'items.%'
              and t.status in ${sql.raw(SETTLED_SQL)}
          ) < jsonb_array_length(s.items)
        order by s.id desc
        limit ${budget - jobs.length}
      `);
      for (const r of rows) {
        for (const [field, text] of Object.entries(itemDescriptionFields(r.items))) {
          jobs.push({ entityType: "simple_invoices", entityId: Number(r.id), field, text });
        }
      }
    }

    const result: SweepResult = {
      limit: budget, configured: this.isConfigured(),
      scanned: jobs.length, translated: 0, skipped: 0, failed: 0,
    };

    const queue = jobs.slice();
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const outcome = await this.ensureTranslation(job.entityType, job.entityId, job.field, job.text);
        if (outcome === "done") result.translated += 1;
        else if (outcome === "skipped") result.skipped += 1;
        else if (outcome === "failed" || outcome === "error") result.failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

    return result;
  }

  /** `db.execute` answers with an array on some drivers and `{ rows }` on others. */
  private async rows(query: any): Promise<any[]> {
    const res: any = await this.db.execute(query);
    return Array.isArray(res) ? res : (res?.rows ?? []);
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
    if (typeof d === "string" && d.trim()) out[`items.${i}.description`] = d;
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
