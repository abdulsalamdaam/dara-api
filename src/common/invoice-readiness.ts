/**
 * Invoice readiness guard.
 *
 * An imported (or hand-entered) contract can easily be missing the details a
 * tax invoice legally needs — Ejar, for instance, never sends a VAT number and
 * often has no email. Issuing anyway produces an invoice that ZATCA will reject
 * or that is simply wrong, so both invoice paths call this first and refuse
 * with a precise list of what is missing on which record.
 *
 * Shared by the ZATCA e-invoice controller and the plain billing-doc
 * controller so the two can never drift apart.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  contractsTable, contractUnitsTable, unitsTable, propertiesTable,
  ownersTable, tenantsTable, zatcaCredentialsTable,
} from "@oqudk/database";
import type { Drizzle } from "../database/database.module";

/** One thing standing between the user and a valid invoice. */
export interface InvoiceBlocker {
  /** Which record to fix. `zatca` means onboarding, not a field. */
  entity: "tenant" | "landlord" | "contract" | "zatca";
  /** Row id, so the UI can deep-link straight to it. */
  id: number | null;
  name: string | null;
  /** Machine-readable field keys — the UI localizes them. */
  missing: string[];
  /** Where the user should be sent to fix it. */
  action: "edit_tenant" | "edit_landlord" | "zatca_settings" | "edit_contract";
}

export interface InvoiceReadiness {
  ok: boolean;
  blockers: InvoiceBlocker[];
  tenantId: number | null;
  ownerId: number | null;
}

/**
 * Required on every party of a tax invoice. Kept as data so the API response,
 * the UI copy and the tests all describe the same rule.
 */
const PARTY_REQUIRED = ["name", "email", "phone", "idNumber"] as const;

/**
 * The Saudi national address block. ZATCA's standard (B2B) tax invoice needs a
 * full postal address for the seller, and for the buyer when the buyer is a
 * VAT-registered business.
 */
const ADDRESS_REQUIRED = ["street", "buildingNumber", "district", "city", "postalCode"] as const;

const blank = (v: unknown) => v == null || String(v).trim() === "";

/** Landlord (owner) for a contract: contract → unit → property → owner. */
async function resolveOwnerId(db: Drizzle, contractId: number): Promise<number | null> {
  const [row] = await db
    .select({ ownerId: propertiesTable.ownerId })
    .from(contractUnitsTable)
    .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
    .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
    .where(eq(contractUnitsTable.contractId, contractId))
    .limit(1);
  return row?.ownerId ?? null;
}

/**
 * Is this landlord onboarded with ZATCA for the environment they are currently
 * operating in? A row alone is not enough — onboarding only completes once the
 * CSID material for that environment exists.
 */
function isOnboarded(creds: typeof zatcaCredentialsTable.$inferSelect | undefined): boolean {
  if (!creds) return false;
  const sandbox = creds.activeEnvironment === "sandbox";
  const cert = sandbox ? creds.sandboxCertPem : creds.prodCertPem;
  const key = sandbox ? creds.sandboxPrivateKeyEnc : creds.prodPrivateKeyEnc;
  const token = sandbox ? creds.sandboxBinarySecurityToken : creds.prodBinarySecurityToken;
  const secret = sandbox ? creds.sandboxSecretEnc : creds.prodSecretEnc;
  return !!(cert && key && token && secret);
}

/**
 * Check whether an invoice can legally be issued for `contractId`.
 *
 * Deliberately NOT fatal on a missing landlord link — that is reported as a
 * blocker on the contract rather than throwing, so the UI can show one unified
 * "here is what to fix" panel instead of an opaque 500.
 */
