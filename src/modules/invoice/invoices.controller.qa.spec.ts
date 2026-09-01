/**
 * QA pass over the `POST /invoices` gate.
 *
 * The property that matters is an ORDERING one: every refusal must happen
 * strictly before `InvoiceService.issue`, because `issue()` signs the document
 * and consumes an ICV that `invoices_user_owner_env_icv_uniq` will never let
 * anyone reclaim. So the controller is driven directly with a stub
 * `InvoiceService` that records whether it was reached — asserting only that a
 * call throws would pass just as well for a refusal made too late.
 *
 * `CreateInvoiceDto` is an interface, so `ValidationPipe({ whitelist: true })`
 * resolves its metatype to `Object` and passes the body through untouched.
 * Every value below is therefore reachable from a real HTTP client.
 *
 * Skipped when DATABASE_URL is unset (the gate reads the seller from the db).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { getPool, getDb } from "@dara/database";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { eInvoiceBuyerBlockers } from "../../common/invoice-readiness";
import { InvoicesController } from "./invoices.controller";
import type { InvoiceService } from "./services/invoice.service";
import type { PdfService } from "./services/pdf.service";

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && "DATABASE_URL not set";

let QA_USER = 0;
let user: AuthUser;

before(async () => {
  if (!HAS_DB) return;
  const { rows } = await getPool().query<{ id: number }>(
    `insert into users (email, password_hash, name)
     values ('invoices-gate-qa@dara.local', 'x', 'gate qa')
     on conflict (email) do update set name = excluded.name
     returning id`,
  );
  QA_USER = rows[0].id;
  user = { id: QA_USER, email: "invoices-gate-qa@dara.local", role: "user" };
});

after(async () => {
  if (!HAS_DB) return;
  await getPool().query("delete from users where id = $1", [QA_USER]);
  await getPool().end();
});

/** A controller whose `issue()` records that it was reached and never signs anything. */
function harness() {
  const calls: unknown[] = [];
  const invoices = {
    issue: async (_uid: number, dto: unknown) => {
      calls.push(dto);
      return { invoice: { id: 1 }, lines: [] };
    },
  } as unknown as InvoiceService;
  const controller = new InvoicesController(
    getDb() as never,
    invoices,
    {} as unknown as PdfService,
  );
  return { controller, calls };
}

/** A body that passes every gate for this user, so the negative cases are not vacuous. */
const GOOD_BUYER = {
  name: "Buyer Co", vat: "399999999900003", id: "1010101010", idScheme: "CRN",
  street: "King Fahd Rd", buildingNo: "1234", district: "Olaya", city: "Riyadh", postalZone: "12345",
};
const goodBody = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: `QA-${Math.random().toString(36).slice(2, 10)}`,
  profile: "standard",
  lines: [{ id: "1", name: "Rent", quantity: 1, unitPrice: 100, vatPercent: 15, vatCategory: "S" }],
  buyer: GOOD_BUYER,
  ...over,
});

/* ── Baseline ─────────────────────────────────────────────────────────────
 * If this does not reach `issue()`, every "was refused before issue" assertion
 * below is worthless — they would all pass on a controller that refuses
 * everything.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-C0 a well-formed contract-less body does reach issue()", { skip }, async () => {
  const { controller, calls } = harness();
  await controller.create(user, goodBody() as never);
  assert.equal(calls.length, 1, "the gate refuses a body it should pass — the negative tests below prove nothing");
});

/* ── The smuggling matrix ─────────────────────────────────────────────────
 * Every value here reaches the controller as raw client input. A refusal is
 * only worth anything if it lands before `issue()`.
 * ──────────────────────────────────────────────────────────────────────── */
const BAD_PROFILES: [string, unknown][] = [
  ["uppercase", "STANDARD"],
  ["title case", "Standard"],
  ["leading space", " standard"],
  ["trailing space", "standard "],
  ["null", null],
  ["zero", 0],
  ["array", ["standard"]],
  ["object", { toString: () => "standard" }],
  ["boolean", true],
  ["empty string", ""],
  ["arabic digit lookalike", "ѕtandard"], // Cyrillic 's'
];

