import { and, eq, inArray, isNull } from "drizzle-orm";
import { accountAccessTable, accountGroupsTable, companiesTable, rolesTable, usersTable, type AccountGroup } from "@dara/database";
import type { AuthUser } from "./guards/jwt-auth.guard";
import type { Drizzle } from "../database/database.module";
import { CYCLE_MONTHS, CYCLE_UPLIFT, PLAN_YEARLY_PRICE, planAllowedForUserType, resolvePackage, type BillingCycle } from "./packages";
import { signalPlanChanged } from "../modules/plan-transition/plan-transition-signal";
import { signalFv2Entitlement } from "../modules/finance-v2/auto-provision-signal";

/**
 * Linked accounts (0096) — one person, several Dara accounts, one sign-in.
 *
 * Every member account is an ordinary account holder row with its own data
 * scope; nothing about scoping changes. A switched session is a token for the
 * person who signed in (its `id`, its `tv`, so the single-session rule still
 * belongs to them) plus `act`: the account holder id they are working in.
 * JwtAuthGuard re-checks the right to `act` on EVERY request through
 * `resolveActingAccess`, so unlinking an account or revoking an employee's
 * access takes effect on the next call, not at the next login.
 *
 * Who may act where:
 *  - the group's PRIMARY account holder → every member account, as that
 *    account's holder (full rights, billing included);
 *  - an EMPLOYEE of any member account → the member accounts an
 *    `account_access` row names, with that row's role;
 *  - nobody else. A member account's own login sees only itself.
 */

export type ActingAccess =
  | {
      kind: "holder";
      account: ActingAccount;
    }
  | {
      kind: "employee";
      account: ActingAccount;
      roleId: number;
      roleKey: string;
      permissions: string[];
    };

export interface ActingAccount {
  id: number;
  email: string;
  companyId: number | null;
  roleId: number | null;
  roleKey: string | null;
  permissions: string[];
  groupId: number;
}

/** The live member account `accountId` (a top-level, active, linked holder) or null. */
async function memberAccount(db: Drizzle, accountId: number): Promise<ActingAccount | null> {
  const [row] = await db
    .select({
      id: usersTable.id, email: usersTable.email, companyId: usersTable.companyId, roleId: usersTable.roleId,
      isActive: usersTable.isActive, ownerUserId: usersTable.ownerUserId, groupId: usersTable.accountGroupId,
      roleKey: rolesTable.key, permissions: rolesTable.permissions,
    })
    .from(usersTable)
    .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
    .where(and(eq(usersTable.id, accountId), isNull(usersTable.deletedAt)));
  if (!row || row.ownerUserId != null || row.groupId == null || !row.isActive) return null;
  return {
    id: row.id, email: row.email, companyId: row.companyId ?? null, roleId: row.roleId ?? null,
    roleKey: row.roleKey ?? null, permissions: (row.permissions as string[] | null) ?? [], groupId: row.groupId,
  };
}

/**
 * May `actor` (the signed-in users row) work in account `accountId`? Returns
 * how, or null. `accountId` equal to the actor's own scope is not a switch and
 * is answered by the caller, not here.
 */
export async function resolveActingAccess(
  db: Drizzle,
  actor: { id: number; ownerUserId: number | null },
  accountId: number,
): Promise<ActingAccess | null> {
  const account = await memberAccount(db, accountId);
  if (!account) return null;
  if (actor.ownerUserId == null) {
    const [g] = await db.select({ primaryUserId: accountGroupsTable.primaryUserId })
      .from(accountGroupsTable).where(eq(accountGroupsTable.id, account.groupId));
    if (!g || g.primaryUserId !== actor.id) return null;
    return { kind: "holder", account };
  }
  // An employee: their own account must be a member of the same group…
  const home = await memberAccount(db, actor.ownerUserId);
  if (!home || home.groupId !== account.groupId) return null;
  // …and the primary must have granted this account to them.
  const [grant] = await db
    .select({ roleId: accountAccessTable.roleId, roleKey: rolesTable.key, permissions: rolesTable.permissions })
    .from(accountAccessTable)
    .innerJoin(rolesTable, and(eq(rolesTable.id, accountAccessTable.roleId), isNull(rolesTable.deletedAt)))
    .where(and(
      eq(accountAccessTable.userId, actor.id),
      eq(accountAccessTable.accountId, accountId),
      eq(accountAccessTable.groupId, account.groupId),
    ));
  if (!grant) return null;
  return { kind: "employee", account, roleId: grant.roleId, roleKey: grant.roleKey, permissions: (grant.permissions as string[] | null) ?? [] };
}

