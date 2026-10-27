/**
 * Ejar Import v2 — the lookup and its budget.
 *
 * The blocks up to "Get Contracts mode" run with EJAR_LOOKUP_SECOND_CALL=
 * details (Invoices → Details, what production uses); the Get Contracts mode
 * (the default) has its own block below.
 *
 * Drives the real EjarLookupService and the real EjarClientService against a
 * mocked Balady staging gateway (no network) and an in-memory store, so every
 * count below is a count of what would actually have left the server.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CN, STG, UUID, world, httpError, individualDetails, baladyErr, baladyOk, json, fixture, invoicesFor, detailsFor,
  contractsFor, PROPERTY_UUID, UNIT_UUID,
} from "./__tests__/lookup-harness";
import { computeBudget, lookupConfig, windowBounds } from "./ejar.budget";
import { EjarConfigError, EjarApiError } from "./ejar.client.service";
import { mapLookup, computeRequired, normalizeContractNumber, lookupUuid } from "./ejar.lookup.map";
import { EjarImportService } from "./ejar.import.service";

const USER = { id: 1 } as never;
/** The fixtures' lessor CR — عقاري accounts must type it at the inquiry. */
const LESSOR_CR = "1010000002";
const OTHER = { id: 2 } as never;

let w: ReturnType<typeof world>;
afterEach(() => w?.restore());
/** A world in Details mode (Invoices → Details). */
const dworld = (opts: { env?: Record<string, string>; delayMs?: number } = {}) =>
  world({ ...opts, env: { EJAR_LOOKUP_SECOND_CALL: "details", ...(opts.env ?? {}) } });

describe("POST /ejar/lookup — the two calls", () => {
  it("happy path: exactly Invoices then Details, with the right URLs and headers", async () => {
    w = dworld();
    const res = await w.svc.lookup(USER, { contract_number: CN });
    const data = w.dataCalls();
    assert.equal(data.length, 2, "one lookup = two data calls");
    assert.equal(data[0].url, `${STG}/v1/ejar-services/contracts/${CN}/invoices`);
    assert.equal(data[1].url, `${STG}/v1/ejar-services/contracts/${UUID}`);
    for (const c of data) {
      const h = c.init.headers as Record<string, string>;
      assert.equal(h.Authorization, "Bearer tok-1");
      assert.equal(h.RefId, "1");
      assert.equal(h.Accept, "application/json");
      assert.equal(h["X-IBM-Client-Id"], undefined, "Balady only — no NHC headers");
    }
    assert.equal(res.source, "ejar");
    assert.equal(res.contract.ejarId, UUID);
    assert.equal(res.contract.contractNumber, CN);
    assert.equal(res.contract.contractType, "commercial");
    assert.equal(res.contract.securityDeposit, 6000);
    assert.equal(res.contract.ridServiceEnabled, true);
    assert.equal(res.financial.totalRentAmount, 60000);
    assert.equal(res.financial.iban, "SA0000000000000000000000");
    assert.equal(res.financial.invoiceCount, 2);
    assert.equal(res.financial.invoiceTotal, 69000);
    assert.equal(res.financial.invoiceRemaining, 34500);
    assert.deepEqual(res.invoices.map((i) => i.dueDate), ["2026-11-26", "2027-05-26"], "sorted by due date");
    assert.deepEqual(res.invoices.map((i) => i.status), ["paid", "unpaid"]);
    assert.equal(res.logs.length, 2);
    assert.equal(res.alreadyImported, null);
    assert.deepEqual(res.budget, { enabled: true, available: true, remaining: 49 }, "the customer sees only what is available");
    const b = await w.svc.budget(1);
    assert.deepEqual(b.used, { invoices: 1, contracts: 0, details: 1 });
    assert.equal(b.remaining, 49);
    assert.ok(w.store.lookups.get(`1:${CN}`), "the lookup is saved for the import");
  });

  it("a cache hit spends nothing", async () => {
    w = dworld();
    await w.svc.lookup(USER, { contract_number: CN });
    const before = w.calls.length;
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(w.calls.length, before, "no call at all, not even a token");
    assert.equal(res.source, "cache");
    assert.deepEqual(res.logs, []);
    assert.deepEqual((await w.svc.budget(1)).used, { invoices: 1, contracts: 0, details: 1 });
  });

  it("refresh: true spends a fresh lookup", async () => {
    w = dworld();
    await w.svc.lookup(USER, { contract_number: CN });
    const res = await w.svc.lookup(USER, { contract_number: CN, refresh: true });
    assert.equal(res.source, "ejar");
    assert.equal(w.dataCalls().length, 4);
  });

  it("a stale saved lookup (past EJAR_LOOKUP_CACHE_HOURS) calls Ejar again", async () => {
    w = dworld({ env: { EJAR_LOOKUP_CACHE_HOURS: "1" } });
    await w.svc.lookup(USER, { contract_number: CN });
    w.store.lookups.get(`1:${CN}`)!.createdAt = new Date(Date.now() - 2 * 3_600_000);
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "ejar");
  });

  it("the cache is per account", async () => {
    w = dworld();
    await w.svc.lookup(USER, { contract_number: CN });
    const res = await w.svc.lookup(OTHER, { contract_number: CN });
    assert.equal(res.source, "ejar");
  });

  it("an unknown number makes one call, answers 404 not_found, and is free for the user", async () => {
    w = dworld();
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: "10000000099" }));
    assert.equal(status, 404);
    assert.equal(body.code, "not_found");
    assert.equal(w.dataCalls().length, 1, "Details is never called without a UUID");
    assert.deepEqual(body.budget, { enabled: true, available: true, remaining: 50 }, "no allowance or usage in the refusal");
    const b = await w.svc.budget(1);
    assert.equal(b.used.invoices, 0, "a wrong number is not counted toward the budget");
    assert.equal(b.remaining, 50);
    assert.equal(b.used.details, 0);
    assert.equal(w.store.lookups.size, 0);
  });

  it("an Invoices 200 that carries no contract (staging's answer to a wrong number) is not_found, and free", async () => {
    w = dworld();
    w.setRespond(() => json(200, { statusDetails: { code: 200 }, data: { result: { data: [], meta: { count: 0 }, included: [] } } }));
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 404);
    assert.equal(w.dataCalls().length, 1);
    assert.equal(body.code, "not_found");
    assert.equal((await w.svc.budget(1)).used.invoices, 0, "the empty 200 is a wrong number too");
  });

  it("a bad number format spends nothing", async () => {
    w = dworld();
    for (const bad of ["", "12ab", "abc", "1234", "1".repeat(25), null, { x: 1 }]) {
      const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: bad }));
      assert.equal(status, 400, String(bad));
      assert.equal(body.code, "bad_format");
    }
    assert.equal(w.calls.length, 0);
  });

  it("Arabic-Indic digits and spaces are accepted", () => {
    assert.equal(normalizeContractNumber("١٠٠٠٠٠٠٠٠٠١"), CN);
    assert.equal(normalizeContractNumber(" 100 0000 0001 "), CN);
  });

  it("no automatic retries: a 5xx on Invoices is one call and a 502", async () => {
    w = dworld();
    w.setRespond(() => baladyErr(503, "E503", "unavailable"));
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 502);
    assert.equal(w.dataCalls().length, 1);
    assert.equal(w.store.logs[0].attempts, 1);
  });

  it("no automatic retries: a 5xx on Details is still two calls in total", async () => {
    w = dworld();
    w.setRespond((url) => (url.endsWith("/invoices") ? (fixtureOk()) : baladyErr(500, "E500", "boom")));
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 502);
    assert.equal(w.dataCalls().length, 2);
    assert.equal(w.store.lookups.size, 0, "a half lookup is not saved");
  });

  it("a 429 from the gateway is not retried either", async () => {
    w = dworld();
    w.setRespond(() => baladyErr(429, "E429", "rate"));
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 502, "never confused with our own budget_exhausted 429");
    assert.equal(body.status, 429);
    assert.equal(w.dataCalls().length, 1);
  });

  it("the single token-refresh retry on 401 is counted in attempts", async () => {
    w = dworld();
    let first = true;
    w.setRespond((url) => {
      if (url.endsWith("/invoices") && first) { first = false; return baladyErr(401, "401-01", "token"); }
      return url.endsWith("/invoices") ? fixtureOk() : detailsOk();
    });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    const inv = w.store.logs.find((l) => l.endpoint === "rentalContractInvoices")!;
    assert.equal(inv.attempts, 2, "both sent requests are counted");
    assert.deepEqual((await w.svc.budget(1)).used, { invoices: 2, contracts: 0, details: 1 });
  });
});

