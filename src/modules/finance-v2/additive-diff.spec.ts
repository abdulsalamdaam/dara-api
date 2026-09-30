import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkMigrationAlters, checkProtected, checkPurgeInMigration, hunkHash, parseAllowlist, parseDiff, PROFILES,
} from "../../../scripts/finance-v2-additive-diff";

const P = PROFILES.api.protected;

function diffOf(file: string, body: string, extra = ""): string {
  return `diff --git a/${file} b/${file}\n${extra}index 1..2 100644\n--- a/${file}\n+++ b/${file}\n${body}`;
}

describe("finance-v2 additive-diff gate (DESIGN §1.4.5)", () => {
  it("accepts a marked added hunk in a protected file", () => {
    const d = parseDiff(diffOf("src/modules/billing/billing.module.ts",
      "@@ -10,0 +11,2 @@\n+    const fv2 = await this.fv2.resolve(scope); // finance-v2: fork\n+    if (fv2) return this.v2.approve(id);\n"));
    assert.deepEqual(checkProtected(d, P, new Set()), []);
  });

  it("rejects an unmarked added hunk", () => {
    const d = parseDiff(diffOf("src/modules/payments/payments.module.ts", "@@ -10,0 +11 @@\n+    doSomething();\n"));
    assert.equal(checkProtected(d, P, new Set()).length, 1);
  });

  it("rejects a removed line unless its hunk hash is allowlisted", () => {
    const body = "@@ -375 +375 @@\n-  pageSize: 1000,\n+  pageSize: 500, // finance-v2: EX-1\n";
    const d = parseDiff(diffOf("src/modules/reports/reports.module.ts", body));
    const problems = checkProtected(d, P, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /finance-v2-removed-lines\.allow/);
    const hash = hunkHash({ removed: ["  pageSize: 1000,"] });
    const allow = parseAllowlist(`# comment\nsrc/modules/reports/reports.module.ts\t${hash}\tEX-1 export 400\n`);
    assert.deepEqual(checkProtected(d, P, allow), []);
  });

  it("ignores unprotected files and exempts new files from the marker rule; rejects deletes", () => {
    const d = parseDiff(
      diffOf("src/modules/finance-v2/x.ts", "@@ -1 +1 @@\n-a\n+b\n") +
      diffOf("src/modules/billing/new-helper.ts", "@@ -0,0 +1 @@\n+export const x = 1;\n", "new file mode 100644\n") +
      diffOf("src/common/scope.ts", "@@ -1 +0,0 @@\n-export const y = 1;\n", "deleted file mode 100644\n"));
    const problems = checkProtected(d, P, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /scope\.ts: a protected legacy file was deleted/);
  });

  it("allowlist entries need a reason", () => {
    assert.throws(() => parseAllowlist("src/a.ts\tabc\n"));
  });

  it("migration: ALTER TABLE only on tables the file creates", () => {
    assert.deepEqual(checkMigrationAlters("create table if not exists accounts (id int); alter table accounts add column x int;", "m"), []);
    assert.equal(checkMigrationAlters("alter table users add column finance_v2 boolean;", "m").length, 1);
  });

  it("the real 0066 passes both migration checks", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const sql = readFileSync(join(__dirname, "../../../db/drizzle/0066_finance_v2.sql"), "utf8");
    assert.deepEqual(checkMigrationAlters(sql, "0066"), []);
    assert.deepEqual(checkPurgeInMigration(sql), []);
  });

  it("the real 0067 alters nothing and never touches the purge switch", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const sql = readFileSync(join(__dirname, "../../../db/drizzle/0067_finance_v2_tier2.sql"), "utf8");
    assert.deepEqual(checkMigrationAlters(sql, "0067"), []);
    assert.ok(!sql.includes(["fv2", "purge"].join(".")), "the purge switch stays in 0066");
    assert.ok(!/\balter\s+table\b/i.test(sql.replace(/--[^\n]*/g, "")), "no ALTER TABLE at all");
  });

  it("the real 0068 and 0069 alter nothing and never touch the purge switch", () => {
    const { readFileSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    for (const f of ["0068_finance_v2_hardening.sql", "0069_finance_v2_tier3.sql", "0074_finance_v2_assets.sql"]) {
      const p = join(__dirname, "../../../db/drizzle", f);
      if (f.startsWith("0068")) assert.ok(existsSync(p), f);
      if (!existsSync(p)) continue;
      const sql = readFileSync(p, "utf8");
      assert.deepEqual(checkMigrationAlters(sql, f), []);
      assert.ok(!sql.includes(["fv2", "purge"].join(".")), `${f}: the purge switch stays in 0066`);
      assert.ok(!/\balter\s+table\b/i.test(sql.replace(/--[^\n]*/g, "")), `${f}: no ALTER TABLE at all`);
    }
  });
});
