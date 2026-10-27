import { BadRequestException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { ownersTable } from "@dara/database";
import { ejarPartyRole, type EjarPartyRole } from "./plan-features";
import { isBlank, partyIdentityNumber } from "./validation";
import { resolvePartyCheck } from "../modules/ejar/ejar.party-check";

/*
 * On عقاري (`basic`) and the tenant plan, an Ejar inquiry is pinned to the
 * account's own identity (ejar.party-check.ts): the landlord's national ID /
 * CR, or the tenant account's CR / national ID. Without it the lookup is
 * blocked (409 party_id_missing), so on those plans the ID is REQUIRED on the
 * record it is read from. Offices / Companies are unpinned and keep it
 * optional.
 *
 * Which rows:
 *  - landlord side, عقاري: every owners row (the plan holds one landlord, and
 *    it is the account's own — the pin falls back to "the only row").
 *  - tenant side, tenant plan: the account-holder tenant row only. Other
 *    tenant rows (Ejar-imported strangers) are not the account's identity.
 *
 * When: on create, and on a PATCH that touches identity (`type` or the ID
 * field) or finalises a draft — the same rule tenants.module applies to the
 * company CR. An unrelated PATCH (a phone change) on a legacy row with no ID
 * still saves; the dashboard banner (`/me/package` → `identity`) asks for it.
 * Drafts are exempt like every other identity format rule.
 *
 * Format: individual → national ID / Iqama (10 digits, 1 or 2); company → CR
 * (10 digits, which admits the 7-prefixed unified number). Reuses
 * partyIdentityNumber, so the messages match the other identity checks.
 *
 * Ejar and bulk imports insert rows directly and are not affected.
 */

export const PARTY_ID_REQUIRED = "PARTY_ID_REQUIRED";

export type PinnedSide = EjarPartyRole;

/** Is a row of `side` on this plan the pinned Ejar identity? Pure. */
export function isPinnedRow(plan: string | null | undefined, side: PinnedSide, isAccountHolder: boolean): boolean {
  const role = ejarPartyRole(plan);
  if (role !== side) return false;
  return side === "landlord" ? true : isAccountHolder;
}

export interface PinnedIdentity {
  type: string;
  idNumber: unknown;
  isDraft: boolean;
}

/**
 * The identity a request leaves on the row, or null when it need not be
 * checked (a PATCH that neither touches identity nor finalises a draft). Pure.
 * `field` is the ID column's API name: `idNumber` (owners) / `nationalId` (tenants).
 */
export function pinnedIdentityAfter(
  prior: Record<string, any> | null | undefined,
  body: Record<string, any>,
  field: "idNumber" | "nationalId",
): PinnedIdentity | null {
  if (!prior) {
    return { type: body.type || "individual", idNumber: body[field], isDraft: Boolean(body.isDraft ?? false) };
  }
  const isDraft = body.isDraft !== undefined ? Boolean(body.isDraft) : Boolean(prior.isDraft);
  const finalising = Boolean(prior.isDraft) && !isDraft;
  const touches = body.type !== undefined || body[field] !== undefined;
  if (!touches && !finalising) return null;
  return {
    type: (body.type ?? prior.type) || "individual",
    idNumber: body[field] !== undefined ? body[field] : prior[field],
    isDraft,
  };
}

const MESSAGES: Record<PinnedSide, Record<"individual" | "company", string>> = {
  landlord: {
    individual:
      "رقم الهوية / الإقامة للمؤجر مطلوب في باقة عقاري — يُطابَق به عقد إيجار · The landlord's national ID / Iqama is required on the Aqari plan — Ejar contracts are matched against it",
    company:
      "السجل التجاري للمؤجر مطلوب في باقة عقاري — يُطابَق به عقد إيجار · The landlord's commercial registration is required on the Aqari plan — Ejar contracts are matched against it",
  },
  tenant: {
    individual:
      "رقم الهوية / الإقامة مطلوب في باقة المستأجرين — يُطابَق به عقد إيجار · Your national ID / Iqama is required on the Tenant plan — Ejar contracts are matched against it",
    company:
      "السجل التجاري مطلوب في باقة المستأجرين — يُطابَق به عقد إيجار · Your commercial registration is required on the Tenant plan — Ejar contracts are matched against it",
  },
};

export function pinnedIdRequiredMessage(side: PinnedSide, type: unknown): string {
  return MESSAGES[side][type === "company" ? "company" : "individual"];
}

/**
 * 400 `PARTY_ID_REQUIRED` when a non-draft pinned row would be left without
 * an ID; the format error of partyIdentityNumber when it has a malformed one.
 * `null` identity (nothing to check) passes. Pure.
 */
export function assertPinnedPartyId(side: PinnedSide, identity: PinnedIdentity | null, field: "idNumber" | "nationalId"): void {
  if (!identity || identity.isDraft) return;
  if (isBlank(identity.idNumber)) {
    throw new BadRequestException({
      statusCode: 400,
      code: PARTY_ID_REQUIRED,
      role: side,
      field,
      message: pinnedIdRequiredMessage(side, identity.type),
    });
  }
  partyIdentityNumber(identity.idNumber, identity.type);
}

/**
 * For the dashboard banner: is the account pinned, and is its identity on
 * file? `editIn` says which form holds it — Settings (the account's own
 * landlord / tenant / company profile) or the Landlords tab (an عقاري account
 * whose only landlord is not flagged as the account's own).
 */
export interface PinnedIdentityStatus {
  role: PinnedSide | null;
  missing: boolean;
  editIn: "settings" | "owners" | null;
}

export async function pinnedIdentityStatus(db: any, accountId: number): Promise<PinnedIdentityStatus> {
  const check = await resolvePartyCheck(db, accountId);
  if (!check.role) return { role: null, missing: false, editIn: null };
  if (check.idNumber) return { role: check.role, missing: false, editIn: null };
  if (check.role === "tenant") return { role: "tenant", missing: true, editIn: "settings" };
  const rows: Array<{ isAccountHolder: boolean }> = await db
    .select({ isAccountHolder: ownersTable.isAccountHolder })
    .from(ownersTable)
    .where(and(eq(ownersTable.userId, accountId), isNull(ownersTable.deletedAt)));
  const settings = rows.length === 0 || rows.some((r) => r.isAccountHolder);
  return { role: "landlord", missing: true, editIn: settings ? "settings" : "owners" };
}