/** The group an account holder belongs to, or null. */
export async function groupOfAccount(db: Drizzle, accountId: number): Promise<AccountGroup | null> {
  const [row] = await db.select({ g: accountGroupsTable })
    .from(usersTable)
    .innerJoin(accountGroupsTable, eq(accountGroupsTable.id, usersTable.accountGroupId))
    .where(eq(usersTable.id, accountId));
  return row?.g ?? null;
}

/** Live member account ids of a group, primary first. */
export async function groupMemberIds(db: Drizzle, group: Pick<AccountGroup, "id" | "primaryUserId">): Promise<number[]> {
  const rows = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.accountGroupId, group.id), isNull(usersTable.deletedAt), isNull(usersTable.ownerUserId)));
  const ids = rows.map((r) => r.id).filter((id) => id !== group.primaryUserId);
  return [group.primaryUserId, ...ids];
}

/* ── Shared-package pricing ────────────────────────────────────────────── */

/** Default extra-account price: half the plan's yearly list price. */
export const DEFAULT_EXTRA_ACCOUNT_SHARE = 0.5;

/** Yearly list price (SAR, before VAT) of one extra account in a shared group, or null when the plan is on request. */
export function extraAccountYearlyPrice(group: Pick<AccountGroup, "extraAccountPriceYearly">, plan: string | null | undefined): number | null {
  if (group.extraAccountPriceYearly != null) return Number(group.extraAccountPriceYearly);
  const yearly = PLAN_YEARLY_PRICE[resolvePackage(plan).key];
  return yearly == null ? null : Math.round(yearly * DEFAULT_EXTRA_ACCOUNT_SHARE);
}

/** One extra account's list price on a cycle — the same cycle formula as `listPrice`. */
export function extraAccountListPrice(group: Pick<AccountGroup, "extraAccountPriceYearly">, plan: string | null | undefined, cycle: BillingCycle): number | null {
  const yearly = extraAccountYearlyPrice(group, plan);
  if (yearly == null) return null;
  return Math.round((yearly * (1 + CYCLE_UPLIFT[cycle]) * CYCLE_MONTHS[cycle]) / 12);
}

/** Cycle list price (before VAT) from a yearly price — the same formula as `listPrice`. */
export function cycleListPrice(yearly: number, cycle: BillingCycle): number {
  return Math.round((yearly * (1 + CYCLE_UPLIFT[cycle]) * CYCLE_MONTHS[cycle]) / 12);
}