describe("the lookup budget", () => {
  it("budget exhausted: 429, nothing sent", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "1" } });
    w.known.add("10000000002");
    await w.svc.lookup(USER, { contract_number: CN });
    const sent = w.calls.length;
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: "10000000002" }));
    assert.equal(status, 429);
    assert.equal(body.code, "budget_exhausted");
    assert.deepEqual(body.budget, { enabled: true, available: false, remaining: 0 }, "no allowance or usage: only that it is used up");
    assert.doesNotMatch(String(body.message), /\d/, "the message states no number");
    assert.equal((await w.svc.budget(1)).remaining, 0);
    assert.equal(w.calls.length, sent, "not a single call — not even the token");
  });

  it("a cache hit still works with the budget exhausted", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "1" } });
    await w.svc.lookup(USER, { contract_number: CN });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "cache");
  });

  it("is counted per endpoint: limit 2 allows at most 2 Invoices and 2 Details calls", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "2" } });
    for (const n of ["10000000002", "10000000003", "10000000004"]) w.known.add(n);
    await w.svc.lookup(USER, { contract_number: "10000000002" });
    await w.svc.lookup(USER, { contract_number: "10000000003" });
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: "10000000004" }));
    assert.equal(status, 429);
    const by = (e: string) => w.dataCalls().filter((c) => (e === "inv" ? c.url.endsWith("/invoices") : !c.url.endsWith("/invoices"))).length;
    assert.equal(by("inv"), 2);
    assert.equal(by("det"), 2);
  });

  it("unknown numbers don't use up the budget", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "2" } });
    await httpError(w.svc.lookup(USER, { contract_number: "10000000098" }));
    await httpError(w.svc.lookup(USER, { contract_number: "10000000099" }));
    const budget = await w.svc.budget(1);
    assert.deepEqual(budget.used, { invoices: 0, contracts: 0, details: 0 });
    assert.equal(budget.remaining, 2);
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "ejar", "the real lookup still has its full budget");
  });

  it("wrong numbers are capped per account per day, without spending a call once the cap is hit", async () => {
    w = dworld({ env: { EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY: "2" } });
    await httpError(w.svc.lookup(USER, { contract_number: "10000000097" }));
    await httpError(w.svc.lookup(USER, { contract_number: "10000000098" }));
    const before = w.dataCalls().length;
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: "10000000099" }));
    assert.equal(status, 429);
    assert.equal(body.code, "too_many_wrong_numbers");
    assert.equal(w.dataCalls().length, before, "nothing is sent once the cap is reached");
    assert.equal((await w.svc.budget(1)).remaining, 50, "the cap is separate from the lookup budget");
  });

  it("another account's wrong numbers don't count toward this account's cap", async () => {
    w = dworld({ env: { EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY: "1" } });
    await httpError(w.svc.lookup(OTHER, { contract_number: "10000000098" }));
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "ejar");
  });

  it("EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY=off removes the cap; default is 20", () => {
    assert.equal(lookupConfig({ EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY: "off" }).wrongNumbersPerDay, null);
    assert.equal(lookupConfig({}).wrongNumbersPerDay, 20);
    assert.equal(lookupConfig({ EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY: "oops" }).wrongNumbersPerDay, 0, "a typo closes it");
  });

  it("per-account cap: one account's lookups don't spend another's", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT_PER_ACCOUNT: "1" } });
    w.known.add("10000000002");
    w.store.accountOf[7] = 1; // user 7 is an employee of account 1
    await w.svc.lookup(USER, { contract_number: CN });
    const employee = { id: 7, ownerUserId: 1 } as never;
    const { status, body } = await httpError(w.svc.lookup(employee, { contract_number: "10000000002" }));
    assert.equal(status, 429, "the employee shares the owner's cap");
    assert.equal(body.budget.available, false);
    const acct = (await w.svc.budget(1)).perAccount;
    assert.equal(acct.limit, 1);
    assert.equal(acct.used, 1);
    const res = await w.svc.lookup(OTHER, { contract_number: "10000000002" });
    assert.equal(res.source, "ejar", "another account still has its own allowance");
    assert.equal(res.budget.available, false, "OTHER's own cap is now spent too");
    const other = await w.svc.budget(2);
    assert.equal(other.perAccount.used, 1);
    assert.equal(other.used.invoices, 2, "the global count includes both accounts");
  });

  it("concurrent lookups cannot exceed the limit", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "1" }, delayMs: 15 });
    const nums = ["10000000002", "10000000003", "10000000004", "10000000005"];
    for (const n of nums) w.known.add(n);
    const results = await Promise.allSettled(nums.map((n) => w.svc.lookup(USER, { contract_number: n })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      assert.equal((r as PromiseRejectedResult).reason.getStatus(), 429);
    }
    assert.equal(w.dataCalls().length, 2, "one lookup's worth of calls, no more");
    assert.equal(w.store.locksTaken, 4, "every lookup went through the lock");
  });

  it("GET /ejar/budget reports the documented shape", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "5", EJAR_LOOKUP_WINDOW: "day" } });
    await w.svc.lookup(USER, { contract_number: CN });
    const b = await w.svc.budget(1);
    assert.equal(b.limit, 5);
    assert.equal(b.window, "day");
    assert.deepEqual(b.used, { invoices: 1, contracts: 0, details: 1 });
    assert.equal(b.remaining, 4);
    assert.ok(b.resetsAt);
    assert.deepEqual(b.perAccount, { limit: null, used: 1, remaining: null });
  });

  it("blocked attempts are not counted", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "1" } });
    w.store.logs.push({ id: 1, userId: 1, env: "blocked", endpoint: "rentalContractInvoices", attempts: 0, status: 403, createdAt: new Date() });
    w.store.logs.push({ id: 2, userId: 1, env: "uat", endpoint: "rentalContractInvoices", attempts: 3, status: 200, createdAt: new Date() });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "ejar");
  });
});

