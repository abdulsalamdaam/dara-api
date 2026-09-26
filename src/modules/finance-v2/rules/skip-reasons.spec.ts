import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKIP_REASONS } from "./skip-reasons";

/** Every skip reason written anywhere in finance-v2 is in SKIP_REASONS (the list dara-web labels). */
describe("fv2 skip reasons are all listed (the web labels each one)", () => {
  it("scans the rules and the engine for skip literals", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "__tests__") walk(p); } else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) files.push(p);
      }
    };
    walk(root);
    const found = new Set<string>();
    const res = [/\bskip\("([a-z_]+)"/g, /\bskip: "([a-z_]+)"/g];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const re of res) for (const m of src.matchAll(re)) found.add(m[1]);
    }
    assert.ok(found.size >= 15, `found ${found.size}`);
    const listed = new Set<string>(SKIP_REASONS);
    assert.deepEqual([...found].filter((r) => !listed.has(r)).sort(), [], "skip reasons missing from SKIP_REASONS");
    assert.deepEqual([...listed].filter((r) => !found.has(r)).sort(), [], "listed reasons nothing writes");
  });
});
