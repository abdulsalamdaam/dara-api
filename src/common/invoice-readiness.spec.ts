/**
 * Invoice guard (Task 3).
 *
 * Builds a real contract + tenant + landlord + property + unit, then checks
 * every way an invoice can be blocked — inside a transaction that is always
 * rolled back, so this is safe against any database.
 *
 * Skipped when DATABASE_URL is unset.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, getPool, usersTable, ownersTable, tenantsTable, propertiesTable, unitsTable,
  contractsTable, contractUnitsTable, zatcaCredentialsTable,
} from "@dara/database";
import { checkInvoiceReadiness } from "./invoice-readiness";

const HAS_DB = !!process.env.DATABASE_URL;
class Rollback extends Error {}

let userId = 0;

before(async () => {
  if (!HAS_DB) return;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  userId = u?.id ?? 0;
});
after(async () => {
  if (HAS_DB) await getPool().end();
});

/** A landlord/tenant with every invoice-required field filled in. */
const completeAddress = {
  nationalAddressStreet: "طريق الملك فهد",
  nationalAddressDistrict: "العليا",
  nationalAddressCity: "الرياض",
  buildingNumber: "1234",
  postalCode: "12211",
};

type Ctx = {
  tx: typeof db;
  contractId: number;
  ownerId: number;
  tenantId: number;
};

/**
 * Build the full chain, let the caller mutate it, then check readiness.
 * `tweak` receives the ids so a test can null out exactly one field.
 */
async function withScenario<T>(
  opts: { tenantType?: "individual" | "company"; ownerVat?: string | null; zatca?: "none" | "row-only" | "onboarded" },
  tweak: (ctx: Ctx) => Promise<void>,
  assertFn: (readiness: Awaited<ReturnType<typeof checkInvoiceReadiness>>, ctx: Ctx) => T,
): Promise<T> {
  let out!: T;
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.insert(ownersTable).values({
        userId, name: "مؤجر الاختبار", type: "individual", idNumber: "1000000001",
        phone: "+966500000001", email: "landlord@test.local",
        taxNumber: opts.ownerVat === undefined ? "300000000000003" : opts.ownerVat,
        ...completeAddress, status: "active",
      }).returning();

      const [tenant] = await tx.insert(tenantsTable).values({
        userId, name: "مستأجر الاختبار", type: opts.tenantType ?? "individual",
        nationalId: "1000000002", phone: "+966500000002", email: "tenant@test.local",
        taxNumber: "300000000000011", ...completeAddress, status: "active", isDemo: "false",
      }).returning();

      const [property] = await tx.insert(propertiesTable).values({
        userId, name: "عقار الاختبار", ownerId: owner!.id,
      }).returning();
      const [unit] = await tx.insert(unitsTable).values({
        propertyId: property!.id, unitNumber: "T-1", status: "rented",
      }).returning();
      const [contract] = await tx.insert(contractsTable).values({
        userId, contractNumber: `TEST-GUARD-${Date.now()}`, tenantId: tenant!.id,
        tenantName: tenant!.name, startDate: "2026-01-01", endDate: "2026-12-31",
        monthlyRent: "1000", status: "active",
      }).returning();
      await tx.insert(contractUnitsTable).values({ contractId: contract!.id, unitId: unit!.id });

      if (opts.zatca === "row-only" || opts.zatca === "onboarded") {
        const done = opts.zatca === "onboarded";
        await tx.insert(zatcaCredentialsTable).values({
          userId, ownerId: owner!.id, activeEnvironment: "sandbox",
          sellerName: "Seller", sellerVatNumber: "300000000000003",
          sellerStreet: "S", sellerBuildingNo: "1", sellerDistrict: "D",
          sellerCity: "R", sellerPostalZone: "12211",
          // CSR fields the table requires but that play no part in this guard.
          serialNumber: "1-Dara|2-Test|3-0001",
          organizationIdentifier: "300000000000003",
          organizationUnitName: "Test Unit",
          locationAddress: "Riyadh",
          industryCategory: "Real Estate",
          commonName: "Dara Test",
          sandboxCertPem: done ? "CERT" : null,
          sandboxPrivateKeyEnc: done ? "KEY" : null,
          sandboxBinarySecurityToken: done ? "TOKEN" : null,
          sandboxSecretEnc: done ? "SECRET" : null,
        } as never);
      }

      const ctx: Ctx = { tx: tx as never, contractId: contract!.id, ownerId: owner!.id, tenantId: tenant!.id };
      await tweak(ctx);
      const readiness = await checkInvoiceReadiness(tx as never, userId, contract!.id);
      out = assertFn(readiness, ctx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

const blockerFor = (r: Awaited<ReturnType<typeof checkInvoiceReadiness>>, entity: string) =>
  r.blockers.find((b) => b.entity === entity);

test("a fully-complete contract is invoice-ready", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "onboarded" }, async () => {}, (r) => {
    assert.equal(r.ok, true, `expected ready, got: ${JSON.stringify(r.blockers)}`);
    assert.equal(r.blockers.length, 0);
  });
});