describe("the plan's Ejar lookup quota", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const period = (plan: string, cycle: string) => ({
    packagePlan: plan, billingCycle: cycle,
    subscriptionStartedAt: new Date(Date.now() - DAY), subscriptionEndsAt: new Date(Date.now() + 80 * DAY),
  });

  it("a quarterly Basic account gets 22 lookups for its period, then 429", async () => {
    w = dworld();
    w.store.plans[1] = period("basic", "quarterly");
    const b = await w.svc.budget(1);
    assert.equal(b.limit, 22);
    assert.equal(b.window, "period");
    assert.equal(b.remaining, 22);
    assert.equal(b.gateway.limit, 50, "the gateway budget is still reported");
    assert.ok(b.resetsAt, "renews with the subscription");

    const numbers = Array.from({ length: 23 }, (_, i) => String(10000000100 + i));
    numbers.forEach((n) => w.known.add(n));
    for (const n of numbers.slice(0, 22)) await w.svc.lookup(USER, { contract_number: n, landlord_cr: LESSOR_CR });
    const sent = w.calls.length;
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: numbers[22], landlord_cr: LESSOR_CR }));
    assert.equal(status, 429);
    assert.equal(body.code, "budget_exhausted");
    assert.equal(body.budget.available, false);
    assert.equal((await w.svc.budget(1)).plan?.used, 22);
    assert.equal(w.calls.length, sent, "nothing is sent past the quota");
  });

  it("counts only the current paid period", async () => {
    w = dworld();
    w.store.plans[1] = period("tenant", "quarterly"); // floor(30 × 3/12) = 7
    w.store.logs.push({
      id: 999, userId: 1, env: "balady-staging", endpoint: "rentalContractInvoices", attempts: 5,
      status: 200, createdAt: new Date(Date.now() - 10 * DAY),
    });
    const b = await w.svc.budget(1);
    assert.equal(b.limit, 7);
    assert.equal(b.plan?.used, 0, "calls before the period started don't count");
  });

  it("Enterprise has no plan quota", async () => {
    w = dworld();
    w.store.plans[1] = period("enterprise", "yearly");
    const b = await w.svc.budget(1);
    assert.equal(b.plan, null);
    assert.equal(b.limit, 50);
    assert.equal(b.window, "month");
  });
});

