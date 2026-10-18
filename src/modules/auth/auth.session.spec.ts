import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { ConflictException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { getTableName, is, SQL } from "drizzle-orm";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { TenantAuthGuard } from "../../common/guards/tenant-auth.guard";
import { SESSION_REPLACED_CODE, SESSION_REVOKED_CODE, SESSION_REVOKED_MESSAGE, staleSessionException } from "../../common/session";
import { EMAIL_TAKEN_CODE } from "../../common/user-email";

/**
 * A scripted Drizzle stand-in. Every awaited query is one "op" — its kind
 * (select / update / insert), the table it names, and the builder calls made
 * on it — and is answered from a per-"kind:table" queue (default: no rows).
 * Nothing touches a database; nothing sends a message (the email/SMS services
 * are stubs that only record).
 */
type Op = { kind: string; table: string; calls: Array<[string, unknown[]]> };
function fakeDb(script: Record<string, Array<unknown[] | Error>> = {}) {
  const ops: Op[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const start = (kind: string, table?: unknown) => {
    const op: Op = { kind, table: table ? getTableName(table as any) : "", calls: [] };
    ops.push(op);
    let settled: Promise<unknown> | null = null;
    const run = () => {
      if (!settled) {
        const next = queues.get(`${op.kind}:${op.table}`)?.shift() ?? [];
        settled = next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      return settled;
    };
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: any, rej: any) => run().then(res, rej);
        if (prop === "catch") return (rej: any) => run().catch(rej);
        if (prop === "finally") return (fn: any) => run().finally(fn);
        return (...args: unknown[]) => {
          if (prop === "from" && !op.table) op.table = getTableName(args[0] as any);
          op.calls.push([prop, args]);
          return chain;
        };
      },
    });
    return chain;
  };
  const db: any = {
    select: (..._a: unknown[]) => start("select"),
    update: (t: unknown) => start("update", t),
    insert: (t: unknown) => start("insert", t),
  };
  return { db, ops };
}

const jwt = new JwtService({ secret: "spec-secret" });
const noopEmail: any = new Proxy({}, { get: () => async () => true });
const okPhone: any = { check: async () => true, start: async () => undefined, normalizePhone: (p: string) => p };
const ctx = { ip: "127.0.0.1", ua: "spec" };

function service(db: any, phoneOtp: any = okPhone) {
  return new AuthService(db, jwt, {} as any, phoneOtp, noopEmail);
}
const setOf = (op: Op) => op.calls.find(([m]) => m === "set")?.[1][0] as Record<string, unknown>;
const isIncrement = (v: unknown) => is(v, SQL);

function guardCtx(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as any };
}

const USER = {
  id: 7, email: "owner@example.com", name: "Owner", phone: "502907100",
  isActive: true, accountStatus: "active", roleId: 1, ownerUserId: null, roleKey: "user",
  loginCount: 3, createdAt: new Date("2026-01-01"), companyId: null, companyName: null,
};

