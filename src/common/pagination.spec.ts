import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listQuerySchema,
  pageBounds, parseDateBound, parseEnumList, parseIdList, wantsPagination,
} from "./pagination";

describe("listQuerySchema", () => {
  it("defaults to page 1 and the shared page size of 25", () => {
    const q = listQuerySchema.parse({});
    assert.equal(q.page, 1);
    assert.equal(q.pageSize, DEFAULT_PAGE_SIZE);
    assert.equal(q.pageSize, 25);
    assert.equal(q.order, "desc");
  });

  it("coerces the string values a query string actually delivers", () => {
    const q = listQuerySchema.parse({ page: "3", pageSize: "50" });
    assert.equal(q.page, 3);
    assert.equal(q.pageSize, 50);
  });

  it("refuses a page size past the cap rather than silently clamping it", () => {
    // A silent clamp would answer 200 rows to a request for 5,000 and look
    // like a complete list. Better to fail the request.
    assert.throws(() => listQuerySchema.parse({ pageSize: String(MAX_PAGE_SIZE + 1) }));
    assert.equal(listQuerySchema.parse({ pageSize: String(MAX_PAGE_SIZE) }).pageSize, MAX_PAGE_SIZE);
  });

  it("refuses page 0 and negative pages", () => {
    assert.throws(() => listQuerySchema.parse({ page: "0" }));
    assert.throws(() => listQuerySchema.parse({ page: "-1" }));
  });

  it("trims search but leaves it undefined when absent", () => {
    assert.equal(listQuerySchema.parse({ search: "  alpha  " }).search, "alpha");
    assert.equal(listQuerySchema.parse({}).search, undefined);
  });
});

describe("pageBounds", () => {
  it("turns page/pageSize into LIMIT and OFFSET", () => {
    assert.deepEqual(pageBounds({ page: 1, pageSize: 25 }), { limit: 25, offset: 0 });
    assert.deepEqual(pageBounds({ page: 3, pageSize: 25 }), { limit: 25, offset: 50 });
  });
});

describe("wantsPagination", () => {
  it("is off for a caller that sends nothing, so bare-array callers keep working", () => {
    // The mobile app and the Ejar import read these endpoints as `T[]`.
    assert.equal(wantsPagination(undefined), false);
    assert.equal(wantsPagination({}), false);
  });

  it("is on for page or pageSize", () => {
    assert.equal(wantsPagination({ page: "2" }), true);
    assert.equal(wantsPagination({ pageSize: "25" }), true);
  });

  it("honours an explicit paginated=1 opt-in, and its off switch", () => {
    assert.equal(wantsPagination({ paginated: "1" }), true);
    assert.equal(wantsPagination({ paginated: "true" }), true);
    assert.equal(wantsPagination({ paginated: "0" }), false);
    assert.equal(wantsPagination({ paginated: "false" }), false);
  });

  it("only treats the endpoint's own declared keys as triggers", () => {
    // `search` triggers on endpoints that already behaved that way; a filter
    // the endpoint has not declared must NOT flip the response shape, or a
    // caller sending only that filter would start getting an envelope.
    assert.equal(wantsPagination({ search: "a" }, ["search"]), true);
    assert.equal(wantsPagination({ search: "a" }), false);
    assert.equal(wantsPagination({ status: "active" }, ["search"]), false);
  });
});

describe("parseIdList", () => {
  it("parses a comma-separated list", () => {
    assert.deepEqual(parseIdList("1,2,3"), [1, 2, 3]);
    assert.deepEqual(parseIdList(" 4 , 5 "), [4, 5]);
    assert.deepEqual(parseIdList("7"), [7]);
  });

  it("drops ids the int4 columns cannot hold instead of passing them to the driver", () => {
    // An id past 2^31 used to reach the driver and come back a 500 rather
    // than a clean miss.
    assert.deepEqual(parseIdList("1,2147483648"), [1]);
    assert.deepEqual(parseIdList("0,-3,1"), [1]);
  });

  it("is undefined for anything unusable, so no filter is applied", () => {
    assert.equal(parseIdList(""), undefined);
    assert.equal(parseIdList("   "), undefined);
    assert.equal(parseIdList("abc"), undefined);
    assert.equal(parseIdList(undefined), undefined);
    assert.equal(parseIdList(42), undefined);
  });
});

describe("parseEnumList", () => {
  const allowed = ["active", "expired", "terminated"] as const;

  it("accepts one value or a set", () => {
    assert.deepEqual(parseEnumList("active", allowed), ["active"]);
    assert.deepEqual(parseEnumList("active,expired", allowed), ["active", "expired"]);
  });

  it("silently drops values outside the enum", () => {
    assert.deepEqual(parseEnumList("active,bogus", allowed), ["active"]);
  });

  it("is undefined when nothing valid remains, rather than an impossible IN ()", () => {
    assert.equal(parseEnumList("bogus", allowed), undefined);
    assert.equal(parseEnumList("", allowed), undefined);
    assert.equal(parseEnumList(undefined, allowed), undefined);
  });
});

describe("parseDateBound", () => {
  it("accepts YYYY-MM-DD only", () => {
    assert.equal(parseDateBound("2026-08-30"), "2026-08-30");
    assert.equal(parseDateBound(" 2026-08-30 "), "2026-08-30");
  });

  it("rejects anything else rather than letting it reach the query", () => {
    assert.equal(parseDateBound("30-08-2026"), undefined);
    assert.equal(parseDateBound("2026-08"), undefined);
    assert.equal(parseDateBound("yesterday"), undefined);
    assert.equal(parseDateBound(undefined), undefined);
  });
});