describe("what the customer is shown: attempts available, prorated to the paid period", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const period = (plan: string, cycle: string) => ({
    packagePlan: plan, billingCycle: cycle,
    subscriptionStartedAt: new Date(Date.now() - DAY), subscriptionEndsAt: new Date(Date.now() + 80 * DAY),
  });
  // A gateway budget large enough not to mask the plan quota.
  const env = { EJAR_LOOKUP_LIMIT: "1000" };

  for (const [cycle, n] of [["quarterly", 37], ["semiannual", 75], ["yearly", 150]] as const) {
    it(`Offices on ${cycle}: ${n} available`, async () => {
      w = dworld({ env });
      w.store.plans[1] = period("professional", cycle);
      const c = await w.svc.customerBudget(1);
      assert.deepEqual(c, { enabled: true, available: true, remaining: n });
      assert.deepEqual(Object.keys(c).sort(), ["available", "enabled", "remaining"], "no allowance, usage or windows");
    });
  }

  it("Aqari quarterly: floor(90 × 3/12) = 22, and a lookup takes one off", async () => {
    w = dworld({ env });
    w.store.plans[1] = period("basic", "quarterly");
    assert.equal((await w.svc.customerBudget(1)).remaining, 22);
    const res = await w.svc.lookup(USER, { contract_number: CN, landlord_cr: LESSOR_CR });
    assert.equal(res.budget.remaining, 21);
    assert.equal((await w.svc.customerBudget(1)).remaining, 21);
  });

  it("an admin override and an Ejar pack are part of the number", async () => {
    w = dworld({ env });
    w.store.plans[1] = period("professional", "quarterly");
    w.store.quotaAdjust[1] = { override: undefined, addons: 10 };
    assert.equal((await w.svc.customerBudget(1)).remaining, 47);
    w.store.quotaAdjust[1] = { override: 5, addons: 0 };
    assert.equal((await w.svc.customerBudget(1)).remaining, 5);
  });

  it("the shared gateway budget does not mask the account's own number — only shows once it is shut", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "50" } });
    w.store.plans[1] = period("professional", "yearly");
    assert.equal((await w.svc.customerBudget(1)).remaining, 150, "not 50");
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "0" } });
    w.store.plans[1] = period("professional", "yearly");
    assert.deepEqual(await w.svc.customerBudget(1), { enabled: true, available: false, remaining: 0 });
  });

  it("an uncapped plan (Companies) is shown the gateway's headroom", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "50" } });
    w.store.plans[1] = period("enterprise", "yearly");
    assert.equal((await w.svc.customerBudget(1)).remaining, 50);
  });

  it("a per-account cap below the plan is the number shown", async () => {
    w = dworld({ env: { EJAR_LOOKUP_LIMIT: "1000", EJAR_LOOKUP_LIMIT_PER_ACCOUNT: "12" } });
    w.store.plans[1] = period("professional", "quarterly");
    assert.equal((await w.svc.customerBudget(1)).remaining, 12);
  });

  it("Ejar off for the account: 0 available", async () => {
    w = dworld({ env });
    w.store.plans[1] = period("professional", "yearly");
    w.store.ejarModes[1] = "disabled";
    assert.deepEqual(await w.svc.customerBudget(1, undefined, 1), { enabled: false, available: false, remaining: 0 });
  });
});

describe("budget configuration", () => {
  it("defaults: 50 per month, no per-account cap, 24 h cache, 20 wrong numbers a day", () => {
    assert.deepEqual(lookupConfig({}), { limit: 50, window: "month", perAccount: null, cacheHours: 24, secondCall: "contracts", wrongNumbersPerDay: 20 });
    assert.equal(lookupConfig({ EJAR_LOOKUP_SECOND_CALL: "details" }).secondCall, "details");
    assert.equal(lookupConfig({ EJAR_LOOKUP_SECOND_CALL: "contrcts" }).secondCall, "details", "a typo picks the call prod is subscribed to");
  });

  it("a typo closes the budget rather than opening it", () => {
    assert.equal(lookupConfig({ EJAR_LOOKUP_LIMIT: "fifty" }).limit, 0);
    assert.equal(lookupConfig({ EJAR_LOOKUP_LIMIT_PER_ACCOUNT: "-3" }).perAccount, 0);
  });

  it("windows reset at Riyadh midnight / first of the month", () => {
    // 2026-10-31 22:30 UTC is already 1 Nov 01:30 in Riyadh.
    const now = new Date("2026-10-31T22:30:00Z");
    const month = windowBounds("month", now);
    assert.equal(month.start!.toISOString(), "2026-10-31T21:00:00.000Z");
    assert.equal(month.resetsAt!.toISOString(), "2026-11-30T21:00:00.000Z");
    const day = windowBounds("day", now);
    assert.equal(day.start!.toISOString(), "2026-10-31T21:00:00.000Z");
    assert.equal(day.resetsAt!.toISOString(), "2026-11-01T21:00:00.000Z");
    assert.deepEqual(windowBounds("total", now), { start: null, resetsAt: null });
  });

  it("remaining = limit - max(used), min'd with the account's remaining", () => {
    const cfg = { limit: 10, window: "month" as const, perAccount: 3, cacheHours: 24, secondCall: "contracts" as const, wrongNumbersPerDay: 20 };
    const acct = (n: number) => ({ invoices: n, contracts: 0, details: 0 });
    const b = computeBudget(cfg, { invoices: 4, contracts: 3, details: 2, account: acct(1) });
    assert.equal(b.remaining, 2);
    assert.equal(computeBudget({ ...cfg, perAccount: null }, { invoices: 4, contracts: 5, details: 2, account: acct(1) }).remaining, 5);
    assert.equal(computeBudget(cfg, { invoices: 12, contracts: 0, details: 2, account: acct(0) }).remaining, 0, "never negative");
  });
});