test("(a) missing tenant email blocks and names the tenant", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ email: null }).where(eq(tenantsTable.id, tenantId));
  }, (r, ctx) => {
    assert.equal(r.ok, false);
    const b = blockerFor(r, "tenant");
    assert.ok(b, "a tenant blocker must be reported");
    assert.deepEqual(b!.missing, ["email"], "only the actually-missing field is reported");
    assert.equal(b!.id, ctx.tenantId, "the blocker carries the row id so the UI can deep-link");
    assert.equal(b!.action, "edit_tenant");
  });
});

test("(b) missing landlord VAT blocks — and does not demand ZATCA", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ ownerVat: null, zatca: "none" }, async () => {}, (r, ctx) => {
    assert.equal(r.ok, false);
    const b = blockerFor(r, "landlord");
    assert.ok(b);
    assert.deepEqual(b!.missing, ["vatNumber"]);
    assert.equal(b!.id, ctx.ownerId);
    assert.equal(b!.action, "edit_landlord");
    // No VAT number means no e-invoicing obligation yet, so onboarding is not
    // demanded on top — that would be two contradictory instructions at once.
    assert.equal(blockerFor(r, "zatca"), undefined);
  });
});

test("(c) landlord VAT present but ZATCA not configured blocks with a Settings CTA", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "none" }, async () => {}, (r, ctx) => {
    assert.equal(r.ok, false);
    const b = blockerFor(r, "zatca");
    assert.ok(b, "a VAT-registered landlord with no ZATCA row must block");
    assert.deepEqual(b!.missing, ["zatcaNotConfigured"]);
    assert.equal(b!.action, "zatca_settings");
    assert.equal(b!.id, ctx.ownerId);
    // The landlord record itself is fine — only onboarding is outstanding.
    assert.equal(blockerFor(r, "landlord"), undefined);
  });
});

test("(c2) a ZATCA row without CSID material is still 'not onboarded'", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "row-only" }, async () => {}, (r) => {
    assert.equal(r.ok, false);
    assert.deepEqual(blockerFor(r, "zatca")?.missing, ["zatcaOnboardingIncomplete"]);
  });
});

test("company tenants must carry a VAT number and a national address", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ tenantType: "company", zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ taxNumber: null, nationalAddressCity: null }).where(eq(tenantsTable.id, tenantId));
  }, (r) => {
    const b = blockerFor(r, "tenant");
    assert.ok(b);
    assert.ok(b!.missing.includes("vatNumber"));
    assert.ok(b!.missing.includes("city"));
  });
});

test("individual tenants are NOT asked for a VAT number", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ tenantType: "individual", zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ taxNumber: null }).where(eq(tenantsTable.id, tenantId));
  }, (r) => {
    assert.equal(r.ok, true, `individuals are not VAT-registered: ${JSON.stringify(r.blockers)}`);
  });
});

