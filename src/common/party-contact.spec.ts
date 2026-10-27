import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveOwnerContact, resolvePartyContact, resolveTenantContact } from "./party-contact";

const party = { name: "Party", phone: "551111111", email: "party@example.test" };

describe("resolvePartyContact", () => {
  it("uses the party's own contact when there is no representative", () => {
    const c = resolvePartyContact({ ...party, isRepresentative: false, representativeName: "Rep", representativePhone: "552222222", representativeEmail: "rep@example.test" });
    assert.deepEqual(c.email, { to: "party@example.test", name: "Party", viaRepresentative: false });
    assert.deepEqual(c.phone, { to: "551111111", name: "Party", viaRepresentative: false });
  });

  it("routes every channel to the representative when they have contact details", () => {
    const c = resolvePartyContact({ ...party, isRepresentative: true, representativeName: "Rep", representativePhone: "552222222", representativeEmail: "rep@example.test" });
    assert.deepEqual(c.email, { to: "rep@example.test", name: "Rep", viaRepresentative: true });
    assert.deepEqual(c.phone, { to: "552222222", name: "Rep", viaRepresentative: true });
  });

  it("falls back per channel to the party when the representative has none for it", () => {
    const c = resolvePartyContact({ ...party, isRepresentative: true, representativeName: "Rep", representativePhone: "552222222", representativeEmail: "  " });
    assert.deepEqual(c.email, { to: "party@example.test", name: "Party", viaRepresentative: false });
    assert.deepEqual(c.phone, { to: "552222222", name: "Rep", viaRepresentative: true });
  });

  it("greets with the party's name when the representative has no name on file", () => {
    const c = resolvePartyContact({ ...party, isRepresentative: true, representativeEmail: "rep@example.test" });
    assert.equal(c.email.name, "Party");
    assert.equal(c.email.viaRepresentative, true);
  });

  it("returns a null recipient when nobody has that channel", () => {
    const c = resolvePartyContact({ name: "Party", isRepresentative: true });
    assert.equal(c.email.to, null);
    assert.equal(c.phone.to, null);
  });
});

describe("row adapters", () => {
  it("reads a landlord's representative from the originalOwner* columns", () => {
    const c = resolveOwnerContact({ ...party, isRepresentative: true, originalOwnerName: "Wakeel", originalOwnerPhone: "553333333", originalOwnerEmail: "w@example.test" });
    assert.equal(c.email.to, "w@example.test");
    assert.equal(c.phone.to, "553333333");
    assert.equal(c.phone.name, "Wakeel");
  });

  it("reads a tenant's representative from the originalTenant* columns", () => {
    const c = resolveTenantContact({ ...party, isRepresentative: true, originalTenantName: "Wakeel", originalTenantPhone: null, originalTenantEmail: "w@example.test" });
    assert.equal(c.email.to, "w@example.test");
    assert.equal(c.phone.to, "551111111");
    assert.equal(c.phone.viaRepresentative, false);
  });

  it("ignores stale representative columns while the flag is off", () => {
    const c = resolveTenantContact({ ...party, isRepresentative: false, originalTenantEmail: "old@example.test" });
    assert.equal(c.email.to, "party@example.test");
  });
});