describe("access, scope and gateway guards", () => {
  it("the EJAR_ACCESS gate stands in front of the lookup (and its cache)", async () => {
    w = dworld({ env: { EJAR_ACCESS: "allowlist", EJAR_ALLOWED_USER_IDS: "5" } });
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(w.calls.length, 0);
  });

  it("a locked account may only look up a contract it is a party to", async () => {
    w = dworld();
    w.store.scopes[1] = { locked: true, idNumber: "7000000009" };
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(body.code, "scope_mismatch");
    assert.equal(w.store.lookups.size, 0, "nothing is saved for a contract that is not theirs");
  });

  it("a locked account whose CR is on the contract gets it", async () => {
    w = dworld();
    w.store.scopes[1] = { locked: true, idNumber: "1010000001" }; // the tenant's CR
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.parties.tenant?.crNumber, "1010000001");
  });

  it("the production Balady host stays blocked — no call is made", async () => {
    w = dworld({ env: { EJAR_BALADY_BASE_URL: "https://apiservices.balady.gov.sa/" } });
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 503);
    assert.equal(w.calls.length, 0);
    await assert.rejects(w.client.request("contractDetails", { uuid: UUID }), EjarConfigError);
    await assert.rejects(w.client.checkToken(), EjarConfigError);
  });

  it("contractDetails refuses a non-UUID before anything is sent", async () => {
    w = dworld();
    await assert.rejects(w.client.request("contractDetails", { uuid: "10000000001" }), (e: unknown) => {
      assert.ok(e instanceof EjarApiError);
      assert.equal((e as EjarApiError).status, 400);
      return true;
    });
    assert.equal(w.calls.length, 0);
  });

  it("contractDetails has no NHC fallback", async () => {
    w = dworld();
    delete process.env.EJAR_BALADY_BASE_URL;
    process.env.EJAR_BASE_URL = "https://integration-gw.housingapps.sa/nhc/uat";
    process.env.EJAR_CLIENT_ID = "x";
    process.env.EJAR_CLIENT_SECRET = "y";
    await assert.rejects(w.client.request("contractDetails", { uuid: UUID }), EjarConfigError);
    assert.equal(w.calls.length, 0);
  });

  it("checkToken makes a token request and nothing else", async () => {
    w = dworld();
    await w.client.checkToken();
    assert.equal(w.calls.length, 1);
    assert.ok(w.calls[0].url.endsWith("/oauth/v1/token"));
    assert.equal(w.store.logs.length, 0);
  });
});

describe("matches, alreadyImported and required[]", () => {
  it("never offers existing landlords/tenants, and flags an existing contract", async () => {
    w = dworld();
    w.store.owners.push({ id: 11, accountId: 1, name: "مؤجر محلي", idNumber: "1010000002" });
    w.store.tenants.push({ id: 21, accountId: 1, name: "مستأجر محلي", nationalId: "1010000001" });
    w.store.tenants.push({ id: 22, accountId: 2, name: "حساب آخر", nationalId: "1010000001" });
    w.store.imported.set(`1:${CN}`, 99);
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.matches.landlord, null, "existing landlords are never offered for linking");
    assert.equal(res.matches.tenant, null, "existing tenants are never offered for linking");
    assert.deepEqual(res.alreadyImported, { contractId: 99 });
  });
});

describe("mapping the Details parties", () => {
  it("organizations carry their CR; representatives are individuals with no ID", () => {
    const m = mapLookup(fixture("lookup-invoices"), fixture("lookup-details"));
    assert.equal(m.parties.lessor?.kind, "organization");
    assert.equal(m.parties.lessor?.crNumber, "1010000002");
    assert.equal(m.parties.lessor?.organizationType, "commercial");
    assert.equal(m.parties.tenant?.crNumber, "1010000001");
    assert.equal(m.parties.lessorRepresentative?.kind, "individual");
    assert.equal(m.parties.lessorRepresentative?.name, "محمد تجريبي");
    assert.equal(m.parties.lessorRepresentative?.idType, "national_id");
    assert.equal(m.parties.lessorRepresentative?.idNumber, null);
    assert.equal(m.parties.lessorRepresentative?.approved, true);
    assert.equal(m.parties.tenantRepresentative?.name, "خالد تجريبي");
    assert.deepEqual(m.parties.others, []);
    const keys = computeRequired(m.parties).filter((r) => r.required).map((r) => r.key);
    assert.ok(!keys.includes("landlord.idNumber"), "an organization's CR comes from Ejar");
    assert.ok(!keys.includes("tenant.idNumber"));
  });

  it("individual parties and missing representatives", () => {
    const m = mapLookup(fixture("lookup-invoices"), individualDetails());
    assert.equal(m.contract.contractType, "residential");
    assert.equal(m.parties.lessor?.kind, "individual");
    assert.equal(m.parties.lessor?.name, "فهد تجريبي");
    assert.equal(m.parties.lessor?.crNumber, null);
    assert.equal(m.parties.tenant?.idType, "iqama");
    assert.equal(m.parties.lessorRepresentative, null);
    assert.equal(m.parties.tenantRepresentative, null);
    assert.equal(m.financial.iban, null);
    const req = computeRequired(m.parties);
    const required = req.filter((r) => r.required).map((r) => r.key);
    assert.ok(required.includes("landlord.idNumber"), "Ejar gives an individual no ID number");
    assert.ok(required.includes("tenant.idNumber"));
    for (const k of ["property.name", "property.propertyTypeId", "property.usageId", "property.city", "unit.unitNumber", "unit.unitTypeId"]) {
      assert.ok(required.includes(k), k);
    }
    assert.ok(!req.some((r) => r.key === "contract.vatEnabled"), "rent VAT is decided server-side");
    for (const k of ["landlord.phone", "tenant.email", "unit.usageId"]) {
      const e = req.find((r) => r.key === k);
      assert.ok(e && e.required === false, `${k} is listed, not required`);
    }
  });

  it("the UUID is read from the Invoices body", () => {
    assert.equal(lookupUuid(fixture("lookup-invoices"), CN), UUID);
    assert.equal(lookupUuid({ data: [] }, CN), null);
  });

  it("an unexpected role lands in others, and a missing lessor asks for a name", () => {
    const d = fixture("lookup-details");
    d.included = d.included.filter((r: { type: string; id: string }) => !(r.type === "contract_parties" && r.id === "2"));
    d.data.relationships.contract_parties.data = d.data.relationships.contract_parties.data.filter((r: { id: string }) => r.id !== "2");
    d.included.push({ type: "contract_parties", id: "9", attributes: { contract_party_role: "broker" }, relationships: {} });
    d.data.relationships.contract_parties.data.push({ type: "contract_parties", id: "9" });
    const m = mapLookup(null, d);
    assert.equal(m.parties.lessor, null);
    assert.equal(m.parties.others.length, 1);
    assert.equal(m.parties.others[0].role, "broker");
    assert.ok(computeRequired(m.parties).some((r) => r.key === "landlord.name" && r.required));
  });
});

