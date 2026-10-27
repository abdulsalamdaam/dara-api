/**
 * The lines legacy paths call around a plan change, with no Nest dependency (the same pattern as
 * finance-v2/auto-provision-signal.ts): the subscription and admin modules call these without importing the
 * plan-transition module, so there is no cycle and no constructor change.
 *
 *  - `signalPlanChanged(id, {from, to, source, …})` — after `users.package_plan` was written. Never throws,
 *    never awaits; PlanTransitionService records the change and runs its steps on its own queue. With no
 *    handler registered (specs, a CLI, the kill switch) it is a no-op; the hourly sweep then records the change
 *    it missed (`source = 'sweep'`).
 *  - `assertCustomerPlanChangeAllowed` / `assertAdminPlanChangeAllowed` — BEFORE a plan is written or a payment
 *    for it is opened: 409 DOWNGRADE_NEEDS_SUPPORT (with the preview) for a downgrade out of accounting while the
 *    office holds client money or manages third-party landlords with active contracts (D2). No handler = allowed.
 *  - `requestModeMigration` — the Owner-mode third-party guard asks for the automatic Owner→Manager migration.
 */
import { currentRequestContext } from "../../common/request-context";

export type PlanChangeSource = "admin_approve" | "admin_package_change" | "subscription_paid" | "backfill" | "sweep" | "owner_mode_guard";

export interface PlanChangeSignal {
  from: string | null;
  to: string;
  source: PlanChangeSource;
  actorUserId?: number | null;
  paymentId?: number | null;
  reason?: string | null;
  /** An admin forced a downgrade the preview refused. */
  forced?: boolean;
}

export type PlanChangeHandler = (accountUserId: number, c: PlanChangeSignal) => void;
export type PlanGuardHandler = (accountUserId: number, toPlan: string, viewer: "customer" | "admin", opts: { force?: boolean; reason?: string | null }) => Promise<void>;
export type ModeMigrationHandler = (accountUserId: number, trigger: string) => Promise<{ outcome: string; blockers?: Array<{ code: string }>; archiveId?: number }>;
export type OwnerModeConflictHandler = (accountUserId: number, detail: Record<string, unknown>) => Promise<void>;

let changeHandler: PlanChangeHandler | null = null;
let guardHandler: PlanGuardHandler | null = null;
let migrationHandler: ModeMigrationHandler | null = null;
let conflictHandler: OwnerModeConflictHandler | null = null;

export function setPlanChangeHandler(fn: PlanChangeHandler | null): void { changeHandler = fn; }
export function setPlanGuardHandler(fn: PlanGuardHandler | null): void { guardHandler = fn; }
export function setModeMigrationHandler(fn: ModeMigrationHandler | null): void { migrationHandler = fn; }
export function setOwnerModeConflictHandler(fn: OwnerModeConflictHandler | null): void { conflictHandler = fn; }

/** The acting user of the current request, when the caller did not name one (admin routes without @CurrentUser). */
function ambientActor(): number | null {
  try {
    const id = currentRequestContext()?.userId;
    return Number.isInteger(id) ? (id as number) : null;
  } catch {
    return null;
  }
}

export function signalPlanChanged(accountUserId: number | null | undefined, c: PlanChangeSignal): void {
  if (!changeHandler || !Number.isInteger(accountUserId) || (accountUserId as number) <= 0 || !c?.to) return;
  try {
    changeHandler(accountUserId as number, { ...c, actorUserId: c.actorUserId ?? ambientActor() });
  } catch {
    /* a signal must never reach the caller */
  }
}

/** 409 DOWNGRADE_NEEDS_SUPPORT when a customer may not move to `toPlan` by himself (see PlanTransitionService.preview). */
export async function assertCustomerPlanChangeAllowed(accountUserId: number, toPlan: string): Promise<void> {
  if (!guardHandler) return;
  await guardHandler(accountUserId, toPlan, "customer", {});
}

/** The admin form: the same refusal unless `force` and a reason (5–500 characters) are given. */
export async function assertAdminPlanChangeAllowed(accountUserId: number, toPlan: string, force?: unknown, reason?: unknown): Promise<void> {
  if (!guardHandler) return;
  await guardHandler(accountUserId, toPlan, "admin", { force: force === true || force === "true", reason: typeof reason === "string" ? reason : null });
}

/** Ask for the automatic Owner→Manager migration; null when nothing is registered. Never throws. */
export async function requestModeMigration(accountUserId: number, trigger: string): Promise<{ outcome: string; blockers?: Array<{ code: string }>; archiveId?: number } | null> {
  if (!migrationHandler) return null;
  try {
    return await migrationHandler(accountUserId, trigger);
  } catch {
    return null;
  }
}

/** Record what the Owner-mode third-party guard did (a refusal, or the migration it ran) for the admin. Never throws. */
export async function reportOwnerModeConflict(accountUserId: number, detail: Record<string, unknown>): Promise<void> {
  if (!conflictHandler) return;
  try {
    await conflictHandler(accountUserId, detail);
  } catch {
    /* the refusal itself still reaches the user */
  }
}
