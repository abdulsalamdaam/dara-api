import { BlockList, isIP } from "node:net";

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
 * How we know who is calling (2026-10-28, after the origin was found answering
 * requests that never went through Cloudflare):
 *
 *  1. The **peer** is the address that actually opened the TCP connection to
 *     Traefik. Traefik trusts no upstream (`forwardedHeaders.trustedIPs` is
 *     unset), so it strips any `x-real-ip` the caller sent and writes the peer
 *     there itself. That header is therefore NOT attacker-controlled on the
 *     path we run. Without Traefik (local dev) the socket is the peer.
 *  2. If the peer is a **Cloudflare edge**, the client is `cf-connecting-ip` —
 *     Cloudflare overwrites it on every request it proxies.
 *  3. Otherwise the peer IS the client, and `cf-connecting-ip` /
 *     `x-forwarded-for` are ignored: anyone can type them. Before this, a
 *     request sent straight to the origin IP could name a fresh address on
 *     every attempt and get a fresh OTP / login rate-limit bucket each time.
 *
 * The server firewall now only lets Cloudflare reach 80/443 (ufw
 * `after.rules`, DOCKER-USER), so in production case 3 should not happen at
 * all; this is the second lock in case that rule is ever lost.
 *
 * Every value is still checked with `isIP`: a value that is not an IP address
 * is discarded rather than stored or used as a rate-limit key, so a header
 * cannot smuggle a 4KB string, a SQL fragment or a wildcard into a throttler
 * bucket or a log column.
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
 * Cloudflare's edge ranges — https://www.cloudflare.com/ips-v4 and /ips-v6,
 * fetched 2026-10-28. The server firewall carries the same v4 list; if
 * Cloudflare adds a range, update both. A missing range here is not an outage,
 * only those users sharing their edge's rate-limit bucket; a missing range in
 * the firewall IS one.
 */
const CLOUDFLARE_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22],
  ["141.101.64.0", 18], ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20],
  ["197.234.240.0", 22], ["198.41.128.0", 17], ["162.158.0.0", 15], ["104.16.0.0", 13],
  ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22],
  ["2400:cb00::", 32], ["2606:4700::", 32], ["2803:f800::", 32], ["2405:b500::", 32],
  ["2405:8100::", 32], ["2a06:98c0::", 29], ["2c0f:f248::", 32],
];

const cloudflare = new BlockList();
for (const [net, prefix] of CLOUDFLARE_RANGES) {
  cloudflare.addSubnet(net, prefix, isIP(net) === 6 ? "ipv6" : "ipv4");
}

/** Whether a (normalized) address belongs to a Cloudflare edge. */
export function isCloudflareIp(ip: string): boolean {
  // `::ffff:1.2.3.4` is how a v4 peer shows up on a dual-stack socket.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return cloudflare.check(mapped[1]!, "ipv4");
  const family = isIP(ip);
  if (family === 0) return false;
  return cloudflare.check(ip, family === 6 ? "ipv6" : "ipv4");
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
  const peer =
    normalizeIp(headerValue(headers["x-real-ip"])) ??
    normalizeIp(req?.socket?.remoteAddress);
  if (!peer) return "unknown";
  if (isCloudflareIp(peer)) {
    return normalizeIp(headerValue(headers["cf-connecting-ip"])) ?? peer;
  }
  return peer;
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
