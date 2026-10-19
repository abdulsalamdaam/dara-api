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
import { sql } from "drizzle-orm";
import { paymentsTable } from "@dara/database";

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