for (const [label, value] of BAD_PROFILES) {
  test(`QA-C1 profile ${label} is refused before issue()`, { skip }, async () => {
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, goodBody({ profile: value }) as never),
      BadRequestException,
    );
    assert.equal(calls.length, 0, `profile ${label} reached issue() — an ICV would have been consumed`);
  });
}

const BAD_DOC_TYPES: [string, unknown][] = [
  ["uppercase", "INVOICE"],
  ["title case", "Invoice"],
  ["leading space", " invoice"],
  ["zero", 0],
  ["array", ["invoice"]],
  ["empty string", ""],
  ["unknown word", "proforma"],
];

for (const [label, value] of BAD_DOC_TYPES) {
  test(`QA-C2 docType ${label} is refused before issue()`, { skip }, async () => {
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, goodBody({ docType: value }) as never),
      BadRequestException,
    );
    assert.equal(calls.length, 0, `docType ${label} reached issue()`);
  });
}

const BAD_SUBMIT_TO: [string, unknown][] = [
  ["uppercase", "CLEARANCE"],
  ["title case", "Reporting"],
  ["leading space", " clearance"],
  ["array", ["reporting"]],
  ["zero", 0],
  ["empty string", ""],
  ["unknown word", "sandbox"],
];

for (const [label, value] of BAD_SUBMIT_TO) {
  test(`QA-C3 submitTo ${label} is refused before issue()`, { skip }, async () => {
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, goodBody({ submitTo: value }) as never),
      BadRequestException,
    );
    assert.equal(calls.length, 0, `submitTo ${label} reached issue()`);
  });
}

test("QA-C4 an absent or null submitTo is allowed — the service derives it", { skip }, async () => {
  for (const value of [undefined, null]) {
    const { controller, calls } = harness();
    await controller.create(user, goodBody({ submitTo: value }) as never);
    assert.equal(calls.length, 1, `submitTo ${String(value)} must be treated as "not specified"`);
  }
});

test("QA-C5 an absent docType is allowed — the service defaults it to invoice", { skip }, async () => {
  const { controller, calls } = harness();
  const body = goodBody();
  delete (body as Record<string, unknown>).docType;
  await controller.create(user, body as never);
  assert.equal(calls.length, 1);
});

test("QA-C6 a submitTo contradicting the profile is refused before issue()", { skip }, async () => {
  for (const [profile, submitTo] of [["simplified", "clearance"], ["standard", "reporting"]] as const) {
    const { controller, calls } = harness();
    const buyer = profile === "simplified" ? { name: "Walk-in" } : GOOD_BUYER;
    await assert.rejects(
      () => controller.create(user, goodBody({ profile, submitTo, buyer }) as never),
      BadRequestException,
      `${profile} + submitTo=${submitTo} was not refused`,
    );
    assert.equal(calls.length, 0, `${profile} + submitTo=${submitTo} reached issue()`);
  }
});

