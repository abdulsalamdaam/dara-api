import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeNewsCursor, encodeNewsCursor, newsCursorCondition, type NewsCursor } from "./news.cursor";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AT = "2026-10-17T05:00:00.123456Z";

const render = (c: NewsCursor) => {
  const q = new PgDialect().sqlToQuery(newsCursorCondition(c));
  return { sql: q.sql.replace(/"news_items"\./g, ""), params: q.params };
};

describe("news cursor encoding", () => {
  it("round-trips every boundary shape", () => {
    for (const c of [
      { pinned: true, postedAt: AT, id: ID },
      { pinned: true, postedAt: null, id: ID },
      { pinned: false, postedAt: AT, id: ID },
      { pinned: false, postedAt: null, id: ID },
    ]) assert.deepEqual(decodeNewsCursor(encodeNewsCursor(c)), c);
  });

  it("treats an absent cursor as the first page", () => {
    assert.equal(decodeNewsCursor(undefined), undefined);
    assert.equal(decodeNewsCursor(""), undefined);
  });

  it("rejects anything it did not issue", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const raw of [
      "not-base64-json", 42, ["a"], enc({}), enc([2, AT, ID]), enc([1, AT, "1; drop table"]),
      enc([1, "2026-10-17", ID]), enc([1, "2026-10-17T05:00:00Z", ID]), enc([0, 5, ID]), enc([0, null, ID, 1]),
      "x".repeat(300),
    ]) assert.throws(() => decodeNewsCursor(raw), /invalid cursor/, String(raw));
  });
});

/**
 * The order is `pinned desc, posted_at desc nulls last, id desc`. Each case
 * pins down the boundary that is easy to get wrong.
 */
describe("news cursor predicate", () => {
  it("pinned + dated: rest of the pinned group (older, undated, same-instant lower id), then every unpinned row", () => {
    const { sql, params } = render({ pinned: true, postedAt: AT, id: ID });
    assert.equal(sql,
      `("pinned" = $1 or ("pinned" = $2 and ("posted_at" < $3::timestamptz or "posted_at" is null or ("posted_at" = $4::timestamptz and "id" < $5))))`);
    assert.deepEqual(params, [false, true, AT, AT, ID]);
  });

  it("pinned + undated: only lower-id undated pinned rows remain in the group, then every unpinned row", () => {
    const { sql, params } = render({ pinned: true, postedAt: null, id: ID });
    assert.equal(sql, `("pinned" = $1 or ("pinned" = $2 and ("posted_at" is null and "id" < $3)))`);
    assert.deepEqual(params, [false, true, ID]);
  });

  it("unpinned + dated: never returns a pinned row; undated rows still follow", () => {
    const { sql, params } = render({ pinned: false, postedAt: AT, id: ID });
    assert.equal(sql,
      `("pinned" = $1 and ("posted_at" < $2::timestamptz or "posted_at" is null or ("posted_at" = $3::timestamptz and "id" < $4)))`);
    assert.deepEqual(params, [false, AT, AT, ID]);
  });

  it("unpinned + undated: the tail — undated rows with a lower id, and no dated row", () => {
    const { sql, params } = render({ pinned: false, postedAt: null, id: ID });
    assert.equal(sql, `("pinned" = $1 and ("posted_at" is null and "id" < $2))`);
    assert.deepEqual(params, [false, ID]);
  });
});
