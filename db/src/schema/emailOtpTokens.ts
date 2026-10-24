import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";

/**
 * Short-lived email-OTP login codes. We store the *bcrypt hash* of the code
 * (never the plaintext) along with an explicit expiry so a stolen DB dump
 * doesn't grant attackers active codes.
 *
 * One row per (email, attempt). New requests soft-rotate by writing a new
 * row + ignoring older ones. A nightly cleanup (or cron-style passive) can
 * drop rows where expiresAt < now() - 1 day.
 */
export const emailOtpTokensTable = pgTable("email_otp_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  /** bcrypt hash of the 6-digit code. Never stored in plaintext. */
  codeHash: text("code_hash").notNull(),
  /** Brute-force counter. After 5 wrong attempts on the same row we burn it. */
  attempts: integer("attempts").notNull().default(0),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * What the code is for (migration 0085): 'login' (default — every row before
   * 0085) or 'email_change', where `email` is the NEW address and `userId` the
   * account asking to move to it. Login queries filter on 'login' so a change
   * code can never sign anybody in.
   */
  purpose: text("purpose").notNull().default("login"),
  userId: integer("user_id"),
}, (t) => ({
  byEmail: index("email_otp_tokens_email_idx").on(t.email, t.expiresAt),
}));

export type EmailOtpToken = typeof emailOtpTokensTable.$inferSelect;
