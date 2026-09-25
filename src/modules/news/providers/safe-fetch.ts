import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";

/**
 * GET an admin-supplied URL without letting it reach inside our network (SSRF).
 *
 * An admin types a feed URL; the API fetches it from inside Coolify, next to
 * Postgres, the Docker host and the cloud metadata endpoint. So:
 *
 *  - http/https only, no userinfo, ports 80/443 only;
 *  - the host is resolved and EVERY address is checked against the private,
 *    loopback, link-local, CGNAT, multicast and reserved ranges (v4 + v6,
 *    including v4-mapped v6). The check runs inside the socket's own `lookup`,
 *    so the address checked is the address connected to — a DNS answer that
 *    changes between a check and the connect (rebinding) cannot slip through.
 *    IP-literal hosts skip `lookup` in Node, so they are checked up front;
 *  - redirects are followed by hand (max 5), each hop re-validated the same way;
 *  - a total timeout and a byte cap, the cap applied AFTER decompression so a
 *    gzip bomb cannot get around it.
 */

export class SafeFetchError extends Error {
  constructor(
    public readonly kind: "blocked" | "invalid_url" | "timeout" | "too_large" | "network" | "http" | "too_many_redirects",
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam: resolve a host name (default dns.lookup, all addresses). */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam: skip the network entirely. */
  transport?: (url: URL, headers: Record<string, string>, lookup: LookupFunction, timeoutMs: number) => Promise<RawResponse>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface SafeResponse extends RawResponse {
  /** The URL finally fetched, after redirects. */
  url: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

// ── address checks ──────────────────────────────────────────────────────────

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
  });
}

/** Expand an IPv6 address to 8 hextets (handles `::` and a dotted v4 tail). */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4tail) {
    const n = v4ToInt(v4tail[1]);
    s = s.slice(0, -v4tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  const all = [...h, ...Array(tail !== undefined ? fill : 0).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null;
}

/** True when `ip` must never be fetched: anything that is not public unicast. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const h = v6Hextets(ip);
  if (!h) return true;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // v4-mapped ::ffff:a.b.c.d and v4-compatible ::a.b.c.d → judge the v4 address
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return v4Blocked(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) { // NAT64 64:ff9b::/96
    return v4Blocked(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) return true; // 6to4 can wrap any v4 — refuse
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  return false;
}

/**
 * Static URL checks (no DNS). Returns the parsed URL or throws `invalid_url` /
 * `blocked`. Exported for the admin controller's early 400.
 */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new SafeFetchError("invalid_url", "not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SafeFetchError("invalid_url", "only http and https URLs are allowed");
  if (u.username || u.password) throw new SafeFetchError("invalid_url", "URLs with a user name or password are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new SafeFetchError("blocked", "only the standard ports 80 and 443 are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("invalid_url", "the URL has no host");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError("blocked", "that address is private or reserved");
  } else if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host) || !host.includes(".")) {
    throw new SafeFetchError("blocked", "that host is not a public internet name");
  }
  return u;
}

const defaultResolve = (host: string) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Resolve `host` and fail unless every address is public. Used both as an
 * early check (a nice 400 in the admin UI) and — through `guardedLookup` — at
 * connect time.
 */
export async function assertPublicHost(host: string, resolve = defaultResolve): Promise<void> {
  const h = host.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (isBlockedAddress(h)) throw new SafeFetchError("blocked", "that address is private or reserved");
    return;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolve(h);
  } catch (err) {
    throw new SafeFetchError("network", `could not resolve ${h}: ${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message}`);
  }
  if (!addrs.length) throw new SafeFetchError("network", `${h} has no address`);
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new SafeFetchError("blocked", `${h} resolves to a private or reserved address`);
}

/** A socket `lookup` that refuses to hand back a non-public address. */
export function guardedLookup(resolve = defaultResolve): LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    const cb = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options?.all;
    resolve(hostname).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }));
      if (addrs.some((a) => isBlockedAddress(a.address))) {
        return cb(Object.assign(new Error(`${hostname} resolves to a private or reserved address`), { code: "EBLOCKED" }));
      }
      // IPv4 first: containers often have no IPv6 route, and a v6 connect then hangs.
      const ordered = [...addrs].sort((x, y) => (x.family === 4 ? 0 : 1) - (y.family === 4 ? 0 : 1));
      if (all) cb(null, ordered);
      else cb(null, ordered[0].address, ordered[0].family);
    }, (err) => cb(err));
  }) as LookupFunction;
}

// ── the request ─────────────────────────────────────────────────────────────

export function nodeTransport(maxBytes: number) {
  return (url: URL, headers: Record<string, string>, lookup: LookupFunction, timeoutMs: number): Promise<RawResponse> =>
    new Promise<RawResponse>((resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      // Hard deadline for the whole exchange (the socket `timeout` is only idle time).
      const hard = setTimeout(() => req.destroy(new SafeFetchError("timeout", `no response within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      const done = <T,>(f: (v: T) => void) => (v: T) => { clearTimeout(hard); f(v); };
      resolve = done(resolve) as typeof resolve;
      reject = done(reject);
      const req = mod.request(url, { method: "GET", headers, lookup, timeout: timeoutMs, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        // Redirects and 304s: the body is irrelevant.
        if ((status >= 300 && status < 400) || status === 204) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        const declared = Number(res.headers["content-length"]);
        if (!enc && Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new SafeFetchError("too_large", `response is ${declared} bytes (cap ${maxBytes})`, status));
        }
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            (stream as any).destroy?.();
            reject(new SafeFetchError("too_large", `response exceeds ${maxBytes} bytes`, status));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on("error", (err: Error) => reject(new SafeFetchError("network", `read failed: ${err.message}`, status)));
      });
      req.on("timeout", () => req.destroy(new SafeFetchError("timeout", `no response within ${timeoutMs / 1000}s`)));
      req.on("error", (err: any) => {
        if (err instanceof SafeFetchError) return reject(err);
        if (err?.code === "EBLOCKED") return reject(new SafeFetchError("blocked", err.message));
        reject(new SafeFetchError("network", `network error: ${err?.code ?? ""} ${err?.message ?? err}`.trim()));
      });
      req.end();
    });
}

/**
 * GET `rawUrl` under the SSRF rules above. Resolves with the final response,
 * whatever its status (the caller decides what a 404 means); throws
 * `SafeFetchError` for anything blocked, too big, too slow or unreachable.
 */
export async function safeGet(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  const resolve = opts.resolve ?? defaultResolve;
  const transport = opts.transport ?? nodeTransport(maxBytes);
  const lookup = guardedLookup(resolve);
  const deadline = Date.now() + timeoutMs;

  let url = checkUrlShape(rawUrl);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url.hostname, resolve);
    const left = deadline - Date.now();
    if (left <= 0) throw new SafeFetchError("timeout", `no response within ${timeoutMs / 1000}s`);
    const res = await withTimeout(transport(url, { "accept-encoding": "gzip, deflate, br", ...(opts.headers ?? {}) }, lookup, left), left, timeoutMs);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.location;
      const target = Array.isArray(loc) ? loc[0] : loc;
      if (!target) return { ...res, url: url.toString() };
      if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", `more than ${maxRedirects} redirects`);
      let next: URL;
      try {
        next = new URL(target, url);
      } catch {
        throw new SafeFetchError("invalid_url", "redirect to an invalid URL");
      }
      url = checkUrlShape(next.toString());
      continue;
    }
    return { ...res, url: url.toString() };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, total: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SafeFetchError("timeout", `no response within ${total / 1000}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
