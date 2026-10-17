import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIST_INDEXES, createSql } from "./indexes";

describe("LIST_INDEXES", () => {
  it("builds every index concurrently and idempotently", () => {
    for (const ix of LIST_INDEXES) {
      const s = createSql(ix);
      assert.match(s, /^create index concurrently if not exists "[a-z0-9_]+" on "[a-z_]+" /, ix.name);
      // One statement only: CONCURRENTLY refuses a multi-statement string.
      assert.ok(!s.includes(";"), ix.name);
    }
  });

  it("has unique names, each documented with the query it serves", () => {
    const names = LIST_INDEXES.map((i) => i.name);
    assert.equal(new Set(names).size, names.length);
    for (const ix of LIST_INDEXES) {
      assert.ok(ix.name.length <= 63, `${ix.name} exceeds NAMEDATALEN`);
      assert.ok(ix.serves.trim().length > 0, ix.name);
    }
  });

  it("never supersedes an index another entry builds", () => {
    const names = new Set(LIST_INDEXES.map((i) => i.name));
    for (const ix of LIST_INDEXES) for (const old of ix.supersedes ?? []) assert.ok(!names.has(old), old);
  });

  it("keeps the payment_ids GIN on the exact expression the queries use", () => {
    // `coalesce(si.payment_ids, '[]'::jsonb) @> …` only matches an index on the
    // same expression; an index on bare payment_ids is never picked.
    const gin = LIST_INDEXES.find((i) => i.name === "simple_invoices_payment_ids_gin")!;
    assert.match(gin.def, /coalesce\(payment_ids, '\[\]'::jsonb\)/);
  });
});
