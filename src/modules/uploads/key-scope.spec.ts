import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_KEY_PREFIX,
  MAX_KEY_LENGTH,
  accountKeyPrefix,
  classifyKey,
  keyShapeError,
  sanitizeFolder,
  scopedFolder,
} from "./key-scope";

/**
 * These cases are the whole authorization decision for `GET /uploads/sign` and
 * `DELETE /uploads`. Before them, the check was "the caller has a valid token",
 * and the objects in question are contracts, title deeds and national-ID scans.
 * A regression here is not a broken feature — it is a bucket that is readable
 * and deletable by every account in the product.
 */
describe("classifyKey — the caller's own scope", () => {
  it("allows a key under the caller's own prefix", () => {
    assert.deepEqual(classifyKey("acct/7/contracts/1738-abc.pdf", 7), { kind: "own" });
  });

  it("refuses a key under another account's prefix", () => {
    // The single case that motivated the whole change: account 7 naming
    // account 9's file. Previously indistinguishable from its own.
    assert.deepEqual(classifyKey("acct/9/contracts/1738-abc.pdf", 7), { kind: "foreign", scopeId: 9 });
  });

  it("does not let a scope number match by numeric coercion", () => {
    // `Number("07") === 7`. If the segment were parsed rather than compared as
    // digits, `acct/07/…` would read as account 7's and the bucket would have
    // two spellings of one prefix — one of them writable by whoever guessed it.
    const v = classifyKey("acct/07/x.pdf", 7);
    assert.equal(v.kind, "invalid");
  });

  it("refuses a bare prefix with no object after it", () => {
    // `acct/7` names a folder. Signing it is meaningless and deleting it is
    // ambiguous, so it never reaches the bucket.
    assert.equal(classifyKey("acct/7", 7).kind, "invalid");
    assert.equal(classifyKey("acct/7/", 7).kind, "invalid"); // trailing "//"-style empty segment
  });
});

describe("classifyKey — traversal cannot escape the prefix", () => {
  it("refuses acct/2/../3/x.pdf even though it starts with the caller's prefix", () => {
    // This is the case a `startsWith(accountKeyPrefix(scope))` check gets
    // wrong: the string genuinely begins with `acct/2/`, and the object it
    // names — under any layer that normalises the path — is account 3's.
    // Shape is therefore checked BEFORE the prefix.
    const v = classifyKey("acct/2/../3/x.pdf", 2);
    assert.equal(v.kind, "invalid");
    assert.equal(v.kind === "invalid" && v.reason, "path traversal");
  });

  it("refuses a percent-encoded dot", () => {
    // We compare keys as literal strings, but a proxy, an SDK or a future
    // caller may decode first. Refusing is cheaper than reasoning about every
    // layer between here and MinIO.
    assert.equal(classifyKey("acct/2/%2e%2e/3/x.pdf", 2).kind, "invalid");
    assert.equal(classifyKey("acct/2/%2E%2E/3/x.pdf", 2).kind, "invalid");
  });

  it("refuses a lone dot segment, at any position", () => {
    assert.equal(classifyKey("./acct/2/x.pdf", 2).kind, "invalid");
    assert.equal(classifyKey("acct/2/./x.pdf", 2).kind, "invalid");
    assert.equal(classifyKey("acct/2/x.pdf/..", 2).kind, "invalid");
  });

  it("allows dots that are part of a filename rather than a segment", () => {
    // `..` only climbs when it is a whole segment. A file called `..pdf` or
    // `report..final.pdf` is ordinary, and refusing it would be a bug that
    // only shows up on somebody's real document.
    assert.deepEqual(classifyKey("acct/2/docs/report..final.pdf", 2), { kind: "own" });
    assert.deepEqual(classifyKey("acct/2/docs/..pdf", 2), { kind: "own" });
  });
});

describe("classifyKey — malformed input never reaches the bucket or the database", () => {
  it("refuses backslashes, control characters and absolute keys", () => {
    // A backslash is a separator to anything Windows-flavoured in the path;
    // a NUL truncates the string in some layers, so the key that is CHECKED
    // and the key that is USED could differ.
    assert.equal(classifyKey("acct\\2\\x.pdf", 2).kind, "invalid");
    assert.equal(classifyKey(`acct/2/x.pdf${"\u0000"}.png`, 2).kind, "invalid");
    assert.equal(classifyKey("/acct/2/x.pdf", 2).kind, "invalid");
  });

  it("refuses empty segments", () => {
    assert.equal(classifyKey("acct//2/x.pdf", 2).kind, "invalid");
  });

  it("refuses an over-long key without looking it up", () => {
    // The legacy branch costs a database query. The cap keeps a multi-kilobyte
    // query string from turning an unauthenticated-ish probe into one.
    const long = `acct/2/${"a".repeat(MAX_KEY_LENGTH)}.pdf`;
    assert.equal(classifyKey(long, 2).kind, "invalid");
  });

  it("refuses whitespace padding rather than trimming it", () => {
    // Trimming would mean the key we authorize is not the key we sign.
    assert.equal(classifyKey(" acct/2/x.pdf", 2).kind, "invalid");
    assert.equal(keyShapeError(""), "empty");
  });
});

describe("classifyKey — legacy keys", () => {
  it("reports an unprefixed key as legacy rather than allowing or refusing it", () => {
    // Every key written before this change looks like this, and they are
    // referenced by live rows across eleven tables, so they cannot be refused
    // outright. `UploadKeyAccessService` decides them by attribution — which
    // is the point: "legacy" is a question, not a pass.
    assert.deepEqual(
      classifyKey("contracts/1738012345678-4f1c2e9a-0b7d.pdf", 7),
      { kind: "legacy" },
    );
  });

  it("treats a key that merely mentions acct later as legacy, not scoped", () => {
    assert.deepEqual(classifyKey("contracts/acct/7/x.pdf", 7), { kind: "legacy" });
  });
});

describe("key minting", () => {
  it("prefixes the folder with the caller's scope", () => {
    assert.equal(scopedFolder(7, "contracts"), "acct/7/contracts");
    assert.equal(scopedFolder(7, "payment-confirmations/88"), "acct/7/payment-confirmations/88");
    assert.equal(scopedFolder(7), "acct/7");
    assert.equal(accountKeyPrefix(7), `${ACCOUNT_KEY_PREFIX}/7/`);
  });

  it("strips navigation out of a caller-supplied folder", () => {
    // `folder` comes straight off a multipart body. Without this, an upload
    // with folder `../../acct/9` would file the object outside the caller's
    // prefix — the write-side version of the read hole this all closes.
    assert.equal(scopedFolder(7, "../../acct/9"), "acct/7/acct/9");
    assert.equal(scopedFolder(7, "/leading/and/trailing/"), "acct/7/leading/and/trailing");
    assert.equal(sanitizeFolder("a/../b"), "a/b");
    assert.equal(sanitizeFolder("..."), "...");   // three dots is a legal name
    assert.equal(sanitizeFolder(null), "");
  });

  it("produces keys its own classifier calls the caller's own", () => {
    // The round trip is what matters: a folder we would sanitize into
    // something `classifyKey` then refuses would make uploads unreadable.
    for (const folder of ["contracts", "../../etc", "a/b/c", "", "%2e%2e"]) {
      const key = `${scopedFolder(7, folder)}/1738-abc.pdf`;
      assert.deepEqual(classifyKey(key, 7), { kind: "own" }, `folder: ${folder}`);
    }
  });
});
