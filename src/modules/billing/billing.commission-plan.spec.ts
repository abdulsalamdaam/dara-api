import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usersTable, simpleInvoicesTable } from "@dara/database";
import { getTableName } from "drizzle-orm";
import { BillingModule } from "./billing.module";
import { CommissionNotInPlanException } from "../../common/plan-features";

/**
 * عقاري (basic) never gets a commission invoice (COM-) from the legacy billing
 * paths: the paired commission on rent-invoice approval, a manual commission
 * document, or approving a commission draft left from before a downgrade.
 * The controller is driven with a Drizzle double; any write fails the test.
 */
function fakeDb(plan: string | null, doc: any = null) {
  const reads: string[] = [];
  const writes: string[] = [];
  const builder = (fields?: any) => {
    let table = "";
    const b: any = {
      from(t: any) { table = getTableName(t); reads.push(table); return b; },
      innerJoin() { return b; }, leftJoin() { return b; }, where() { return b; }, limit() { return b; },
      orderBy() { return b; },
      then(res: any, rej: any) {
        let rows: any[] = [];
        if (table === getTableName(usersTable) && fields && "p" in fields) rows = [{ p: plan }];
        else if (table === getTableName(simpleInvoicesTable) && doc) rows = [doc];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return b;
  };
  const fail = (what: string) => () => { writes.push(what); throw new Error(`unexpected ${what}`); };
  const db: any = { select: builder, insert: fail("insert"), update: fail("update"), delete: fail("delete"), execute: fail("execute") };
  return { db, reads, writes };
}

function controller(db: any): any {
  const Ctl = (Reflect as any).getMetadata("controllers", BillingModule)?.[0];
  const ctl = Object.create(Ctl.prototype);
  ctl.db = db;
  ctl.fv2h = undefined; // flag off — what عقاري always resolves to
  return ctl;
}

const user = { id: 9, ownerUserId: null, ownerScopeId: null, role: "user", permissions: [], email: "" };
const rentDoc = { id: 1, number: "INV-000001", kind: null, contractId: 3, paymentIds: [5], paymentId: 5, dueDate: null };

describe("legacy billing — commission is not issued on عقاري", () => {
  it("the paired commission on approval is skipped before anything is read (stale fee %)", async () => {
    const { db, reads, writes } = fakeDb("basic");
    const out = await controller(db).maybeCreateCommissionInvoice(9, rentDoc, 3);
    assert.equal(out, null);
    assert.deepEqual(reads, [getTableName(usersTable)]);
    assert.deepEqual(writes, []);
  });

  it("an Offices account still goes on to read the property's fee %", async () => {
    const { db, reads } = fakeDb("professional");
    const out = await controller(db).maybeCreateCommissionInvoice(9, rentDoc, 3);
    assert.equal(out, null); // the double has no property row → no fee
    assert.ok(reads.length > 1, "went past the plan gate");
  });

  it("approving a COM- draft from before a downgrade is a 403", async () => {
    const draft = { id: 4, userId: 9, number: "COM-000001", type: "invoice", kind: "commission", status: "draft", items: [], total: "0" };
    const { db, writes } = fakeDb("basic", draft);
    await assert.rejects(controller(db).approve(user, "4", {}), CommissionNotInPlanException);
    assert.deepEqual(writes, []);
  });

  it("creating a commission document by hand is a 403", async () => {
    const { db, writes } = fakeDb("basic");
    await assert.rejects(
      controller(db).create(user, { type: "invoice", kind: "commission", items: [{ description: "عمولة", quantity: 1, unitPrice: 100, amount: 100, vat: false }] }),
      CommissionNotInPlanException,
    );
    assert.deepEqual(writes, []);
  });
});