describe("login bumps tokenVersion — single active session", () => {
  it("phone OTP: one UPDATE bumps token_version + stamps last_login_at, and the token carries the NEW version", async () => {
    const { db, ops } = fakeDb({
      "select:users": [[USER]],
      "update:users": [[{ tokenVersion: 4 }]],
    });
    const res = await service(db).userPhoneVerifyOtp({ phone: "0502907100", code: "1234" }, ctx);

    const updates = ops.filter((o) => o.kind === "update" && o.table === "users");
    assert.equal(updates.length, 1, "exactly one users UPDATE for the login");
    const set = setOf(updates[0]!);
    assert.ok(isIncrement(set.tokenVersion), "tokenVersion is bumped in SQL, not computed client-side");
    assert.ok(set.lastLoginAt instanceof Date);
    assert.ok(updates[0]!.calls.some(([m]) => m === "returning"), "the new version comes back from the same statement");

    const claims = jwt.verify<any>(res.token);
    assert.equal(claims.tv, 4);
    assert.equal(claims.kind, "user");
    assert.equal(claims.loginAt, (set.lastLoginAt as Date).getTime());
  });

  it("email OTP: same bump, plus login_count", async () => {
    const codeHash = await bcrypt.hash("482913", 4);
    const { db, ops } = fakeDb({
      "select:email_otp_tokens": [[{ id: 1, codeHash, attempts: 0 }]],
      "select:users": [[USER]],
      "update:users": [[{ tokenVersion: 12 }]],
    });
    const res = await service(db).verifyEmailOtp({ email: "  Owner@Example.com ", code: "482913" }, ctx);

    const set = setOf(ops.find((o) => o.kind === "update" && o.table === "users")!);
    assert.ok(isIncrement(set.tokenVersion));
    assert.ok(isIncrement(set.loginCount));
    assert.equal(jwt.verify<any>(res.token).tv, 12);
  });

  it("email OTP: a disabled account is refused and its session is not bumped", async () => {
    const codeHash = await bcrypt.hash("482913", 4);
    const { db, ops } = fakeDb({
      "select:email_otp_tokens": [[{ id: 1, codeHash, attempts: 0 }]],
      "select:users": [[{ ...USER, isActive: false, emailVerified: true }]],
    });
    await assert.rejects(service(db).verifyEmailOtp({ email: "owner@example.com", code: "482913" }, ctx), UnauthorizedException);
    assert.equal(ops.filter((o) => o.kind === "update" && o.table === "users").length, 0, "no token_version bump");
  });

  it("email OTP: an unverified employee and a pending account are refused", async () => {
    for (const row of [{ ...USER, ownerUserId: 3, emailVerified: false }, { ...USER, accountStatus: "pending", emailVerified: true }]) {
      const codeHash = await bcrypt.hash("482913", 4);
      const { db, ops } = fakeDb({ "select:email_otp_tokens": [[{ id: 1, codeHash, attempts: 0 }]], "select:users": [[row]] });
      await assert.rejects(service(db).verifyEmailOtp({ email: "owner@example.com", code: "482913" }, ctx), ForbiddenException);
      assert.equal(ops.filter((o) => o.kind === "update" && o.table === "users").length, 0);
    }
  });

  it("a failed code bumps nothing", async () => {
    const { db, ops } = fakeDb({ "select:users": [[USER]] });
    const badPhone = { ...okPhone, check: async () => false };
    await assert.rejects(service(db, badPhone).userPhoneVerifyOtp({ phone: "0502907100", code: "0000" }, ctx), UnauthorizedException);
    assert.equal(ops.filter((o) => o.kind === "update" && o.table === "users").length, 0);
  });

  it("tenant OTP: bumps tenants.token_version the same way", async () => {
    const { db, ops } = fakeDb({
      "select:tenants": [[{ id: 3, phone: "501111111", status: "active", tokenVersion: 0, name: "T" }]],
      "update:tenants": [[{ tokenVersion: 1 }]],
    });
    const res = await service(db).tenantVerifyOtp({ phone: "0501111111", code: "1234" }, ctx);
    const set = setOf(ops.find((o) => o.kind === "update" && o.table === "tenants")!);
    assert.ok(isIncrement(set.tokenVersion));
    const claims = jwt.verify<any>(res.token);
    assert.equal(claims.tv, 1);
    assert.equal(claims.kind, "tenant");
  });
});

describe("the guard tells 'signed in elsewhere' from 'revoked'", () => {
  const firstLogin = new Date("2026-10-18T08:00:00.000Z");
  const secondLogin = new Date("2026-10-18T09:30:00.000Z");
  const oldToken = jwt.sign({ id: 7, email: USER.email, role: "user", kind: "user", tv: 4, loginAt: firstLogin.getTime() });
  const newToken = jwt.sign({ id: 7, email: USER.email, role: "user", kind: "user", tv: 5, loginAt: secondLogin.getTime() });
  const row = (tokenVersion: number, lastLoginAt: Date) => ({
    id: 7, tokenVersion, lastLoginAt, isActive: true, ownerUserId: null, companyId: null, roleId: 1, roleKey: "user", rolePermissions: [],
  });

  it("old device after a second login: 401 SESSION_REPLACED, message still starts with the old text", async () => {
    const { db } = fakeDb({ "select:users": [[row(5, secondLogin)]] });
    const g = new JwtAuthGuard(jwt, db);
    await assert.rejects(g.canActivate(guardCtx(oldToken).ctx), (e: unknown) => {
      assert.ok(e instanceof UnauthorizedException);
      const body = e.getResponse() as any;
      assert.equal(body.statusCode, 401);
      assert.equal(body.code, SESSION_REPLACED_CODE);
      assert.equal(body.error, SESSION_REPLACED_CODE);
      assert.ok(String(body.message).startsWith(SESSION_REVOKED_MESSAGE));
      return true;
    });
  });

  it("the new device passes", async () => {
    const { db } = fakeDb({ "select:users": [[row(5, secondLogin)]] });
    const { req, ctx: c } = guardCtx(newToken);
    assert.equal(await new JwtAuthGuard(jwt, db).canActivate(c), true);
    assert.equal(req.user.id, 7);
  });

  it("logout / force-logout (version bumped, no later login): 401 SESSION_REVOKED", async () => {
    const { db } = fakeDb({ "select:users": [[row(5, firstLogin)]] });
    await assert.rejects(new JwtAuthGuard(jwt, db).canActivate(guardCtx(oldToken).ctx), (e: unknown) => {
      const body = (e as UnauthorizedException).getResponse() as any;
      assert.equal(body.code, SESSION_REVOKED_CODE);
      assert.equal(body.message, SESSION_REVOKED_MESSAGE);
      return true;
    });
  });

  it("a disabled account is still refused before the version check", async () => {
    const { db } = fakeDb({ "select:users": [[{ ...row(4, firstLogin), isActive: false }]] });
    await assert.rejects(new JwtAuthGuard(jwt, db).canActivate(guardCtx(oldToken).ctx), /Account disabled/);
  });

  it("a pre-change token (no loginAt) falls back to iat with a 1s margin", () => {
    const iat = Math.floor(firstLogin.getTime() / 1000);
    // Same-second last_login_at is this token's own login, not a later one.
    assert.equal((staleSessionException({ tv: 1, iat }, { tokenVersion: 2, lastLoginAt: new Date(firstLogin.getTime() + 400) }).getResponse() as any).code, SESSION_REVOKED_CODE);
    assert.equal((staleSessionException({ tv: 1, iat }, { tokenVersion: 2, lastLoginAt: secondLogin }).getResponse() as any).code, SESSION_REPLACED_CODE);
  });

  it("tenant guard: the same distinction", async () => {
    const t = jwt.sign({ id: 3, phone: "501111111", kind: "tenant", tv: 1, loginAt: firstLogin.getTime() });
    const { db } = fakeDb({ "select:tenants": [[{ id: 3, tokenVersion: 2, lastLoginAt: secondLogin, status: "active", deletedAt: null }]] });
    await assert.rejects(new TenantAuthGuard(jwt, db).canActivate(guardCtx(t).ctx), (e: unknown) => {
      assert.equal(((e as UnauthorizedException).getResponse() as any).code, SESSION_REPLACED_CODE);
      return true;
    });
  });
});

