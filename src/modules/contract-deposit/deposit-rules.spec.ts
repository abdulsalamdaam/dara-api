import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { amountAfterTopUp, statusForTerms, termsChangeRefusal, topUpRefusal, type DepositFacts } from "./deposit-rules";

const live: DepositFacts = { isDraft: false, status: "active", depositStatus: null, received: 0, legacyDepositRow: false };

describe("deposit after contract creation (TR-5): the rules", () => {
  it("terms change freely while nothing is receipted, including from zero", () => {
    assert.equal(termsChangeRefusal(live, 3000), null);
    assert.equal(termsChangeRefusal({ ...live, depositStatus: "pending" }, 0), null);
    assert.equal(statusForTerms(3000), "pending");
    assert.equal(statusForTerms(0), null);
  });

  it("a receipted deposit is never edited — an increase is a top-up, a decrease a refund at settlement", () => {
    const r = termsChangeRefusal({ ...live, depositStatus: "collected", received: 3000 }, 2500);
    assert.equal(r?.error, "DEPOSIT_RECEIPTED");
    assert.equal(r?.status, 409);
    assert.equal(topUpRefusal({ ...live, depositStatus: "collected", received: 3000 }, 500), null);
  });

  it("a top-up needs a receipt to top up and a positive amount", () => {
    assert.equal(topUpRefusal(live, 500)?.error, "DEPOSIT_NOT_RECEIPTED");
    assert.equal(topUpRefusal({ ...live, received: 100 }, 0)?.error, "DEPOSIT_BAD_AMOUNT");
  });

  it("draft, ended, settled and legacy-row contracts are refused on both routes", () => {
    for (const [f, code] of [
      [{ ...live, isDraft: true }, "DEPOSIT_CONTRACT_DRAFT"],
      [{ ...live, status: "terminated" }, "DEPOSIT_CONTRACT_ENDED"],
      [{ ...live, status: "cancelled" }, "DEPOSIT_CONTRACT_ENDED"],
      [{ ...live, depositStatus: "returned", received: 10 }, "DEPOSIT_SETTLED"],
      [{ ...live, depositStatus: "forfeited", received: 10 }, "DEPOSIT_SETTLED"],
      [{ ...live, legacyDepositRow: true, received: 10 }, "DEPOSIT_LEGACY_ROW"],
    ] as Array<[DepositFacts, string]>) {
      assert.equal(termsChangeRefusal(f, 1)?.error, code);
      assert.equal(topUpRefusal(f, 1)?.error, code);
    }
  });

  it("after a top-up the contract amount covers every receipt", () => {
    assert.equal(amountAfterTopUp(3000, 3000, 500), 3500);
    assert.equal(amountAfterTopUp(5000, 2000, 1000), 5000);
    assert.equal(amountAfterTopUp(0, 1000, 0.1), 1000.1);
  });
});
