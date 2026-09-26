import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FinanceV2Guard } from "./finance-v2.guard";
import { FlagUnavailableError } from "./flag.service";
import { FinanceV2StatusController } from "./controllers/status.controller";

const holder = { id: 10, email: "", role: "user", ownerUserId: null, ownerScopeId: null,
  permissions: ["reports.view", "payments.view", "invoices.write", "expenses.write", "expenses.approve", "payments.write"] };

function ctxFor(user: any, meta: Record<string, unknown> = {}) {
  const req: any = { user };
  const handler = () => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as any };
}

function flagWith(state: any) {
  return { stateStrict: async () => { if (state instanceof Error) throw state; return state; }, state: async () => state } as any;
}

describe("FinanceV2Guard (DESIGN §1.2, §10.2)", () => {
  const on = { on: true, mode: "manager", ledgerStartedAt: null };
  it("404 when the flag is off", async () => {
    const g = new FinanceV2Guard(flagWith({ on: false, mode: null, ledgerStartedAt: null }), new Reflector());
    await assert.rejects(g.canActivate(ctxFor(holder).ctx), NotFoundException);
  });
  it("503 when the flag cannot be read and nothing is cached", async () => {
    const g = new FinanceV2Guard(flagWith(new FlagUnavailableError("x")), new Reflector());
    await assert.rejects(g.canActivate(ctxFor(holder).ctx), ServiceUnavailableException);
  });
  it("passes when on, and leaves the state on the request", async () => {
    const g = new FinanceV2Guard(flagWith(on), new Reflector());
    const { req, ctx } = ctxFor(holder, { "fv2:capability": "settings" });
    assert.equal(await g.canActivate(ctx), true);
    assert.deepEqual(req.fv2, on);
  });
  it("403 without the capability; 403 for owner-mobile tokens unless allowed", async () => {
    const g = new FinanceV2Guard(flagWith(on), new Reflector());
    const employee = { ...holder, ownerUserId: 10, permissions: ["reports.view", "payments.view"] };
    await assert.rejects(g.canActivate(ctxFor(employee, { "fv2:capability": "settings" }).ctx), ForbiddenException);
    const ownerTok = { ...holder, role: "owner", ownerScopeId: 4, permissions: [] };
    await assert.rejects(g.canActivate(ctxFor(ownerTok).ctx), ForbiddenException);
    assert.equal(await g.canActivate(ctxFor(ownerTok, { "fv2:allowOwnerScope": true }).ctx), true);
  });
});

describe("GET /finance/v2/status", () => {
  it("off → exactly { enabled: false }", async () => {
    const c = new FinanceV2StatusController(flagWith({ on: false, mode: null, ledgerStartedAt: null }));
    assert.deepEqual(await c.status({ user: holder } as any), { enabled: false });
  });
  it("on → mode, capabilities and the beta label", async () => {
    const c = new FinanceV2StatusController(flagWith({ on: true, mode: "manager", ledgerStartedAt: null }));
    const s: any = await c.status({ user: holder } as any);
    assert.equal(s.enabled, true);
    assert.equal(s.mode, "manager");
    assert.ok(s.capabilities.includes("view"));
    assert.equal(s.betaLabel.en, "Finance v2 (Beta)");
    assert.equal(s.ledgerStarted, false);
  });
});
