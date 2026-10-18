import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { SuperAdminGuard } from "./guards/roles.guard";
import {
  ANY_PERMISSIONS_META, FV2_OWNER_SCOPE_META, OWNER_TOKEN_META, PERMISSIONS_META, PermissionsGuard,
} from "./permissions.decorator";
import { EMPLOYEE_PRESETS, PERMISSIONS, ROLE_PRESETS } from "./permissions";
import { EMPLOYEE_ASSIGNABLE, exceeding, knownPermissions, teamCeiling } from "./rbac";

/** A drizzle stand-in: any chain of builder calls resolves to `rows`. */
function fakeDb(rows: any[]) {
  const chain: any = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? (res: any) => res(rows) : () => chain),
    apply: () => chain,
  });
  return chain;
}

function ctx(meta: Record<string, unknown>, req: any) {
  const handler = () => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as any;
}

const jwt = (decoded: any) => ({ verify: () => decoded }) as any;
const bearer = { headers: { authorization: "Bearer t" } };

describe("JwtAuthGuard — owner-mobile tokens", () => {
  const ownerRow = [{ id: 7, userId: 10, holderActive: true }];
  it("refuses an owner token on a route that does not opt in", async () => {
    const g = new JwtAuthGuard(jwt({ kind: "owner", ownerId: 7, id: 10 }), fakeDb(ownerRow), new Reflector());
    await assert.rejects(g.canActivate(ctx({}, { ...bearer })), ForbiddenException);
  });
  it("lets it through where the route opts in (either marker), narrowed and permission-less", async () => {
    for (const meta of [{ [OWNER_TOKEN_META]: true }, { [FV2_OWNER_SCOPE_META]: true }]) {
      const req: any = { ...bearer };
      const g = new JwtAuthGuard(jwt({ kind: "owner", ownerId: 7, id: 10 }), fakeDb(ownerRow), new Reflector());
      assert.equal(await g.canActivate(ctx(meta, req)), true);
      assert.equal(req.user.ownerScopeId, 7);
      assert.deepEqual(req.user.permissions, []);
    }
  });
  it("shuts out an owner token once the managing account is suspended", async () => {
    const g = new JwtAuthGuard(jwt({ kind: "owner", ownerId: 7, id: 10 }), fakeDb([{ ...ownerRow[0], holderActive: false }]), new Reflector());
    await assert.rejects(g.canActivate(ctx({ [OWNER_TOKEN_META]: true }, { ...bearer })), UnauthorizedException);
  });
});

describe("JwtAuthGuard — staff role keys are pinned", () => {
  // `holderId`/`holderActive` are the account holder's row, joined for employees.
  const row = (o: any) => [{ id: 1, tokenVersion: 0, isActive: true, ownerUserId: null, companyId: null, roleId: 3, roleKey: "user", roleCompanyId: null, rolePermissions: [], holderId: 9, holderActive: true, ...o }];
  const run = (o: any) => new JwtAuthGuard(jwt({ id: 1, kind: "user", tv: 0 }), fakeDb(row(o)), new Reflector()).canActivate(ctx({}, { ...bearer }));
  it("refuses super_admin on an employee row", async () => {
    await assert.rejects(run({ roleKey: "super_admin", ownerUserId: 9 }), ForbiddenException);
  });
  it("refuses a company-scoped role that calls itself admin", async () => {
    await assert.rejects(run({ roleKey: "admin", roleCompanyId: 4 }), ForbiddenException);
  });
  it("accepts real staff and ordinary employees", async () => {
    assert.equal(await run({ roleKey: "super_admin" }), true);
    assert.equal(await run({ roleKey: "accountant", ownerUserId: 9 }), true);
  });
  it("locks out a disabled account", async () => {
    await assert.rejects(run({ isActive: false }), UnauthorizedException);
  });
  it("locks out an employee of a suspended account", async () => {
    await assert.rejects(run({ ownerUserId: 9, holderActive: false }), UnauthorizedException);
  });
  it("locks out an employee whose account holder is gone", async () => {
    await assert.rejects(run({ ownerUserId: 9, holderId: null, holderActive: null }), UnauthorizedException);
  });
  it("does not consult a holder for a top-level account", async () => {
    assert.equal(await run({ ownerUserId: null, holderId: null, holderActive: null }), true);
  });
});

