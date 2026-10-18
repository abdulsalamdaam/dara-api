import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import {
  EMAIL_TAKEN_CODE,
  assertEmailAvailable,
  emailTakenException,
  isEmailUniqueViolation,
  normalizeEmail,
} from "./user-email";

/** A db whose users lookup answers with `rows`, recording that it was asked. */
function dbWith(rows: Array<{ id: number }>) {
  const calls: string[] = [];
  const chain: any = {
    select: () => { calls.push("select"); return chain; },
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { db: chain, calls };
}

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    assert.equal(normalizeEmail("  Foo.Bar@Example.COM \t"), "foo.bar@example.com");
  });
  it("is empty for nothing or a non-string", () => {
    assert.equal(normalizeEmail(""), "");
    assert.equal(normalizeEmail("   "), "");
    assert.equal(normalizeEmail(undefined), "");
    assert.equal(normalizeEmail(42), "");
  });
});

describe("assertEmailAvailable — one email, one account", () => {
  it("passes when no row carries the address", async () => {
    const { db, calls } = dbWith([]);
    await assertEmailAvailable(db, "new@example.com");
    assert.deepEqual(calls, ["select"]);
  });

  it("409s when another row carries it (live or soft-deleted — the query does not filter deleted_at)", async () => {
    const { db } = dbWith([{ id: 5 }]);
    await assert.rejects(assertEmailAvailable(db, "taken@example.com"), (e: unknown) => {
      assert.ok(e instanceof ConflictException);
      assert.equal(e.getStatus(), 409);
      const body = e.getResponse() as Record<string, unknown>;
      assert.equal(body.error, EMAIL_TAKEN_CODE, "web register form reads data.error === EMAIL_TAKEN");
      assert.equal(body.code, EMAIL_TAKEN_CODE);
      assert.match(String(body.message), /مسجّل مسبقاً/);
      assert.match(String(body.message), /already registered/);
      return true;
    });
  });

  it("ignores the row being edited itself", async () => {
    const { db } = dbWith([{ id: 5 }]);
    await assertEmailAvailable(db, "me@example.com", 5);
  });

  it("still 409s when the row itself AND another share it", async () => {
    const { db } = dbWith([{ id: 5 }, { id: 9 }]);
    await assert.rejects(assertEmailAvailable(db, "me@example.com", 5), ConflictException);
  });
});

describe("isEmailUniqueViolation — the race the check cannot see", () => {
  it("matches a bare pg unique violation on an email index", () => {
    assert.equal(isEmailUniqueViolation({ code: "23505", constraint: "users_email_unique" }), true);
    assert.equal(isEmailUniqueViolation({ code: "23505", constraint: "users_email_lower_unique" }), true);
  });
  it("matches one wrapped by drizzle (on .cause)", () => {
    const err = Object.assign(new Error("Failed query: insert into users"), {
      cause: { code: "23505", constraint: "users_email_lower_unique" },
    });
    assert.equal(isEmailUniqueViolation(err), true);
  });
  it("does not match other unique violations or other errors", () => {
    assert.equal(isEmailUniqueViolation({ code: "23505", constraint: "companies_pkey" }), false);
    assert.equal(isEmailUniqueViolation({ code: "23503", constraint: "users_email_unique" }), false);
    assert.equal(isEmailUniqueViolation(new Error("boom")), false);
    assert.equal(isEmailUniqueViolation(null), false);
  });
  it("translates to the same 409 as the check", () => {
    const e = emailTakenException();
    assert.equal(e.getStatus(), 409);
    assert.equal((e.getResponse() as any).error, EMAIL_TAKEN_CODE);
  });
});