test("a document with no contract is checked against the buyer it carries", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // This used to pass unconditionally, on the grounds that a free-standing
  // document "has no parties to validate against". It has a buyer — the buyer
  // simply lives on the document rather than on a contract — and issuing a tax
  // invoice to nobody at all is not something to wave through.
  const r = await checkInvoiceReadiness(db, userId, null);
  assert.equal(r.draftOk, false);
  assert.equal(r.draftBlockers[0]!.entity, "buyer");
});

test("an individual tenant with no VAT asks for confirmation, not a blocker", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ tenantType: "individual", zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ taxNumber: null }).where(eq(tenantsTable.id, tenantId));
  }, (r, ctx) => {
    // Still issuable — an individual is not VAT-registered — but the user has
    // to say so rather than the invoice going out on an assumption.
    assert.equal(r.ok, true, "no VAT on an individual is not a blocker");
    assert.equal(r.confirmations.length, 1);
    assert.equal(r.confirmations[0].key, "tenantNoVat");
    assert.equal(r.confirmations[0].id, ctx.tenantId);
  });
});

test("a tenant WITH a VAT number needs no confirmation", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ tenantType: "individual", zatca: "onboarded" }, async () => {}, (r) => {
    assert.equal(r.confirmations.length, 0);
  });
});

test("a company tenant with no VAT stays a hard blocker, not a confirmation", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ tenantType: "company", zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ taxNumber: null }).where(eq(tenantsTable.id, tenantId));
  }, (r) => {
    assert.equal(r.ok, false);
    assert.ok(blockerFor(r, "tenant")!.missing.includes("vatNumber"));
    assert.equal(r.confirmations.length, 0, "a company must HAVE one — nothing to confirm");
  });
});

/* ── The draft/issue split ──────────────────────────────────────────────────
 * Saving a draft is gated on `draftOk` (the parties' own data); approving it
 * is gated on `ok` (that plus the landlord's ZATCA link). These pin the one
 * asymmetry between the two lists — nothing but `entity: "zatca"` may differ.
 */

test("an unlinked ZATCA landlord can still be DRAFTED for, just not approved", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "none" }, async () => {}, (r) => {
    assert.equal(r.ok, false, "not approvable — the landlord has a VAT number and no CSID");
    assert.equal(r.draftOk, true, "but the draft must still be writable");
    assert.deepEqual(r.draftBlockers, [], "linking ZATCA is not a field on this invoice");
  });
});

test("a missing party field blocks the DRAFT too, not just the approval", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "onboarded" }, async ({ tx, tenantId }) => {
    await tx.update(tenantsTable).set({ nationalId: null }).where(eq(tenantsTable.id, tenantId));
  }, (r) => {
    assert.equal(r.draftOk, false, "a tenant with no ID is wrong data, caught while the user is still on the form");
    assert.deepEqual(r.draftBlockers.map((b) => b.entity), ["tenant"]);
    assert.deepEqual(r.draftBlockers[0]!.missing, ["idNumber"]);
  });
});

test("draftBlockers is blockers minus ZATCA, and nothing else", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withScenario({ zatca: "none" }, async ({ tx, ownerId, tenantId }) => {
    await tx.update(ownersTable).set({ nationalAddressCity: null }).where(eq(ownersTable.id, ownerId));
    await tx.update(tenantsTable).set({ phone: null }).where(eq(tenantsTable.id, tenantId));
  }, (r) => {
    assert.equal(r.ok, false);
    assert.equal(r.draftOk, false);
    // Spelled out rather than re-derived with the implementation's own filter,
    // which would agree with itself no matter what the rule became.
    assert.deepEqual(
      r.blockers.map((b) => b.entity).sort(),
      ["landlord", "tenant", "zatca"],
      "landlord address + tenant phone + the unlinked landlord",
    );
    assert.deepEqual(
      r.draftBlockers.map((b) => b.entity).sort(),
      ["landlord", "tenant"],
      "the save side sees the same two, and never the ZATCA link",
    );
    assert.deepEqual(r.draftBlockers.find((b) => b.entity === "tenant")?.missing, ["phone"]);
    assert.deepEqual(r.draftBlockers.find((b) => b.entity === "landlord")?.missing, ["city"]);
  });
});