describe("SuperAdminGuard", () => {
  const g = new (SuperAdminGuard as any)();
  it("refuses an employee even when the key says super_admin", () => {
    assert.throws(() => g.canActivate(ctx({}, { user: { id: 2, role: "super_admin", ownerUserId: 1 } })), ForbiddenException);
    assert.throws(() => g.canActivate(ctx({}, { user: { id: 2, role: "super_admin", ownerScopeId: 3 } })), ForbiddenException);
    assert.equal(g.canActivate(ctx({}, { user: { id: 2, role: "super_admin", ownerUserId: null } })), true);
  });
});

describe("PermissionsGuard", () => {
  const g = new PermissionsGuard(new Reflector());
  const user = (permissions: string[], extra: any = {}) => ({ user: { id: 1, permissions, ...extra } });
  it("requires every listed key", () => {
    const meta = { [PERMISSIONS_META]: ["team.manage", "contracts.view"] };
    assert.throws(() => g.canActivate(ctx(meta, user(["team.manage"]))), ForbiddenException);
    assert.equal(g.canActivate(ctx(meta, user(["team.manage", "contracts.view"]))), true);
  });
  it("requires one of an any-of list", () => {
    const meta = { [ANY_PERMISSIONS_META]: ["units.write", "company.manage"] };
    assert.throws(() => g.canActivate(ctx(meta, user(["units.view"]))), ForbiddenException);
    assert.equal(g.canActivate(ctx(meta, user(["company.manage"]))), true);
  });
  it("passes an owner token only on an owner-token route", () => {
    const owner = user([], { ownerScopeId: 4 });
    assert.throws(() => g.canActivate(ctx({ [PERMISSIONS_META]: ["properties.view"] }, owner)), ForbiddenException);
    assert.equal(g.canActivate(ctx({ [PERMISSIONS_META]: ["properties.view"], [OWNER_TOKEN_META]: true }, owner)), true);
    // …and that does NOT relax the check for a user/employee on the same route.
    assert.throws(() => g.canActivate(ctx({ [PERMISSIONS_META]: ["properties.view"], [OWNER_TOKEN_META]: true }, user([]))), ForbiddenException);
  });
});

describe("team ceiling", () => {
  it("never contains platform keys", () => {
    for (const k of [PERMISSIONS.ADMIN_USERS, PERMISSIONS.ADMIN_ROLES, PERMISSIONS.ADMIN_DASHBOARD, PERMISSIONS.ADMIN_DEMO]) {
      assert.ok(!EMPLOYEE_ASSIGNABLE.has(k), k);
    }
  });
  it("is everything assignable for the account holder, and only what they hold for an employee", () => {
    assert.equal(teamCeiling({ ownerUserId: null, permissions: [] }).size, EMPLOYEE_ASSIGNABLE.size);
    const emp = teamCeiling({ ownerUserId: 1, permissions: ["team.manage", "contracts.view", "admin.users"] });
    assert.deepEqual([...emp].sort(), ["contracts.view", "team.manage"]);
    assert.equal(teamCeiling({ ownerScopeId: 3, ownerUserId: null }).size, 0);
  });
  it("lets the holder hand out every employee preset", () => {
    const c = teamCeiling({ ownerUserId: null });
    for (const [k, d] of Object.entries(EMPLOYEE_PRESETS)) assert.deepEqual(exceeding(d.permissions, c), [], k);
  });
  it("gives the account-holder presets the new management keys; demo stays read-only", () => {
    for (const k of [PERMISSIONS.TEAM_MANAGE, PERMISSIONS.COMPANY_MANAGE]) {
      assert.ok(ROLE_PRESETS.user.includes(k));
      assert.ok(EMPLOYEE_PRESETS.general.permissions.includes(k));
      assert.ok(!ROLE_PRESETS.demo.includes(k));
      for (const [key, d] of Object.entries(EMPLOYEE_PRESETS)) if (key !== "general") assert.ok(!d.permissions.includes(k), key);
    }
  });
  it("keeps catalog keys only", () => {
    assert.deepEqual(knownPermissions(["contracts.view", "contracts.view", "x.y", 3, " units.view "]), ["contracts.view", "units.view"]);
  });
});
