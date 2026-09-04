/**
 * What may and may not be written into a log row.
 *
 * A debug log that leaks OTP codes is worse than no debug log: `app_logs` is
 * readable by every super-admin, survives the container it was written in, and
 * — unlike the request it describes — is never rotated by anything but the
 * retention sweep. Anything in here that authenticates a person must be gone
 * before the row is built, not before it is displayed.
 *
 * The redactor is deliberately **key-first and value-second**. Key rules catch
 * the fields we know about; the value rules catch the same secret arriving
 * under a name nobody predicted (`{ h: "Bearer eyJ…" }`), which is the failure
 * mode a pure allowlist of key names has every time.
 *
 * Everything here is pure and dependency-free so it can be tested without a
 * database, a Nest context or a request.
 */

export const REDACTED = "[redacted]";

/** Caps. Small enough that one pathological request cannot fill the table. */
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_ERROR_CHARS = 4_000;
export const MAX_STACK_CHARS = 8_000;
export const MAX_META_CHARS = 20_000;

/** How deep into a nested object the redactor walks before giving up. */
const MAX_DEPTH = 6;
/** How many entries of one array or object survive. */
const MAX_ENTRIES = 60;
/** Longest single string kept inside `meta`. */
const MAX_META_STRING = 2_000;

/**
 * Substrings that make a field name a secret wherever they appear in it.
 * Matched against the name with `_`, `-` and `.` removed and lowercased, so
 * `X-Api-Key`, `api_key` and `apiKey` are one rule rather than three.
 */
const SECRET_SUBSTRINGS = [
  "authorization",
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "cookie",
  "otp",
  "passcode",
  "csrf",
  "bearer",
  "signature",
  "mnemonic",
  "cvv",
  "cardnumber",
  "clientsecret",
  "sessionid",
];

/**
 * Words that make a field name a secret when the name ENDS with them.
 *
 * Kept separate from the substring list because these over-match anywhere
 * else: matched as a suffix of the string, `key` makes `monkey` a secret. They
 * are therefore matched against the last WORD of the name (see `keyWords`), so
 * `apiKey`, `api_key` and `APP_ENCRYPTION_KEY` all hit and `monkey` does not.
 */
const SECRET_SUFFIXES = ["key", "secret", "token", "code", "hash", "salt", "pin"];

/**
 * The only names allowed through a suffix rule.
 *
 * Every entry here is a value that is structurally incapable of being a
 * credential — an HTTP status, an ISO country. **Do not add a name to this
 * list to make a log more readable.** The suffix rules exist because the next
 * secret will be called something nobody thought of, and each exemption is a
 * hole punched in that.
 */
const SUFFIX_EXEMPT = new Set([
  "statuscode",
  "httpcode",
  "errorcode",
  "countrycode",
  "currencycode",
  "postalcode",
  "zipcode",
  "areacode",
  "languagecode",
]);

function normalizeKey(key: string): string {
  return key.replace(/[-_.\s]/g, "").toLowerCase();
}

/**
 * A field name split into its words, so a suffix rule can mean "the last WORD
 * is `key`" rather than "the string ends in the letters k-e-y". Without this
 * `monkey` is a secret and `apiKey` and `APP_ENCRYPTION_KEY` have to be spelled
 * out one by one.
 *
 * Handles the three conventions that actually appear here: `snake_case`,
 * `kebab-case` / dotted header names, and `camelCase` — plus `APIKey`, where
 * the boundary is between a run of capitals and a capitalised word.
 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Is this field name one whose VALUE must never be written down? */
export function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  if (!k) return false;
  if (SECRET_SUBSTRINGS.some((s) => k.includes(s))) return true;
  if (SUFFIX_EXEMPT.has(k)) return false;
  const words = keyWords(key);
  const last = words[words.length - 1];
  return !!last && SECRET_SUFFIXES.includes(last);
}

