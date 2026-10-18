import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import { OPS_DEFS, OPS_REPORT_PERMS, catalog, missingReportPerms } from "./ops-catalog";
import { OpsReportsController } from "./ops-reports.module";
import { EMPLOYEE_PRESETS } from "../../../common/permissions";

/**
 * `reports.view` used to open every operational report: a Maintenance Manager
 * read tenant balances and collections on staging (Oct 2026 RBAC QA). Each
 * report now also needs the view key of every module it reads.
 */
describe("operational reports are gated per module", () => {
  it("every report declares its permissions", () => {
    for (const d of OPS_DEFS) assert.ok(OPS_REPORT_PERMS[d.id]?.length, d.id);
  });

  it("a maintenance manager sees only property/unit/maintenance reports", () => {
    const ids = catalog("2026-10-18", EMPLOYEE_PRESETS.maintenanceManager!.permissions).reports.map((r) => r.id).sort();
    assert.deepEqual(ids, ["data_quality", "maintenance_requests", "occupancy_trend", "vacant_units"]);
  });

  it("the general manager sees every report; no perms argument = the full catalog", () => {
    assert.equal(catalog("2026-10-18", EMPLOYEE_PRESETS.general!.permissions).reports.length, OPS_DEFS.length);
    assert.equal(catalog("2026-10-18").reports.length, OPS_DEFS.length);
  });

  it("money reports need payments.view", () => {
    assert.deepEqual(missingReportPerms("collections_summary", ["reports.view", "maintenance.view"]), ["payments.view"]);
    assert.deepEqual(missingReportPerms("tenant_balances", ["tenants.view", "payments.view"]), []);
  });

  it("GET /reports/ops/:id refuses a report the role may not run, before touching the database", () => {
    const db: any = new Proxy({}, { get: () => { throw new Error("database touched"); } });
    const c = new OpsReportsController(db);
    const user: any = { id: 56, ownerUserId: 34, permissions: EMPLOYEE_PRESETS.maintenanceManager!.permissions };
    assert.throws(() => c.one(user, "tenant_balances", {}), ForbiddenException);
  });
});
