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
 *
 * The result carries TWO views of the same blocker list — `draftBlockers`
 * (everything except the ZATCA link) and `blockers` (everything). Saving a
 * draft is gated on the first, approving it on the second; see
 * `InvoiceReadiness` for why the ZATCA link is the one thing held back.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  contractsTable, contractUnitsTable, unitsTable, propertiesTable,
  ownersTable, tenantsTable, zatcaCredentialsTable,
} from "@dara/database";
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

/**
 * Something the user must acknowledge rather than fix. A tenant with no VAT
 * number is usually correct — individuals are not VAT-registered — but it is
 * also exactly what a forgotten field looks like, so we ask instead of
 * assuming either way.
 */
export interface InvoiceConfirmation {
  key: "tenantNoVat";
  entity: "tenant";
  id: number | null;
  name: string | null;
}

export interface InvoiceReadiness {
  /** Everything is in place — the document can be ISSUED (approved). */
  ok: boolean;
  /** Every blocker, ZATCA onboarding included. The gate for approve(). */
  blockers: InvoiceBlocker[];
  /**
   * The subset that has to hold before the document may even be WRITTEN: the
   * parties' own data — name, e-mail, phone, ID/CR, VAT number, national
   * address. Everything except the ZATCA link.
   *
   * The split exists because the two are different kinds of problem. A missing
   * VAT number or national address is a mistake in the document being drafted,
   * and the moment to catch it is while the user is still on the form — a draft
   * saved on top of it is simply wrong data. Linking ZATCA, by contrast, is an
   * account-level errand that involves a certificate, an OTP the taxpayer
   * generates in the Fatoora portal, and no part of the invoice at hand; it
   * cannot be done from the invoice form and must not stop the bookkeeping.
   * So it is only demanded at approval, the moment the document is actually
   * signed and mirrored to ZATCA.
   */
  draftBlockers: InvoiceBlocker[];
  /** `draftBlockers` is empty — the document can be SAVED as a draft. */
  draftOk: boolean;
  /** Must be acknowledged by the caller before an invoice can be issued. */
  confirmations: InvoiceConfirmation[];
  tenantId: number | null;
  ownerId: number | null;
}

/** `blockers` minus the ZATCA link — see `InvoiceReadiness.draftBlockers`. */
export function draftBlockersOf(blockers: InvoiceBlocker[]): InvoiceBlocker[] {
  return blockers.filter((b) => b.entity !== "zatca");
}

/** Assemble the two views of one blocker list, so no caller has to. */
function readinessOf(
  blockers: InvoiceBlocker[],
  rest: Omit<InvoiceReadiness, "ok" | "blockers" | "draftBlockers" | "draftOk">,
): InvoiceReadiness {
  const draftBlockers = draftBlockersOf(blockers);
  return {
    ok: blockers.length === 0,
    blockers,
    draftBlockers,
    draftOk: draftBlockers.length === 0,
    ...rest,
  };
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
  const confirmations: InvoiceConfirmation[] = [];
  if (!contractId) {
    // A free-standing document has no parties to validate against.
    return readinessOf([], { confirmations: [], tenantId: null, ownerId: null });
  }

  const [contract] = await db
    .select()
    .from(contractsTable)
    .where(and(eq(contractsTable.id, Number(contractId)), eq(contractsTable.userId, userId)))
    .limit(1);
  if (!contract) {
    return readinessOf(
      [{ entity: "contract", id: Number(contractId), name: null, missing: ["contract"], action: "edit_contract" }],
      { tenantId: null, ownerId: null, confirmations: [] },
    );
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
    // An individual tenant with no VAT number is normal, but indistinguishable
    // from a field someone forgot — so the user confirms it explicitly rather
    // than the invoice quietly going out without one.
    if (!tenantIsCompany && blank(tenant.taxNumber)) {
      confirmations.push({ key: "tenantNoVat", entity: "tenant", id: tenant.id, name: tenant.name });
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
     * blocks and points at Settings.
     *
     * This is the ONLY blocker excluded from `draftBlockers`: it is an account
     * errand (certificate + a Fatoora OTP), not a field on the invoice, so it
     * is demanded at approval rather than at save. */
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

  return readinessOf(blockers, { confirmations, tenantId, ownerId });
}

/**
 * Human-readable one-liner for an API error message.
 *
 * `scope` picks which of the two blocker lists to name: "draft" for the
 * save-time refusal (which never mentions ZATCA, because the user cannot act on
 * it from the invoice form), "issue" for the approval refusal.
 */
export function readinessMessage(
  readiness: InvoiceReadiness,
  scope: "issue" | "draft" = "issue",
): string {
  const label: Record<InvoiceBlocker["entity"], string> = {
    tenant: "المستأجر", landlord: "المؤجر", contract: "العقد", zatca: "الزكاة والضريبة",
  };
  return (scope === "draft" ? readiness.draftBlockers : readiness.blockers)
    .map((b) => `${label[b.entity]}${b.name ? ` (${b.name})` : ""}: ${b.missing.join("، ")}`)
    .join(" | ");
}
