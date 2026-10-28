import { UnauthorizedException } from "@nestjs/common";

/**
 * Single active session per account.
 *
 * A login is the only thing that mints a session, and every successful
 * interactive login bumps the account's `token_version` and signs the new token
 * with the bumped value (atomically, `UPDATE … RETURNING`). Every token minted
 * before it carries an older `tv` and the guard refuses it. So one account is
 * one session: signing in on a second device signs the first one out.
 *
 * The guard only sees "this token's tv is stale", which is also what a logout,
 * an admin force-logout or a password reset produce. To tell the old device
 * WHY, the token carries `loginAt` (ms, equal to the `last_login_at` the login
 * wrote). If the account's `last_login_at` is later than the token's own
 * login, someone signed in after it: SESSION_REPLACED. Otherwise the session
 * was ended on purpose: SESSION_REVOKED.
 *
 * Both are 401s whose `message` still starts with the old
 * "Session revoked. Please log in again." text, so any client matching on it
 * keeps working; new clients read `code`.
 */

export const SESSION_REVOKED_CODE = "SESSION_REVOKED";
export const SESSION_REPLACED_CODE = "SESSION_REPLACED";

export const SESSION_REVOKED_MESSAGE = "Session revoked. Please log in again.";
export const SESSION_REPLACED_MESSAGE =
  "Session revoked. Please log in again. · تم تسجيل خروجك لأن هذا الحساب سجّل الدخول من جهاز آخر · You were signed out because this account signed in on another device.";

export interface SessionClaims {
  tv?: number;
  /**
   * "mobile" on a token minted by the app's phone-OTP login. Its `tv` is the
   * account's mobile_token_version, which logins never bump: the app does not
   * count toward the single session (owner decision, 28 Oct 2026).
   */
  ch?: "mobile";
  /** ms epoch of the login that minted this token (absent on pre-change tokens). */
  loginAt?: number;
  /** jsonwebtoken's issued-at, seconds. */
  iat?: number;
}

export interface SessionRow {
  tokenVersion: number | null;
  lastLoginAt: Date | string | null;
  /** users only — the app's own counter (0093). Absent for tenants. */
  mobileTokenVersion?: number | null;
}

/** True when the token's version is still the account's current one. */
export function sessionIsCurrent(claims: SessionClaims, row: SessionRow): boolean {
  if (claims.ch === "mobile") return (claims.tv ?? 0) === (row.mobileTokenVersion ?? 0);
  return (claims.tv ?? 0) === (row.tokenVersion ?? 0);
}

/**
 * Was this (stale) token displaced by a later login rather than revoked?
 *
 * Tokens minted before `loginAt` existed fall back to `iat`, which is whole
 * seconds and set a moment AFTER `last_login_at` was written — so a login only
 * counts as later when it is at least a full second past `iat`.
 */
export function wasReplacedByLaterLogin(claims: SessionClaims, row: SessionRow): boolean {
  if (!row.lastLoginAt) return false;
  const last = new Date(row.lastLoginAt).getTime();
  if (!Number.isFinite(last)) return false;
  if (typeof claims.loginAt === "number" && Number.isFinite(claims.loginAt)) return last > claims.loginAt;
  if (typeof claims.iat === "number") return last >= (claims.iat + 1) * 1000;
  return false;
}

export function staleSessionException(claims: SessionClaims, row: SessionRow): UnauthorizedException {
  // A mobile token is never displaced by a login — only revoked on purpose.
  if (claims.ch !== "mobile" && wasReplacedByLaterLogin(claims, row)) {
    return new UnauthorizedException({
      statusCode: 401,
      error: SESSION_REPLACED_CODE,
      code: SESSION_REPLACED_CODE,
      message: SESSION_REPLACED_MESSAGE,
    });
  }
  return new UnauthorizedException({
    statusCode: 401,
    error: "Unauthorized",
    code: SESSION_REVOKED_CODE,
    message: SESSION_REVOKED_MESSAGE,
  });
}
