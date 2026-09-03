import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeTrialDays } from "../../common/trial";

/**
 * The approval precedence table, as a pure function.
 *
 * This mirrors the decision `PATCH /admin/registrations/:id/approve` makes
 * before it touches the database. It is duplicated here rather than exported
 * because extracting it would not make the handler clearer — but it is the
 * part that was wrong, so it is the part that needs a test: before `noTrial`
 * existed, an admin who deliberately chose "no trial" sent a body that was
 * byte-identical to one who expressed no opinion (absent, empty and zero all
 * normalise to null), so the default fired and burnt the account's one free
 * trial while the UI told him the customer would land on the pay screen.
 */
interface ApproveBody {
  trialDays?: number;
  subscriptionEndsAt?: string;
  grantWithoutPayment?: boolean;
  noTrial?: boolean;
}
interface Account { accountStatus: string; trialConsumedAt: Date | null }
interface Policy { days: number; enabled: boolean }

function decide(body: ApproveBody, account: Account, policy: Policy) {
  const askedTrialDays = normalizeTrialDays(body.trialDays);
  const explicitOverride = askedTrialDays != null || !!body.subscriptionEndsAt || !!body.grantWithoutPayment;
  const isPendingRegistration = account.accountStatus === "pending";
  const autoTrialDays =
    !explicitOverride && !body.noTrial && policy.enabled
    && isPendingRegistration && account.trialConsumedAt == null
      ? policy.days
      : null;
  const trialDays = askedTrialDays ?? autoTrialDays;
  const manualGrant = trialDays != null || !!body.subscriptionEndsAt || !!body.grantWithoutPayment;
  return {
    status: manualGrant ? "active" : "pending_payment",
    isTrial: trialDays != null,
    trialDays,
    burnsTrial: trialDays != null,
  };
}

const PENDING: Account = { accountStatus: "pending", trialConsumedAt: null };
const POLICY: Policy = { days: 14, enabled: true };

describe("approve — the automatic trial", () => {
  it("grants the configured trial when the admin says nothing", () => {
    const d = decide({}, PENDING, POLICY);
    assert.deepEqual(d, { status: "active", isTrial: true, trialDays: 14, burnsTrial: true });
  });

  it("honours a changed policy length", () => {
    assert.equal(decide({}, PENDING, { days: 7, enabled: true }).trialDays, 7);
  });
});

describe("approve — an admin can decline the trial", () => {
  it("noTrial sends the account to the pay screen and does NOT burn the trial", () => {
    const d = decide({ noTrial: true }, PENDING, POLICY);
    assert.equal(d.status, "pending_payment");
    assert.equal(d.isTrial, false);
    assert.equal(d.burnsTrial, false, "declining must not spend the one free trial");
  });

  it("is not defeated by the other fields being present-but-empty", () => {
    // This is the shape the portal actually sends: the untouched controls
    // serialise as false/undefined, and JSON.stringify drops the undefined.
    const d = decide({ noTrial: true, grantWithoutPayment: false, trialDays: undefined }, PENDING, POLICY);
    assert.equal(d.status, "pending_payment");
  });
});

describe("approve — an explicit instruction always wins", () => {
  it("an explicit trialDays overrides the policy", () => {
    assert.equal(decide({ trialDays: 30 }, PENDING, POLICY).trialDays, 30);
  });

  it("grantWithoutPayment grants a window that is NOT a trial", () => {
    const d = decide({ grantWithoutPayment: true }, PENDING, POLICY);
    assert.equal(d.status, "active");
    assert.equal(d.isTrial, false);
    assert.equal(d.burnsTrial, false);
  });

  it("an explicit end date grants a window that is NOT a trial", () => {
    const d = decide({ subscriptionEndsAt: "2027-01-01" }, PENDING, POLICY);
    assert.equal(d.status, "active");
    assert.equal(d.isTrial, false);
  });

  it("an explicit instruction beats noTrial rather than fighting it", () => {
    assert.equal(decide({ trialDays: 30, noTrial: true }, PENDING, POLICY).trialDays, 30);
  });
});

describe("approve — the trial is once, and only out of the queue", () => {
  it("is not re-granted to an account that already used one", () => {
    const d = decide({}, { accountStatus: "pending", trialConsumedAt: new Date("2026-01-01") }, POLICY);
    assert.equal(d.status, "pending_payment");
    assert.equal(d.isTrial, false);
  });

  it("is not granted when the offer is switched off", () => {
    assert.equal(decide({}, PENDING, { days: 14, enabled: false }).status, "pending_payment");
  });

  /**
   * Re-approving a live account must never replace its window — paid or
   * otherwise — with a fresh 14 free days.
   */
  it("is not granted to an account that is already active", () => {
    for (const accountStatus of ["active", "suspended", "rejected"]) {
      const d = decide({}, { accountStatus, trialConsumedAt: null }, POLICY);
      assert.equal(d.status, "pending_payment", accountStatus);
      assert.equal(d.isTrial, false, accountStatus);
    }
  });
});
