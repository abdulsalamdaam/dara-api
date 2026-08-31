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

test("a document with no contract is not blocked", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null);
  assert.equal(r.ok, true);
  assert.equal(r.blockers.length, 0);
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

test("a document with no contract is draft-ready as well as issue-ready", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const r = await checkInvoiceReadiness(db, userId, null);
  assert.equal(r.draftOk, true);
  assert.deepEqual(r.draftBlockers, []);
});
