import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";

/**
 * Short-lived phone-OTP login codes.
 *
 * Twilio Verify held the codes for us; Taqnyat is a plain SMS gateway, so the
 * code lifecycle is ours: generate, store only the bcrypt hash, expire it,
 * count attempts, burn it on use. Same shape and same hardening as
 * `email_otp_tokens` — deliberately, because these two are the product's only
 * two login paths and they should fail the same way.
 *
 * The phone is stored NORMALISED (+9665XXXXXXXX) so a lookup can't be dodged
 * by sending 05… one time and 9665… the next.
 */
export const phoneOtpTokensTable = pgTable("phone_otp_tokens", {
  id: serial("id").primaryKey(),
  /** E.164, e.g. +966502907100. */
  phone: text("phone").notNull(),
  /** Who the code was issued to — "tenant" | "user" — so a tenant code can't
   *  be replayed against the landlord login, or the other way round. */
  purpose: text("purpose").notNull(),
  /** bcrypt hash of the code. Never stored in plaintext. */
  codeHash: text("code_hash").notNull(),
  /** Brute-force counter. After MAX_ATTEMPTS wrong tries the row is burned. */
  attempts: integer("attempts").notNull().default(0),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byPhone: index("phone_otp_tokens_phone_idx").on(t.phone, t.expiresAt),
}));

export type PhoneOtpToken = typeof phoneOtpTokensTable.$inferSelect;
