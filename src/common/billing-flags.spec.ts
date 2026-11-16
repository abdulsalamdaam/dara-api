import { test } from "node:test";
import assert from "node:assert/strict";
import { testPriceFor, tokenizationEnabled } from "./billing-flags";

test("billing flags: per-account opt-in and test price", () => {
  const keep = { ...process.env };
  try {
    process.env.MOYASAR_SECRET_KEY = "sk_test_x";
    process.env.MOYASAR_PUBLISHABLE_KEY = "pk_test_x";
    delete process.env.BILLING_TOKENIZATION_ENABLED;
    process.env.BILLING_TOKENIZATION_USERS = " 7, 9 ,x";
    assert.equal(tokenizationEnabled(7), true);
    assert.equal(tokenizationEnabled(8), false);
    assert.equal(tokenizationEnabled(null), false);
    process.env.BILLING_TOKENIZATION_ENABLED = "true";
    assert.equal(tokenizationEnabled(8), true);
    delete process.env.MOYASAR_PUBLISHABLE_KEY;
    assert.equal(tokenizationEnabled(7), false, "no publishable key, no in-app form");

    process.env.BILLING_TEST_PRICE_USERS = "7=5, 9=1.5, 10=0, bad, 11=abc";
    assert.equal(testPriceFor(7), 5);
    assert.equal(testPriceFor(9), 1.5);
    assert.equal(testPriceFor(10), null);
    assert.equal(testPriceFor(11), null);
    assert.equal(testPriceFor(8), null);
    assert.equal(testPriceFor(undefined), null);
  } finally {
    process.env = keep;
  }
});
