import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agencyFeeRouting, buyerProfileByType, officeSupplyProfile } from "./office-supply";
import { agencyFeeBlockers, agencyFeeZatcaDocV2 } from "./overrides/agency-fee-approve";
import { commissionCarriesVat } from "./account-seller";
import { eInvoiceBuyerBlockers } from "../../common/invoice-readiness";

/** VAT rules Oct 2026 — R2 (commission), R3 (standard vs simplified), R4 (agency fee). Pure / fake Sql. */
describe("office supplies — VAT and ZATCA routing", () => {
  it("R3: a business buyer is standard even without a VAT number; an individual is simplified unless VAT-registered", () => {
    assert.equal(buyerProfileByType("company", null), "standard");
    assert.equal(buyerProfileByType("company", "300000000000003"), "standard");
    assert.equal(buyerProfileByType("establishment", ""), "standard");
    assert.equal(buyerProfileByType("individual", null), "simplified");
    assert.equal(buyerProfileByType("individual", "300000000000003"), "standard", "a registered sole trader is a taxable person");
    assert.equal(buyerProfileByType(null, null), "simplified");
    assert.equal(officeSupplyProfile(null, { vat: "300000000000003" }), null, "not an office supply: the caller keeps its rule");
    assert.equal(officeSupplyProfile({ buyerType: "company" }, { vat: null }), "standard");
  });

  it("R3: a standard invoice to a business without VAT needs its CR instead (idInsteadOfVat), and still the address", () => {
    const buyer = { name: "شركة", id: "1010999999", idScheme: "CRN", street: "s", buildingNo: "1234", district: "d", city: "c", postalZone: "12345" };
    assert.deepEqual(eInvoiceBuyerBlockers(buyer, "standard"), ["vat"], "the default rule is unchanged");
    assert.deepEqual(eInvoiceBuyerBlockers(buyer, "standard", { idInsteadOfVat: true }), []);
    assert.deepEqual(eInvoiceBuyerBlockers({ ...buyer, id: null, idScheme: null }, "standard", { idInsteadOfVat: true }), ["id", "idScheme"]);
  });

  it("R2: commission VAT follows the OFFICE's registration only; the legacy path no longer forces 15%", async () => {
    const q = (reg: boolean): any => ({ rows: async () => [{ reg }] });
    assert.equal(await commissionCarriesVat(q(true), 1), true);
    assert.equal(await commissionCarriesVat(q(false), 1), false);
    const src = readFileSync(join(__dirname, "../billing/billing.module.ts"), "utf8");
    const body = src.slice(src.indexOf("private async maybeCreateCommissionInvoice"), src.indexOf("@Post(\"receipt-voucher\")"));
    assert.ok(body.length > 0);
    assert.doesNotMatch(body, /vatReg = true;/, "the forced 15% is gone");
    assert.match(body, /vatReg = await commissionCarriesVat\(/);
  });

  it("R4: agency fee routing by the office's state", () => {
    assert.deepEqual(agencyFeeRouting({ vatRegistered: false, zatcaLinked: false }), { carriesVat: false, approve: "ok", sendToZatca: false });
    assert.deepEqual(agencyFeeRouting({ vatRegistered: false, zatcaLinked: true }), { carriesVat: false, approve: "ok", sendToZatca: false });
    assert.deepEqual(agencyFeeRouting({ vatRegistered: true, zatcaLinked: false }), { carriesVat: true, approve: "hold_not_linked", sendToZatca: false });
    assert.deepEqual(agencyFeeRouting({ vatRegistered: true, zatcaLinked: true }), { carriesVat: true, approve: "ok", sendToZatca: true });
  });

  it("R4: agency fee approval blockers", () => {
    const vat = { subtotal: "1000.00", total: "1150.00" };
    const noVat = { subtotal: "1000.00", total: "1000.00" };
    const seller = { name: "مكتب", vat: "300000000000003" };
    const codes = (doc: any, office: any) => agencyFeeBlockers(doc, office).map((b) => b.code);
    assert.deepEqual(codes(noVat, { vatRegistered: false, zatcaLinked: false, seller: null }), [], "unregistered: O, approves");
    assert.deepEqual(codes(vat, { vatRegistered: false, zatcaLinked: false, seller: null }), ["OFFICE_NOT_VAT_REGISTERED"]);
    assert.deepEqual(codes(vat, { vatRegistered: true, zatcaLinked: false, seller: null }), ["OFFICE_NOT_LINKED"], "held, not silently O-rated");
    assert.deepEqual(codes(noVat, { vatRegistered: true, zatcaLinked: true, seller }), ["AGENCY_FEE_VAT_MISSING"]);
    assert.deepEqual(codes(vat, { vatRegistered: true, zatcaLinked: true, seller: { name: null, vat: null } }), ["OFFICE_SELLER_INCOMPLETE"]);
    assert.deepEqual(codes(vat, { vatRegistered: true, zatcaLinked: true, seller }), [], "registered + linked: approves (then reported)");
  });

  it("R4: the ZATCA doc for a VAT-bearing agency fee files under the office (no contract) with the tenant as buyer", async () => {
    // officeOf: users/companies row, zatca row, accountVatRegistered, accountZatcaIntegrated; then the contract and tenant rows.
    const fake = (registered: boolean, linked: boolean): any => ({
      rows: async (t: string) => {
        if (/as reg/.test(t)) return [{ reg: registered }];
        if (/as linked/.test(t)) return [{ linked }];
        if (/seller_name/.test(t)) return linked ? [{ seller_name: "مكتب", seller_vat: "300000000000003" }] : [];
        if (/from users u left join companies/.test(t)) return [{ name: "مكتب", vat: registered ? "300000000000003" : null }];
        if (/from contracts/.test(t)) return [{ tenant_type: "company", tenant_name: "شركة المستأجر", tenant_id_number: "1010888888", tenant_tax_number: null, tenant_address: "شارع", tenant_postal_code: "12345", tenant_additional_number: "1111", tenant_building_number: "2222" }];
        if (/from tenants/.test(t)) return [];
        throw new Error(`unexpected query: ${t}`);
      },
    });
    const doc = { id: 5, kind: "agency_fee", type: "invoice", contractId: 9, tenantId: 3, tenantName: "شركة المستأجر", client: {}, subtotal: "1000.00", total: "1150.00" };
    const z = await agencyFeeZatcaDocV2(fake(true, true), 1, doc);
    assert.equal(z.kind, "invoice");
    assert.equal(z.contractId, null, "no contract: the standalone (office) seller, never the landlord");
    assert.equal(z.tenantId, 3);
    assert.deepEqual(z.officeSupply, { buyerType: "company" });
    assert.equal(z.client.idNumber, "1010888888");
    assert.equal(await agencyFeeZatcaDocV2(fake(true, false), 1, doc), null, "unlinked: not sent");
    assert.equal(await agencyFeeZatcaDocV2(fake(true, true), 1, { ...doc, total: "1000.00" }), null, "a non-tax fee is never sent");
    assert.equal(await agencyFeeZatcaDocV2(fake(true, true), 1, { ...doc, kind: "commission" }), null);
  });
});
