import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isSecretKey, looksSecret, prepareMeta, redact, stripNul, truncate,
  MAX_META_CHARS, MAX_STACK_CHARS, REDACTED,
} from "./redact";

/** Every string anywhere inside `value`, so a test can assert on the whole tree. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

/**
 * `app_logs` is readable by every super-admin, survives the container it was
 * written in, and is kept for thirty days. A debug log that leaks an OTP code
 * is worse than no debug log at all — the code is a full login for a phone
 * number the same row usually also carries.
 *
 * These are the values that must never appear in a row, whatever they were
 * called and however deeply they were nested.
 */
describe("redact — the values that must never survive", () => {
  it("drops an Authorization header, under any spelling of the key", () => {
    for (const key of ["authorization", "Authorization", "AUTHORIZATION", "headers.authorization"]) {
      const out = redact({ [key]: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NDd9.abcdefghij" });
      assert.deepEqual(out, { [key]: REDACTED }, key);
    }
  });

  it("drops a token under every naming convention we use", () => {
    const out = redact({
      token: "abc123",
      accessToken: "abc123",
      access_token: "abc123",
      "x-refresh-token": "abc123",
      resetToken: "abc123",
    }) as Record<string, unknown>;
    for (const [k, v] of Object.entries(out)) assert.equal(v, REDACTED, k);
  });

  it("drops an OTP code — the one that would be an outright login", () => {
    // The email OTP is six digits and the phone OTP is four. Either one, plus
    // the phone number sitting in the same log row, is an account.
    const out = redact({
      otp: "1234",
      otpCode: "111111",
      verificationCode: "999999",
      phone: "0500000000",
    }) as Record<string, unknown>;
    assert.equal(out.otp, REDACTED);
    assert.equal(out.otpCode, REDACTED);
    assert.equal(out.verificationCode, REDACTED);
    // The phone number stays: it is what makes the row useful, and it is
    // already stored in `phone_otp_tokens` and `login_logs`.
    assert.equal(out.phone, "0500000000");
  });

  it("drops a password, and every `secret`/`key`-suffixed field", () => {
    const out = redact({
      password: "hunter2",
      newPassword: "hunter2",
      MOYASAR_WEBHOOK_SECRET: "s",
      clientSecret: "s",
      apiKey: "k",
      APP_ENCRYPTION_KEY: "k",
      privateKey: "k",
    }) as Record<string, unknown>;
    for (const [k, v] of Object.entries(out)) assert.equal(v, REDACTED, k);
  });

  it("reaches secrets nested inside objects and arrays", () => {
    // The realistic shape: an exception's `meta` carrying the request that
    // caused it. A top-level-only redactor would leak all of this.
    const out = redact({
      request: {
        headers: { authorization: "Bearer abc.def.ghijklmnop", "user-agent": "curl/8" },
        body: { email: "a@b.com", password: "hunter2" },
      },
      attempts: [{ otpCode: "1234" }, { otpCode: "5678" }],
    });
    const strings = allStrings(out);
    for (const leaked of ["hunter2", "1234", "5678", "abc.def.ghijklmnop"]) {
      assert.ok(!strings.includes(leaked), `leaked: ${leaked}`);
    }
    // The non-secret half is still there — a log that redacts everything is
    // the same as no log.
    assert.ok(strings.includes("a@b.com"));
    assert.ok(strings.includes("curl/8"));
  });

  it("keeps the KEY and replaces only the value", () => {
    // Knowing an Authorization header was present, and that the body carried a
    // password field, is most of what the log is for.
    const out = redact({ authorization: "Bearer x" }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ["authorization"]);
  });
});

/**
 * The key rules only catch names somebody thought of. These are the shapes
 * that are a credential regardless of what the field was called — which is the
 * failure mode a pure key allowlist has every single time.
 */
describe("looksSecret — value-shaped rules catch the unnamed secret", () => {
  it("catches a JWT under an innocent key", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NDcsImVtYWlsIjoiYUBiLmNvbSJ9.Zm9vYmFyYmF6cXV4";
    assert.equal(looksSecret(jwt), true);
    assert.equal((redact({ h: jwt }) as Record<string, unknown>).h, REDACTED);
  });

  it("catches an Authorization value under an innocent key", () => {
    assert.equal((redact({ h: "Bearer abcdef" }) as Record<string, unknown>).h, REDACTED);
    assert.equal((redact({ h: "Basic YWRtaW46cA==" }) as Record<string, unknown>).h, REDACTED);
  });

  it("catches a PEM block — the ZATCA private keys are PEMs", () => {
    assert.equal(looksSecret("-----BEGIN EC PRIVATE KEY-----\nMHQ…"), true);
  });

  it("does not fire on an ordinary sentence, a path or a version", () => {
    // Over-redaction is its own failure: a log that says [redacted] everywhere
    // answers nothing.
    for (const v of ["GET /api/invoices 500", "1.2.3", "a@b.com", "بيانات ناقصة"]) {
      assert.equal(looksSecret(v), false, v);
    }
  });
});

describe("isSecretKey — the suffix rules, and their few exemptions", () => {
  it("treats a `code`-suffixed field as a secret by default", () => {
    // Deliberately the strict direction: the next OTP field will be called
    // something nobody predicted, and losing a readable value costs far less
    // than leaking a login.
    assert.equal(isSecretKey("smsCode"), true);
    assert.equal(isSecretKey("confirmation_code"), true);
  });

  it("exempts only codes that are structurally not credentials", () => {
    // `statusCode` is on almost every error object we log; redacting it would
    // make the exception rows unreadable for no security gain.
    assert.equal(isSecretKey("statusCode"), false);
    assert.equal(isSecretKey("errorCode"), false);
    assert.equal(isSecretKey("countryCode"), false);
  });

  it("does not fire on a word that merely ends in the same letters", () => {
    assert.equal(isSecretKey("monkey"), false);
    assert.equal(isSecretKey("status"), false);
    assert.equal(isSecretKey("path"), false);
  });
});

describe("redact — bounds, so one request cannot become the whole table", () => {
  it("survives a circular reference instead of throwing", () => {
    // Not exotic: an Express request, a pg error and a Nest exception all hold
    // one, and any of the three can end up in `meta`.
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    assert.deepEqual(redact(a), { name: "a", self: "[circular]" });
  });

  it("stops at a depth limit rather than walking forever", () => {
    let deep: Record<string, unknown> = { end: "value" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    assert.ok(JSON.stringify(redact(deep)).includes("[depth limit]"));
  });

  it("caps a long string and says by how much", () => {
    const out = redact({ body: "x".repeat(50_000) }) as Record<string, string>;
    assert.ok(out.body.length < 3_000);
    assert.match(out.body, /truncated \d+ chars/);
  });

  it("replaces a Buffer rather than writing out its bytes", () => {
    // A buffer's contents are as likely to be a key as anything else, and its
    // JSON form is a useless array of byte integers either way.
    assert.equal((redact({ b: Buffer.from("secret") }) as Record<string, unknown>).b, "[buffer 6 bytes]");
  });
});

describe("truncate", () => {
  it("leaves a short value alone", () => {
    assert.equal(truncate("boom", 100), "boom");
  });

  it("marks the cut rather than trimming silently", () => {
    // A stack that ends mid-frame with no marker reads as a stack that ended
    // there — which is how you spend an hour looking for a caller that was
    // simply cut off.
    const out = truncate("y".repeat(MAX_STACK_CHARS + 500), MAX_STACK_CHARS)!;
    assert.equal(out.startsWith("y".repeat(100)), true);
    assert.match(out, /…\[truncated 500 chars\]$/);
  });

  it("returns null for absent input and for a value that is empty once cleaned", () => {
    assert.equal(truncate(null, 10), null);
    assert.equal(truncate(undefined, 10), null);
    assert.equal(truncate("", 10), null);
  });

  it("removes NUL bytes — Postgres rejects them in text and in jsonb", () => {
    assert.equal(truncate(`a${String.fromCharCode(0)}b`, 10), "ab");
  });
});

describe("stripNul", () => {
  it("cleans strings nested inside an object, not just the top level", () => {
    const nul = String.fromCharCode(0);
    assert.deepEqual(stripNul({ a: `x${nul}y`, b: { c: `${nul}z` } }), { a: "xy", b: { c: "z" } });
  });

  it("returns the input rather than throwing on something unserialisable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(stripNul(circular), circular);
  });
});

describe("prepareMeta — what actually reaches the jsonb column", () => {
  it("redacts and returns an object", () => {
    assert.deepEqual(prepareMeta({ token: "x", ok: true }), { token: REDACTED, ok: true });
  });

  it("replaces an oversized payload wholesale instead of half-writing it", () => {
    // Half an object is a worse artefact to read than a note saying it was too
    // big — and the cap is what stops one pathological request from filling
    // the table.
    const huge = { items: Array.from({ length: 400 }, (_, i) => ({ i, blob: "z".repeat(400) })) };
    const out = prepareMeta(huge)!;
    assert.equal(out._truncated, true);
    assert.ok(JSON.stringify(out).length < MAX_META_CHARS);
  });

  it("wraps a non-object so the column always holds an object", () => {
    assert.deepEqual(prepareMeta("just a string"), { value: "just a string" });
  });

  it("returns null for nothing, so the column stays NULL", () => {
    assert.equal(prepareMeta(null), null);
    assert.equal(prepareMeta(undefined), null);
  });
});
