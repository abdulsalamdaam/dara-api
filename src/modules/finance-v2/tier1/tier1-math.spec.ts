import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asciiDigits, checkSaudiIban, ibanMod97, makeSaudiIban, normaliseIban } from "./iban";
import { expenseAmounts, recoverDefault } from "./expense-math";

/** Pure tier-1 helpers (DESIGN §8.2). All values synthetic. */
describe("fv2 tier 1: Saudi IBAN", () => {
  it("builds and accepts a synthetic IBAN with correct check digits (mod-97 = 1)", () => {
    const iban = makeSaudiIban("80", "000000608010167519");
    assert.equal(iban.length, 24);
    assert.equal(ibanMod97(iban), 1);
    const r = checkSaudiIban(iban);
    assert.equal(r.ok, true);
    assert.equal((r as any).bankCode, "80");
    assert.deepEqual((r as any).bank, { ar: "مصرف الراجحي", en: "Al Rajhi Bank" });
  });

  it("normalises spaces, lower case and Arabic-Indic digits", () => {
    const iban = makeSaudiIban("10", "000000000000000001");
    const spaced = iban.toLowerCase().replace(/(.{4})/g, "$1 ").trim();
    assert.equal(normaliseIban(spaced), iban);
    const arabic = iban.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    assert.equal(asciiDigits(arabic), iban);
    assert.equal((checkSaudiIban(arabic) as any).iban, iban);
  });

  it("refuses a wrong check digit, a wrong length and a foreign country code", () => {
    const iban = makeSaudiIban("20", "000000000000000042");
    const bad = iban.slice(0, 2) + String((Number(iban[2]) + 1) % 10) + iban.slice(3);
    assert.deepEqual(checkSaudiIban(bad), { ok: false, reason: "checksum" });
    assert.deepEqual(checkSaudiIban(iban.slice(0, 23)), { ok: false, reason: "format" });
    assert.deepEqual(checkSaudiIban("GB82WEST12345698765432"), { ok: false, reason: "format" });
  });

  it("an unknown bank code is valid with no bank name", () => {
    const r = checkSaudiIban(makeSaudiIban("99", "000000000000000007"));
    assert.equal(r.ok, true);
    assert.equal((r as any).bank, null);
  });
});

describe("fv2 tier 1: expense VAT arithmetic", () => {
  it("gross entry splits at the rate; net entry adds round-half-up VAT", () => {
    assert.deepEqual(expenseAmounts("gross", 115000, "S", 15), { gross: 115000, net: 100000, vat: 15000, rate: 15 });
    assert.deepEqual(expenseAmounts("net", 100000, "S", 15), { gross: 115000, net: 100000, vat: 15000, rate: 15 });
    // 33.33 net at 15% = 4.9995 → 5.00 VAT (half up)
    assert.deepEqual(expenseAmounts("net", 3333, "S", 15), { gross: 3833, net: 3333, vat: 500, rate: 15 });
    // 10.00 gross at 15% → net 8.70, VAT 1.30 (the engine's split)
    assert.deepEqual(expenseAmounts("gross", 1000, "S", 15), { gross: 1000, net: 870, vat: 130, rate: 15 });
  });

  it("Z / E / O carry no VAT whatever the mode", () => {
    for (const c of ["Z", "E", "O"] as const) {
      assert.deepEqual(expenseAmounts("net", 5000, c, 15), { gross: 5000, net: 5000, vat: 0, rate: 0 });
      assert.deepEqual(expenseAmounts("gross", 5000, c, 0), { gross: 5000, net: 5000, vat: 0, rate: 0 });
    }
  });

  it("net + VAT = gross for every amount from 0.01 to 20.00 at 15% (both modes)", () => {
    for (let a = 1; a <= 2000; a++) {
      for (const mode of ["gross", "net"] as const) {
        const r = expenseAmounts(mode, a, "S", 15);
        assert.equal(r.net + r.vat, r.gross);
      }
    }
  });
});

describe("fv2 tier 1: recoverability default (§8.2 b)", () => {
  const base = { category: "S" as const, chargeTo: "company" as const, accountRegistered: true, hasProperty: true, usage: "commercial" as const };
  it("recoverable only when S, registrant known, and not residential", () => {
    assert.deepEqual(recoverDefault(base), { recoverable: true, reason: "recoverable" });
    assert.deepEqual(recoverDefault({ ...base, category: "E" }), { recoverable: false, reason: "not_standard_rated" });
    assert.deepEqual(recoverDefault({ ...base, accountRegistered: false }), { recoverable: false, reason: "account_not_registered" });
    assert.deepEqual(recoverDefault({ ...base, usage: "residential" }), { recoverable: false, reason: "residential_property" });
    assert.deepEqual(recoverDefault({ ...base, usage: null }), { recoverable: false, reason: "mixed_or_unknown_usage" });
    assert.deepEqual(recoverDefault({ ...base, chargeTo: "landlord" }), { recoverable: false, reason: "charged_to_landlord" });
  });
  it("an overhead (no property) is recoverable and left to the ratio", () => {
    assert.deepEqual(recoverDefault({ ...base, hasProperty: false, usage: null }), { recoverable: true, reason: "overhead_apportioned" });
  });
});
