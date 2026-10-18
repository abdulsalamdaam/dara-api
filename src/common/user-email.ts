import { ConflictException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { usersTable } from "@dara/database";

/**
 * One email, one account.
 *
 * An email address identifies exactly one `users` row — an individual, a
 * company's General Manager, or an employee under a company. It is the login
 * (email OTP), so two rows sharing it would make "who is logging in" a coin
 * toss.
 *
 * Every path that writes `users.email` funnels through `normalizeEmail()` and
 * `assertEmailAvailable()`, and every lookup by email uses `emailMatches()`:
 *
 *   - stored form is trimmed + lower-cased;
 *   - lookups compare `lower(email)`, so a legacy row stored with capitals is
 *     still found (and, after migration 0081, served by its unique index);
 *   - the availability check covers SOFT-DELETED rows too. The old
 *     `users_email_unique` constraint never ignored them, so a deleted
 *     employee's address used to pass the app check and then 500 on the
 *     insert. It now gets the same clear 409 as a live duplicate.
 *
 * The DB constraint is still the last word on a race: two simultaneous
 * registrations both pass the check, one insert wins, and the loser's unique
 * violation is translated by `isEmailUniqueViolation()` into the same 409.
 */

export const EMAIL_TAKEN_CODE = "EMAIL_TAKEN";
export const EMAIL_TAKEN_MESSAGE =
  "البريد الإلكتروني مسجّل مسبقاً لحساب آخر · This email is already registered to another account";

/** Trimmed + lower-cased, or "" when there is nothing there. */
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** `lower(users.email) = <normalised>` — the case-insensitive lookup. */
export function emailMatches(normalized: string): SQL {
  return sql`lower(${usersTable.email}) = ${normalized}`;
}

/**
 * The 409 body. `error` stays the machine code the web register form already
 * reads (`err.data.error === "EMAIL_TAKEN"`), `code` matches the other coded
 * errors, `message` is what `apiErrorMessage()` shows.
 */
export function emailTakenException(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: EMAIL_TAKEN_CODE,
    code: EMAIL_TAKEN_CODE,
    message: EMAIL_TAKEN_MESSAGE,
  });
}

type Selectable = {
  select: (...a: any[]) => any;
};

/**
 * Throws the 409 when any `users` row other than `exceptUserId` — live or
 * soft-deleted — already carries this email (case-insensitive).
 */
export async function assertEmailAvailable(db: Selectable, normalized: string, exceptUserId?: number): Promise<void> {
  const rows: Array<{ id: number }> = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(emailMatches(normalized))
    .limit(2);
  if (rows.some((r) => r.id !== exceptUserId)) throw emailTakenException();
}

/**
 * True for a Postgres unique violation on a users email index
 * (`users_email_unique`, `users_email_lower_unique`). Drizzle 0.45 wraps the
 * driver error, so the pg error may sit on `.cause`.
 */
export function isEmailUniqueViolation(err: unknown): boolean {
  for (let e: any = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code === "23505") {
      const where = `${e.constraint ?? ""} ${e.detail ?? ""} ${e.message ?? ""}`;
      return /email/i.test(where);
    }
  }
  return false;
}
