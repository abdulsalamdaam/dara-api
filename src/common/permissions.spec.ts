import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_PERMISSIONS,
  EMPLOYEE_PRESETS,
  PERMISSIONS,
  ROLE_PRESETS,
  effectivePermissions,
} from "./permissions";

/**
 * `effectivePermissions` used to return a stored custom array verbatim, so the
 * role preset was documentation rather than a limit. The clamp is what makes
 * the sentence "ROLE_PRESETS.user is the upper bound" true. These cases pin
 * the direction of the intersection — a clamp that intersects the wrong way
 * round (custom ∩ custom) looks identical in the happy path and grants
 * everything in the case that matters.
 */
describe("effectivePermissions — the preset is a ceiling", () => {
  it("drops a custom permission the role's preset does not contain", () => {
    // The concrete escalation: a `user`-role row whose stored array claims
    // platform administration, or the right to move a seller's ZATCA link to
    // production. Both are outside ROLE_PRESETS.user and both used to be
    // honoured in full.
    const custom = [
      PERMISSIONS.CONTRACTS_VIEW,
      PERMISSIONS.ADMIN_USERS,
      PERMISSIONS.ZATCA_PROMOTE_PRODUCTION,
    ];
    const out = effectivePermissions("user", custom);
    assert.ok(out.includes(PERMISSIONS.CONTRACTS_VIEW));
    assert.ok(!out.includes(PERMISSIONS.ADMIN_USERS));
    // ZATCA_PROMOTE_PRODUCTION happens to be inside ROLE_PRESETS.user, so it
    // survives — the clamp is not a blocklist of scary strings, it is the
    // preset. Stated explicitly so a reader does not mistake this for a bug.
    assert.ok(out.includes(PERMISSIONS.ZATCA_PROMOTE_PRODUCTION));
  });

  it("cannot be widened past a demo account's read-only preset", () => {
    // `demo` is the account type most likely to be handed to a stranger.
    const out = effectivePermissions("demo", [...ALL_PERMISSIONS]);
    assert.deepEqual(out, ROLE_PRESETS.demo);
    assert.ok(!out.includes(PERMISSIONS.CONTRACTS_DELETE));
  });

  it("keeps a legitimate subset intact", () => {
    // The normal case: a trimmed employee list. Nothing may be ADDED by the
    // clamp either — a clamp that returned the preset whenever the custom
    // array was non-empty would silently promote every employee to full
    // account access.
    const custom = [PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.CONTRACTS_VIEW];
    assert.deepEqual(new Set(effectivePermissions("user", custom)), new Set(custom));
  });

  it("falls back to the whole preset when there is no custom array", () => {
    assert.deepEqual(effectivePermissions("user", null), ROLE_PRESETS.user);
    assert.deepEqual(effectivePermissions("user"), ROLE_PRESETS.user);
    // An EMPTY array is a real answer — "this principal holds nothing" — and
    // must not be confused with "no custom array was stored".
    assert.deepEqual(effectivePermissions("user", []), []);
  });

  it("de-duplicates and ignores strings that are not permissions at all", () => {
    const out = effectivePermissions("user", [
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PAYMENTS_VIEW,
      "payments.*",
      "",
    ] as string[]);
    assert.deepEqual(out, [PERMISSIONS.PAYMENTS_VIEW]);
  });
});

/**
 * The employee presets are copied into `roles.permissions` by `bootstrap.ts`,
 * and `JwtAuthGuard` reads permissions from that table — so they do NOT pass
 * through the clamp today. This test exists because the moment they do, any
 * preset permission outside `ROLE_PRESETS.user` is silently stripped from
 * working accounts, and it should fail here rather than in production.
 */
describe("EMPLOYEE_PRESETS versus the user ceiling", () => {
  const ceiling = new Set<string>(ROLE_PRESETS.user);

  it("has exactly one known permission outside ROLE_PRESETS.user", () => {
    const outside = new Set<string>();
    for (const def of Object.values(EMPLOYEE_PRESETS)) {
      for (const p of def.permissions) if (!ceiling.has(p)) outside.add(p);
    }
    // `support.respond` — held by `general` (General Manager) and
    // `customerService`, both of which legitimately answer the account's own
    // support tickets. FULL_TENANT_ADMIN grants only `support.view`.
    //
    // If this assertion fails because a NEW permission appeared, that is the
    // decision to make consciously: either widen FULL_TENANT_ADMIN (which also
    // grants it to every landlord account) or take it out of the preset.
    // Do not just add it to this list.
    assert.deepEqual([...outside], [PERMISSIONS.SUPPORT_RESPOND]);
  });

  it("names which presets carry it, so the blast radius is written down", () => {
    const carriers = Object.entries(EMPLOYEE_PRESETS)
      .filter(([, def]) => def.permissions.includes(PERMISSIONS.SUPPORT_RESPOND))
      .map(([key]) => key);
    assert.deepEqual(carriers.sort(), ["customerService", "general"]);
  });
});
