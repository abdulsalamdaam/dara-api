import type { Provider } from "@nestjs/common";
import { DRIZZLE } from "../../../database/database.module";
import { ReportsModule } from "../../reports/reports.module";
import { LEGACY_ACCOUNTING, type LegacyAccounting } from "./reconciliation.service";
import { contractPropertySnapshots } from "../overrides/reads";

/**
 * Reconciliation R3 compares landlord payable with the legacy landlord-dues
 * report "by calling the same function" (DESIGN §7.10). The legacy
 * `ReportsController` is not exported, so it is taken from its module's
 * metadata (as the DB specs do) and constructed with the shared Drizzle
 * handle. Its finance-v2 hook property is a stub: the flag reads as off (no
 * E3/E4/E1 overlay, so this is the legacy computation), and the one v2 input
 * the dues computation takes, the contract → property snapshot of a
 * terminated contract (N-C), comes from `finance_contract_dims`, exactly as
 * the flag-on dues report gets it. Read-only.
 */
export function legacyAccountingFor(db: unknown): LegacyAccounting {
  const Ctl = (Reflect as any).getMetadata("controllers", ReportsModule)?.[0];
  if (!Ctl) throw new Error("fv2: legacy ReportsController not found");
  const ctl = new Ctl(db);
  const pool = (db as any)?.$client;
  ctl.fv2h = {
    resolve: async () => false,
    contractPropertySnapshots: async (scope: number) => (pool ? contractPropertySnapshots(pool, scope) : new Map<number, number>()),
  };
  return (scope: number) => ctl.accounting({ id: scope, ownerUserId: null, ownerScopeId: null, role: "user", permissions: [], email: "" });
}

export const legacyAccountingProvider: Provider = {
  provide: LEGACY_ACCOUNTING,
  useFactory: (db: unknown) => legacyAccountingFor(db),
  inject: [DRIZZLE],
};
