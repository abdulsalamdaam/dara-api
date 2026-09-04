import { isIP } from "node:net";

/**
 * Who the caller actually is — one definition, used everywhere.
 *
 * There were three copies of this (auth's `clientCtx`, the throttler's
 * `getTracker`, the contact form), all reading the first entry of
 * `x-forwarded-for`. Behind Cloudflare that entry is **Cloudflare's own edge**,
 * so every IP we have ever stored in `login_logs`, `phone_otp_tokens` and
 * `contact_submissions` is a `172.69.x.x` address belonging to us, not to the
 * user. It also weakened the per-IP rate limit: thousands of unrelated users
 * share one edge address, so they shared one bucket.
 *
 * Precedence, most trustworthy first:
 *
 *  1. `cf-connecting-ip` — Cloudflare rewrites this on every request it
 *     proxies and it is the only header on that path that names the origin.
 *  2. `x-real-ip` — what a plain nginx/Traefik hop in front of us sets.
 *  3. the first entry of `x-forwarded-for` — the original client, per the
 *     convention that each hop appends itself.
 *  4. `req.socket.remoteAddress` — the truth when nothing is in front of us
 *     (local dev, a direct container hit).
 *
 * **Every one of the first three is attacker-controlled.** We are behind
 * Cloudflare, which overwrites `cf-connecting-ip`, so in production the header
 * we prefer is the one we can trust — but nothing stops a request that reaches
 * the container directly from inventing all three. Hence the `isIP` check: a
 * value that is not an IP address is discarded rather than stored or used as a
 * rate-limit key. A forged header can still name *someone else's* IP; what it
 * cannot do is smuggle a 4KB string, a SQL fragment or a wildcard into a
 * throttler bucket or a log column.
 *
 * `trust proxy` is deliberately NOT the mechanism. Express's `req.ip` would
 * need the hop count configured correctly and still would not know about
 * `cf-connecting-ip`.
 */

/** Only the shape we read, so a test can pass a plain object. */
export type IpRequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
};

/** Longest user agent we keep. Matches what `contact_submissions` already stored. */
export const MAX_USER_AGENT_CHARS = 400;

function headerValue(raw: string | string[] | undefined): string | undefined {
  // Node hands a repeated header over as an array. The first occurrence is the
  // one the nearest trusted hop set.
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Reduce one candidate to a bare IP address, or null if it is not one.
 *
 * Handles the two shapes a real proxy emits that `isIP` alone rejects:
 * `1.2.3.4:56789` (a v4 address with the source port appended) and
 * `[2001:db8::1]:443` (the bracketed v6 form). An IPv4-mapped v6 address
 * (`::ffff:1.2.3.4`) is left exactly as it arrived — it is a valid address and
 * rewriting it would make two spellings of one client look like two clients.
 */
function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  if (!v) return null;
  // Bounded before any further work: an unbounded header must never become an
  // unbounded regex input.
  if (v.length > 64) return null;

  const bracketed = /^\[(.+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed) v = bracketed[1]!;

  if (isIP(v)) return v;

  // `host:port`, but only when the host half has no other colon — otherwise
  // this is a bare IPv6 address and the last colon is part of it.
  const lastColon = v.lastIndexOf(":");
  if (lastColon > 0 && v.indexOf(":") === lastColon) {
    const host = v.slice(0, lastColon);
    if (isIP(host)) return host;
  }
  return null;
}

/**
 * The client's IP address, or the string `"unknown"` when nothing usable was
 * sent. `"unknown"` rather than null because both call sites that store it
 * (login logs, contact submissions) and the throttler tracker want a string,
 * and lumping the unidentifiable together in one bucket is the safe default
 * for a rate limit.
 */
export function clientIp(req: IpRequestLike | null | undefined): string {
  const headers = req?.headers ?? {};
  const candidates: Array<string | null | undefined> = [
    headerValue(headers["cf-connecting-ip"]),
    headerValue(headers["x-real-ip"]),
    headerValue(headers["x-forwarded-for"])?.split(",")[0],
    req?.socket?.remoteAddress,
  ];
  for (const candidate of candidates) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }
  return "unknown";
}

/**
 * The client's user agent, trimmed and capped, or null.
 *
 * Capped because it is a header: nothing stops a 8KB value, and it is written
 * to a `text` column and to a log line. 400 characters is what the contact
 * form already truncated to and is longer than any real UA string.
 */
export function clientUserAgent(req: IpRequestLike | null | undefined): string | null {
  const raw = headerValue(req?.headers?.["user-agent"]);
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, MAX_USER_AGENT_CHARS);
  return v || null;
}