test("a free invoice with a complete buyer is draft-ready", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null, FULL_EXTERNAL_BUYER);
  assert.equal(r.draftOk, true, `expected saveable, got ${JSON.stringify(r.draftBlockers)}`);
  assert.deepEqual(r.draftBlockers, []);
  // The seller's ZATCA link is still outstanding — approval-side, as ever.
  assert.ok(r.blockers.every((b) => b.entity === "zatca"));
});

/* ── The free invoice (no contract) ─────────────────────────────────────────
 * This path used to return `ok` unconditionally — "a free-standing document
 * has no parties to validate against" — which was true of the buyer only in
 * the sense that nobody had looked. It has a buyer (on the document) and a
 * seller (the account), and the same draft/approve split applies to them.
 */

/** Build the account's own landlord — the seller a free invoice falls back to. */
async function withAccountHolder<T>(
  opts: { zatca?: "none" | "onboarded" | "revoked"; holderVat?: string | null },
  assertFn: (readiness: Awaited<ReturnType<typeof checkInvoiceReadiness>>, tx: typeof db) => Promise<T> | T,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [holder] = await tx.insert(ownersTable).values({
        userId, name: "حساب الاختبار", type: "company", idNumber: "1010101010",
        phone: "+966500000003", email: "holder@test.local",
        taxNumber: opts.holderVat === undefined ? "300000000000003" : opts.holderVat,
        ...completeAddress, status: "active",
        isAccountHolder: true,
      } as never).returning();
      if (opts.zatca === "onboarded" || opts.zatca === "revoked") {
        await tx.insert(zatcaCredentialsTable).values({
          userId, ownerId: holder!.id, activeEnvironment: "sandbox",
          sellerName: "Seller", sellerVatNumber: "300000000000003",
          sellerStreet: "S", sellerBuildingNo: "1", sellerDistrict: "D",
          sellerCity: "R", sellerPostalZone: "12211",
          serialNumber: "1-Dara|2-Test|3-0002", organizationIdentifier: "300000000000003",
          organizationUnitName: "Test Unit", locationAddress: "Riyadh",
          industryCategory: "Real Estate", commonName: "Dara Test",
          sandboxCertPem: "CERT", sandboxPrivateKeyEnc: "KEY",
          sandboxBinarySecurityToken: "TOKEN", sandboxSecretEnc: "SECRET",
          ...(opts.zatca === "revoked"
            ? { linkInvalidAt: new Date(), linkInvalidReason: "ZATCA refused the credentials (401)" }
            : {}),
        } as never);
      }
      await assertFn(await checkInvoiceReadiness(tx as never, userId, null, FULL_EXTERNAL_BUYER), tx as never);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** An external buyer with nothing missing, so a test can remove one thing. */
const FULL_EXTERNAL_BUYER = {
  client: {
    name: "عميل خارجي", email: "buyer@test.local", phone: "+966500000004",
    idNumber: "1000000003", type: "individual",
  },
};

test("a free invoice checks the buyer typed onto the document", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null, {
    client: { name: "عميل خارجي", email: "b@test.local", phone: "+966500000004" },
  });
  // No contract used to mean no checks at all.
  assert.equal(r.draftOk, false);
  const b = r.draftBlockers.find((x) => x.entity === "buyer");
  assert.ok(b, "the buyer lives on the document, so the blocker points at it");
  assert.equal(b!.action, "edit_document");
  assert.equal(b!.id, null, "there is no record to deep-link to");
  assert.ok(b!.missing.includes("idNumber"), "CR / national ID is required");
  assert.ok(b!.missing.includes("buyerType"), "individual vs company is required");
});

