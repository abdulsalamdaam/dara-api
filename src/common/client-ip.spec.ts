import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clientIp, clientUserAgent, MAX_USER_AGENT_CHARS } from "./client-ip";

/** Build the only two things `clientIp` reads. */
function req(headers: Record<string, string | string[] | undefined>, remoteAddress?: string) {
  return { headers, socket: remoteAddress ? { remoteAddress } : undefined };
}

/**
 * Every IP this product has ever stored — in `login_logs`, in
 * `phone_otp_tokens`, in `contact_submissions` — is a `172.69.x.x` Cloudflare
 * edge address, because three separate copies of this function read the first
 * entry of `x-forwarded-for`. The precedence below is the fix, and it is worth
 * pinning: get it wrong and the columns keep filling with our own infrastructure.
 */
describe("clientIp — precedence", () => {
  it("prefers cf-connecting-ip over everything else", () => {
    // Cloudflare rewrites this header on every request it proxies, so on the
    // path we actually run in production it is the only header that names the
    // origin. XFF's first entry there is the edge.
    const ip = clientIp(req({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "198.51.100.9",
      "x-forwarded-for": "172.69.4.1, 10.0.0.1",
    }, "10.0.0.2"));
    assert.equal(ip, "203.0.113.7");
  });

  it("falls back to x-real-ip, then to the first x-forwarded-for entry", () => {
    assert.equal(
      clientIp(req({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "172.69.4.1" })),
      "198.51.100.9",
    );
    // The convention is that each hop appends itself, so the ORIGINAL client
    // is the first entry — not the last.
    assert.equal(
      clientIp(req({ "x-forwarded-for": "203.0.113.7, 172.69.4.1, 10.0.0.1" })),
      "203.0.113.7",
    );
  });

  it("falls back to the socket when nothing is in front of us", () => {
    // Local dev and a direct container hit: no proxy headers at all.
    assert.equal(clientIp(req({}, "127.0.0.1")), "127.0.0.1");
  });

  it("returns \"unknown\" rather than null when nothing is usable", () => {
    // Both storing call sites want a string, and the throttler uses the value
    // as a bucket key — lumping the unidentifiable together is the safe
    // default for a rate limit.
    assert.equal(clientIp(req({})), "unknown");
    assert.equal(clientIp(null), "unknown");
  });
});

/**
 * The first three sources are headers, and a header is whatever the caller
 * typed. These are the cases that must never reach a `text` column or a
 * throttler bucket key.
 */
describe("clientIp — a garbage header is discarded, not stored", () => {
  it("skips a non-IP value and keeps looking", () => {
    // The whole risk of trusting a header: without validation this string
    // becomes the rate-limit bucket, so an attacker gets a fresh quota per
    // request simply by varying it.
    const ip = clientIp(req({
      "cf-connecting-ip": "not-an-ip",
      "x-real-ip": "'; drop table users; --",
      "x-forwarded-for": "<script>alert(1)</script>",
    }, "203.0.113.7"));
    assert.equal(ip, "203.0.113.7");
  });

  it("rejects an absurdly long header outright", () => {
    // Bounded BEFORE any regex work: an unbounded header must never become an
    // unbounded regex input, and it must never become a 64KB log column.
    assert.equal(clientIp(req({ "cf-connecting-ip": "1".repeat(5000) })), "unknown");
  });

  it("rejects a hostname — this is an address column, not a name", () => {
    assert.equal(clientIp(req({ "x-real-ip": "example.com" })), "unknown");
  });

  it("rejects an out-of-range dotted quad", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "999.1.1.1" })), "unknown");
  });

  it("accepts IPv6, including the IPv4-mapped form, unchanged", () => {
    assert.equal(clientIp(req({ "cf-connecting-ip": "2001:db8::1" })), "2001:db8::1");
    // Left exactly as it arrived: rewriting it to 1.2.3.4 would make two
    // spellings of one client look like two clients in the rate limiter.
    assert.equal(clientIp(req({}, "::ffff:1.2.3.4")), "::ffff:1.2.3.4");
  });

  it("strips a source port, in both the v4 and the bracketed v6 form", () => {
    // Real proxies emit both. Without this the value is discarded as garbage
    // and we fall through to the socket, silently losing the client again.
    assert.equal(clientIp(req({ "x-real-ip": "203.0.113.7:51234" })), "203.0.113.7");
    assert.equal(clientIp(req({ "x-real-ip": "[2001:db8::1]:443" })), "2001:db8::1");
  });

  it("takes the first value when a header is repeated", () => {
    // Node hands a repeated header over as an array; the first occurrence is
    // the one the nearest trusted hop set.
    assert.equal(clientIp(req({ "cf-connecting-ip": ["203.0.113.7", "198.51.100.9"] })), "203.0.113.7");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "  203.0.113.7 , 172.69.4.1" })), "203.0.113.7");
  });
});

describe("clientUserAgent", () => {
  it("returns null when absent or empty, never an empty string", () => {
    // `login_logs.device` and `contact_submissions.user_agent` are nullable;
    // an empty string there reads as "we captured one and it was blank".
    assert.equal(clientUserAgent(req({})), null);
    assert.equal(clientUserAgent(req({ "user-agent": "   " })), null);
  });

  it("caps the value — it is a header, and nothing bounds it", () => {
    const ua = clientUserAgent(req({ "user-agent": "x".repeat(10_000) }));
    assert.equal(ua?.length, MAX_USER_AGENT_CHARS);
  });
});