function fixtureOk() { return baladyOk(invoicesFor(CN)); }
function detailsOk() { return baladyOk(detailsFor(CN)); }

describe("Get Contracts mode (EJAR_LOOKUP_SECOND_CALL=contracts, the default)", () => {
  const LIST_URL = `${STG}/v1/ejar-services/contracts?id_number=1&contract_ids=${UUID}&skip_filter_id_number=true&page%5Bnumber%5D=1&page%5Bsize%5D=10`;

  it("happy path: exactly Invoices then Get Contracts, with the exact URL and params", async () => {
    w = world();
    const res = await w.svc.lookup(USER, { contract_number: CN });
    const data = w.dataCalls();
    assert.equal(data.length, 2);
    assert.equal(data[0].url, `${STG}/v1/ejar-services/contracts/${CN}/invoices`);
    assert.equal(data[1].url, LIST_URL);
    const h = data[1].init.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer tok-1");
    assert.equal(h.RefId, "1");
    assert.equal(h.Accept, "application/json");
    assert.equal(w.store.logs[1].endpoint, "getRentalContracts");

    assert.equal(res.contract.source, "contracts");
    assert.equal(res.contract.ejarId, UUID);
    assert.equal(res.contract.status, "active");
    assert.equal(res.contract.startDate, "2026-11-16");
    assert.equal(res.contract.securityDeposit, 6000, "deposit from security_deposit_value");
    assert.equal(res.contract.totalValue, 60000);
    assert.equal(res.contract.paymentFrequency, "semi_annually");
    assert.equal(res.contract.autoRenewal, true);
    assert.deepEqual(res.contract.broker, { name: "وسيط تجريبي", nationalId: "1000000099" });

    const { lessor, tenant, lessorRepresentative, tenantRepresentative } = res.parties;
    assert.equal(lessor?.kind, "organization");
    assert.equal(lessor?.crNumber, "1010000002");
    assert.equal(lessor?.unifiedNumber, null, "an encrypted blob is never an identifier");
    assert.equal(lessor?.vatNumber, "300000000000003");
    assert.equal(lessor?.phone, "0500000001");
    assert.equal(tenant?.kind, "individual");
    assert.equal(tenant?.idNumber, "1000000004");
    assert.equal(tenant?.email, "Tenant@Example.invalid");
    assert.equal(lessorRepresentative?.idNumber, "1000000003");
    assert.equal(tenantRepresentative, null);

    assert.deepEqual(res.property, {
      ejarId: PROPERTY_UUID, name: "برج تجريبي", type: "building",
      region: { key: "riyadh", nameAr: "الرياض", nameEn: "Riyadh" },
      latitude: 24.7, longitude: 46.6, mapsUrl: "https://www.google.com/maps?q=24.7,46.6", unitCount: 1,
    });
    assert.deepEqual(res.units, [{
      ejarId: UNIT_UUID, unitNumber: "S-01", unitType: "shop", floor: null, area: null, rooms: null, usage: null,
      raw: { id: UNIT_UUID, unit_type: "shop", unit_number: "S-01" },
    }]);
    assert.equal(res.invoices.length, 2, "Invoices stay the payment schedule");
    assert.deepEqual((await w.svc.budget(1)).used, { invoices: 1, contracts: 1, details: 0 });
    assert.equal((res as unknown as Record<string, unknown>).contractsResource, undefined, "internal, not in the response");

    const saved = w.store.lookups.get(`1:${CN}`)!;
    assert.ok(saved.contractsBody);
    assert.equal(saved.detailsBody, null);
  });

  it("required[] shrinks to nothing when Ejar gave everything that resolves", async () => {
    w = world();
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.deepEqual(res.required.filter((r) => r.required).map((r) => r.key), []);
    for (const k of ["property.name", "property.propertyTypeId", "property.usageId", "property.city", "unit.unitNumber", "unit.unitTypeId"]) {
      assert.equal(res.required.find((r) => r.key === k)?.required, false, k);
    }
    assert.ok(!res.required.some((r) => r.key === "landlord.idNumber" || r.key === "tenant.idNumber"));
    assert.ok(!res.required.some((r) => r.key === "tenant.phone"), "Ejar gave the phone");
  });

  it("what does not resolve stays required", async () => {
    w = world();
    const list = contractsFor(CN);
    list.data[0].attributes.units[0].unit_type = "spaceship";
    list.data[0].attributes.region = { key: "nowhere", name_ar: "لا مكان", name_en: "Nowhere" };
    list.data[0].attributes.tenants[0].id_number = null;
    w.setRespond((url) => (url.includes("/invoices") ? baladyOk(invoicesFor(CN)) : baladyOk(list)));
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.deepEqual(res.required.filter((r) => r.required).map((r) => r.key).sort(), ["property.city", "tenant.idNumber", "unit.unitTypeId"]);
  });

  it("falls back to Details when Get Contracts holds no such contract: 3 calls", async () => {
    w = world();
    w.listOnly(); // a renewed contract: the list query by the Invoices UUID comes back empty
    const res = await w.svc.lookup(USER, { contract_number: CN });
    const urls = w.dataCalls().map((c) => c.url);
    assert.deepEqual(urls, [`${STG}/v1/ejar-services/contracts/${CN}/invoices`, LIST_URL, `${STG}/v1/ejar-services/contracts/${UUID}`]);
    assert.equal(res.contract.source, "details");
    assert.equal(res.property, null);
    assert.deepEqual(res.units, []);
    assert.deepEqual((await w.svc.budget(1)).used, { invoices: 1, contracts: 1, details: 1 });
  });

  it("a list entry for another contract number also falls back", async () => {
    w = world();
    const list = contractsFor(CN);
    list.data[0].id = "99999999-2222-4333-8444-555555555555";
    list.data[0].attributes.contract_id = "99999999-2222-4333-8444-555555555555";
    list.data[0].attributes.contract_number = "10000000555";
    w.setRespond((url) => (url.includes("/invoices") ? baladyOk(invoicesFor(CN)) : url.includes("?") ? baladyOk(list) : baladyOk(detailsFor(CN))));
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.contract.source, "details");
    assert.equal(w.dataCalls().length, 3);
  });

  it("without Details headroom the fallback is not made: 429 details_unavailable, nothing saved", async () => {
    w = world({ env: { EJAR_LOOKUP_LIMIT: "1" } });
    w.store.logs.push({ id: 1, userId: 9, env: "balady-stg", endpoint: "contractDetails", attempts: 1, status: 200, createdAt: new Date() });
    w.listOnly();
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 429);
    assert.equal(body.code, "details_unavailable");
    assert.equal(w.dataCalls().length, 2, "Invoices + Get Contracts, no third call");
    assert.equal(w.store.lookups.size, 0);
  });

  it("the budget is counted per endpoint, fallback included", async () => {
    w = world({ env: { EJAR_LOOKUP_LIMIT: "2" } });
    for (const n of ["10000000002", "10000000003", "10000000004"]) w.known.add(n);
    w.listOnly("10000000002", "10000000004");
    await w.svc.lookup(USER, { contract_number: "10000000002" }); // 2 calls
    await w.svc.lookup(USER, { contract_number: "10000000003" }); // 3 calls (fallback)
    const b = await w.svc.budget(1);
    assert.deepEqual(b.used, { invoices: 2, contracts: 2, details: 1 });
    assert.equal(b.remaining, 0);
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: "10000000004" }));
    assert.equal(status, 429);
    assert.equal(body.code, "budget_exhausted");
    assert.equal(w.dataCalls().length, 5);
  });

  it("a lookup needs headroom on the second call it will make", async () => {
    w = world({ env: { EJAR_LOOKUP_LIMIT: "1" } });
    w.store.logs.push({ id: 1, userId: 9, env: "balady-stg", endpoint: "getRentalContracts", attempts: 1, status: 200, createdAt: new Date() });
    assert.equal((await httpError(w.svc.lookup(USER, { contract_number: CN }))).status, 429);
    assert.equal(w.calls.length, 0);
  });

  it("a Get Contracts failure is not retried and does not fall back", async () => {
    w = world();
    w.setRespond((url) => (url.includes("/invoices") ? baladyOk(invoicesFor(CN)) : baladyErr(401, "401-01", "API authorization failed")));
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 502);
    // Invoices + Get Contracts + the one token-refresh resend of Get Contracts.
    assert.deepEqual(w.dataCalls().map((c) => c.url.includes("?")), [false, true, true]);
    assert.equal(w.store.logs.find((l) => l.endpoint === "getRentalContracts")!.attempts, 2);
  });

  it("EJAR_LOOKUP_SECOND_CALL=details skips Get Contracts", async () => {
    w = world({ env: { EJAR_LOOKUP_SECOND_CALL: "details" } });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.deepEqual(w.dataCalls().map((c) => c.url), [`${STG}/v1/ejar-services/contracts/${CN}/invoices`, `${STG}/v1/ejar-services/contracts/${UUID}`]);
    assert.equal(res.contract.source, "details");
    assert.equal((await w.svc.budget(1)).secondCall, "details");
  });

  it("matches property/unit by Ejar UUID but never landlord/tenant", async () => {
    w = world();
    w.store.owners.push({ id: 11, accountId: 1, name: "مؤجر", idNumber: "1010000002" });
    w.store.tenants.push({ id: 21, accountId: 1, name: "مستأجر", nationalId: "1000000004" });
    w.store.properties.push({ id: 31, accountId: 1, ownerId: 11, usageLookupId: 2, ejarId: PROPERTY_UUID, name: "عقاري" });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "S-01", usageLookupId: null, ejarId: UNIT_UUID });
    w.store.properties.push({ id: 32, accountId: 2, ownerId: null, usageLookupId: null, ejarId: PROPERTY_UUID, name: "حساب آخر" });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.matches.landlord, null, "parties are not offered for linking");
    assert.equal(res.matches.tenant, null);
    assert.deepEqual(res.matches.property, { id: 31, name: "عقاري" });
    assert.equal(res.matches.unit?.id, 41);
    assert.ok(!res.required.some((r) => r.section === "property" || r.section === "unit"), "matched sections need nothing");
  });

  it("a locked account is checked against the list parties' real IDs", async () => {
    w = world();
    w.store.scopes[1] = { locked: true, idNumber: "1000000004" }; // the tenant's ID
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.contract.source, "contracts");
    w.store.scopes[2] = { locked: true, idNumber: "7000000009" };
    assert.equal((await httpError(w.svc.lookup(OTHER, { contract_number: CN }))).status, 403);
  });

  it("the production host stays blocked in this mode too", async () => {
    w = world({ env: { EJAR_BALADY_BASE_URL: "https://apiservices.balady.gov.sa" } });
    assert.equal((await httpError(w.svc.lookup(USER, { contract_number: CN }))).status, 503);
    await assert.rejects(
      w.client.request("getRentalContracts", { id_number: "1", contract_ids: UUID, skip_filter_id_number: "true" }), EjarConfigError,
    );
    assert.equal(w.calls.length, 0);
  });

  it("Get Contracts is refused without a UUID contract_ids (it would list the whole dataset)", async () => {
    w = world();
    await assert.rejects(w.client.request("getRentalContracts", { id_number: "1", skip_filter_id_number: "true" }), /contract_ids/);
    await assert.rejects(w.client.request("getRentalContracts", { id_number: "1", contract_ids: "10000000001" }), /UUID/);
    assert.equal(w.calls.length, 0);
  });
});

