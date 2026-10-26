import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ejarDenialFor, ejarEnvMode, ejarModeOf } from "./ejar.access";

describe("ejarDenialFor — EJAR_ACCESS × the account switch (decision 6)", () => {
  const allow = { EJAR_ACCESS: "allowlist", EJAR_ALLOWED_USER_IDS: "5" };
  it("default follows EJAR_ACCESS", () => {
    assert.equal(ejarDenialFor("default", 7, {}), null);
    assert.equal(ejarDenialFor("default", 5, allow), null);
    assert.equal(ejarDenialFor("default", 7, allow)?.code, "access_denied");
  });
  it("enabled opens the allowlist", () => {
    assert.equal(ejarDenialFor("enabled", 7, allow), null);
  });
  it("enabled never opens EJAR_ACCESS=off (or a typo, which reads as off)", () => {
    assert.equal(ejarDenialFor("enabled", 7, { EJAR_ACCESS: "off" })?.code, "access_denied");
    assert.equal(ejarDenialFor("enabled", 7, { EJAR_ACCESS: "alowlist" })?.code, "access_denied");
  });
  it("disabled always blocks, even on an allowlisted user or EJAR_ACCESS=all", () => {
    assert.equal(ejarDenialFor("disabled", 5, allow)?.code, "ejar_disabled_for_account");
    assert.equal(ejarDenialFor("disabled", 7, {})?.code, "ejar_disabled_for_account");
  });
  it("modes and env normalise", () => {
    assert.equal(ejarModeOf(1), "enabled");
    assert.equal(ejarModeOf(0), "disabled");
    assert.equal(ejarModeOf(null), "default");
    assert.equal(ejarModeOf(undefined), "default");
    assert.equal(ejarEnvMode({}), "all");
    assert.equal(ejarEnvMode({ EJAR_ACCESS: " AllowList " }), "allowlist");
    assert.equal(ejarEnvMode({ EJAR_ACCESS: "nope" }), "off");
  });
});