describe("register — one email, one account", () => {
  const input = { email: "  New.Owner@Example.COM ", name: "New", phone: "0502907100" };

  it("stores the trimmed lower-case address", async () => {
    const { db, ops } = fakeDb({
      "insert:users": [[{ id: 50, email: "new.owner@example.com", name: "New", accountStatus: "pending" }]],
    });
    await service(db).register(input);
    const ins = ops.find((o) => o.kind === "insert" && o.table === "users")!;
    const values = ins.calls.find(([m]) => m === "values")![1][0] as any;
    assert.equal(values.email, "new.owner@example.com");
  });

  it("409 EMAIL_TAKEN when any row (live or soft-deleted) has it, and nothing is inserted", async () => {
    const { db, ops } = fakeDb({ "select:users": [[{ id: 9 }]] });
    await assert.rejects(service(db).register(input), (e: unknown) => {
      assert.ok(e instanceof ConflictException);
      assert.equal((e.getResponse() as any).error, EMAIL_TAKEN_CODE);
      return true;
    });
    assert.equal(ops.filter((o) => o.kind === "insert").length, 0);
  });

  it("a lost race (unique violation on insert) is the same 409, not a 500", async () => {
    const raced = Object.assign(new Error("Failed query"), { cause: { code: "23505", constraint: "users_email_lower_unique" } });
    const { db } = fakeDb({ "insert:users": [raced] });
    await assert.rejects(service(db).register(input), ConflictException);
  });
});

describe("team: adding an employee — one email, one account", () => {
  const actor = { id: 1, ownerUserId: null, packagePlan: "enterprise", companyId: null };
  // The account holder making the request (TeamService takes the AuthUser).
  const caller = { id: 1, email: "", role: "user", ownerUserId: null, permissions: [] };

  it("409 EMAIL_TAKEN when the address belongs to any other user, nothing inserted", async () => {
    const { TeamService } = await import("../team/team.service");
    // actor lookup, seat count, then the email check.
    const { db, ops } = fakeDb({ "select:users": [[actor], [{ c: 1 }], [{ id: 9 }]] });
    const team = new TeamService(db, noopEmail);
    await assert.rejects(team.createEmployee(caller, { name: "E", email: " Someone@Example.com", preset: "accountant" }), (e: unknown) => {
      assert.ok(e instanceof ConflictException);
      assert.equal((e.getResponse() as any).error, EMAIL_TAKEN_CODE);
      return true;
    });
    assert.equal(ops.filter((o) => o.kind === "insert").length, 0);
  });

  it("stores the normalised address when it is free", async () => {
    const { TeamService } = await import("../team/team.service");
    const { db, ops } = fakeDb({
      "select:users": [[actor], [{ c: 1 }], []],
      "select:roles": [[{ id: 4 }]],
      "insert:users": [[{ id: 60, email: "someone@example.com", name: "E" }]],
    });
    await new TeamService(db, noopEmail).createEmployee(caller, { name: "E", email: " Someone@Example.com", preset: "accountant" });
    const values = ops.find((o) => o.kind === "insert" && o.table === "users")!.calls.find(([m]) => m === "values")![1][0] as any;
    assert.equal(values.email, "someone@example.com");
  });
});
