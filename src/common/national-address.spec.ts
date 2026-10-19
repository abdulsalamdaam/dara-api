import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertNationalAddress, assertTenantNationalAddress } from "./national-address";

const full = {
  buildingNumber: "1234", nationalAddressStreet: "King Fahd", nationalAddressDistrict: "Olaya",
  nationalAddressCity: "Riyadh", postalCode: "12345", additionalNumber: "6789",
};

describe("assertTenantNationalAddress", () => {
  it("lets an individual without VAT through with no address", () => {
    assert.doesNotThrow(() => assertTenantNationalAddress({ type: "individual", name: "x" }));
    assert.doesNotThrow(() => assertTenantNationalAddress({ name: "x", taxNumber: "  " }));
  });

  it("accepts a partial address on an individual but checks the postal code format", () => {
    assert.doesNotThrow(() => assertTenantNationalAddress({ type: "individual", nationalAddressCity: "Riyadh" }));
    assert.throws(() => assertTenantNationalAddress({ type: "individual", postalCode: "123" }));
  });

  it("requires the full address for a company or a VAT-registered tenant", () => {
    assert.throws(() => assertTenantNationalAddress({ type: "company" }));
    assert.throws(() => assertTenantNationalAddress({ type: "individual", taxNumber: "300000000000003" }));
    assert.doesNotThrow(() => assertTenantNationalAddress({ type: "company", ...full }));
    assert.doesNotThrow(() => assertTenantNationalAddress({ type: "individual", taxNumber: "300000000000003", ...full }));
  });

  it("exempts drafts", () => {
    assert.doesNotThrow(() => assertTenantNationalAddress({ type: "company", isDraft: true }));
  });
});

describe("assertNationalAddress (landlords)", () => {
  it("still requires the full address", () => {
    assert.throws(() => assertNationalAddress({ type: "individual" }));
    assert.doesNotThrow(() => assertNationalAddress(full));
  });
});
