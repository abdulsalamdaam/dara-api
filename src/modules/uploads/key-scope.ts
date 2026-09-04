/**
 * Object-key scoping for the MinIO bucket.
 *
 * Until this file existed, an object key WAS the authorization. `GET
 * /uploads/sign?key=…` and `DELETE /uploads?key=…` took any key an
 * authenticated caller cared to name and handed back a signed URL — or
 * destroyed the object — with no check that the file had anything to do with
 * that account. The bucket holds contracts, title deeds and national-ID scans,
 * so "whoever has seen the key" is the wrong access list: a former employee, a
 * tenant who was sent a link, or a key pasted into a support ticket keeps
 * permanent read and delete access to somebody else's documents.
 *
 * Keys minted from now on carry the caller's account scope:
 *
 *     acct/<scopeId>/<folder>/<file>
 *
 * `scopeId` is `common/scope.ts`'s — an employee shares their owner's scope,
 * which is exactly right here: the whole account can already read every one of
 * these documents through the ordinary endpoints.
 *
 * Everything in this file is pure so it can be tested without a bucket or a
 * database; the legacy-key half of the decision lives in `key-access.service`.
 */

/** First segment of every scoped key. */
export const ACCOUNT_KEY_PREFIX = "acct";

/**
 * Longest key we will mint or accept. S3/MinIO allows 1024 bytes; ours are
 * `folder/<timestamp>-<uuid>.ext` and nowhere near it. The cap exists so a
 * multi-kilobyte query string cannot be pushed through the classifier and into
 * a database lookup.
 */
export const MAX_KEY_LENGTH = 512;

/** Control characters and NUL (which truncate strings in some layers), and the
 *  Windows separator (which a path-normalizing layer may treat as a `/`). */
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/** A `.` or `..` as a WHOLE path segment — the only shape that can climb. */
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;

/**
 * A percent-encoded dot. Nothing we write produces one, and a key is compared
 * as a literal string here but may be decoded by something downstream, so
 * `acct/2/%2e%2e/3/x.pdf` is refused rather than reasoned about.
 */
const ENCODED_DOT = /%2e/i;

export type KeyScopeVerdict =
  /** Carries the caller's own `acct/<scopeId>/` prefix. */
  | { kind: "own" }
  /** Carries somebody else's `acct/<n>/` prefix. */
  | { kind: "foreign"; scopeId: number }
  /** No `acct/` prefix at all — minted before this change; needs attribution. */
  | { kind: "legacy" }
  /** Malformed, traversal-shaped, or too long. Never allowed, never looked up. */
  | { kind: "invalid"; reason: string };

/** `acct/7/` — the prefix every key minted for scope 7 starts with. */
export function accountKeyPrefix(scopeId: number): string {
  return `${ACCOUNT_KEY_PREFIX}/${scopeId}/`;
}

/**
 * Reduce a caller-supplied folder to something that cannot escape (or reshape)
 * the account prefix it will be appended to. Callers pass free-form folders
 * (`maintenance/123`, `payment-confirmations/88`), so this keeps the slashes
 * but drops everything that could be read as navigation.
 */
export function sanitizeFolder(folder?: string | null): string {
  return (folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim().replace(/[\u0000-\u001f\u007f]/g, "").replace(/%2e/gi, ""))
    // "." and ".." are dropped entirely rather than escaped: there is no
    // legitimate folder by either name, so silently ignoring them is safe.
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
}

/**
 * The folder a new upload for `scopeId` must land in. Always prefixed, so the
 * key that comes back is self-describing and needs no database lookup to
 * authorize later.
 */
export function scopedFolder(scopeId: number, folder?: string | null): string {
  const clean = sanitizeFolder(folder);
  const base = `${ACCOUNT_KEY_PREFIX}/${scopeId}`;
  return clean ? `${base}/${clean}` : base;
}

/** Structural validity only — says nothing about who owns the object. */
export function keyShapeError(key: string): string | null {
  if (typeof key !== "string") return "not a string";
  if (key.length === 0) return "empty";
  if (key.length > MAX_KEY_LENGTH) return "too long";
  if (key !== key.trim()) return "leading or trailing whitespace";
  if (CONTROL_OR_BACKSLASH.test(key)) return "control character or backslash";
  if (key.startsWith("/")) return "absolute";
  if (key.includes("//")) return "empty path segment";
  if (DOT_SEGMENT.test(key)) return "path traversal";
  if (ENCODED_DOT.test(key)) return "encoded path traversal";
  return null;
}

/**
 * Decide what a key is, relative to the caller's scope.
 *
 * Note the ORDER: the shape is checked before the prefix, so
 * `acct/2/../3/x.pdf` is rejected as traversal and never gets to enjoy the
 * fact that it starts with `acct/2/`. A `startsWith` test on its own would
 * have let it through.
 */
export function classifyKey(key: string, callerScopeId: number): KeyScopeVerdict {
  const shape = keyShapeError(key);
  if (shape) return { kind: "invalid", reason: shape };

  if (!key.startsWith(`${ACCOUNT_KEY_PREFIX}/`)) return { kind: "legacy" };

  const rest = key.slice(ACCOUNT_KEY_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  // `acct/7` and `acct/7/` name a prefix, not an object: nothing to sign and
  // nothing well-defined to delete.
  if (slash <= 0 || slash === rest.length - 1) {
    return { kind: "invalid", reason: "scoped key with no object path" };
  }

  const scopeText = rest.slice(0, slash);
  // Strictly digits: `acct/07/` and `acct/7 /` must not compare equal to
  // `acct/7/` after a Number() coercion.
  if (!/^[1-9][0-9]*$/.test(scopeText)) return { kind: "invalid", reason: "malformed scope segment" };

  const scope = Number(scopeText);
  if (!Number.isSafeInteger(scope)) return { kind: "invalid", reason: "malformed scope segment" };

  return scope === callerScopeId ? { kind: "own" } : { kind: "foreign", scopeId: scope };
}
