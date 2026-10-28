import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clientIp, clientUserAgent, isCloudflareIp, MAX_USER_AGENT_CHARS } from "./client-ip";

/** Build the only two things `clientIp` reads. */
function req(headers: Record<string, string | string[] | undefined>, remoteAddress?: string) {
  return { headers, socket: remoteAddress ? { remoteAddress } : undefined };
}

/** A Cloudflare edge address (172.64.0.0/13), as Traefik writes it into x-real-ip. */
const EDGE = "172.69.4.1";

/**
 * Every IP this product stored before mid-2026 was a `172.69.x.x` Cloudflare
 * edge, because the code read the first entry of `x-forwarded-for`. Then the
 * fix trusted `cf-connecting-ip` from anyone — and the origin turned out to
 * answer requests that never went through Cloudflare, so a caller could name a
 * new IP per request and get a new rate-limit bucket each time. These pin both.
 */
describe("clientIp — who the caller is", () => {
  it("uses cf-connecting-ip when the peer is a Cloudflare edge", () => {
    const ip = clientIp(req({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": EDGE,
      "x-forwarded-for": "198.51.100.9, 10.0.0.1",
    }, "10.0.1.7"));
    assert.equal(ip, "203.0.113.7");
  });

  it("ignores cf-connecting-ip when the peer is NOT Cloudflare", () => {
    // Straight to the origin: the header is typed by the attacker.
    const ip = clientIp(req({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "198.51.100.9",
    }, "10.0.1.7"));
    assert.equal(ip, "198.51.100.9");
  });

  it("never uses x-forwarded-for — Traefik strips it, and anyone can type it", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7" }, "198.51.100.9")), "198.51.100.9");
  });

  it("falls back to the edge itself when Cloudflare sent no client header", () => {
    assert.equal(clientIp(req({ "x-real-ip": EDGE })), EDGE);
  });

  it("uses the socket when nothing is in front of us", () => {
    // Local dev and a direct container hit: no proxy headers at all.
    assert.equal(clientIp(req({}, "127.0.0.1")), "127.0.0.1");
    // A Cloudflare socket peer (no Traefik hop) is honoured too.
    assert.equal(clientIp(req({ "cf-connecting-ip": "203.0.113.7" }, EDGE)), "203.0.113.7");
  });

  it("returns \"unknown\" rather than null when nothing is usable", () => {
    // Both storing call sites want a string, and the throttler uses the value
    // as a bucket key — lumping the unidentifiable together is the safe
    // default for a rate limit.
    assert.equal(clientIp(req({})), "unknown");
    assert.equal(clientIp(null), "unknown");
  });
});

describe("isCloudflareIp", () => {
  it("knows the edge ranges, v4, v6 and IPv4-mapped", () => {
    assert.equal(isCloudflareIp("172.69.4.1"), true);
    assert.equal(isCloudflareIp("104.16.0.1"), true);
    assert.equal(isCloudflareIp("2606:4700::1"), true);
    assert.equal(isCloudflareIp("::ffff:162.158.1.1"), true);
  });

  it("rejects everything else", () => {
    assert.equal(isCloudflareIp("87.237.226.107"), false);
    assert.equal(isCloudflareIp("10.0.1.7"), false);
    assert.equal(isCloudflareIp("2001:db8::1"), false);
    assert.equal(isCloudflareIp("not-an-ip"), false);
  });
});

/**
 * The client header is still whatever the caller typed. These are the cases
 * that must never reach a `text` column or a throttler bucket key.
 */
describe("clientIp — a garbage header is discarded, not stored", () => {
  it("skips a non-IP client header and keeps the edge", () => {
    // Without validation this string becomes the rate-limit bucket, so an
    // attacker gets a fresh quota per request simply by varying it.
    assert.equal(clientIp(req({ "cf-connecting-ip": "'; drop table users; --", "x-real-ip": EDGE })), EDGE);
  });

  it("skips a non-IP peer header and uses the socket", () => {
    assert.equal(clientIp(req({ "x-real-ip": "<script>alert(1)</script>" }, "203.0.113.7")), "203.0.113.7");
  });

  it("rejects an absurdly long header outright", () => {
    // Bounded BEFORE any regex work: an unbounded header must never become an
    // unbounded regex input, and it must never become a 64KB log column.
    assert.equal(clientIp(req({ "x-real-ip": "1".repeat(5000) })), "unknown");
  });

  it("rejects a hostname — this is an address column, not a name", () => {
    assert.equal(clientIp(req({ "x-real-ip": "example.com" })), "unknown");
  });

  it("rejects an out-of-range dotted quad", () => {
    assert.equal(clientIp(req({ "x-real-ip": "999.1.1.1" })), "unknown");
  });

  it("accepts IPv6, including the IPv4-mapped form, unchanged", () => {
    assert.equal(clientIp(req({ "cf-connecting-ip": "2001:db8::1", "x-real-ip": EDGE })), "2001:db8::1");
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
    assert.equal(clientIp(req({ "cf-connecting-ip": ["203.0.113.7", "198.51.100.9"], "x-real-ip": EDGE })), "203.0.113.7");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(clientIp(req({ "x-real-ip": "  203.0.113.7 " })), "203.0.113.7");
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
