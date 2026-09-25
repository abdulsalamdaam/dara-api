import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseHandle } from "./news.handles";

describe("normaliseHandle", () => {
  it("strips @ and lowercases", () => {
    assert.equal(normaliseHandle("@REGA_KSA"), "rega_ksa");
    assert.equal(normaliseHandle("  Ejar_sa "), "ejar_sa");
    assert.equal(normaliseHandle("@@sakani"), "sakani");
  });

  it("accepts x.com / twitter.com links, with or without scheme, paths and query", () => {
    assert.equal(normaliseHandle("https://x.com/REGA_KSA"), "rega_ksa");
    assert.equal(normaliseHandle("x.com/rega_ksa?s=20"), "rega_ksa");
    assert.equal(normaliseHandle("https://twitter.com/Ejar_sa/status/123456"), "ejar_sa");
    assert.equal(normaliseHandle("https://mobile.twitter.com/sakani/"), "sakani");
    assert.equal(normaliseHandle("http://www.x.com/redfksa#top"), "redfksa");
  });

  it("rejects what is not a handle", () => {
    assert.equal(normaliseHandle(""), null);
    assert.equal(normaliseHandle("@"), null);
    assert.equal(normaliseHandle("has space"), null);
    assert.equal(normaliseHandle("dash-name"), null);
    assert.equal(normaliseHandle("a".repeat(16)), null);
    assert.equal(normaliseHandle("الهيئة"), null);
    assert.equal(normaliseHandle("https://example.com/rega"), null);
    assert.equal(normaliseHandle("https://x.com/home"), null);
    assert.equal(normaliseHandle("https://x.com/i/lists/1"), null);
    assert.equal(normaliseHandle(42), null);
    assert.equal(normaliseHandle(null), null);
  });

  it("allows the 15-char maximum", () => {
    assert.equal(normaliseHandle("A".repeat(15)), "a".repeat(15));
  });
});
