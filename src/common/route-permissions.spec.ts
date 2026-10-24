import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { TenantAuthGuard } from "./guards/tenant-auth.guard";
import { SuperAdminGuard, AdminGuard } from "./guards/roles.guard";
import {
  ANY_PERMISSIONS_META, FV2_OWNER_SCOPE_META, OWNER_TOKEN_META, PERMISSIONS_META, PermissionsGuard,
} from "./permissions.decorator";
import { ALL_PERMISSIONS } from "./permissions";

/**
 * Every route in the app, walked from AppModule by reflection, must say who
 * may call it. A route passes when it is one of:
 *
 *   - public (no JwtAuthGuard) AND listed in PUBLIC below;
 *   - a tenant-app route (TenantAuthGuard — tenant tokens, not portal users);
 *   - platform staff only (SuperAdminGuard / AdminGuard);
 *   - permission-gated: `@RequirePermissions` / `@RequireAnyPermission` with
 *     PermissionsGuard running AFTER JwtAuthGuard;
 *   - Finance v2 capability-gated (`@RequireCapability`, FinanceV2Guard);
 *   - authenticated but deliberately open to every portal login, listed in
 *     OPEN with the reason.
 *
 * A new controller route that is none of these fails here — that is the
 * point: "forgot the decorator" was how most of the gaps in the Oct 2026
 * audit happened. The allowlists are checked for stale entries too.
 */

/** `METHOD /path` for routes that need no login at all. */
const PUBLIC: Record<string, string> = {
  "GET /healthz": "liveness probe",
  "POST /auth/login": "login",
  "POST /auth/email-otp/request": "login",
  "POST /auth/email-otp/verify": "login",
  "POST /auth/register": "self-registration",
  "POST /auth/verify-email": "email verification link",
  "POST /auth/verify-email-otp": "email verification code",
  "POST /auth/resend-verification": "email verification",
  "POST /auth/forgot-password": "password reset",
  "POST /auth/reset-password": "password reset",
  "POST /auth/tenant/request-otp": "tenant app login",
  "POST /auth/tenant/verify-otp": "tenant app login",
  "POST /auth/user/phone-otp/request": "landlord app login",
  "POST /auth/user/phone-otp/verify": "landlord app login",
  "GET /stats/public": "landing-page counters",
  "GET /public/trial": "landing-page trial offer",
  "POST /public/contact": "landing-page contact form",
  "POST /subscription/webhook": "Moyasar webhook (verified in the handler)",
};

/** Authenticated, but open to every portal login on purpose. */
const OPEN: Record<string, string> = {
  "GET /auth/me": "the caller's own profile",
  "GET /auth/me/permissions": "the caller's own permission list (the web gates its UI on it)",
  "POST /auth/logout": "end the caller's own sessions (no-op for owner tokens)",
  "POST /auth/me/change-password": "the caller's own password",
  "POST /auth/me/email-change/request": "the caller's own login email",
  "POST /auth/me/email-change/verify": "the caller's own login email",
  "GET /profile": "the caller's own profile",
  "PATCH /profile": "the caller's own name/phone only",
  "GET /me/package": "plan limits — every screen's quota hints read it",
  "POST /me/setup-complete": "dismiss the getting-started card (a UI flag)",
  "GET /me/subscription": "subscription status — the expiry gate shows for every login",
  "GET /companies/me": "the account's company name/logo for headers and documents",
  "GET /lookups": "dropdown reference data every form needs",
  "GET /dashboard/summary": "landing dashboard aggregates (follow-up: redact money without payments.view)",
  "GET /news": "industry news feed",
  "GET /news/summary": "industry news feed",
  "GET /audit": "account holder only — refused for employees in the handler",
  "GET /support/tickets": "the caller's own tickets to Dara (staff see all by role)",
  "GET /support/tickets/open-count": "staff badge; 0 for customers",
  "POST /support/tickets": "open a ticket with Dara support",
  "GET /support/tickets/:id/messages": "own ticket only (checked in the handler)",
  "POST /support/tickets/:id/messages": "own ticket only (checked in the handler)",
  "POST /uploads": "files land under the caller's own scope prefix",
  "GET /uploads/sign": "key access checked against the caller's scope",
  "POST /uploads/sign-batch": "key access checked against the caller's scope",
  "POST /uploads/presign": "key minted under the caller's own scope prefix",
  "DELETE /uploads": "key access checked against the caller's scope",
  "GET /ejar/manual-add-policy": "whether manual entry is enabled (global flag)",
  "GET /ejar/locks": "which form fields are read-only for an imported record (scoped)",
  "GET /landlord/me/profile": "landlord app: the caller's own identity",
  "POST /landlord/me/fcm-token": "landlord app: own device push token",
  "DELETE /landlord/me/fcm-token": "landlord app: own device push token",
  "GET /landlord/me/summary": "landlord app home aggregates (same as /dashboard/summary)",
  "GET /landlord/me/recent-activity": "landlord app home feed",
  "GET /finance/v2/status": "whether the Finance v2 beta is on for the account",
  "POST /finance/v2/posting-errors/:id/retry": "capability approve|money checked inline",
  "GET /finance/v2/reports/landlord-statement": "capability view checked inline; owner tokens narrowed",
};