describe("account limits on the Ejar quota (override / add-ons)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const period = (plan: string, cycle: string) => ({
    packagePlan: plan, billingCycle: cycle,
    subscriptionStartedAt: new Date(Date.now() - DAY), subscriptionEndsAt: new Date(Date.now() + 80 * DAY),
  });

  it("an active Ejar pack adds to the period quota", async () => {
    w = dworld();
    w.store.plans[1] = period("basic", "quarterly"); // 22
    w.store.quotaAdjust[1] = { override: undefined, addons: 50 };
    const b = await w.svc.budget(1);
    assert.equal(b.limit, 72);
    assert.equal(b.plan?.limit, 72);
    assert.equal(b.window, "period");
  });

  it("an override replaces the plan quota — down to 1, the second lookup is refused, pointing at the admin", async () => {
    w = dworld();
    w.store.plans[1] = period("basic", "quarterly");
    w.store.quotaAdjust[1] = { override: 1, addons: 0 };
    w.known.add("10000000201");
    await w.svc.lookup(USER, { contract_number: CN, landlord_cr: LESSOR_CR });
    const sent = w.calls.length;
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: "10000000201", landlord_cr: LESSOR_CR }));
    assert.equal(status, 429);
    assert.equal(body.code, "budget_exhausted");
    // Add-ons come from the admin only: nothing for sale, "contact us".
    assert.equal(body.addonAvailable, false);
    assert.equal(body.contactAdmin, true);
    assert.equal((await w.svc.budget(1)).plan?.limit, 1);
    assert.equal(w.calls.length, sent);
  });

  it("addonAvailable is always false (admin-only add-ons)", async () => {
    w = dworld();
    w.store.plans[1] = period("basic", "quarterly");
    w.store.quotaAdjust[1] = { override: 0, addons: 0 };
    const { body } = await httpError(w.svc.lookup(USER, { contract_number: CN, landlord_cr: LESSOR_CR }));
    assert.equal(body.code, "budget_exhausted");
    assert.equal(body.addonAvailable, false);
  });

  it("an unlimited override lifts the plan quota (the gateway budget still applies)", async () => {
    w = dworld();
    w.store.plans[1] = period("basic", "quarterly");
    w.store.quotaAdjust[1] = { override: null, addons: 0 };
    const b = await w.svc.budget(1);
    assert.equal(b.plan, null);
    assert.equal(b.limit, 50);
  });

  it("an override can cap an uncapped plan", async () => {
    w = dworld();
    w.store.plans[1] = period("enterprise", "yearly");
    w.store.quotaAdjust[1] = { override: 5, addons: 2 };
    const b = await w.svc.budget(1);
    assert.equal(b.plan?.limit, 7);
  });
});

