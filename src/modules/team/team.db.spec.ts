import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { ALL_PERMISSIONS, EMPLOYEE_PRESETS, PERMISSIONS, ROLE_PRESETS } from "../../common/permissions";
import { TeamService } from "./team.service";

/**
 * Team management against a real Postgres (the finance-v2 harness: a
 * throwaway schema on FV2_TEST_DATABASE_URL, localhost only). Nothing is
 * emailed: the EmailService is a stub that records calls.
 *
 *   FV2_TEST_DATABASE_URL=postgres://localhost:5432/<scratch db> pnpm test
 */
describe("team management — privilege escalation (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let team: TeamService;
  const q = (s: string, p: unknown[] = []) => t.pool.query(s, p).then((r) => r.rows);
  const roleId: Record<string, number> = {};
  let holder = 0, otherHolder = 0, gm = 0, weakMgr = 0, accountant = 0, strangerEmp = 0;
  let n = 0;
  const mail = () => `e${++n}@rbac.test`;

  const asHolder = () => ({ id: holder, email: "", role: "user", ownerUserId: null, ownerScopeId: null, permissions: ROLE_PRESETS.user }) as any;
  const asGm = () => ({ id: gm, email: "", role: "general", ownerUserId: holder, ownerScopeId: null, permissions: EMPLOYEE_PRESETS.general.permissions }) as any;
  const weakPerms = [PERMISSIONS.TEAM_MANAGE, PERMISSIONS.CONTRACTS_VIEW, PERMISSIONS.TENANTS_VIEW];
  const asWeak = () => ({ id: weakMgr, email: "", role: "emp_custom", ownerUserId: holder, ownerScopeId: null, permissions: weakPerms }) as any;

  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    team = new TeamService(drizzle(t.pool, { schema }) as any, { sendVerifyEmail: async () => {} } as any);
    const presets: Record<string, readonly string[]> = {
      super_admin: ALL_PERMISSIONS, admin: ROLE_PRESETS.admin, user: ROLE_PRESETS.user, demo: ROLE_PRESETS.demo,
      ...Object.fromEntries(Object.entries(EMPLOYEE_PRESETS).map(([k, d]) => [k, d.permissions])),
    };
    for (const [key, perms] of Object.entries(presets)) {
      const [r] = await q(`insert into roles (key, label_ar, label_en, permissions, is_system) values ($1, $1, $1, $2::jsonb, true) returning id`, [key, JSON.stringify(perms)]);
      roleId[key] = r.id;
    }
    const [h] = await q(`insert into users (email, password_hash, name, role_id, package_plan) values ('h@rbac.test', 'x', 'Holder', $1, 'enterprise') returning id`, [roleId.user]);
    holder = h.id;
    const [h2] = await q(`insert into users (email, password_hash, name, role_id, package_plan) values ('h2@rbac.test', 'x', 'Other', $1, 'enterprise') returning id`, [roleId.user]);
    otherHolder = h2.id;
    const emp = async (email: string, rid: number, owner = holder) =>
      (await q(`insert into users (email, password_hash, name, role_id, owner_user_id) values ($1, 'x', $1, $2, $3) returning id`, [email, rid, owner]))[0].id;
    gm = await emp("gm@rbac.test", roleId.general);
    const [weakRole] = await q(`insert into roles (key, label_ar, label_en, permissions, company_id) values ('emp_custom_x', 'c', 'c', $1::jsonb, 77) returning id`, [JSON.stringify(weakPerms)]);
    weakMgr = await emp("weak@rbac.test", weakRole.id);
    accountant = await emp("acc@rbac.test", roleId.accountant);
    strangerEmp = await emp("stranger@rbac.test", roleId.accountant, otherHolder);
  });
  after(async () => { await t?.drop(); });

  it("refuses platform and owner roles as an employee preset", async () => {
    for (const preset of ["super_admin", "admin", "user", "demo", "emp_custom_x", "", undefined]) {
      await assert.rejects(team.createEmployee(asHolder(), { name: "x", email: mail(), preset: preset as any }), BadRequestException, String(preset));
    }
    await assert.rejects(team.updateEmployee(asHolder(), accountant, { preset: "super_admin" }), BadRequestException);
    const [row] = await q(`select role_id from users where id = $1`, [accountant]);
    assert.equal(row.role_id, roleId.accountant);
  });

  it("files a GM-created employee under the ACCOUNT, not under the GM", async () => {
    const created = await team.createEmployee(asGm(), { name: "New", email: mail(), preset: "accountant" });
    assert.equal(created.ownerUserId, holder);
    assert.equal(created.roleId, roleId.accountant);
  });

  it("never grants platform keys through custom permissions; drops unknown strings", async () => {
    await assert.rejects(team.updateEmployeePermissions(asHolder(), accountant, [PERMISSIONS.ADMIN_USERS]), ForbiddenException);
    await assert.rejects(team.updateEmployeePermissions(asHolder(), accountant, [PERMISSIONS.ADMIN_ROLES, PERMISSIONS.CONTRACTS_VIEW]), ForbiddenException);
    const out = await team.updateEmployeePermissions(asHolder(), accountant, [PERMISSIONS.CONTRACTS_VIEW, "payments.*", "nonsense"]);
    const [r] = await q(`select permissions from roles where id = $1`, [out.roleId]);
    assert.deepEqual(r.permissions, [PERMISSIONS.CONTRACTS_VIEW]);
  });

  it("clamps an employee manager to what they hold", async () => {
    // accountant preset carries payments/invoices/expenses — the weak manager has none of them.
    await assert.rejects(team.createEmployee(asWeak(), { name: "x", email: mail(), preset: "accountant" }), ForbiddenException);
    await assert.rejects(team.updateEmployeePermissions(asWeak(), accountant, [PERMISSIONS.CONTRACTS_DELETE]), ForbiddenException);
    // …and may not touch someone stronger than themselves (the GM).
    await assert.rejects(team.updateEmployee(asWeak(), gm, { isActive: false }), ForbiddenException);
    await assert.rejects(team.deleteEmployee(asWeak(), gm), ForbiddenException);
    await assert.rejects(team.resetEmployeePassword(asWeak(), gm, "secret123"), ForbiddenException);
  });

  it("refuses self-promotion and self-edits of role", async () => {
    await assert.rejects(team.updateEmployee(asWeak(), weakMgr, { preset: "general" }), ForbiddenException);
    await assert.rejects(team.updateEmployeePermissions(asWeak(), weakMgr, [...weakPerms, PERMISSIONS.SUBSCRIPTION_MANAGE]), ForbiddenException);
    await assert.rejects(team.updateEmployee(asGm(), gm, { preset: "general" }), ForbiddenException);
    await assert.rejects(team.deleteEmployee(asGm(), gm), ForbiddenException);
  });

  it("never lets an employee touch the account holder", async () => {
    await assert.rejects(team.updateEmployee(asGm(), holder, { isActive: false }), NotFoundException);
    await assert.rejects(team.deleteEmployee(asGm(), holder), NotFoundException);
    await assert.rejects(team.resetEmployeePassword(asGm(), holder, "secret123"), NotFoundException);
    await assert.rejects(team.updateEmployeePermissions(asGm(), holder, []), NotFoundException);
    const [h] = await q(`select is_active, deleted_at, role_id from users where id = $1`, [holder]);
    assert.equal(h.is_active, true);
    assert.equal(h.deleted_at, null);
    assert.equal(h.role_id, roleId.user);
  });

  it("keeps accounts apart", async () => {
    await assert.rejects(team.updateEmployee(asHolder(), strangerEmp, { name: "pwn" }), NotFoundException);
    await assert.rejects(team.deleteEmployee(asGm(), strangerEmp), NotFoundException);
    const list = await team.listEmployees(asGm()) as any[];
    assert.ok(list.every((u) => u.id === holder || u.ownerUserId === holder));
    assert.ok(!list.some((u) => u.id === strangerEmp || u.id === otherHolder));
  });

  it("refuses owner-mobile tokens outright", async () => {
    const ownerTok = { id: holder, email: "", role: "owner", ownerUserId: null, ownerScopeId: 5, permissions: [] } as any;
    await assert.rejects(team.listEmployees(ownerTok), ForbiddenException);
    await assert.rejects(team.createEmployee(ownerTok, { name: "x", email: mail(), preset: "accountant" }), ForbiddenException);
  });

  it("ends a deactivated or removed employee's sessions", async () => {
    const [before] = await q(`select token_version from users where id = $1`, [accountant]);
    await team.updateEmployee(asHolder(), accountant, { isActive: false });
    const [after] = await q(`select token_version, is_active from users where id = $1`, [accountant]);
    assert.equal(after.is_active, false);
    assert.equal(after.token_version, (before.token_version ?? 0) + 1);
  });

  it("marks which presets an employee manager may hand out", async () => {
    const weak = await team.rolePresets(asWeak());
    assert.ok(weak.every((p) => p.assignable === false), "the weak manager can grant no full preset");
    const all = await team.rolePresets(asHolder());
    assert.ok(all.length > 0 && all.every((p) => p.assignable));
  });
});
