import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";

import { assertPinnedPartyId, isPinnedRow, pinnedIdentityAfter, PARTY_ID_REQUIRED } from "./pinned-identity";

const code = (fn: () => void): string | null => {
  try { fn(); return null; } catch (e) {
    assert.ok(e instanceof BadRequestException);
    const r = (e as BadRequestException).getResponse() as any;
    return typeof r === "object" && r.code ? r.code : "FORMAT";
  }
};

describe("isPinnedRow — which plans and rows require the ID", () => {
  it("عقاري: every landlord row; never a tenant row", () => {
    assert.equal(isPinnedRow("basic", "landlord", false), true);
    assert.equal(isPinnedRow("basic", "landlord", true), true);
    assert.equal(isPinnedRow("basic", "tenant", true), false);
  });
  it("tenant plan: only the account-holder tenant row; never a landlord row", () => {
    assert.equal(isPinnedRow("tenant", "tenant", true), true);
    assert.equal(isPinnedRow("tenant", "tenant", false), false);
    assert.equal(isPinnedRow("tenant", "landlord", true), false);
  });
  it("Offices / Companies (and the broker default) stay optional", () => {
    for (const plan of ["professional", "enterprise", "broker", null, undefined, "nonsense"]) {
      assert.equal(isPinnedRow(plan, "landlord", true), false, String(plan));
      assert.equal(isPinnedRow(plan, "tenant", true), false, String(plan));
    }
  });
});

describe("pinnedIdentityAfter — when a request must be checked", () => {
  it("create: always, with the sent values", () => {
    assert.deepEqual(pinnedIdentityAfter(null, { idNumber: "1012345678" }, "idNumber"),
      { type: "individual", idNumber: "1012345678", isDraft: false });
    assert.deepEqual(pinnedIdentityAfter(null, { type: "company", isDraft: true }, "idNumber"),
      { type: "company", idNumber: undefined, isDraft: true });
  });
  it("PATCH that does not touch identity (a phone change) is not checked", () => {
    const prior = { type: "individual", idNumber: null, isDraft: false };
    assert.equal(pinnedIdentityAfter(prior, { phone: "0501234567", isDraft: false }, "idNumber"), null);
    assert.equal(pinnedIdentityAfter(prior, { email: "x@y.sa" }, "idNumber"), null);
  });
  it("PATCH touching type or the ID is checked against the merged row", () => {
    const prior = { type: "individual", nationalId: "1012345678", isDraft: false };
    assert.deepEqual(pinnedIdentityAfter(prior, { type: "company" }, "nationalId"),
      { type: "company", idNumber: "1012345678", isDraft: false });
    assert.deepEqual(pinnedIdentityAfter(prior, { nationalId: null }, "nationalId"),
      { type: "individual", idNumber: null, isDraft: false });
  });
  it("finalising a draft is checked even when identity is not re-sent", () => {
    const prior = { type: "individual", idNumber: null, isDraft: true };
    assert.deepEqual(pinnedIdentityAfter(prior, { isDraft: false }, "idNumber"),
      { type: "individual", idNumber: null, isDraft: false });
  });
});

describe("assertPinnedPartyId", () => {
  const ind = (idNumber: unknown, isDraft = false) => ({ type: "individual", idNumber, isDraft });
  const co = (idNumber: unknown, isDraft = false) => ({ type: "company", idNumber, isDraft });

  it("refuses a missing ID with PARTY_ID_REQUIRED, for both sides and types", () => {
    for (const v of [null, undefined, "", "   "]) {
      assert.equal(code(() => assertPinnedPartyId("landlord", ind(v), "idNumber")), PARTY_ID_REQUIRED);
      assert.equal(code(() => assertPinnedPartyId("landlord", co(v), "idNumber")), PARTY_ID_REQUIRED);
      assert.equal(code(() => assertPinnedPartyId("tenant", ind(v), "nationalId")), PARTY_ID_REQUIRED);
      assert.equal(code(() => assertPinnedPartyId("tenant", co(v), "nationalId")), PARTY_ID_REQUIRED);
    }
  });
  it("the message is Arabic + English and names the right thing", () => {
    try { assertPinnedPartyId("landlord", ind(null), "idNumber"); assert.fail(); } catch (e) {
      const r = (e as BadRequestException).getResponse() as any;
      assert.match(r.message, /رقم الهوية/);
      assert.match(r.message, /national ID/);
      assert.equal(r.role, "landlord");
      assert.equal(r.field, "idNumber");
    }
    try { assertPinnedPartyId("tenant", co(""), "nationalId"); assert.fail(); } catch (e) {
      const r = (e as BadRequestException).getResponse() as any;
      assert.match(r.message, /السجل التجاري/);
      assert.match(r.message, /commercial registration/);
    }
  });
  it("individual: national ID / Iqama — 10 digits starting 1 or 2", () => {
    assert.equal(code(() => assertPinnedPartyId("landlord", ind("1012345678"), "idNumber")), null);
    assert.equal(code(() => assertPinnedPartyId("landlord", ind("2012345678"), "idNumber")), null);
    assert.equal(code(() => assertPinnedPartyId("landlord", ind("3012345678"), "idNumber")), "FORMAT");
    assert.equal(code(() => assertPinnedPartyId("landlord", ind("101234567"), "idNumber")), "FORMAT");
    assert.equal(code(() => assertPinnedPartyId("tenant", ind("10123456ab"), "nationalId")), "FORMAT");
  });
  it("company: CR — 10 digits, the 7-prefixed unified number included", () => {
    assert.equal(code(() => assertPinnedPartyId("landlord", co("1010999001"), "idNumber")), null);
    assert.equal(code(() => assertPinnedPartyId("tenant", co("7001234567"), "nationalId")), null);
    assert.equal(code(() => assertPinnedPartyId("tenant", co("70012345"), "nationalId")), "FORMAT");
  });
  it("drafts and requests with nothing to check pass", () => {
    assert.equal(code(() => assertPinnedPartyId("landlord", ind(null, true), "idNumber")), null);
    assert.equal(code(() => assertPinnedPartyId("tenant", null, "nationalId")), null);
  });
});
