import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ejarNumberKey, ejarNumberTakenMessage } from "./ejar-contract-number";

describe("ejarNumberKey — one Ejar number however it was typed", () => {
  it("normalises digits, spaces, dashes and leading zeros", () => {
    for (const raw of ["20498373268", " 20498 373268 ", "2049-8373-268", "٢٠٤٩٨٣٧٣٢٦٨", "۲۰۴۹۸۳۷۳۲۶۸", "0020498373268"]) {
      assert.equal(ejarNumberKey(raw), "20498373268", raw);
    }
  });
  it("blank is no number", () => {
    for (const raw of [null, undefined, "", "   ", "000"]) assert.equal(ejarNumberKey(raw), null);
  });
  it("the refusal names the number in Arabic and English", () => {
    const m = ejarNumberTakenMessage("20498373268", "C-0007");
    assert.match(m, /هذا العقد مسجّل مسبقاً برقم إيجار 20498373268 \(C-0007\)/);
    assert.match(m, /already in your account/);
  });
});
