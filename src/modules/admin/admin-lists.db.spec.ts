import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { AdminModule, phoneCoreLike } from "./admin.module";
import { SupportModule } from "../support/support.module";

/**
 * The admin lists against a real Postgres (the finance-v2 harness: a throwaway
 * schema on FV2_TEST_DATABASE_URL, localhost only).
 *
 *   FV2_TEST_DATABASE_URL=postgres://postgres@localhost:55432/fv2_test pnpm test
 */
const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];

describe("phoneCoreLike", () => {
  it("reduces any spelling of a Saudi mobile to its national core", () => {
    for (const v of ["0501234567", "966501234567", "+966 50 123 4567", "00966501234567"]) {
      assert.equal(phoneCoreLike(v), "%501234567%", v);
    }
  });
  it("leaves non-numbers to the plain search (escaped)", () => {
    assert.equal(phoneCoreLike("ali_%"), "%ali\\_\\%%");
  });
});

describe("admin lists (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let admin: any;
  let support: any;
  let acct = 0;

  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    const db = drizzle(t.pool, { schema });
    const Admin = ctl(AdminModule);
    admin = new Admin(db, null, null, null, null, null, null);
    const Support = ctl(SupportModule);
    support = new Support(db, { sendSupportReply: async () => {} });

    const q = (s: string, p: unknown[] = []) => t.pool.query(s, p).then((r) => r.rows);
    const [role] = await q(`insert into roles (key, label_ar, label_en, permissions) values ('user', 'u', 'u', '[]') returning id`);
    const [u] = await q(`insert into users (email, password_hash, name, phone, role_id, package_plan)
      values ('a@x.test', 'x', 'Acme', '+966501234567', $1, 'professional') returning id`, [role.id]);
    acct = u.id;
    // An employee, one live and one soft-deleted.
    await q(`insert into users (email, password_hash, name, owner_user_id) values ('e1@x.test', 'x', 'E1', $1)`, [acct]);
    await q(`insert into users (email, password_hash, name, owner_user_id, deleted_at) values ('e2@x.test', 'x', 'E2', $1, now())`, [acct]);
    const [p1] = await q(`insert into properties (user_id, name) values ($1, 'P1') returning id`, [acct]);
    const [p2] = await q(`insert into properties (user_id, name, deleted_at) values ($1, 'P2', now()) returning id`, [acct]);
    await q(`insert into units (property_id, unit_number) values ($1, '1'), ($1, '2')`, [p1.id]);
    await q(`insert into units (property_id, unit_number, deleted_at) values ($1, '3', now())`, [p1.id]);
    await q(`insert into units (property_id, unit_number) values ($1, '9')`, [p2.id]);
    await q(`insert into contracts (user_id, contract_number, tenant_name, start_date, end_date, monthly_rent)
      values ($1, 'C1', 'T', '2026-01-01', '2026-12-31', 1000)`, [acct]);
    await q(`insert into contracts (user_id, contract_number, tenant_name, start_date, end_date, monthly_rent, deleted_at)
      values ($1, 'C2', 'T', '2026-01-01', '2026-12-31', 1000, now())`, [acct]);

    const [tk1] = await q(`insert into support_tickets (user_id, status, updated_at) values ($1, 'open', now() - interval '1 hour') returning id`, [acct]);
    const [tk2] = await q(`insert into support_tickets (user_id, status) values ($1, 'closed') returning id`, [acct]);
    await q(`insert into support_messages (ticket_id, sender_id, sender_role, message, created_at) values
      ($1, $3, 'user', 'first', now() - interval '2 hours'),
      ($1, $3, 'admin', 'latest reply', now() - interval '1 hour'),
      ($2, $3, 'user', 'only one', now())`, [tk1.id, tk2.id, acct]);
  });

  after(async () => { await t?.drop(); });

  it("companies carry the real package and count only live rows", async () => {
    const r = await admin.companies({ page: "1", pageSize: "25" });
    const c = r.data.find((x: any) => x.id === acct);
    assert.equal(c.plan, "professional");
    assert.equal(c.propertiesCount, 1, "deleted property not counted");
    assert.equal(c.unitsCount, 2, "deleted unit, and units of a deleted property, not counted");
    assert.equal(c.contractsCount, 1, "deleted contract not counted");
    assert.equal(c.employeesCount, 1);
  });

  it("company search matches a phone however it is typed, and escapes wildcards", async () => {
    for (const s of ["0501234567", "966501234567", "+966 50 123 4567", "acme"]) {
      const r = await admin.companies({ page: "1", search: s });
      assert.equal(r.total, 1, s);
    }
    assert.equal((await admin.companies({ page: "1", search: "%" })).total, 0, "% is literal");
  });

  it("overview stats ignore soft-deleted rows", async () => {
    const s = await admin.stats();
    assert.equal(s.totalProperties, 1);
    assert.equal(s.totalUnits, 3, "the deleted unit is out; the live unit of a deleted property is still a live row");
    assert.equal(s.totalContracts, 1);
    assert.equal(s.totalUsers, 2, "the account and its live employee");
  });

  it("support tickets carry their newest message (lateral join), and search escapes wildcards", async () => {
    const r = await support.list({ id: acct, role: "super_admin" }, { page: "1", pageSize: "10" });
    assert.equal(r.total, 2);
    const byStatus = Object.fromEntries(r.data.map((x: any) => [x.status, x]));
    assert.equal(byStatus.open.lastMessage, "latest reply");
    assert.equal(byStatus.closed.lastMessage, "only one");
    assert.ok(byStatus.open.lastMessageAt instanceof Date || typeof byStatus.open.lastMessageAt === "string");
    assert.equal((await support.list({ id: acct, role: "super_admin" }, { page: "1", search: "latest" })).total, 1);
    assert.equal((await support.list({ id: acct, role: "super_admin" }, { page: "1", search: "%" })).total, 0);
    assert.deepEqual(await support.openCount({ id: acct, role: "super_admin" }), { count: 1 });
  });
});
