import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capIdentity, matchCapCandidate, type CapCandidate } from "./ejar.landlord-cap";

/** The looser at-cap identity match: reuse the account's own landlord, never a stranger. Synthetic values. */
const holder: CapCandidate = { id: 10, name: "Synthetic Holder", idNumber: "1000000001", taxNumber: null, isAccountHolder: true };
const noId: CapCandidate = { id: 11, name: "Synthetic  Holder", idNumber: null, taxNumber: null, isAccountHolder: false };
const company: CapCandidate = { id: 12, name: "Synthetic Co", idNumber: "1010000002", taxNumber: "7000000003", isAccountHolder: true };

const lessor = (o: Partial<{ idNumber: string; registrationNumber: string; unifiedNumber: string }>) => ({
  group: "lessor", role: null, isRepresentative: false, name: null, partyType: null, idType: null,
  idNumber: o.idNumber ?? null, phone: null, email: null, unifiedNumber: o.unifiedNumber ?? null,
  registrationNumber: o.registrationNumber ?? null, organizationType: null, vat: null,
}) as any;

describe("Ejar landlord cap — identity", () => {
  it("collects every identifier Ejar gave, deduped", () => {
    assert.deepEqual(capIdentity(lessor({ idNumber: "1", registrationNumber: "2", unifiedNumber: "2" }), " A  B ", "1").ids, ["1", "2"]);
    assert.equal(capIdentity(null, " A  B ", null).name, "A B");
  });

  it("same ID number → the account's own row", () => {
    assert.equal(matchCapCandidate([holder], capIdentity(lessor({ idNumber: "1000000001" }), "Other Name", "1000000001"))?.id, 10);
  });

  it("a company named by its 700 number matches the row carrying it as tax number", () => {
    assert.equal(matchCapCandidate([company], capIdentity(lessor({ unifiedNumber: "7000000003" }), "x", null))?.id, 12);
    assert.equal(matchCapCandidate([company], capIdentity(lessor({ registrationNumber: "1010000002" }), "x", null))?.id, 12);
  });

  it("same name on a row WITHOUT an ID number is the same party (whitespace-insensitive)", () => {
    assert.equal(matchCapCandidate([noId], capIdentity(lessor({ idNumber: "1999999999" }), "Synthetic Holder", "1999999999"))?.id, 11);
  });

  it("same name on a row with a DIFFERENT ID is a different person → no match (refused at the cap)", () => {
    assert.equal(matchCapCandidate([holder], capIdentity(lessor({ idNumber: "1999999999" }), "Synthetic Holder", "1999999999")), null);
  });

  it("a stranger matches nothing", () => {
    assert.equal(matchCapCandidate([holder, company], capIdentity(lessor({ idNumber: "1888888888" }), "Stranger", "1888888888")), null);
  });

  it("the account-holder row wins a tie", () => {
    const dupe: CapCandidate = { ...holder, id: 5, isAccountHolder: false };
    assert.equal(matchCapCandidate([dupe, holder], capIdentity(null, null, "1000000001"))?.id, 10);
  });
});
