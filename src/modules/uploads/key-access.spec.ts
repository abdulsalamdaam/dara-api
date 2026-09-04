import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";

import { legacyKeyOwnershipSql } from "./key-access.service";

const render = (key: string, scope: number, companyId: number | null) =>
  new PgDialect().sqlToQuery(legacyKeyOwnershipSql(key, scope, companyId));

/**
 * A legacy key — one minted before object keys carried an account prefix — is
 * allowed only if a row this account owns still references it. That decision
 * is only as good as the list of columns it looks in: a column left off the
 * list turns a customer's own document into a 403, and a column scoped by the
 * wrong id turns somebody else's into a 200.
 *
 * The query cannot be run here (the only reachable database is production, and
 * these are ownership rules rather than data), so it is rendered and read.
 */
describe("legacy-key attribution — the columns it looks in", () => {
  const { sql: text } = render("some/legacy-key.pdf", 7, 3);

  const EXPECTED: Array<[table: string, column: string]> = [
    ["contracts", "attachment_key"],
    ["payments", "attachment_key"],
    ["payment_collections", "attachment_key"],
    ["payment_confirmations", "proof_key"],
    ["simple_invoices", "attachment_key"],
    ["simple_invoices", "pdf_key"],
    ["deeds", "document_url"],
    ["owners", "representative_doc_url"],
    ["tenants", "representative_doc_url"],
    ["properties", "image_key"],
    ["properties", "images"],
    ["units", "image_key"],
    ["units", "floor_plan_key"],
    ["units", "images"],
    ["units", "documents"],
    ["companies", "logo_key"],
  ];

  for (const [table, column] of EXPECTED) {
    it(`covers ${table}.${column}`, () => {
      // Every one of these holds a MinIO object key on a live row. Dropping one
      // silently breaks whichever screen renders that attachment, with a 403
      // that looks like a permissions bug rather than a missing column.
      assert.ok(text.includes(table), `no reference to ${table}`);
      assert.ok(text.includes(column), `no reference to ${column}`);
    });
  }
});

describe("legacy-key attribution — how it is scoped", () => {
  it("binds the key and the scope as parameters, never as text", () => {
    // The key arrives in a query string. Interpolating it would be SQL
    // injection on the authorization check itself.
    const { sql: text, params } = render("o'brien/x.pdf", 7, null);
    assert.ok(!text.includes("o'brien"));
    assert.ok(params.includes("o'brien/x.pdf"));
    assert.ok(params.includes(7));
  });

  it("scopes units through their property's owner, not through units alone", () => {
    // `units` has no user_id — it hangs off `properties`. Without the join a
    // unit attachment would be attributable to anybody.
    const { sql: text } = render("k", 7, null);
    assert.match(text, /from units u join properties p on p\.id = u\.property_id/);
  });

  it("drops the companies arm entirely when the caller has no company", () => {
    // An employee of no company must not match `companies.logo_key` by having
    // a NULL compared to a NULL — and a bound NULL in `id = $n` would also
    // leave Postgres unable to infer the parameter type (42P08).
    const withCompany = render("k", 7, 3);
    const without = render("k", 7, null);
    assert.ok(withCompany.sql.includes("logo_key"));
    assert.ok(!without.sql.includes("logo_key"));
    assert.ok(!without.params.includes(null));
  });

  it("guards the jsonb galleries against a column that is not an array", () => {
    // `jsonb_array_elements` raises on a scalar or an object. An authorization
    // check that 500s on one odd row is an outage, not a refusal.
    const { sql: text } = render("k", 7, null);
    const guards = text.match(/jsonb_typeof\(/g) ?? [];
    // Three gallery columns — properties.images, units.images, units.documents
    // — each guarded twice (the array test and the per-element object test).
    assert.equal(guards.length, 6);
  });
});