/**
 * Does this string look like a credential regardless of what it was called?
 *
 * Three shapes, each of which is a secret in every context we produce one:
 * an `Authorization` header value, a JWT (ours and Moyasar's both), and a PEM
 * block (the ZATCA private keys and CSIDs).
 */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^(bearer|basic|digest)\s+\S/i.test(v)) return true;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
  if (v.includes("-----BEGIN")) return true;
  return false;
}

/**
 * Postgres rejects a NUL byte in `text` and in `jsonb`, and external payloads
 * carry them often enough that this has already bitten the Ejar log. Same
 * approach as `ejar.log.service.ts`: round-trip through JSON so nested strings
 * are cleaned too, and fall back to the input rather than throwing.
 */
export function stripNul<T>(value: T): T {
  try {
    if (typeof value === "string") return value.replace(/\0/g, "") as unknown as T;
    if (value == null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value).replace(/\\u0000/g, "")) as T;
  } catch {
    return value;
  }
}

/**
 * Cut a string to `max`, saying so rather than trimming silently — a stack
 * that ends mid-frame with no marker reads as a stack that ended there.
 */
export function truncate(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = typeof value === "string" ? value : String(value);
  const clean = s.replace(/\0/g, "");
  if (clean.length <= max) return clean || null;
  return `${clean.slice(0, max)}…[truncated ${clean.length - max} chars]`;
}

/**
 * A deep copy of `value` with every secret replaced by `[redacted]`.
 *
 * The KEY is kept. Knowing that an `authorization` header was present, and
 * that a `password` field was in the body, is most of what the log is for; the
 * value is the only part that must not survive.
 *
 * Also bounded: depth, entry count and string length, so a request carrying a
 * megabyte of JSON cannot turn into a megabyte of `meta`.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null) return value ?? null;

  if (typeof value === "string") {
    if (looksSecret(value)) return REDACTED;
    return value.length > MAX_META_STRING
      ? `${value.slice(0, MAX_META_STRING)}…[truncated ${value.length - MAX_META_STRING} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  // A function or a symbol in a log payload is a mistake, not data.
  if (typeof value !== "object") return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, MAX_ERROR_CHARS),
      stack: truncate(value.stack, MAX_STACK_CHARS),
    };
  }
  // A Buffer's contents are as likely to be a key as anything else, and its
  // JSON form is a useless array of byte integers either way.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[buffer ${value.length} bytes]`;
  }

  if (depth >= MAX_DEPTH) return "[depth limit]";
  // A cycle is not exotic here: an Express request, a pg error and a Nest
  // exception all hold one, and any of the three can be handed to `meta`.
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ENTRIES).map((v) => redactInner(v, depth + 1, seen));
    if (value.length > MAX_ENTRIES) out.push(`[+${value.length - MAX_ENTRIES} more]`);
    return out;
  }

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_ENTRIES) {
      out["[truncated]"] = `${Object.keys(value as object).length - MAX_ENTRIES} more keys`;
      break;
    }
    n += 1;
    out[k] = isSecretKey(k) ? REDACTED : redactInner(v, depth + 1, seen);
  }
  return out;
}

/**
 * `meta` as it goes into the `jsonb` column: redacted, NUL-free and under the
 * size cap. Past the cap the object is replaced wholesale rather than trimmed
 * key by key — half an object is a worse artefact to read than a note saying
 * it was too big.
 */
export function prepareMeta(meta: unknown): Record<string, unknown> | null {
  if (meta == null) return null;
  try {
    const redacted = stripNul(redact(meta));
    if (redacted == null) return null;
    const wrapped: Record<string, unknown> =
      typeof redacted === "object" && !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : { value: redacted };
    const json = JSON.stringify(wrapped);
    if (json && json.length > MAX_META_CHARS) {
      return { _truncated: true, _bytes: json.length, preview: json.slice(0, 2_000) };
    }
    return wrapped;
  } catch (err) {
    // Non-serialisable meta must not cost the caller its log row.
    return { _unserializable: String((err as Error)?.message ?? err) };
  }
}
