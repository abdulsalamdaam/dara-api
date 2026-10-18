import { ALL_PERMISSIONS, EMPLOYEE_PRESETS, ROLE_PRESETS, type Permission } from "./permissions";

/**
 * Everything a customer account may hand to one of its employees: the account
 * holder's own preset plus whatever the employee presets carry
 * (`support.respond` today — see permissions.spec.ts). Platform keys
 * (`admin.*`) are never in it, so no team endpoint can mint a platform admin.
 */
export const EMPLOYEE_ASSIGNABLE: ReadonlySet<Permission> = new Set<Permission>([
  ...ROLE_PRESETS.user,
  ...Object.values(EMPLOYEE_PRESETS).flatMap((d) => d.permissions),
]);

/** The keys an employee preset may be referred to by on the team endpoints. */
export const EMPLOYEE_PRESET_KEYS: readonly string[] = Object.keys(EMPLOYEE_PRESETS);

export type TeamActor = {
  ownerUserId?: number | null;
  ownerScopeId?: number | null;
  role?: string | null;
  permissions?: readonly string[] | null;
};

/**
 * The most a team manager may grant (or touch).
 *
 * - The account holder is the account's ceiling: everything assignable.
 * - An employee holding `team.manage` (a General Manager) may grant only what
 *   they hold themselves — a manager cannot create someone stronger than
 *   themselves, which is also what stops "create a helper, give it more,
 *   log in as it".
 */
export function teamCeiling(actor: TeamActor): Set<Permission> {
  if (actor.ownerScopeId != null || actor.role === "owner") return new Set();
  if (actor.ownerUserId == null) return new Set(EMPLOYEE_ASSIGNABLE);
  const held = new Set(actor.permissions ?? []);
  return new Set([...EMPLOYEE_ASSIGNABLE].filter((p) => held.has(p)));
}

/** The keys of `perms` the ceiling does not cover (empty = allowed). */
export function exceeding(perms: readonly string[], ceiling: ReadonlySet<string>): string[] {
  return [...new Set(perms)].filter((p) => !ceiling.has(p));
}

/** Catalog keys only, de-duplicated; unknown strings are dropped. */
export function knownPermissions(perms: readonly unknown[] | null | undefined): Permission[] {
  const catalog = new Set<string>(ALL_PERMISSIONS);
  return [...new Set((perms ?? []).filter((p): p is string => typeof p === "string").map((p) => p.trim()))]
    .filter((p) => catalog.has(p)) as Permission[];
}