/** Routes an owner-mobile token may reach. Adding one is a deliberate act. */
const OWNER_TOKEN_ROUTES = new Set([
  "POST /auth/logout",
  "GET /finance/v2/reports/landlord-statement",
]);
const OWNER_TOKEN_PREFIX = "/landlord/me";

type Route = {
  key: string; module: string; controller: string; handler: string;
  guards: any[]; perms: string[]; anyPerms: string[]; capability?: string; ownerToken: boolean;
};

function collectRoutes(AppModule: any): Route[] {
  const seen = new Set<any>();
  const ctrls: Array<[string, any]> = [];
  const visit = (m: any) => {
    if (!m) return;
    if (typeof m === "object" && typeof m.forwardRef === "function") m = m.forwardRef();
    if (typeof m === "object" && m.module) {
      visit(m.module);
      for (const i of m.imports ?? []) visit(i);
      for (const c of m.controllers ?? []) ctrls.push([m.module.name, c]);
      return;
    }
    if (seen.has(m)) return;
    seen.add(m);
    for (const c of Reflect.getMetadata("controllers", m) ?? []) ctrls.push([m.name, c]);
    for (const i of Reflect.getMetadata("imports", m) ?? []) visit(i);
  };
  visit(AppModule);

  const out: Route[] = [];
  for (const [module, C] of ctrls) {
    const base = [].concat(Reflect.getMetadata(PATH_METADATA, C) ?? "").join("");
    const classGuards = Reflect.getMetadata(GUARDS_METADATA, C) ?? [];
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      if (name === "constructor") continue;
      const h = C.prototype[name];
      if (typeof h !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, h);
      const sub = Reflect.getMetadata(PATH_METADATA, h);
      if (method === undefined || sub === undefined) continue;
      const path = `/${base}/${[].concat(sub).join("")}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
      const pick = (k: string) => Reflect.getMetadata(k, h) ?? Reflect.getMetadata(k, C);
      out.push({
        key: `${RequestMethod[method]} ${path}`,
        module, controller: C.name, handler: name,
        guards: [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, h) ?? [])],
        perms: pick(PERMISSIONS_META) ?? [],
        anyPerms: pick(ANY_PERMISSIONS_META) ?? [],
        capability: pick("fv2:capability"),
        ownerToken: !!(pick(OWNER_TOKEN_META) || pick(FV2_OWNER_SCOPE_META)),
      });
    }
  }
  return out;
}

describe("route inventory — every route says who may call it", () => {
  let routes: Route[] = [];
  before(async () => {
    // Importing the app graph needs a syntactically valid URL; nothing connects.
    process.env.DATABASE_URL ??= "postgres://rbac:spec@127.0.0.1:1/none";
    const { AppModule } = await import("../app.module");
    routes = collectRoutes(AppModule);
  });

  const name = (r: Route) => `${r.key}  (${r.controller}.${r.handler})`;
  const has = (r: Route, g: any) => r.guards.includes(g);
  const isStaff = (r: Route) => has(r, SuperAdminGuard) || has(r, AdminGuard);
  const isFv2 = (r: Route) => r.guards.some((g) => g?.name === "FinanceV2Guard");

  it("found the app's routes", () => {
    assert.ok(routes.length > 300, `only ${routes.length} routes found — the walk is broken`);
  });

  it("has no route that is neither public, tenant, staff, permission-gated, capability-gated nor allowlisted", () => {
    const bad: string[] = [];
    for (const r of routes) {
      const jwt = has(r, JwtAuthGuard);
      if (!jwt) {
        if (has(r, TenantAuthGuard) || PUBLIC[r.key]) continue;
        bad.push(`${name(r)} — no JwtAuthGuard and not in PUBLIC`);
        continue;
      }
      if (isStaff(r)) continue;
      if (r.perms.length || r.anyPerms.length) continue;
      if (r.capability && isFv2(r)) continue;
      if (OPEN[r.key]) continue;
      bad.push(`${name(r)} — authenticated but no @RequirePermissions (add one, or justify it in OPEN)`);
    }
    assert.deepEqual(bad, []);
  });

  it("runs PermissionsGuard after JwtAuthGuard wherever a permission is required", () => {
    const bad: string[] = [];
    for (const r of routes) {
      if (!r.perms.length && !r.anyPerms.length) continue;
      const j = r.guards.indexOf(JwtAuthGuard);
      const p = r.guards.indexOf(PermissionsGuard);
      if (j < 0 || p < 0 || p < j) bad.push(name(r));
    }
    assert.deepEqual(bad, []);
  });

  it("only names real permission keys", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    const bad = routes.flatMap((r) => [...r.perms, ...r.anyPerms].filter((p) => !known.has(p)).map((p) => `${name(r)}: ${p}`));
    assert.deepEqual(bad, []);
  });

  it("lets owner-mobile tokens reach only the landlord app routes and the reviewed list", () => {
    const bad = routes
      .filter((r) => r.ownerToken && !r.key.split(" ")[1]!.startsWith(OWNER_TOKEN_PREFIX) && !OWNER_TOKEN_ROUTES.has(r.key))
      .map(name);
    assert.deepEqual(bad, []);
    // …and every /landlord/me route does accept them (the mobile app's audience).
    const missing = routes.filter((r) => r.key.split(" ")[1]!.startsWith(OWNER_TOKEN_PREFIX) && !r.ownerToken).map(name);
    assert.deepEqual(missing, []);
  });

  it("keeps the allowlists honest (no stale or double-classified entries)", () => {
    const keys = new Set(routes.map((r) => r.key));
    const stale = [...Object.keys(PUBLIC), ...Object.keys(OPEN), ...OWNER_TOKEN_ROUTES].filter((k) => !keys.has(k));
    assert.deepEqual(stale, []);
    const gated = routes.filter((r) => OPEN[r.key] && (r.perms.length || r.anyPerms.length || r.capability)).map(name);
    assert.deepEqual(gated, [], "a route in OPEN now carries a permission — drop it from OPEN");
    const pubWithJwt = routes.filter((r) => PUBLIC[r.key] && has(r, JwtAuthGuard)).map(name);
    assert.deepEqual(pubWithJwt, []);
  });

  it("pins the permissions chosen in the Oct 2026 RBAC pass", () => {
    const want: Record<string, string> = {
      "GET /team/employees": "team.manage",
      "POST /team/employees": "team.manage",
      "PATCH /team/employees/:id": "team.manage",
      "PATCH /team/employees/:id/permissions": "team.manage",
      "DELETE /team/employees/:id": "team.manage",
      "POST /team/employees/:id/reset-password": "team.manage",
      "POST /team/employees/:id/resend-verification": "team.manage",
      "GET /team/role-presets": "team.manage",
      "POST /me/subscription/pay": "subscription.manage",
      "POST /me/subscription/sync": "subscription.manage",
      "GET /me/subscription/payments/:id/invoice.pdf": "subscription.manage",
      "POST /companies/me": "company.manage",
      "PATCH /companies/me": "company.manage",
      "POST /me/onboarding": "company.manage",
      "POST /ejar/lookup": "contracts.write",
      "GET /landlord/me/properties": "properties.view",
      "GET /landlord/me/payments": "payments.view",
      "GET /landlord/me/invoices/:id/pdf": "invoices.view",
    };
    const byKey = new Map(routes.map((r) => [r.key, r]));
    for (const [k, p] of Object.entries(want)) {
      assert.ok(byKey.get(k)?.perms.includes(p), `${k} should require ${p}`);
    }
    for (const k of ["POST /lookups", "PATCH /lookups/:id", "DELETE /lookups/:id"]) {
      assert.ok(byKey.get(k)?.anyPerms.includes("company.manage"), `${k} should take one of the writer permissions`);
    }
  });
});
