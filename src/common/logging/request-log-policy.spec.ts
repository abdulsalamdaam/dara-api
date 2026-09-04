import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { shouldPersistRequest } from "./request-log.middleware";

/**
 * The DB-write policy, pinned.
 *
 * stdout carries one line per request; `app_logs` carries only the ones
 * somebody will come back to look for. Getting this wrong in either direction
 * is expensive: persist everything and the table is tens of thousands of rows
 * a day of nothing, persist too little and we are back to a customer's problem
 * leaving no trace at all — which is the situation this whole change exists to
 * end.
 */

const ENV_KEYS = ["APP_LOG_ALL_REQUESTS", "SLOW_REQUEST_MS"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("shouldPersistRequest", () => {
  it("keeps every 5xx", () => {
    // The whole point. A 500 used to print a stack with no request context and
    // die with the container.
    assert.equal(shouldPersistRequest(500, 12), true);
    assert.equal(shouldPersistRequest(502, 12), true);
  });

  it("keeps every 429 — a throttle rejection was completely silent before", () => {
    assert.equal(shouldPersistRequest(429, 5), true);
  });

  it("keeps 401 and 403, because those are what a customer reports", () => {
    // "It says I'm not allowed" is a real support ticket, and the same status
    // is what an attack looks like. Both need the history.
    assert.equal(shouldPersistRequest(401, 5), true);
    assert.equal(shouldPersistRequest(403, 5), true);
  });

  it("does NOT keep 404 or 400", () => {
    // Overwhelmingly bots probing paths and clients sending malformed queries:
    // high volume, near-zero diagnostic value, and they would be most of the
    // table. They still get their stdout line.
    assert.equal(shouldPersistRequest(404, 5), false);
    assert.equal(shouldPersistRequest(400, 5), false);
    assert.equal(shouldPersistRequest(422, 5), false);
  });

  it("does not keep an ordinary success", () => {
    assert.equal(shouldPersistRequest(200, 40), false);
    assert.equal(shouldPersistRequest(304, 3), false);
  });

  it("keeps anything slower than SLOW_REQUEST_MS, even a 200", () => {
    // A request that times out is reported as a failure by the user and as a
    // success by the server. The duration is the only place they disagree.
    assert.equal(shouldPersistRequest(200, 2_999), false);
    assert.equal(shouldPersistRequest(200, 3_000), true);
  });

  it("honours SLOW_REQUEST_MS, and ignores a nonsense value", () => {
    process.env.SLOW_REQUEST_MS = "500";
    assert.equal(shouldPersistRequest(200, 600), true);
    process.env.SLOW_REQUEST_MS = "not-a-number";
    // Falls back to the 3000ms default rather than to 0, which would persist
    // literally every request the moment somebody fat-fingers the env var.
    assert.equal(shouldPersistRequest(200, 600), false);
    assert.equal(shouldPersistRequest(200, 3_500), true);
  });

  it("persists everything under APP_LOG_ALL_REQUESTS, and only for the literal \"true\"", () => {
    process.env.APP_LOG_ALL_REQUESTS = "true";
    assert.equal(shouldPersistRequest(200, 1), true);
    assert.equal(shouldPersistRequest(404, 1), true);
    // Anything else is off — an override that turns itself on for "false" or
    // "0" is worse than no override.
    for (const v of ["false", "0", "1", "yes", ""]) {
      process.env.APP_LOG_ALL_REQUESTS = v;
      assert.equal(shouldPersistRequest(200, 1), false, v);
    }
  });
});