describe("the per-account Ejar switch (ejar.access.ts)", () => {
  it("disabled: 403 ejar_disabled_for_account, nothing sent, budget says enabled:false", async () => {
    w = dworld();
    w.store.ejarModes[1] = "disabled";
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(body.code, "ejar_disabled_for_account");
    assert.equal(w.calls.length, 0);
    assert.equal((await w.svc.budget(1, undefined, 1)).enabled, false);
  });

  it("disabled also blocks the import (which never calls Ejar)", async () => {
    w = dworld();
    w.store.ejarModes[1] = "disabled";
    const importer = new EjarImportService(w.store, {} as never);
    const { status, body } = await httpError(importer.import(USER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(body.code, "ejar_disabled_for_account");
  });

  it("enabled overrides EJAR_ACCESS=allowlist for that account only", async () => {
    w = dworld({ env: { EJAR_ACCESS: "allowlist", EJAR_ALLOWED_USER_IDS: "5" } });
    w.store.ejarModes[1] = "enabled";
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.source, "ejar");
    assert.equal((await w.svc.budget(1, undefined, 1)).enabled, true);
    // Another account on default is still shut out by the allowlist.
    const { status, body } = await httpError(w.svc.lookup(OTHER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(body.code, "access_denied");
  });

  it("enabled does NOT override EJAR_ACCESS=off (the server kill switch)", async () => {
    w = dworld({ env: { EJAR_ACCESS: "off" } });
    w.store.ejarModes[1] = "enabled";
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: CN }));
    assert.equal(status, 403);
    assert.equal(body.code, "access_denied");
    assert.equal(w.calls.length, 0);
    assert.equal((await w.svc.budget(1, undefined, 1)).enabled, false);
  });

  it("client.request honours the account switch it is handed", async () => {
    w = dworld();
    await assert.rejects(
      w.client.request("contractDetails", { uuid: UUID }, { userId: 1, accountId: 1, accountMode: "disabled" }),
      (e: unknown) => e instanceof EjarApiError && (e as EjarApiError).status === 403,
    );
    assert.equal(w.dataCalls().length, 0);
  });
});
