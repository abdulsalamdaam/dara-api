/**
 * An X handle as the admin types or pastes it → the stored form.
 *
 * Accepts `@SAMA_GOV`, `sama_gov`, `https://x.com/SAMA_GOV`,
 * `twitter.com/SAMA_GOV/status/123`, `x.com/SAMA_GOV?s=20`, and returns
 * `sama_gov`. Returns null when what is left is not a valid handle
 * (`^[a-z0-9_]{1,15}$`), so the caller can 400 with a specific message.
 */
export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

const RESERVED_PATHS = new Set(["home", "i", "search", "explore", "intent", "share", "hashtag", "settings", "notifications", "messages"]);

export function normaliseHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;

  const url = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i);
  if (url) s = url[1];
  else if (/^(?:https?:\/\/)/i.test(s)) return null; // some other site

  s = s.replace(/^@+/, "").toLowerCase();
  if (RESERVED_PATHS.has(s)) return null;
  return HANDLE_RE.test(s) ? s : null;
}
