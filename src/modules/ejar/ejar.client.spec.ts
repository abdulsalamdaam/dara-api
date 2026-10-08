import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { EjarAccessError, EjarClientService, EjarConfigError, ejarAccessDenial } from "./ejar.client.service";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BODY = { data: [{ type: "contracts", id: "u1", attributes: { contract_number: "10603093808" } }], meta: { count: 1 } };
const baladyOk = (result = BODY) =>
  json(200, { statusDetails: { code: 200, message: "Ok" }, data: { responseCode: "1", responseMessage: "success", responseId: "r-1", result } });
const tokenOk = (token = "tok-1") => json(200, { access_token: token, expires_in: "17999", token_type: "Bearer" });

const ENV_KEYS = [
  "EJAR_BASE_URL", "EJAR_CLIENT_ID", "EJAR_CLIENT_SECRET",
  "EJAR_BALADY_BASE_URL", "EJAR_BALADY_CLIENT_ID", "EJAR_BALADY_CLIENT_SECRET",
  "EJAR_ACCESS", "EJAR_ALLOWED_USER_IDS",
];

describe("EjarClientService gateways", () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  let calls: { url: string; init: RequestInit }[];
  let replies: Response[];
  const client = () => new EjarClientService({ insert: async (r: unknown) => r } as never);

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    calls = [];
    replies = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = replies.shift();
      if (!r) throw new Error(`unexpected fetch ${url}`);
      return r;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const setNhc = () => {
    process.env.EJAR_BASE_URL = "https://integration-gw.housingapps.sa/nhc/uat";
    process.env.EJAR_CLIENT_ID = "nhc-id";
    process.env.EJAR_CLIENT_SECRET = "nhc-secret";
  };
  const setBalady = (base = "https://apiservicesstg.balady.gov.sa/") => {
    process.env.EJAR_BALADY_BASE_URL = base;
    process.env.EJAR_BALADY_CLIENT_ID = "bal-id";
    process.env.EJAR_BALADY_CLIENT_SECRET = "bal-secret";
  };

  it("sends contracts to Balady with a bearer token and unwraps data.result", async () => {
    setNhc(); setBalady();
    replies.push(tokenOk(), baladyOk());
    const { body, log } = await client().request("getRentalContracts", { id_number: "1050000008", "page[size]": 10 });
    assert.deepEqual(body, BODY);
    assert.equal(calls[0].url, "https://apiservicesstg.balady.gov.sa/oauth/v1/token");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("bal-id:bal-secret").toString("base64")}`);
    assert.equal(calls[1].url, "https://apiservicesstg.balady.gov.sa/v1/ejar-services/contracts?id_number=1050000008&page%5Bsize%5D=10");
    const h = calls[1].init.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer tok-1");
    assert.equal(h.RefId, "1");
    assert.equal(h["X-IBM-Client-Id"], undefined);
    assert.equal((log as { env: string }).env, "balady-stg");
    assert.equal((log as { requestHeaders: Record<string, string> }).requestHeaders.Authorization, "Bearer ***redacted***");
  });

  it("puts the contract number in the invoices path", async () => {
    setBalady();
    replies.push(tokenOk(), baladyOk());
    await client().request("rentalContractInvoices", { contractNumber: "10603093808", partyType: 0 });
    assert.equal(calls[1].url, "https://apiservicesstg.balady.gov.sa/v1/ejar-services/contracts/10603093808/invoices?partyType=0");
  });

  it("reuses the token across calls", async () => {
    setBalady();
    const c = client();
    replies.push(tokenOk(), baladyOk(), baladyOk());
    await c.request("getRentalContracts", { id_number: "1" });
    await c.request("getRentalContracts", { id_number: "2" });
    assert.equal(calls.filter((x) => x.url.endsWith("/oauth/v1/token")).length, 1);
  });

  it("fetches a fresh token once when Balady answers 401", async () => {
    setBalady();
    replies.push(tokenOk("old"), json(401, { statusDetails: { code: 401, message: "API authorization failed" } }), tokenOk("new"), baladyOk());
    const { body } = await client().request("getRentalContracts", { id_number: "1" });
    assert.deepEqual(body, BODY);
    assert.equal((calls[3].init.headers as Record<string, string>).Authorization, "Bearer new");
  });

  it("keeps endpoints Balady does not carry on NHC", async () => {
    setNhc(); setBalady();
    replies.push(json(200, { Header: { Status: { Code: 200 } }, Body: BODY }));
    const { body, log } = await client().request("getProperties", { id_number: "1" });
    assert.deepEqual(body, BODY);
    assert.ok(calls[0].url.startsWith("https://integration-gw.housingapps.sa/nhc/uat/v1/ejarext/GetProperties"));
    assert.equal((calls[0].init.headers as Record<string, string>)["X-IBM-Client-Id"], "nhc-id");
    assert.equal((log as { env: string }).env, "uat");
  });

  it("falls back to NHC for contracts when Balady is not configured", async () => {
    setNhc();
    replies.push(json(200, { Header: { Status: { Code: 200 } }, Body: BODY }));
    await client().request("getRentalContracts", { id_number: "1" });
    assert.ok(calls[0].url.includes("/v1/ejarext/GetRentalContracts"));
  });

  it("surfaces Balady's business message on an error", async () => {
    setBalady();
    replies.push(tokenOk(), json(400, { statusDetails: { code: 400, message: "Bad Request" }, data: { responseCode: "E1.11", responseMessage: "رقم العقد غير صحيح" } }));
    await assert.rejects(client().request("rentalContractInvoices", { contractNumber: "1" }), /E1\.11 رقم العقد غير صحيح/);
  });

  it("refuses the production Balady gateway", async () => {
    setBalady("https://apiservices.balady.gov.sa/");
    await assert.rejects(client().request("getRentalContracts", { id_number: "1" }), EjarConfigError);
    assert.equal(calls.length, 0);
  });
});

describe("ejarAccessDenial", () => {
  it("lets everyone through when EJAR_ACCESS is unset or all", () => {
    assert.equal(ejarAccessDenial(7, {}), null);
    assert.equal(ejarAccessDenial(7, { EJAR_ACCESS: "all" }), null);
  });

  it("allows only listed users in allowlist mode", () => {
    const env = { EJAR_ACCESS: "allowlist", EJAR_ALLOWED_USER_IDS: "1, 5" };
    assert.equal(ejarAccessDenial(1, env), null);
    assert.equal(ejarAccessDenial(5, env), null);
    assert.match(ejarAccessDenial(34, env) ?? "", /user 34 is not allowed/);
  });

  it("lets nobody in when the allowlist is empty", () => {
    assert.ok(ejarAccessDenial(1, { EJAR_ACCESS: "allowlist" }));
  });

  it("keeps the unattended health probe running in allowlist mode", () => {
    assert.equal(ejarAccessDenial(undefined, { EJAR_ACCESS: "allowlist" }), null);
  });

  it("blocks everything, probe included, when off or misspelled", () => {
    for (const mode of ["off", "allowlsit", "false"]) {
      assert.ok(ejarAccessDenial(1, { EJAR_ACCESS: mode }), mode);
      assert.ok(ejarAccessDenial(undefined, { EJAR_ACCESS: mode }), mode);
    }
  });
});

describe("EjarClientService access gate", () => {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  afterEach(() => { globalThis.fetch = realFetch; process.env = { ...saved }; });

  it("refuses before any network call and logs the attempt", async () => {
    process.env.EJAR_ACCESS = "allowlist";
    process.env.EJAR_ALLOWED_USER_IDS = "1";
    process.env.EJAR_BASE_URL = "https://integration-gw.housingapps.sa/nhc/uat";
    process.env.EJAR_CLIENT_ID = "x";
    process.env.EJAR_CLIENT_SECRET = "y";
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; throw new Error("no"); }) as typeof fetch;
    const logged: { userId: number | null; env: string; error: string | null }[] = [];
    const c = new EjarClientService({ insert: async (r: never) => { logged.push(r); return r; } } as never);
    await assert.rejects(c.request("getRentalContracts", { id_number: "1" }, { userId: 34 }), (e: unknown) => {
      assert.ok(e instanceof EjarAccessError);
      assert.equal((e as EjarAccessError).status, 403);
      return true;
    });
    assert.equal(fetched, 0);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].userId, 34);
    assert.equal(logged[0].env, "blocked");
  });
});
