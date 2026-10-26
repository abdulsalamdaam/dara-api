/**
 * Module-level signals between code that must not import LimitsModule (the
 * subscription activation path, the seat and Ejar gates) and the limits side
 * that reacts. Same pattern as finance-v2/auto-provision-signal.ts: a plain
 * function, no Nest dependency, never throws, never awaits. With no handler
 * registered (specs, a CLI, the module not loaded) a signal is a no-op.
 */
import type { LimitKey } from "../../common/limit-core";

export type LimitRefusedHandler = (accountId: number, key: LimitKey) => void;
export type AddonPaidHandler = (addonId: number) => void;

let refused: LimitRefusedHandler | null = null;
let paid: AddonPaidHandler | null = null;

export function setLimitRefusedHandler(fn: LimitRefusedHandler | null): void {
  refused = fn;
}

export function setLimitAddonPaidHandler(fn: AddonPaidHandler | null): void {
  paid = fn;
}

/**
 * A gate refused an action because `key` is at its limit (seat gate, Ejar
 * plan quota exhausted). The auto-offer may answer with an `offered` add-on.
 */
export function signalLimitRefused(accountId: number | null | undefined, key: LimitKey): void {
  if (!refused || !Number.isInteger(accountId) || (accountId as number) <= 0) return;
  try {
    refused(accountId as number, key);
  } catch {
    /* a signal must never reach the caller */
  }
}

/** An add-on's payment was confirmed and the add-on is active. */
export function signalLimitAddonPaid(addonId: number | null | undefined): void {
  if (!paid || !Number.isInteger(addonId) || (addonId as number) <= 0) return;
  try {
    paid(addonId as number);
  } catch {
    /* a signal must never reach the caller */
  }
}
