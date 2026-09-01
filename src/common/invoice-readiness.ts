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
  /**
   * Which record to fix. `zatca` means onboarding, not a field; `buyer` is the
   * external customer typed onto the document itself, which has no row to send
   * anyone to — the user is already looking at it.
   */
  entity: "tenant" | "landlord" | "contract" | "zatca" | "buyer";
  /** Row id, so the UI can deep-link straight to it. Null for `buyer`. */
  id: number | null;
  name: string | null;
  /** Machine-readable field keys — the UI localizes them. */
  missing: string[];
  /** Where the user should be sent to fix it. */
  action: "edit_tenant" | "edit_landlord" | "zatca_settings" | "edit_contract" | "edit_document";
}

/**
 * The buyer of a document that has no contract to read one from — the "free
 * invoice" on the Invoices page. Either a party the account already holds
 * (a tenant or a landlord picked from the list) or a customer typed straight
 * onto the document.
 */
export interface InvoiceBuyerInput {
  tenantId?: number | null;
  ownerId?: number | null;
  tenantName?: string | null;
  client?: Record<string, unknown> | null;
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
export function isOnboarded(creds: typeof zatcaCredentialsTable.$inferSelect | undefined | null): boolean {
  if (!creds) return false;
  // ZATCA has stopped accepting these credentials — the device was removed in
  // Fatoora, or the CSID was revoked. Everything below still passes (the
  // certificate is right there in the row), which is exactly why this has to be
  // checked first: holding valid-looking material is not the same as being
  // linked, and the difference is invisible from our side until a submission
  // comes back 401.
  if (creds.linkInvalidAt) return false;
  // The prod slot is holding a COMPLIANCE certificate — onboarding reached step
  // 2 of 4 and stopped. Every column below is filled, which is exactly why this
  // has to be asked first: a compliance certificate signs perfectly well and is
  // refused by /core, so treating the row as onboarded means real invoices go
  // out signed with something ZATCA will not accept.
  if (creds.prodSlotEnv?.startsWith("compliance") && creds.activeEnvironment !== "sandbox") return false;
  const sandbox = creds.activeEnvironment === "sandbox";
  const cert = sandbox ? creds.sandboxCertPem : creds.prodCertPem;
  const key = sandbox ? creds.sandboxPrivateKeyEnc : creds.prodPrivateKeyEnc;
  const token = sandbox ? creds.sandboxBinarySecurityToken : creds.prodBinarySecurityToken;
  const secret = sandbox ? creds.sandboxSecretEnc : creds.prodSecretEnc;
  return !!(cert && key && token && secret);
}

/**
 * Which ZATCA seller signs a document that has no contract?
 *
 * The account-level credentials row (`owner_id IS NULL`) is the historical
 * answer, and it stays the answer whenever one exists — that row owns an ICV
 * chain, and quietly moving a seller to a different chain is how invoices start
 * colliding. But nothing in the product can CREATE that row: the settings tab
 * onboards per landlord and always sends an ownerId. So an account whose only
 * rows are per-landlord had no reachable seller at all, and every free-standing
 * invoice reported "landlord not linked" about a link the user could not make.
 *
 * Hence the fallback: the account's own landlord record — the one flagged
 * `is_account_holder`, which IS onboardable from the settings tab. Both the
 * readiness gate and the submission path call this, so the seller the gate
 * checks is always the seller the submission uses.
 */
export async function resolveStandaloneSellerId(db: Drizzle, userId: number): Promise<number | null> {
  const [accountLevel] = await db
    .select({ id: zatcaCredentialsTable.id })
    .from(zatcaCredentialsTable)
    .where(and(
      eq(zatcaCredentialsTable.userId, userId),
      isNull(zatcaCredentialsTable.ownerId),
      isNull(zatcaCredentialsTable.deletedAt),
    ))
    .limit(1);
  if (accountLevel) return null; // null = the account-level seller itself
  const [holder] = await db
    .select({ id: ownersTable.id })
    .from(ownersTable)
    .where(and(
      eq(ownersTable.userId, userId),
      eq(ownersTable.isAccountHolder, true),
      isNull(ownersTable.deletedAt),
    ))
    .limit(1);
  return holder?.id ?? null;
}

/**
 * The seller's VAT number, which the link now depends on.
 *
 * "Every seller must be linked" implies "every seller must be VAT-registered",
 * because a VAT number is the one thing onboarding cannot proceed without:
 * `POST /zatca/profile` requires it, the settings tab replaces the Onboard
 * button with "N/A" without it, and ZATCA keys the CSR to it as the
 * organization identifier.
 *
 * So an unregistered seller told only "link with ZATCA" is sent to a screen
 * that offers them nothing — a dead end with no sequence of actions out of it.
 * Naming the missing VAT number alongside the link turns that into a route:
 * add the number, then onboard. The contract path has always done this (its
 * landlord blocker demands `vatNumber`); this is the free path catching up.
 */
async function sellerVatBlocker(
  db: Drizzle,
  userId: number,
  ownerId: number | null,
): Promise<InvoiceBlocker | null> {
  if (ownerId == null) {
    // The account-level seller states its VAT number on the profile itself.
    const [creds] = await db
      .select({ vat: zatcaCredentialsTable.sellerVatNumber })
      .from(zatcaCredentialsTable)
      .where(and(
        eq(zatcaCredentialsTable.userId, userId),
        isNull(zatcaCredentialsTable.ownerId),
        isNull(zatcaCredentialsTable.deletedAt),
      ))
      .limit(1);
    // No row at all is reported by the ZATCA blocker, not twice over here.
    return creds && blank(creds.vat)
      ? { entity: "landlord", id: null, name: null, missing: ["vatNumber"], action: "zatca_settings" }
      : null;
  }
  const [owner] = await db
    .select({ id: ownersTable.id, name: ownersTable.name, taxNumber: ownersTable.taxNumber })
    .from(ownersTable)
    .where(and(eq(ownersTable.id, ownerId), eq(ownersTable.userId, userId), isNull(ownersTable.deletedAt)))
    .limit(1);
  if (!owner || !blank(owner.taxNumber)) return null;
  return { entity: "landlord", id: owner.id, name: owner.name, missing: ["vatNumber"], action: "edit_landlord" };
}

/** Load the seller's credentials row and report it as a blocker if unusable. */
async function sellerZatcaBlocker(
  db: Drizzle,
  userId: number,
  ownerId: number | null,
  name: string | null,
): Promise<InvoiceBlocker | null> {
  const [creds] = await db
    .select()
    .from(zatcaCredentialsTable)
    .where(and(
      eq(zatcaCredentialsTable.userId, userId),
      ownerId == null ? isNull(zatcaCredentialsTable.ownerId) : eq(zatcaCredentialsTable.ownerId, ownerId),
      isNull(zatcaCredentialsTable.deletedAt),
    ))
    .limit(1);
  if (isOnboarded(creds)) return null;
  return {
    entity: "zatca", id: ownerId, name,
    missing: [
      creds?.linkInvalidAt ? "zatcaLinkRevoked"
        : creds ? "zatcaOnboardingIncomplete"
        : "zatcaNotConfigured",
    ],
    action: "zatca_settings",
  };
}

/**
 * The buyer's own data, checked the same way on every path.
 *
 * `type` is not decoration: it decides what else is required and which ZATCA
 * document this becomes. A company buyer must carry a VAT number and a full
 * national address, because that is what makes the invoice a STANDARD one that
 * goes to clearance; an individual needs neither, and gets a simplified invoice
 * that is merely reported. Leaving the type unstated means we cannot tell which
 * of the two we are about to file, so it is required rather than guessed.
 */
function buyerBlockers(buyer: {
  name?: unknown; email?: unknown; phone?: unknown; idNumber?: unknown; type?: unknown;
  vatNumber?: unknown; street?: unknown; buildingNumber?: unknown; district?: unknown;
  city?: unknown; postalCode?: unknown;
}): string[] {
  const missing: string[] = [];
  if (blank(buyer.name)) missing.push("name");
  if (blank(buyer.email)) missing.push("email");
  if (blank(buyer.phone)) missing.push("phone");
  // CR for a company, national ID or iqama for an individual. ZATCA's BT-46 on
  // a standard invoice, and the only way to tell two same-named customers apart
  // on any of them.
  if (blank(buyer.idNumber)) missing.push("idNumber");
  const type = String(buyer.type ?? "").trim();
  if (type !== "individual" && type !== "company") {
    missing.push("buyerType");
    return missing; // what else is required depends on it — do not guess.
  }
  if (type === "company" && blank(buyer.vatNumber)) missing.push("vatNumber");
  // The national address is required by whatever makes this a STANDARD invoice
  // bound for clearance — and that is the VAT number, not the type. A company
  // must have one (so it always needs the address); an individual may also be
  // registered, and when they are, the same address applies. Keying this on the
  // type alone let a VAT-registered individual pass the gate and then fail
  // `assertAddressComplete` at submission, which the user never sees.
  if (type === "company" || !blank(buyer.vatNumber)) {
    for (const [key, v] of [
      ["street", buyer.street], ["buildingNumber", buyer.buildingNumber],
      ["district", buyer.district], ["city", buyer.city], ["postalCode", buyer.postalCode],
    ] as const) {
      if (blank(v)) missing.push(key);
    }
  }
  return missing;
}

/**
 * Readiness for a document with NO contract — the "free invoice" on the
 * Invoices page.
 *
 * This used to return `ok` unconditionally ("a free-standing document has no
 * parties to validate against"), which was true of the buyer only in the sense
 * that nobody had looked. The document still has a buyer and still has a
 * seller; they just live on the document and on the account rather than on a
 * contract. Both are checked here, and the ZATCA link stays on the approval
 * side exactly as it does for a contract-linked invoice.
 */
async function standaloneReadiness(
  db: Drizzle,
  userId: number,
  buyer: InvoiceBuyerInput,
): Promise<InvoiceReadiness> {
  const blockers: InvoiceBlocker[] = [];
  const confirmations: InvoiceConfirmation[] = [];
  const client = (buyer.client ?? {}) as Record<string, unknown>;
  const tenantId = buyer.tenantId ?? null;
  // `client.kind` records how the buyer was picked, which is the only way to
  // tell a landlord-as-buyer from a landlord-as-seller.
  const buyerOwnerId = String(client.kind ?? "") === "landlord" ? (buyer.ownerId ?? null) : null;

  if (tenantId) {
    const [tenant] = await db.select().from(tenantsTable)
      .where(and(eq(tenantsTable.id, tenantId), eq(tenantsTable.userId, userId), isNull(tenantsTable.deletedAt)))
      .limit(1);
    if (!tenant) {
      blockers.push({ entity: "buyer", id: null, name: null, missing: ["name"], action: "edit_document" });
    } else {
      const missing = buyerBlockers({
        name: tenant.name, email: tenant.email, phone: tenant.phone,
        idNumber: tenant.nationalId, type: tenant.type, vatNumber: tenant.taxNumber,
        street: tenant.nationalAddressStreet, buildingNumber: tenant.buildingNumber,
        district: tenant.nationalAddressDistrict, city: tenant.nationalAddressCity,
        postalCode: tenant.postalCode,
      });
      if (missing.length) {
        blockers.push({ entity: "tenant", id: tenant.id, name: tenant.name, missing, action: "edit_tenant" });
      }
      if (tenant.type !== "company" && blank(tenant.taxNumber)) {
        confirmations.push({ key: "tenantNoVat", entity: "tenant", id: tenant.id, name: tenant.name });
      }
    }
  } else if (buyerOwnerId) {
    const [owner] = await db.select().from(ownersTable)
      .where(and(eq(ownersTable.id, buyerOwnerId), eq(ownersTable.userId, userId), isNull(ownersTable.deletedAt)))
      .limit(1);
    if (!owner) {
      blockers.push({ entity: "buyer", id: null, name: null, missing: ["name"], action: "edit_document" });
    } else {
      const missing = buyerBlockers({
        name: owner.name, email: owner.email, phone: owner.phone,
        idNumber: owner.idNumber, type: owner.type, vatNumber: owner.taxNumber,
        street: owner.nationalAddressStreet, buildingNumber: owner.buildingNumber,
        district: owner.nationalAddressDistrict, city: owner.nationalAddressCity,
        postalCode: owner.postalCode,
      });
      if (missing.length) {
        blockers.push({ entity: "landlord", id: owner.id, name: owner.name, missing, action: "edit_landlord" });
      }
    }
  } else {
    // An external customer: everything we know about them is on the document,
    // so the blocker points at the form rather than at a record.
    const missing = buyerBlockers({
      name: client.name || buyer.tenantName, email: client.email, phone: client.phone,
      idNumber: client.idNumber, type: client.type, vatNumber: client.vatNumber,
      street: client.street, buildingNumber: client.buildingNumber,
      district: client.district, city: client.city, postalCode: client.postalCode,
    });
    if (missing.length) {
      blockers.push({
        entity: "buyer", id: null,
        name: (client.name as string) || buyer.tenantName || null,
        missing, action: "edit_document",
      });
    }
  }

  // The seller. A free invoice is still a tax invoice, so the account has to be
  // linked to ZATCA before it can be issued — the same unconditional rule the
  // contract path applies to its landlord. The VAT number rides with it because
  // the link cannot be obtained without one; see `sellerVatBlocker`.
  const sellerId = await resolveStandaloneSellerId(db, userId);
  const vatBlocker = await sellerVatBlocker(db, userId, sellerId);
  if (vatBlocker) blockers.push(vatBlocker);
  const sellerBlocker = await sellerZatcaBlocker(db, userId, sellerId, null);
  if (sellerBlocker) blockers.push(sellerBlocker);

  return readinessOf(blockers, { confirmations, tenantId, ownerId: sellerId });
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
  buyer?: InvoiceBuyerInput,
): Promise<InvoiceReadiness> {
  const blockers: InvoiceBlocker[] = [];
  const confirmations: InvoiceConfirmation[] = [];
  if (!contractId) {
    // No contract to read the parties from — but the document still has a buyer
    // and a seller. See `standaloneReadiness`.
    return standaloneReadiness(db, userId, buyer ?? {});
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
    if (tenantIsCompany && blank(tenant.taxNumber)) missing.push("vatNumber");
    // The address is required by whatever makes this a STANDARD invoice bound
    // for clearance, and that is the VAT number rather than the type — an
    // individual can be VAT-registered too, and one who is used to pass this
    // gate and then fail `assertAddressComplete` deep in the submission, where
    // the refusal reaches nobody.
    if (tenantIsCompany || !blank(tenant.taxNumber)) {
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
     * No tax invoice is issued by an unlinked seller. This used to trigger only
     * on a VAT number — the reasoning being that e-invoicing is an obligation
     * of registered sellers, so an unregistered landlord was not owed a link
     * and should not be blocked on one. The product's rule is stricter: issuing
     * a tax invoice at all requires the seller to be linked to ZATCA, whatever
     * their registration says.
     *
     * The practical consequence is worth stating plainly, because it is large:
     * a landlord who has not onboarded cannot approve anything, and most have
     * not. Drafts are unaffected — this is the ONE blocker excluded from
     * `draftBlockers`, since linking is an account errand (a certificate and a
     * Fatoora OTP) rather than a field on the invoice, so bookkeeping continues
     * and only issuance waits. */
    {
      const b = await sellerZatcaBlocker(db, userId, owner.id, owner.name);
      if (b) blockers.push(b);
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
    tenant: "المستأجر", landlord: "المؤجر", contract: "العقد",
    buyer: "العميل", zatca: "الزكاة والضريبة",
  };
  return (scope === "draft" ? readiness.draftBlockers : readiness.blockers)
    .map((b) => `${label[b.entity]}${b.name ? ` (${b.name})` : ""}: ${b.missing.join("، ")}`)
    .join(" | ");
}

/**
 * Is this seller linked to ZATCA, asked on its own?
 *
 * The full gate above answers a question about a whole document. A caller that
 * only holds a seller — the contract-less e-invoice path, which has no contract
 * to read parties from — needs just this half, and must reach it through the
 * same code the gate uses so the two can never disagree about what "linked"
 * means.
 *
 * Unconditional, like the gate: a seller issues tax invoices only once linked,
 * whatever their VAT registration says.
 */
export async function checkSellerLink(
  db: Drizzle,
  userId: number,
  ownerId: number | null,
): Promise<InvoiceBlocker | null> {
  return sellerZatcaBlocker(db, userId, ownerId, null);
}

/**
 * What the buyer of a ZATCA e-invoice must carry for the profile it is being
 * filed under.
 *
 * Deliberately NOT `buyerBlockers` above: that one governs OUR record of a
 * customer (e-mail and phone included, so an invoice can actually be delivered
 * and a person contacted), and those are not fields of a `BuyerSnapshot` at
 * all. This one governs the DOCUMENT — only what ZATCA reads off the XML.
 *
 * The split by profile is the split between the two document types. A
 * simplified (B2C) invoice is issued to a walk-in consumer: it is merely
 * reported, and states nothing about the buyer beyond a name. A standard (B2B)
 * invoice goes to clearance, where the buyer is a taxable person who must be
 * identified in full — VAT number, national address, and an identifier.
 *
 * `id` and `idScheme` are demanded together because the builder emits the buyer
 * `PartyIdentification` only when it holds both, and rightly so: an identifier
 * with no scheme is not something UBL can express. Accepting one without the
 * other therefore does not produce a partially-identified buyer, it produces an
 * unidentified one — silently, on the document that most needs the identifier.
 */
export function eInvoiceBuyerBlockers(
  buyer: {
    name?: unknown; vat?: unknown; id?: unknown; idScheme?: unknown;
    street?: unknown; buildingNo?: unknown; district?: unknown;
    city?: unknown; postalZone?: unknown;
  } | null | undefined,
  profile: "standard" | "simplified",
): string[] {
  const b = buyer ?? {};
  const missing: string[] = [];
  if (blank(b.name)) missing.push("name");
  if (profile !== "standard") return missing;
  if (blank(b.vat)) missing.push("vat");
  // The snapshot's own field names, not `ADDRESS_REQUIRED`'s: these keys travel
  // back to a form that is bound to the document, not to a tenant record.
  for (const [key, v] of [
    ["street", b.street], ["buildingNo", b.buildingNo], ["district", b.district],
    ["city", b.city], ["postalZone", b.postalZone],
  ] as const) {
    if (blank(v)) missing.push(key);
  }
  if (blank(b.id)) missing.push("id");
  if (blank(b.idScheme)) missing.push("idScheme");
  return missing;
}
