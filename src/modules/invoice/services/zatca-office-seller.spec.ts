/**
 * The office's own ZATCA seller (credentials with owner_id NULL).
 *
 * An office registered without an account-holder landlord had no row on the
 * integration tab, so it could never link — and its commission / agency-fee
 * tax invoices stayed held with OFFICE_NOT_LINKED. GET /zatca/landlords now
 * puts an office row first; POST /zatca/profile fills the CSR fields a bare
 * profile leaves out instead of 500-ing on the NOT NULL columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { officeSellerRow, withProfileDefaults, nextEgsSerial } from "./zatca-onboarding.service";

const COMPANY = {
  name: "مكتب الاختبار", vatNumber: "300000000000003", commercialReg: "1010101010",
  buildingNumber: "1234", street: "طريق الملك فهد", district: "العليا", city: "الرياض",
  postalCode: "12211", additionalNumber: "5678",
};

test("office row: same shape as a landlord row, ownerId null and isAccount", () => {
  const r = officeSellerRow(COMPANY, null);
  assert.equal(r.ownerId, null);
  assert.equal(r.isAccount, true);
  assert.equal(r.type, "company");
  assert.equal(r.name, "مكتب الاختبار");
  assert.equal(r.vatNumber, "300000000000003");
  assert.equal(r.vatReady, true);
  assert.equal(r.addressReady, true);
  assert.equal(r.address.city, "الرياض");
  assert.equal(r.configured, false);
  assert.equal(r.sandboxOnboarded, false);
  assert.equal(r.productionOnboarded, false);
});

test("office row: no VAT on the company reads as not ready, and a partial address too", () => {
  const r = officeSellerRow({ ...COMPANY, vatNumber: "  ", street: null }, null);
  assert.equal(r.vatNumber, null);
  assert.equal(r.vatReady, false);
  assert.equal(r.addressReady, false);
});

test("office row: link state comes from the owner-less credentials row", () => {
  const r = officeSellerRow(COMPANY, {
    activeEnvironment: "production", prodCertPem: "CERT", prodSlotEnv: "production",
    sandboxCertPem: null, locationAddress: "1234 12211 5678 SA", linkInvalidAt: null,
  } as never);
  assert.equal(r.configured, true);
  assert.equal(r.productionOnboarded, true);
  assert.equal(r.simulationOnboarded, false);
  assert.equal(r.activeEnvironment, "production");
  assert.equal(r.nationalAddress, "1234 12211 5678 SA");
});

const BARE = {
  sellerName: "مكتب الاختبار", sellerVatNumber: "300000000000003", sellerCrn: "1010101010",
  sellerStreet: "طريق", sellerBuildingNo: "1234", sellerDistrict: "العليا",
  sellerCity: "الرياض", sellerPostalZone: "12211", sellerAdditionalNo: "5678",
};

test("profile defaults: account-level seller gets Dara-acct CN and serial", () => {
  const p = withProfileDefaults(BARE, { userId: 77, ownerId: null });
  assert.equal(p.commonName, "Dara-acct-77");
  assert.equal(p.serialNumber, "1-Dara|2-PMS|3-acct-77");
  assert.equal(p.organizationIdentifier, "300000000000003");
  assert.equal(p.organizationUnitName, "1010101010");
  assert.equal(p.industryCategory, "Real estate");
  // ASCII only: it lands in the certificate's subjectAltName.
  assert.equal(p.locationAddress, "1234 12211 5678 SA");
});

test("profile defaults: a landlord keeps the per-landlord serial; no CRN → name as org unit", () => {
  const p = withProfileDefaults({ ...BARE, sellerCrn: null }, { userId: 77, ownerId: 9 });
  assert.equal(p.commonName, "Dara-9");
  assert.equal(p.serialNumber, "1-Dara|2-PMS|3-9");
  assert.equal(p.organizationUnitName, "مكتب الاختبار");
});

test("profile defaults: sent values win, then the existing row (keeps a bumped generation)", () => {
  const sent = withProfileDefaults({ ...BARE, commonName: "X", serialNumber: "1-A|2-B|3-C" }, { userId: 1, ownerId: null });
  assert.equal(sent.commonName, "X");
  assert.equal(sent.serialNumber, "1-A|2-B|3-C");
  const kept = withProfileDefaults(BARE, { userId: 1, ownerId: null, existing: { serialNumber: "1-Dara|2-PMS|3-acct-1-2" } });
  assert.equal(kept.serialNumber, "1-Dara|2-PMS|3-acct-1-2");
});

test("the account seller's device is versioned like a landlord's", () => {
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-acct-77"), "1-Dara|2-PMS|3-acct-77-2");
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-acct-77-2"), "1-Dara|2-PMS|3-acct-77-3");
});