test("an unstated buyer type does not silently pull in the company rules", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null, {
    client: { name: "س", email: "b@test.local", phone: "+966500000004", idNumber: "1000000003" },
  });
  const missing = r.draftBlockers.find((x) => x.entity === "buyer")!.missing;
  // What else is required DEPENDS on the type, so asking for the type and for
  // the consequences of a type at the same time would be incoherent.
  assert.deepEqual(missing, ["buyerType"]);
});

test("a company buyer must carry a VAT number and a full national address", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null, {
    client: { name: "منشأة", email: "b@test.local", phone: "+966500000004", idNumber: "4030000001", type: "company" },
  });
  const missing = r.draftBlockers.find((x) => x.entity === "buyer")!.missing;
  // A company buyer is what makes this a STANDARD invoice bound for clearance,
  // and clearance is what needs these fields.
  assert.ok(missing.includes("vatNumber"));
  for (const f of ["street", "buildingNumber", "district", "city", "postalCode"]) {
    assert.ok(missing.includes(f), `${f} is required of a company buyer`);
  }
});

test("an individual buyer needs neither a VAT number nor an address", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withAccountHolder({ zatca: "onboarded" }, (r) => {
    assert.equal(r.ok, true, `expected ready, got ${JSON.stringify(r.blockers)}`);
  });
});

test("a free invoice cannot be APPROVED until the account is linked to ZATCA", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withAccountHolder({ zatca: "none" }, (r) => {
    // The point of the split, on the free path too: the document writes down
    // fine, and the account errand is demanded only at approval.
    assert.equal(r.draftOk, true, "the buyer is complete, so the draft saves");
    assert.equal(r.ok, false, "but a tax invoice needs a linked seller");
    const z = r.blockers.find((b) => b.entity === "zatca");
    assert.ok(z, "the account's own ZATCA link is the seller's link");
    assert.deepEqual(z!.missing, ["zatcaNotConfigured"]);
    assert.equal(z!.action, "zatca_settings");
  });
});

test("a link ZATCA has revoked reads as unlinked, and says so distinctly", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withAccountHolder({ zatca: "revoked" }, (r) => {
    // Every column still holds valid-looking material — certificate, key,
    // token, secret. Only the flag distinguishes this from a working link, and
    // "onboarding incomplete" would send the user to finish something that is
    // already finished.
    assert.equal(r.ok, false);
    assert.deepEqual(r.blockers.find((b) => b.entity === "zatca")?.missing, ["zatcaLinkRevoked"]);
    assert.equal(r.draftOk, true, "a revoked link still does not stop bookkeeping");
  });
});

test("an account that is not VAT-registered is not asked to link ZATCA", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withAccountHolder({ zatca: "none", holderVat: null }, (r) => {
    // E-invoicing applies to VAT-registered sellers. Demanding the link of an
    // account that has no VAT number would brick every free invoice for a
    // residential-only manager whose supplies are exempt — permanently, over an
    // obligation they do not have. Same rule the contract path already applies.
    assert.equal(r.ok, true, `expected issuable, got ${JSON.stringify(r.blockers)}`);
    assert.equal(r.blockers.find((b) => b.entity === "zatca"), undefined);
  });
});

test("a VAT-registered INDIVIDUAL buyer is asked for the national address too", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null, {
    client: {
      name: "فرد مسجّل", email: "b@test.local", phone: "+966500000004",
      idNumber: "1000000003", type: "individual", vatNumber: "300000000000011",
    },
  });
  // The VAT number, not the type, is what makes this a STANDARD invoice bound
  // for clearance — and clearance is what needs the address. Keying it on the
  // type alone let this buyer pass the gate and then fail assertAddressComplete
  // deep inside the submission, where the refusal reaches nobody.
  const missing = r.draftBlockers.find((b) => b.entity === "buyer")!.missing;
  for (const f of ["street", "buildingNumber", "district", "city", "postalCode"]) {
    assert.ok(missing.includes(f), `${f} is required once the buyer is VAT-registered`);
  }
  assert.ok(!missing.includes("vatNumber"), "they have one — only a company is asked to HAVE one");
});
