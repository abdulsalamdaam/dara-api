/**
 * The one line a legacy path calls when an account may just have become
 * entitled to Finance v2 (registration approved, plan changed, subscription
 * paid/activated, account re-activated): `signalFv2Entitlement(id, "why")`.
 *
 * Deliberately a plain module-level function with no Nest dependency, so the
 * subscription and admin modules can call it without importing the Finance v2
 * module (no cycle, no constructor change). It never throws and never awaits:
 * the handler (FinanceV2AutoProvisionService) queues the work and returns, so
 * the user action can neither fail nor slow down because of it. With no handler
 * registered (kill switch, specs, a CLI) it is a no-op.
 */
export type Fv2EntitlementHandler = (accountUserId: number, trigger: string) => void;

let handler: Fv2EntitlementHandler | null = null;

export function setFv2EntitlementHandler(fn: Fv2EntitlementHandler | null): void {
  handler = fn;
}

export function signalFv2Entitlement(accountUserId: number | null | undefined, trigger: string): void {
  if (!handler || !Number.isInteger(accountUserId) || (accountUserId as number) <= 0) return;
  try {
    handler(accountUserId as number, trigger);
  } catch {
    /* a signal must never reach the caller */
  }
}
