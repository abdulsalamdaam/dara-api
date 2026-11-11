import { test } from "node:test";
import assert from "node:assert/strict";
import { registrationRequiresApproval } from "./registration-policy";

test("registration is self-serve unless REGISTRATION_REQUIRES_APPROVAL=true", () => {
  const prev = process.env.REGISTRATION_REQUIRES_APPROVAL;
  try {
    delete process.env.REGISTRATION_REQUIRES_APPROVAL;
    assert.equal(registrationRequiresApproval(), false);
    process.env.REGISTRATION_REQUIRES_APPROVAL = "false";
    assert.equal(registrationRequiresApproval(), false);
    process.env.REGISTRATION_REQUIRES_APPROVAL = " TRUE ";
    assert.equal(registrationRequiresApproval(), true);
  } finally {
    if (prev === undefined) delete process.env.REGISTRATION_REQUIRES_APPROVAL; else process.env.REGISTRATION_REQUIRES_APPROVAL = prev;
  }
});
