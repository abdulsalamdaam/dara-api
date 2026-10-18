import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { MaintenanceModule } from "./maintenance.module";
import { FacilitiesModule } from "../facilities/facilities.module";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { PaymentsModule } from "../payments/payments.module";

/**
 * Found by the Oct 2026 RBAC QA pass on staging:
 *  - PATCH with nothing to write (`{}`) on maintenance / facilities / campaigns
 *    / payments was a 500 (Drizzle "No values to set");
 *  - maintenance create/update took `tenantId` / `contractId` from the body
 *    without checking they belong to the caller's account, and the contract
 *    path looked a tenant up by phone across every account — so a request
 *    could be linked to (and its emails sent to) another account's tenant.
 * Scripted Drizzle stand-in: no database, and the email service is a stub.
 */
type Op = { kind: string; table: string; calls: Array<[string, unknown[]]> };
function fakeDb(script: Record<string, Array<unknown[]>> = {}) {
  const ops: Op[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const start = (kind: string, table?: unknown) => {
    const op: Op = { kind, table: table ? getTableName(table as any) : "", calls: [] };
    ops.push(op);
    let settled: Promise<unknown> | null = null;
    const run = () => (settled ??= Promise.resolve(queues.get(`${op.kind}:${op.table}`)?.shift() ?? []));
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: any, rej: any) => run().then(res, rej);
        if (prop === "catch") return (rej: any) => run().catch(rej);
        return (...args: unknown[]) => {
          if (prop === "from" && !op.table) op.table = getTableName(args[0] as any);
          op.calls.push([prop, args]);
          return chain;
        };
      },
    });
    return chain;
  };
  return { db: { select: () => start("select"), update: (t: unknown) => start("update", t), insert: (t: unknown) => start("insert", t) } as any, ops };
}
const ctrl = (M: any, db: any) => { const [C] = Reflect.getMetadata("controllers", M); return new C(db, new Proxy({}, { get: () => async () => true })); };
const user: any = { id: 34, ownerUserId: null, permissions: [] };
const writes = (ops: Op[]) => ops.filter((o) => o.kind !== "select");

describe("PATCH with nothing to update is a 400, not a 500", () => {
  for (const [name, M, method, id] of [
    ["maintenance", MaintenanceModule, "update", "5"], ["facilities", FacilitiesModule, "update", "5"],
    ["campaigns", CampaignsModule, "update", "5"], ["payments", PaymentsModule, "update", "5"],
  ] as const) {
    it(name, async () => {
      const { db, ops } = fakeDb();
      await assert.rejects(ctrl(M, db)[method](user, id, {}), BadRequestException);
      assert.equal(writes(ops).length, 0, "nothing written");
    });
  }
});

describe("maintenance links only the account's own tenant / contract", () => {
  it("create refuses another account's tenantId before inserting", async () => {
    const { db, ops } = fakeDb({ "select:tenants": [[]] });
    await assert.rejects(ctrl(MaintenanceModule, db).create(user, { description: "x", unitLabel: "A1", tenantId: 442 }), NotFoundException);
    assert.equal(writes(ops).length, 0);
  });
  it("create accepts the account's own tenant", async () => {
    const { db, ops } = fakeDb({ "select:tenants": [[{ id: 442 }]], "insert:maintenance_requests": [[{ id: 1, tenantId: 442 }]] });
    await ctrl(MaintenanceModule, db).create(user, { description: "x", unitLabel: "A1", tenantId: 442 });
    assert.equal(ops.filter((o) => o.kind === "insert").length, 1);
  });
  it("create's phone fallback is scoped to the account", async () => {
    const { db, ops } = fakeDb({
      "select:contracts": [[{ id: 9, userId: 34, tenantPhone: "500000001" }]],
      "insert:maintenance_requests": [[{ id: 1 }]],
    });
    await ctrl(MaintenanceModule, db).create(user, { description: "x", unitLabel: "A1", contractId: 9 });
    const phoneLookup = ops.find((o) => o.kind === "select" && o.table === "tenants")!;
    const where = new PgDialect().sqlToQuery(phoneLookup.calls.find(([m]) => m === "where")![1][0] as SQL).sql;
    assert.match(where, /"tenants"\."user_id"/, "the tenant-by-phone lookup filters on the account");
  });
  it("update refuses re-linking to another account's tenant", async () => {
    const { db, ops } = fakeDb({ "select:maintenance_requests": [[{ status: "open", tenantId: null }]], "select:tenants": [[]] });
    await assert.rejects(ctrl(MaintenanceModule, db).update(user, "5", { tenantId: 479 }), NotFoundException);
    assert.equal(writes(ops).length, 0);
  });
  it("update refuses re-linking to another account's contract", async () => {
    const { db, ops } = fakeDb({ "select:maintenance_requests": [[{ status: "open", tenantId: null }]], "select:contracts": [[]] });
    await assert.rejects(ctrl(MaintenanceModule, db).update(user, "5", { contractId: 602 }), NotFoundException);
    assert.equal(writes(ops).length, 0);
  });
});