export async function checkInvoiceReadiness(
  db: Drizzle,
  userId: number,
  contractId: number | null | undefined,
): Promise<InvoiceReadiness> {
  const blockers: InvoiceBlocker[] = [];
  if (!contractId) {
    // A free-standing document has no parties to validate against.
    return { ok: true, blockers: [], tenantId: null, ownerId: null };
  }

  const [contract] = await db
    .select()
    .from(contractsTable)
    .where(and(eq(contractsTable.id, Number(contractId)), eq(contractsTable.userId, userId)))
    .limit(1);
  if (!contract) {
    return {
      ok: false, tenantId: null, ownerId: null,
      blockers: [{ entity: "contract", id: Number(contractId), name: null, missing: ["contract"], action: "edit_contract" }],
    };
  }

  /* ── Tenant (buyer) ── */
  const tenantId = contract.tenantId ?? null;
  const [tenant] = tenantId
    ? await db.select().from(tenantsTable)
        .where(and(eq(tenantsTable.id, tenantId), eq(tenantsTable.userId, userId), isNull(tenantsTable.deletedAt)))
        .limit(1)
    : [];

  if (!tenant) {
    blockers.push({
      entity: "contract", id: contract.id, name: contract.contractNumber,
      missing: ["tenantLink"], action: "edit_contract",
    });
  } else {
    const missing: string[] = [];
    for (const f of PARTY_REQUIRED) {
      const v = f === "idNumber" ? tenant.nationalId : (tenant as Record<string, unknown>)[f];
      if (blank(v)) missing.push(f);
    }
    // Individuals are not VAT-registered in KSA, so requiring a VAT number
    // from them would block every residential invoice. Organizations must have
    // one — that is what makes it a standard (B2B) tax invoice.
    const tenantIsCompany = tenant.type === "company";
    if (tenantIsCompany) {
      if (blank(tenant.taxNumber)) missing.push("vatNumber");
      for (const f of ADDRESS_REQUIRED) {
        const v = f === "street" ? tenant.nationalAddressStreet
          : f === "district" ? tenant.nationalAddressDistrict
          : f === "city" ? tenant.nationalAddressCity
          : (tenant as Record<string, unknown>)[f];
        if (blank(v)) missing.push(f);
      }
    }
    if (missing.length) {
      blockers.push({ entity: "tenant", id: tenant.id, name: tenant.name, missing, action: "edit_tenant" });
    }
  }

  /* ── Landlord (seller) ── */
  const ownerId = await resolveOwnerId(db, contract.id);
  const [owner] = ownerId
    ? await db.select().from(ownersTable)
        .where(and(eq(ownersTable.id, ownerId), eq(ownersTable.userId, userId), isNull(ownersTable.deletedAt)))
        .limit(1)
    : [];

  if (!owner) {
    blockers.push({
      entity: "contract", id: contract.id, name: contract.contractNumber,
      missing: ["landlordLink"], action: "edit_contract",
    });
  } else {
    const missing: string[] = [];
    for (const f of PARTY_REQUIRED) {
      const v = (owner as Record<string, unknown>)[f];
      if (blank(v)) missing.push(f);
    }
    // The seller on a tax invoice must be VAT-registered.
    if (blank(owner.taxNumber)) missing.push("vatNumber");
    for (const f of ADDRESS_REQUIRED) {
      const v = f === "street" ? owner.nationalAddressStreet
        : f === "district" ? owner.nationalAddressDistrict
        : f === "city" ? owner.nationalAddressCity
        : (owner as Record<string, unknown>)[f];
      if (blank(v)) missing.push(f);
    }
    if (missing.length) {
      blockers.push({ entity: "landlord", id: owner.id, name: owner.name, missing, action: "edit_landlord" });
    }

    /* ── ZATCA ──
     * Having a VAT number is the trigger: the moment a landlord is
     * VAT-registered, their invoices are e-invoices and must be signed with
     * that landlord's own CSID. A VAT number with no completed onboarding is
     * the single most common way to produce an invoice ZATCA rejects, so it
     * blocks and points at Settings. */
    if (!blank(owner.taxNumber)) {
      const [creds] = await db
        .select()
        .from(zatcaCredentialsTable)
        .where(and(
          eq(zatcaCredentialsTable.userId, userId),
          eq(zatcaCredentialsTable.ownerId, owner.id),
          isNull(zatcaCredentialsTable.deletedAt),
        ))
        .limit(1);
      if (!isOnboarded(creds)) {
        blockers.push({
          entity: "zatca", id: owner.id, name: owner.name,
          missing: [creds ? "zatcaOnboardingIncomplete" : "zatcaNotConfigured"],
          action: "zatca_settings",
        });
      }
    }
  }

  return { ok: blockers.length === 0, blockers, tenantId, ownerId };
}

/** Human-readable one-liner for an API error message. */
export function readinessMessage(readiness: InvoiceReadiness): string {
  const label: Record<InvoiceBlocker["entity"], string> = {
    tenant: "المستأجر", landlord: "المؤجر", contract: "العقد", zatca: "الزكاة والضريبة",
  };
  return readiness.blockers
    .map((b) => `${label[b.entity]}${b.name ? ` (${b.name})` : ""}: ${b.missing.join("، ")}`)
    .join(" | ");
}
