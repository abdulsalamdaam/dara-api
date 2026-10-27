import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertNationalAddress, assertPartyNationalAddress, assertPartyNationalAddressOnPatch } from "./national-address";

const full = {
  buildingNumber: "1234", nationalAddressStreet: "King Fahd", nationalAddressDistrict: "Olaya",
  nationalAddressCity: "Riyadh", postalCode: "12345", additionalNumber: "6789",
};
const VAT = "300000000000003";

describe("assertPartyNationalAddress (landlords and tenants — address follows the VAT number)", () => {
  it("lets a party without a VAT number through with no address, individual or company", () => {
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "individual", name: "x" }));
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "company", name: "x" }));
    assert.doesNotThrow(() => assertPartyNationalAddress({ name: "x", taxNumber: "  " }));
    assert.doesNotThrow(() => assertPartyNationalAddress({ name: "x", taxNumber: null }));
  });

  it("accepts a partial address without VAT but checks the postal code format", () => {
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "individual", nationalAddressCity: "Riyadh" }));
    assert.throws(() => assertPartyNationalAddress({ type: "company", postalCode: "123" }));
  });

  it("requires the full address once a VAT number is given", () => {
    assert.throws(() => assertPartyNationalAddress({ type: "company", taxNumber: VAT }));
    assert.throws(() => assertPartyNationalAddress({ type: "individual", taxNumber: VAT, ...full, additionalNumber: "" }));
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "company", taxNumber: VAT, ...full }));
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "individual", taxNumber: VAT, ...full }));
  });

  it("exempts drafts", () => {
    assert.doesNotThrow(() => assertPartyNationalAddress({ type: "company", taxNumber: VAT, isDraft: true }));
  });
});

describe("assertNationalAddress (the full block)", () => {
  it("requires every field", () => {
    assert.throws(() => assertNationalAddress({ type: "individual" }));
    assert.doesNotThrow(() => assertNationalAddress(full));
  });
});

describe("assertPartyNationalAddressOnPatch", () => {
  it("ignores a PATCH that touches neither VAT nor address", () => {
    assert.doesNotThrow(() => assertPartyNationalAddressOnPatch({ taxNumber: VAT }, { phone: "0551234567" }));
  });
  it("refuses adding a VAT number to a record without an address", () => {
    assert.throws(() => assertPartyNationalAddressOnPatch({ taxNumber: null }, { taxNumber: VAT }));
    assert.doesNotThrow(() => assertPartyNationalAddressOnPatch({ ...full }, { taxNumber: VAT }));
  });
  it("lets the address be cleared once the VAT number is gone", () => {
    assert.doesNotThrow(() => assertPartyNationalAddressOnPatch({ taxNumber: VAT, ...full }, { taxNumber: null, postalCode: null }));
    assert.throws(() => assertPartyNationalAddressOnPatch({ taxNumber: VAT, ...full }, { postalCode: null }));
  });
});