/** The admin's special yearly price for one account in the group, or null. */
export function memberPriceOverride(group: Pick<AccountGroup, "memberPrices">, accountId: number): number | null {
  const v = (group.memberPrices ?? {})[String(accountId)];
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

export interface SharedPriceLine {
  accountId: number;
  isPrimary: boolean;
  /** Yearly before VAT. */
  yearly: number | null;
  /** Default yearly before VAT (what it costs without a special price). */
  defaultYearly: number | null;
  /** Cycle list price before VAT. */
  list: number | null;
  custom: boolean;
}

/**
 * Shared package, priced per account: each member's own special price if an
 * admin set one, else the plan price (primary) or the extra-account price.
 * Primary first.
 */
export async function sharedPriceLines(db: Drizzle, group: AccountGroup, plan: string | null | undefined, cycle: BillingCycle): Promise<SharedPriceLine[]> {
  const ids = await groupMemberIds(db, group);
  return ids.map((id) => {
    const isPrimary = id === group.primaryUserId;
    const defaultYearly = isPrimary ? (PLAN_YEARLY_PRICE[resolvePackage(plan).key] ?? null) : extraAccountYearlyPrice(group, plan);
    const custom = memberPriceOverride(group, id);
    const yearly = custom ?? defaultYearly;
    return { accountId: id, isPrimary, yearly, defaultYearly, list: yearly == null ? null : cycleListPrice(yearly, cycle), custom: custom != null };
  });
}

/**
 * Shared mode: copy the primary's plan and subscription window onto every
 * other member, so each member account's own gates (lock, trial, plan
 * features, Ejar quota) read the group's subscription without knowing about
 * groups. Called wherever the primary's subscription changes and whenever a
 * member joins a shared group. No-op for a separate-billing group.
 */
/**
 * Shared package: the primary's plan is copied onto every member, so every
 * member's account type must be allowed that plan (e.g. the Tenants plan is
 * company-only — an individual member cannot be put on it). Returns the first
 * member that does not fit, or null. `extraIds` checks accounts about to join.
 */
export async function sharedPlanMisfit(
  db: Drizzle, group: AccountGroup, plan: string | null | undefined, extraIds: number[] = [],
): Promise<{ id: number; name: string } | null> {
  const ids = [...new Set([...(await groupMemberIds(db, group)), ...extraIds])].filter((id) => id !== group.primaryUserId);
  if (!ids.length) return null;
  const rows = await db.select({ id: usersTable.id, name: usersTable.name, userType: usersTable.userType })
    .from(usersTable).where(inArray(usersTable.id, ids));
  const bad = rows.find((r) => !planAllowedForUserType(plan, r.userType));
  return bad ? { id: bad.id, name: bad.name } : null;
}

export function sharedPlanMisfitMessage(plan: string | null | undefined, name: string): string {
  return `باقة "${resolvePackage(plan).labelAr}" لا تناسب الحساب المرتبط «${name}» (حساب فرد) — لا يمكن توحيد الباقة عليه. افصله أو اختر باقة أخرى.`;
}

export async function syncSharedSubscription(db: Drizzle, primaryUserId: number): Promise<number> {
  const [g] = await db.select().from(accountGroupsTable).where(eq(accountGroupsTable.primaryUserId, primaryUserId));
  if (!g || g.billingMode !== "shared") return 0;
  const [p] = await db.select({
    packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle,
    subscriptionStatus: usersTable.subscriptionStatus, subscriptionStartedAt: usersTable.subscriptionStartedAt,
    subscriptionEndsAt: usersTable.subscriptionEndsAt, subscriptionIsTrial: usersTable.subscriptionIsTrial,
  }).from(usersTable).where(eq(usersTable.id, primaryUserId));
  if (!p) return 0;
  const ids = (await groupMemberIds(db, g)).filter((id) => id !== primaryUserId);
  for (const id of ids) {
    const [before] = await db.select({ plan: usersTable.packagePlan, userType: usersTable.userType }).from(usersTable).where(eq(usersTable.id, id));
    // Safety net — the entry points refuse this first: never put a member on a
    // plan its account type may not hold (Tenants plan on an individual).
    if (before && !planAllowedForUserType(p.packagePlan, before.userType)) continue;
    await db.update(usersTable).set({ ...p, desiredPackagePlan: null, desiredBillingCycle: null }).where(eq(usersTable.id, id));
    // A member whose plan moved runs the same transition steps as a paid plan change.
    if (before && before.plan !== p.packagePlan) {
      signalPlanChanged(id, { from: before.plan, to: p.packagePlan, source: "admin_package_change", reason: "linked_accounts_shared_package" });
    }
    signalFv2Entitlement(id, "linked_shared_package");
  }
  return ids.length;
}

/** Shared mode, viewed from a non-primary member: its subscription is paid by the primary. */
export async function sharedBillingPayer(db: Drizzle, accountId: number): Promise<number | null> {
  const g = await groupOfAccount(db, accountId);
  if (!g || g.billingMode !== "shared" || g.primaryUserId === accountId) return null;
  return g.primaryUserId;
}

/* ── The switcher ──────────────────────────────────────────────────────── */

export interface SwitchableAccount {
  id: number;
  name: string;
  userType: string;
  commercialReg: string | null;
  packagePlan: string;
  isPrimary: boolean;
  /** The account the person belongs to (no `act` needed to work in it). */
  isHome: boolean;
  current: boolean;
}

export interface LinkedAccountsView {
  /** The account this session works in (scope id). */
  currentAccountId: number;
  /** The person signed in. */
  actor: { id: number; name: string; email: string };
  /** True when the session is switched into an account other than the person's own. */
  switched: boolean;
  groupId: number | null;
  /** Every account the person can work in, home first; empty when there is nothing to switch to. */
  accounts: SwitchableAccount[];
}

/** Accounts a person (`actorId`, the signed-in users row) can work in, home first. */
export async function switchableAccountIds(db: Drizzle, actorId: number): Promise<{ home: number; ids: number[]; groupId: number | null; primaryUserId: number | null }> {
  const [me] = await db.select({ id: usersTable.id, ownerUserId: usersTable.ownerUserId, groupId: usersTable.accountGroupId })
    .from(usersTable).where(eq(usersTable.id, actorId));
  if (!me) return { home: actorId, ids: [], groupId: null, primaryUserId: null };
  const home = me.ownerUserId ?? me.id;
  const g = await groupOfAccount(db, home);
  if (!g) return { home, ids: [home], groupId: null, primaryUserId: null };
  if (me.ownerUserId == null) {
    // A holder: the primary reaches every member; any other member only itself.
    const ids = g.primaryUserId === me.id ? await groupMemberIds(db, g) : [home];
    return { home, ids: [home, ...ids.filter((i) => i !== home)], groupId: g.id, primaryUserId: g.primaryUserId };
  }
  const grants = await db.select({ accountId: accountAccessTable.accountId }).from(accountAccessTable)
    .where(and(eq(accountAccessTable.userId, me.id), eq(accountAccessTable.groupId, g.id)));
  const members = new Set(await groupMemberIds(db, g));
  const ids = [home, ...grants.map((r) => r.accountId).filter((id) => id !== home && members.has(id))];
  return { home, ids, groupId: g.id, primaryUserId: g.primaryUserId };
}

/** Display rows for account ids (company name for a company account, else the holder's name). */
export async function accountRows(db: Drizzle, ids: number[]): Promise<Array<{ id: number; name: string; userType: string; commercialReg: string | null; packagePlan: string; email: string; isActive: boolean; subscriptionStatus: string; subscriptionEndsAt: Date | null; onboardedAt: Date | null }>> {
  if (!ids.length) return [];
  const rows = await db.select({
    id: usersTable.id, name: usersTable.name, userType: usersTable.userType, packagePlan: usersTable.packagePlan,
    email: usersTable.email, isActive: usersTable.isActive, subscriptionStatus: usersTable.subscriptionStatus,
    subscriptionEndsAt: usersTable.subscriptionEndsAt, onboardedAt: usersTable.onboardedAt,
    companyName: companiesTable.name, commercialReg: companiesTable.commercialReg,
  }).from(usersTable)
    .leftJoin(companiesTable, eq(companiesTable.id, usersTable.companyId))
    .where(inArray(usersTable.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({
    id: r.id,
    name: (r.userType === "company" && r.companyName) ? r.companyName : r.name,
    userType: r.userType, commercialReg: r.commercialReg ?? null, packagePlan: r.packagePlan, email: r.email,
    isActive: r.isActive, subscriptionStatus: r.subscriptionStatus, subscriptionEndsAt: r.subscriptionEndsAt ?? null,
    onboardedAt: r.onboardedAt ?? null,
  }));
}

/** What /auth/me carries as `linkedAccounts`. */
export async function switchableAccounts(db: Drizzle, user: AuthUser): Promise<LinkedAccountsView> {
  const actorId = user.actorUserId ?? user.id;
  const current = user.ownerUserId ?? user.id;
  const [actor] = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, actorId));
  const s = await switchableAccountIds(db, actorId);
  const rows = s.ids.length > 1 ? await accountRows(db, s.ids) : [];
  return {
    currentAccountId: current,
    actor: actor ?? { id: actorId, name: "", email: "" },
    switched: current !== s.home,
    groupId: s.groupId,
    accounts: rows.filter((r) => r.isActive).map((r) => ({
      id: r.id, name: r.name, userType: r.userType, commercialReg: r.commercialReg, packagePlan: r.packagePlan,
      isPrimary: r.id === s.primaryUserId, isHome: r.id === s.home, current: r.id === current,
    })),
  };
}
