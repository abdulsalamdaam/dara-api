import type { AuthUser } from "../../common/guards/jwt-auth.guard";

/**
 * Finance v2 capabilities, DERIVED from existing permission keys (DESIGN §10.1).
 * No new key enters PERMISSIONS or the presets: presets are rewritten on every
 * boot, so a new key would change `/auth/me/permissions` for every account.
 */
export type Capability = "view" | "draft" | "approve" | "settings" | "money" | "expenses";
export const ALL_CAPABILITIES: readonly Capability[] = ["view", "draft", "approve", "settings", "money", "expenses"];

/**
 * The account holder: a top-level login, not an employee and not an
 * owner-mobile token (those also carry ownerUserId null, jwt-auth.guard.ts).
 */
export function isAccountHolder(user: Pick<AuthUser, "ownerUserId" | "ownerScopeId" | "role">): boolean {
  return user.ownerUserId == null && user.ownerScopeId == null && user.role !== "owner";
}

export function capabilities(user: Pick<AuthUser, "ownerUserId" | "ownerScopeId" | "role" | "permissions">): Capability[] {
  if (user.ownerScopeId != null || user.role === "owner") return [];
  const p = new Set(user.permissions ?? []);
  const has = (...keys: string[]) => keys.every((k) => p.has(k));
  const out: Capability[] = [];
  if (has("reports.view") && (p.has("payments.view") || p.has("invoices.view"))) out.push("view");
  if (has("invoices.write", "expenses.write")) out.push("draft");
  if (has("expenses.approve", "invoices.write")) out.push("approve");
  if (isAccountHolder(user) || has("invoices.delete", "expenses.approve", "payments.write")) out.push("settings");
  if (has("payments.write")) out.push("money");
  if (has("expenses.write")) out.push("expenses");
  return out;
}
