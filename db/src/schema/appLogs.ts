import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * The part of the log that survives the container.
 *
 * Everything the API knew about a failure used to die with the process that
 * printed it: an unhandled 500 wrote a stack to stdout with no request id, no
 * user and no path, and once Coolify replaced the container that was the end
 * of the evidence. Debugging a customer's problem after the fact — which is
 * the only kind of debugging that ever actually happens — needs the record to
 * outlive the process.
 *
 * Modelled on `ejar_api_logs`, which is the same idea done well: jsonb for the
 * variable part, truncation before the write, NUL-stripping, and a writer that
 * can never turn a working request into a failed one.
 *
 * Deliberately NOT every request. See `request-log.middleware.ts` for the
 * write policy — stdout carries one line per request, this table carries the
 * ones worth keeping.
 *
 * **No foreign keys.** `user_id` and `owner_user_id` are plain integers on
 * purpose: a log row must be insertable when the user has since been deleted,
 * and must never fail to insert because of a constraint on a table it only
 * refers to. It is evidence, not a relation.
 *
 * Created by `src/database/bootstrap.ts`, not by a migration file — that is
 * how every additive change in this repo ships.
 */
export const appLogsTable = pgTable("app_logs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** `error` | `warn` | `log` | `debug` | `verbose`. */
  level: text("level").notNull(),
  /** A stable name for a thing that happened, e.g. `rate_limit_rejected`. Null for a plain request row. */
  event: text("event"),
  /** Ties every row of one request together, and matches the `x-request-id` the client was given back. */
  requestId: text("request_id"),
  method: text("method"),
  /** Path only — the query string can carry a verification token. */
  path: text("path"),
  status: integer("status"),
  durationMs: integer("duration_ms"),
  userId: integer("user_id"),
  ownerUserId: integer("owner_user_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  message: text("message"),
  /** The Nest logger context, e.g. `BillingZatca` — where in the code this came from. */
  context: text("context"),
  error: text("error"),
  stack: text("stack"),
  meta: jsonb("meta"),
});

export type AppLog = typeof appLogsTable.$inferSelect;