/* ── The buyer gate ───────────────────────────────────────────────────────
 * `eInvoiceBuyerBlockers` governs the DOCUMENT, not our customer record. A
 * `BuyerSnapshot` has no `email` or `phone` field at all, so demanding either
 * would make the endpoint permanently unusable — no caller could ever satisfy
 * it. That is the single most damaging thing this function could do, so it is
 * checked against every profile and a fully-populated buyer.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-C7 eInvoiceBuyerBlockers never demands email or phone", { skip: false }, () => {
  const inputs = [null, undefined, {}, { name: "x" }, GOOD_BUYER, { ...GOOD_BUYER, vat: "" }];
  for (const profile of ["standard", "simplified"] as const) {
    for (const buyer of inputs) {
      const missing = eInvoiceBuyerBlockers(buyer as never, profile);
      assert.equal(missing.includes("email"), false, `email demanded for ${profile} — BuyerSnapshot has no such field`);
      assert.equal(missing.includes("phone"), false, `phone demanded for ${profile} — BuyerSnapshot has no such field`);
    }
  }
});

test("QA-C8 the simplified path stays permissive — a name is the whole requirement", { skip: false }, () => {
  assert.deepEqual(eInvoiceBuyerBlockers({ name: "Walk-in Customer" } as never, "simplified"), []);
  assert.deepEqual(eInvoiceBuyerBlockers({ name: "x" } as never, "simplified"), []);
  assert.deepEqual(eInvoiceBuyerBlockers({} as never, "simplified"), ["name"]);
  assert.deepEqual(eInvoiceBuyerBlockers({ name: "   " } as never, "simplified"), ["name"], "whitespace is not a name");
  // Nothing about VAT, address or identifier may leak into the B2C path.
  const missing = eInvoiceBuyerBlockers({ name: "Walk-in" } as never, "simplified");
  assert.deepEqual(missing, [], `simplified must not demand ${missing.join(", ")}`);
});

test("QA-C9 a simplified invoice with only a buyer name reaches issue()", { skip }, async () => {
  const { controller, calls } = harness();
  await controller.create(user, goodBody({ profile: "simplified", buyer: { name: "Walk-in" } }) as never);
  assert.equal(calls.length, 1, "the B2C path must not require what B2C documents do not carry");
});

test("QA-C10 a standard invoice missing buyer VAT is refused before issue()", { skip }, async () => {
  const { controller, calls } = harness();
  await assert.rejects(
    () => controller.create(user, goodBody({ buyer: { ...GOOD_BUYER, vat: "" } }) as never),
    BadRequestException,
  );
  assert.equal(calls.length, 0, "an unregistered buyer on a standard invoice reached signing");
});

test("QA-C11 a standard invoice with no buyer at all is refused before issue()", { skip }, async () => {
  for (const buyer of [undefined, null, {}]) {
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, goodBody({ buyer }) as never),
      BadRequestException,
    );
    assert.equal(calls.length, 0, `buyer ${JSON.stringify(buyer)} reached issue()`);
  }
});

/* ── The contract-linked path ─────────────────────────────────────────────
 * The enum checks run before the `if (body.contractId)` branch, so they must
 * bite identically there. A contract that does not exist must also be refused
 * by the readiness gate rather than passed through.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-C12 a contract-linked body gets the same enum checks", { skip }, async () => {
  const { controller, calls } = harness();
  await assert.rejects(
    () => controller.create(user, goodBody({ contractId: 999_999, profile: "Standard" }) as never),
    BadRequestException,
  );
  assert.equal(calls.length, 0, "a bad profile slipped through on the contract path");
});

test("QA-C13 a contract-linked body still goes through checkInvoiceReadiness", { skip }, async () => {
  const { controller, calls } = harness();
  await assert.rejects(
    () => controller.create(user, goodBody({ contractId: 999_999 }) as never),
    (e: unknown) => {
      const body = (e as { response?: { error?: string } }).response;
      return e instanceof BadRequestException && body?.error === "invoice_not_ready";
    },
    "a nonexistent contract must be refused by the readiness gate, not passed to issue()",
  );
  assert.equal(calls.length, 0);
});

/* ── Input that is not an enum ────────────────────────────────────────────
 * `ownerId` is typed `number` on the interface and therefore unchecked at
 * runtime, exactly like `profile` was. It is fed straight into a `where id = $1`.
 * ──────────────────────────────────────────────────────────────────────── */
test("QA-C14 a non-numeric ownerId is refused as a 400, not a 500", { skip }, async () => {
  const { controller, calls } = harness();
  await assert.rejects(
    () => controller.create(user, goodBody({ ownerId: "abc" }) as never),
    BadRequestException,
    "an unvalidated ownerId reached the database driver",
  );
  assert.equal(calls.length, 0);
});
