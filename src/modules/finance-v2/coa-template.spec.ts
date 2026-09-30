import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COA_TEMPLATE, REQUIRED_SYSTEM_KEYS } from "./coa-template";

describe("chart-of-accounts template (DESIGN §3)", () => {
  const byCode = new Map(COA_TEMPLATE.map((a) => [a.code, a]));

  it("has the 116 accounts of §3 plus the 3 fixed-asset accounts of §8.5, 30 of them groups", () => {
    assert.equal(COA_TEMPLATE.length, 119);
    assert.equal(COA_TEMPLATE.filter((a) => a.isGroup).length, 30);
  });

  it("matches the DESIGN.md table row for row", () => {
    const md = readFileSync(join(__dirname, "../../../docs/finance-v2/DESIGN.md"), "utf8").split("\n");
    const start = md.findIndex((l) => l.startsWith("| Code | Arabic name"));
    const rows = [];
    for (let i = start + 2; md[i]?.startsWith("|"); i++) rows.push(md[i].split("|").slice(1, -1).map((x) => x.trim()));
    assert.equal(rows.length, COA_TEMPLATE.length);
    rows.forEach(([code, ar, en, type, parent, sk, g], i) => {
      const a = COA_TEMPLATE[i];
      assert.equal(a.code, code);
      assert.equal(a.nameAr, ar);
      assert.equal(a.nameEn, en);
      assert.equal(a.type, type.split(" ")[0]);
      assert.equal(a.parent, parent === "—" ? null : parent);
      assert.equal(a.systemKey, sk === "—" ? null : sk.replace(/`/g, ""));
      assert.equal(a.isGroup, g === "G");
    });
  });

  it("codes are unique 4–8 digit strings; names are non-empty in both languages", () => {
    assert.equal(byCode.size, COA_TEMPLATE.length);
    for (const a of COA_TEMPLATE) {
      assert.match(a.code, /^[0-9]{4,8}$/);
      assert.ok(a.nameAr.trim() && a.nameEn.trim(), a.code);
      assert.match(a.nameAr, /[؀-ۿ]/, `${a.code} Arabic name`);
    }
  });

  it("the hierarchy is valid: five typed roots; every parent exists earlier, is a group of the same type, and prefixes the code", () => {
    const roots = COA_TEMPLATE.filter((a) => a.parent === null);
    assert.deepEqual(roots.map((r) => [r.code, r.type]), [
      ["1000", "asset"], ["2000", "liability"], ["3000", "equity"], ["4000", "revenue"], ["5000", "expense"],
    ]);
    const seen = new Set<string>();
    for (const a of COA_TEMPLATE) {
      if (a.parent !== null) {
        const p = byCode.get(a.parent);
        assert.ok(p, `${a.code}: parent ${a.parent} exists`);
        assert.ok(seen.has(a.parent), `${a.code}: parent listed before child (seed order)`);
        assert.ok(p!.isGroup, `${a.code}: parent ${a.parent} is a group`);
        assert.equal(p!.type, a.type, `${a.code}: same type as parent`);
        assert.equal(p!.systemKey, null, `${a.code}: parent has no system key`);
        assert.ok(a.code.startsWith(a.parent.replace(/0+$/, "")), `${a.code} under ${a.parent}`);
      }
      seen.add(a.code);
    }
    for (const g of COA_TEMPLATE.filter((a) => a.isGroup)) {
      assert.ok(COA_TEMPLATE.some((a) => a.parent === g.code), `group ${g.code} has children`);
    }
  });

  it("system keys are unique, never on a group, and cover every key the engine resolves", () => {
    const keys = COA_TEMPLATE.filter((a) => a.systemKey).map((a) => a.systemKey!);
    assert.equal(new Set(keys).size, keys.length);
    for (const a of COA_TEMPLATE) if (a.systemKey) assert.equal(a.isGroup, false, a.code);
    for (const k of REQUIRED_SYSTEM_KEYS) assert.ok(keys.includes(k), k);
    assert.equal(byCode.get("1111")!.systemKey, "cash");
    assert.equal(byCode.get("1113")!.systemKey, "bank_default");
    assert.equal(byCode.get("2151")!.systemKey, "output_vat");
    assert.equal(byCode.get("2141")!.systemKey, "deposits_held");
    assert.equal(byCode.get("2121")!.systemKey, "landlord_payable");
    assert.equal(byCode.get("4210")!.systemKey, "commission_revenue");
  });

  it("normal balances: debit for assets and expenses, credit otherwise; contra accounts flip", () => {
    const contra = new Set(["1124", "1213", "1229", "1239"]);
    for (const a of COA_TEMPLATE) {
      const natural = a.type === "asset" || a.type === "expense" ? "debit" : "credit";
      const expected = contra.has(a.code) ? (natural === "debit" ? "credit" : "debit") : natural;
      assert.equal(a.normalBalance, expected, a.code);
    }
  });
});
