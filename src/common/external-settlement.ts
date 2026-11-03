/**
 * Externally-settled installments: counted or skipped, per contract.
 *
 * An existing contract added with "earlier rent was collected outside the
 * platform" (or an Ejar import whose invoices were already paid) carries
 * installments stored `settled_external`. `contracts.external_settlement_mode`
 * (migration 0084) decides what money views do with them:
 *
 *  - `count` (default, every pre-existing contract): due + collected in the
 *    operational reports, booked by the finance-v2 recognizer (E02 + E33).
 *  - `skip`: they stay in the payment schedule only — left out of the
 *    reports, KPIs and collection rates, and never charged in the ledger.
 *
 * "Skipped" is always the pair (status `settled_external`, contract `skip`);
 * a live row on a skip contract counts like any other.
 */
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { paymentsTable } from "@dara/database";
import { dateOnly } from "./validation";
import { riyadhToday } from "./payment-status";

export const EXTERNAL_SETTLEMENT_MODES = ["count", "skip"] as const;
export type ExternalSettlementMode = (typeof EXTERNAL_SETTLEMENT_MODES)[number];

/** A request value → a mode; anything but "skip" reads as the default. */
export function externalSettlementMode(v: unknown): ExternalSettlementMode {
  return v === "skip" ? "skip" : "count";
}

/** In memory: is this installment left out of the money views? */
export function isSkippedExternal(status: string | null | undefined, mode: string | null | undefined): boolean {
  return status === "settled_external" && mode === "skip";
}

/**
 * Raw SQL over a payments alias (default `p`): true for an externally-settled
 * installment of a `skip` contract. A correlated sub-select, so it works in a
 * query that does not join contracts.
 */
export const skippedExternalRaw = (p = "p"): string =>
  `(${p}.status::text = 'settled_external' and exists (select 1 from contracts xsc where xsc.id = ${p}.contract_id and xsc.external_settlement_mode = 'skip'))`;

/** The same as a Drizzle fragment over `paymentsTable` (a boolean column in a select, or `not (…)` in a where). */
export const skippedExternalSql = sql<boolean>`(${paymentsTable.status}::text = 'settled_external' and exists (select 1 from contracts xsc where xsc.id = ${paymentsTable.contractId} and xsc.external_settlement_mode = 'skip'))`;

/**
 * The day the landlord says an installment was settled outside the platform:
 * blank → its due date (as before), or today for one not due yet (paid ahead);
 * never in the future.
 */
export function settledOutsideDate(v: unknown, dueDate: string): string {
  const today = riyadhToday();
  const due = String(dueDate).slice(0, 10);
  const d = dateOnly(v, "تاريخ السداد") ?? (due < today ? due : today);
  if (d > today) throw new BadRequestException({ code: "invalid_field", key: "paidDate", message: "تاريخ السداد لا يكون في المستقبل · The payment date cannot be in the future" });
  return d;
}

/**
 * The Ejar import's "settled outside" choices: which Ejar invoices the landlord
 * marks settled although Ejar does not report them paid, each with an optional
 * payment date. Unknown shapes are dropped; a date is checked when applied.
 */
export function settledOutsideChoices(v: unknown): Array<{ invoiceId: string; paidDate: string | null }> {
  if (!Array.isArray(v)) return [];
  const out = new Map<string, string | null>();
  for (const e of v.slice(0, 500)) {
    const id = e && typeof e === "object" ? String((e as any).invoiceId ?? "").trim() : "";
    if (!id || id.length > 100) continue;
    const d = dateOnly((e as any).paidDate, "تاريخ السداد");
    if (d) settledOutsideDate(d, d); // refused here, before anything is written
    out.set(id, d);
  }
  return [...out].map(([invoiceId, paidDate]) => ({ invoiceId, paidDate }));
}
