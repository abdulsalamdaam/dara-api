import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertCompanyCommercialReg } from "./commercial-reg";

const throws = (row: any) => assert.throws(() => assertCompanyCommercialReg(row));
const ok = (row: any) => assert.doesNotThrow(() => assertCompanyCommercialReg(row));

describe("assertCompanyCommercialReg", () => {
  it("requires a CR on a company", () => {
    throws({ type: "company", nationalId: null });
    throws({ type: "company", nationalId: "" });
    throws({ type: "company", nationalId: "   " });
  });

  it("requires exactly 10 digits", () => {
    throws({ type: "company", nationalId: "123456789" });    // 9
    throws({ type: "company", nationalId: "12345678901" });  // 11
    throws({ type: "company", nationalId: "70300000A0" });   // not digits
    ok({ type: "company", nationalId: "7030955236" });
    ok({ type: "company", nationalId: "  7030955236  " });   // trimmed
  });

  it("leaves individuals alone — their ID is validated by its own rule", () => {
    ok({ type: "individual", nationalId: null });
    ok({ type: "individual", nationalId: "1051133120" });
    ok({ nationalId: null });   // type defaults to individual
  });

  it("exempts drafts, which are explicitly incomplete", () => {
    ok({ type: "company", nationalId: null, isDraft: true });
  });
});
