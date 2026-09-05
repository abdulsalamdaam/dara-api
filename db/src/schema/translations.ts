import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The second language of a piece of user-typed free text.
 *
 * The product is bilingual but its DATA is not: a landlord types a line item
 * as «إيجار شهر مارس» and the English-reading tenant is shown Arabic, while an
 * English-typed note reaches an Arabic-reading landlord untranslated. There is
 * exactly one stored string per field and no place to put the other one.
 *
 * Deliberately NOT `name_en` columns next to each field. The first consumer is
 * invoices, but the same problem exists on contracts, maintenance requests and
 * support tickets, and a column-per-field answer has to be re-cut for every one
 * of them — a new column, a new migration, a new write path, a new response
 * shape. So the row is keyed by
 *
 *     (entity_type, entity_id, field, lang)
 *
 * and pointing this at another table is wiring, not a rebuild: name the entity,
 * name the field, call `ensureTranslation`.
 *
 * `field` is the name the JSON RESPONSE uses, not the database column — `name`,
 * `notes`, `instructionNote` — because the only reader is a UI that has the
 * JSON in hand. A field inside a jsonb array carries its path:
 * `items.0.description`.
 *
 * `entity_id` is an integer because every table in this database has a `serial`
 * primary key. If one ever does not, that is the column to widen.
 *
 * `status`:
 *   pending — the source is recorded, the translation has not been produced yet
 *             (no `OPENAI_API_KEY`, or a sweep has yet to reach it)
 *   done    — `text` holds the translation
 *   failed  — the provider was asked and refused; `error` says why. Retried by
 *             the next sweep or the next save of the same field, until
 *             `attempts` reaches the ceiling — a refusal that repeats is not a
 *             reason to keep paying.
 *   skipped — there is nothing to translate: the source is empty, or
 *             `detectLanguage` found no language in it (a bare number, a
 *             currency amount, an em dash). Stored rather than left absent so a
 *             sweep does not re-examine the same untranslatable row forever;
 *             `lang` and `source_lang` are `und` on these.
 *
 * `source_hash` is what keeps the cost bounded: the provider is called only
 * when the source text has actually changed. It is also what keeps a stale
 * translation from being SERVED — the read path re-hashes the live text and
 * ignores any row that disagrees with it, so an edited line item shows the
 * original rather than the previous translation whether or not the background
 * prune in `ensureTranslation` ever ran. The sweep computes the same hash in
 * SQL (`encode(sha256(convert_to(btrim(…), 'UTF8')), 'hex')`) so that it can
 * find and repair such a row.
 *
 * **No foreign keys**, for the same reason `app_logs` has none: this table
 * refers to eleven different tables by name and cannot constrain against all of
 * them, and a translation must never be the reason a delete fails. Orphans are
 * harmless — nothing reads a row whose entity is gone — and the sweep only ever
 * walks live rows.
 *
 * Created by `src/database/bootstrap.ts`, not by a migration file — that is how
 * every additive change in this repo ships.
 */
export const translationsTable = pgTable("translations", {
  id: serial("id").primaryKey(),
  /** The table the text lives on, in its database name: `invoice_lines`, `simple_invoices`. */
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  /** The response-JSON path of the field, e.g. `name`, `notes`, `items.0.description`. */
  field: text("field").notNull(),
  /** `ar` | `en` | `und` — the language the user typed in, as detected. */
  sourceLang: text("source_lang").notNull(),
  /** sha256 of the source text. Unchanged hash ⇒ never ask the provider again. */
  sourceHash: text("source_hash").notNull(),
  /** `ar` | `en` | `und` — the language `text` is written in. */
  lang: text("lang").notNull(),
  /** The translation. Null while pending/failed/skipped. */
  text: text("text"),
  /** `openai`, once one has answered. */
  provider: text("provider"),
  model: text("model"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  /**
   * How many times this source text has been sent to the provider.
   *
   * The ceiling on a `failed` row. Without it a refusal is a standing order: a
   * field the provider will never accept is asked again on every save and every
   * sweep, at full price, for ever. A retry that cannot succeed on a second try
   * — a 400, a truncated reply — is recorded straight at the ceiling. An edit to
   * the source drops the row, so a new text always starts at zero.
   */
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // One row per target language per field — the upsert target.
  byEntityFieldLang: uniqueIndex("translations_entity_field_lang_idx")
    .on(t.entityType, t.entityId, t.field, t.lang),
  // The bulk read a list view does: every field of every row on the page.
  byEntity: index("translations_entity_idx").on(t.entityType, t.entityId),
  // The sweep's entry point: find what is pending or failed.
  byStatus: index("translations_status_idx").on(t.status),
}));

export type Translation = typeof translationsTable.$inferSelect;
