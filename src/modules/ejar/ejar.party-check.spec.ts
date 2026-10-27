/** resolvePartyCheck — the stored ID an عقاري / tenant inquiry is pinned to. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePartyCheck } from "./ejar.party-check";

/** The three drizzle chains resolvePartyCheck walks: the account, its owners, its own tenant row. */
const db = (acct: any, owners: any[] = [], self: any = null) => ({
  select: () => ({
    from: () => ({
      leftJoin: () => ({ where: async () => [acct] }),
      where: () => ({ orderBy: async () => owners, limit: async () => (self ? [self] : []) }),
    }),
  }),
});

describe("resolvePartyCheck", () => {
  it("عقاري: the account-holder landlord's ID", async () => {
    const owners = [{ idNumber: "1077700002", isAccountHolder: true }, { idNumber: "1010555001", isAccountHolder: false }];
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "basic" }, owners), 1), { role: "landlord", idNumber: "1077700002" });
  });

  it("عقاري: the only landlord when none is flagged; several unflagged → none", async () => {
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "basic" }, [{ idNumber: "1010999001", isAccountHolder: false }]), 1), { role: "landlord", idNumber: "1010999001" });
    const two = [{ idNumber: "1010999001", isAccountHolder: false }, { idNumber: "1010999002", isAccountHolder: false }];
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "basic" }, two), 1), { role: "landlord", idNumber: null });
  });

  it("عقاري: no landlord, or one without an ID → null (the user completes it first)", async () => {
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "basic" }, []), 1), { role: "landlord", idNumber: null });
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "basic" }, [{ idNumber: " ", isAccountHolder: true }]), 1), { role: "landlord", idNumber: null });
  });

  it("tenant: the company CR, else the account-holder tenant's national ID", async () => {
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "tenant", commercialReg: "1010777001" }), 1), { role: "tenant", idNumber: "1010777001" });
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "tenant", commercialReg: null }, [], { nationalId: "1000000201" }), 1), { role: "tenant", idNumber: "1000000201" });
    assert.deepEqual(await resolvePartyCheck(db({ packagePlan: "tenant", commercialReg: null }), 1), { role: "tenant", idNumber: null });
  });

  it("Offices / Companies: unpinned", async () => {
    for (const plan of ["professional", "enterprise", null]) {
      assert.deepEqual(await resolvePartyCheck(db({ packagePlan: plan, commercialReg: "1010777003" }), 1), { role: null, idNumber: null });
    }
  });
});
