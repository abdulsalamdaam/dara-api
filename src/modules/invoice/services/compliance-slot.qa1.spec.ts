/**
 * QA pass over "a compliance certificate is not a production one" (601526b).
 *
 * ZATCA onboarding is four steps. Step 2 (`issueComplianceCsid`) returns a
 * COMPLIANCE CSID into the very same `prod_*` columns a finished onboarding
 * lives in, so before the fix a row that reached step 2 and stopped was
 * indistinguishable from a live seller — and owner 264 spent a day signing real
 * invoices with a certificate `/core` answers 401 to.
 *
 * The fix hangs entirely off one string: `prod_slot_env` now says
 * `compliance-production` / `compliance-simulation` until a successful
 * `issueProductionCsid` promotes it. Four readers are supposed to honour that:
 * `isOnboarded()`, its SQL twin in the admin 360 view, `switchEnvironment()`,
 * and — transitively — every gate that calls the first.
 *
 * This file asks the only question that matters about such a fix: **is there
 * still a door?** A refusal in one place is worth nothing if a document can be
 * signed and submitted through another. So the tests below are not only about
 * the four readers agreeing; they drive the real `POST /invoices` controller
 * against a step-2 seller and check whether `InvoiceService.issue()` — which
 * signs, and which has no onboarding check of its own — is reachable.
 *
 * Every behavioural assertion is paired with a MUTATION PROOF: the same input
 * is run through `isOnboardedPreFix` / `PRE_FIX_ONBOARDED_SQL` below, which are
 * verbatim copies of the two mechanisms with the new clause removed. Asserting
 * that the real implementation and the broken one DISAGREE on exactly the
 * compliance rows (and agree everywhere else) is the same evidence as deleting
 * the clause and watching the suite go red — except it stays in the repository,
 * so deleting the clause later turns these tests red on its own.
 *
 * DB-gated on DATABASE_URL; everything that writes runs inside a transaction
 * that is always rolled back. Point it at a scratch database, never at .env.
 */
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  db, getDb, getPool, usersTable, ownersTable, invoicesTable, zatcaCredentialsTable,
  type ZatcaCredentials,
} from "@dara/database";
import { isOnboarded } from "../../../common/invoice-readiness";
import { encryptString } from "../../../common/crypto/encryption";
import { ZatcaOnboardingService } from "./zatca-onboarding.service";
import { InvoicesController } from "../invoices.controller";
import { ZatcaOnboardingController } from "../zatca-onboarding.controller";
import { InvoiceService } from "./invoice.service";
import type { PdfService } from "./pdf.service";
import type { AuthUser } from "../../../common/guards/jwt-auth.guard";

// The onboarding service encrypts the CSID secret before storing it. Any key
// will do — the tests only ever decrypt what they themselves encrypted.
process.env.APP_ENCRYPTION_KEY ||= "qa1-compliance-slot-fixture-key";

/** This file's directory. tsx transpiles the suite to CJS, so `__dirname` is it. */
const HERE = __dirname;

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && "DATABASE_URL not set";

class Rollback extends Error {}

let userId = 0;
let user: AuthUser;

before(async () => {
  if (!HAS_DB) return;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  userId = u?.id ?? 0;
  assert.ok(userId, "no users row — seed one before running this suite");
  user = { id: userId, email: "qa1@dara.local", role: "user" } as AuthUser;
});
after(async () => {
  if (HAS_DB) await getPool().end();
});

/* ══════════════════════════════════════════════════════════════════════════
 * The mechanism, and the mechanism with the fix taken back out.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * `isOnboarded()` exactly as it stood BEFORE 601526b — same code, minus the
 * one `compliance%` line. Every assertion about the new behaviour is checked
 * against this too, so a test can only pass because of the clause it claims to
 * be testing. Delete the clause from the real function and the "must disagree"
 * assertions below fail immediately.
 */
function isOnboardedPreFix(creds: ZatcaCredentials | undefined | null): boolean {
  if (!creds) return false;
  if (creds.linkInvalidAt) return false;
  const sandbox = creds.activeEnvironment === "sandbox";
  const cert = sandbox ? creds.sandboxCertPem : creds.prodCertPem;
  const key = sandbox ? creds.sandboxPrivateKeyEnc : creds.prodPrivateKeyEnc;
  const token = sandbox ? creds.sandboxBinarySecurityToken : creds.prodBinarySecurityToken;
  const secret = sandbox ? creds.sandboxSecretEnc : creds.prodSecretEnc;
  return !!(cert && key && token && secret);
}

/**
 * The admin 360 view's SQL twin (`customer-overview.controller.ts` →
 * `onboardedSql`), copied verbatim, and the same predicate without the new
 * clause. Copied rather than imported because it is a private literal inside a
 * controller method — which is precisely why it can drift, and why this file
 * checks the two against each other on every row of the matrix.
 */
const ONBOARDED_SQL = `z.link_invalid_at is null
  and not (coalesce(z.prod_slot_env, '') like 'compliance%' and z.active_environment <> 'sandbox')
  and case when z.active_environment = 'sandbox'
    then (z.sandbox_cert_pem is not null and z.sandbox_private_key_enc is not null
          and z.sandbox_binary_security_token is not null and z.sandbox_secret_enc is not null)
    else (z.prod_cert_pem is not null and z.prod_private_key_enc is not null
          and z.prod_binary_security_token is not null and z.prod_secret_enc is not null)
  end`;

const PRE_FIX_ONBOARDED_SQL = `z.link_invalid_at is null
  and case when z.active_environment = 'sandbox'
    then (z.sandbox_cert_pem is not null and z.sandbox_private_key_enc is not null
          and z.sandbox_binary_security_token is not null and z.sandbox_secret_enc is not null)
    else (z.prod_cert_pem is not null and z.prod_private_key_enc is not null
          and z.prod_binary_security_token is not null and z.prod_secret_enc is not null)
  end`;

/* ══════════════════════════════════════════════════════════════════════════
 * Fixtures
 * ═══════════════════════════════════════════════════════════════════════ */

const PROFILE = {
  sellerName: "QA1 Seller", sellerVatNumber: "300000000000003",
  sellerStreet: "S", sellerBuildingNo: "1", sellerDistrict: "D",
  sellerCity: "Riyadh", sellerPostalZone: "12211",
  serialNumber: "1-Dara|2-PMS|3-9001",
  organizationIdentifier: "300000000000003",
  organizationUnitName: "QA1 Unit",
  locationAddress: "Riyadh", industryCategory: "Real Estate",
  commonName: "Dara QA1",
} as const;

/** The prod slot, filled — whichever kind of certificate it is holding. */
const PROD_MATERIAL = {
  prodPrivateKeyEnc: encryptString("prod-private-key"), prodPublicKeyPem: "PUB", prodCsrPem: "CSR",
  prodBinarySecurityToken: "PROD-TOKEN", prodSecretEnc: encryptString("prod-compliance-secret"),
  prodCertPem: "CERT", prodComplianceRequestId: "1787837521875",
  prodOnboardedAt: new Date(),
} as const;

/** The sandbox slot, filled. */
const SANDBOX_MATERIAL = {
  sandboxPrivateKeyEnc: encryptString("sandbox-private-key"), sandboxPublicKeyPem: "PUB-S", sandboxCsrPem: "CSR-S",
  sandboxBinarySecurityToken: "SANDBOX-TOKEN", sandboxSecretEnc: encryptString("sandbox-secret"),
  sandboxCertPem: "CERT-S", sandboxComplianceRequestId: "1787837500000",
  sandboxOnboardedAt: new Date(),
} as const;

/**
 * Every state a `zatca_credentials` row can be in around this fix, with the
 * verdict the product intends for each. `disagreesWithPreFix` marks the rows
 * the change is FOR — the ones where the old code said "live" and the new one
 * must not.
 */
type Row = Record<string, unknown>;
interface Case { label: string; row: Row; onboarded: boolean; disagreesWithPreFix: boolean }

const CASES: Case[] = [
  {
    label: "step 2 of 4 on production — a compliance CSID in the prod slot",
    row: { activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL },
    onboarded: false, disagreesWithPreFix: true,
  },
  {
    label: "step 2 of 4 on simulation",
    row: { activeEnvironment: "simulation", prodSlotEnv: "compliance-simulation", ...PROD_MATERIAL },
    onboarded: false, disagreesWithPreFix: true,
  },
  {
    label: "promoted to a real production CSID",
    row: { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL },
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "promoted to a simulation CSID, operating on simulation",
    row: { activeEnvironment: "simulation", prodSlotEnv: "simulation", ...PROD_MATERIAL },
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "sandbox seller — the only certificate sandbox has IS a compliance one",
    row: { activeEnvironment: "sandbox", prodSlotEnv: null, ...SANDBOX_MATERIAL },
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "sandbox seller whose prod slot still holds an abandoned compliance CSID",
    row: {
      activeEnvironment: "sandbox", prodSlotEnv: "compliance-production",
      ...SANDBOX_MATERIAL, ...PROD_MATERIAL,
    },
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "pre-column row — prodSlotEnv null on production",
    row: { activeEnvironment: "production", prodSlotEnv: null, ...PROD_MATERIAL },
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "LEGACY step-2 row — old code stamped 'production' on a compliance CSID",
    row: { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL },
    // Identical, column for column, to the promoted case above. Nothing in the
    // schema can tell them apart, which is the whole of finding #7.
    onboarded: true, disagreesWithPreFix: false,
  },
  {
    label: "compliance slot AND a link ZATCA has revoked",
    row: {
      activeEnvironment: "production", prodSlotEnv: "compliance-production",
      ...PROD_MATERIAL, linkInvalidAt: new Date(), linkInvalidReason: "401",
    },
    onboarded: false, disagreesWithPreFix: false, // the flag already refused it
  },
  {
    label: "unlinked after reaching step 2 — slot label kept, material gone",
    row: { activeEnvironment: "sandbox", prodSlotEnv: "compliance-production" },
    onboarded: false, disagreesWithPreFix: false,
  },
];

/** Insert a landlord + a credentials row shaped by `row`, then roll back. */
async function withRow(
  row: Row,
  fn: (ctx: { tx: typeof db; ownerId: number; credsId: number }) => Promise<void>,
) {
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.insert(ownersTable).values({
        userId, name: "مؤجر QA1", type: "individual", idNumber: "1000009001",
        phone: "+966500009001", email: "qa1-slot@test.local",
        taxNumber: "300000000000003", status: "active",
      }).returning();
      const [creds] = await tx.insert(zatcaCredentialsTable)
        .values({ userId, ownerId: owner!.id, ...PROFILE, ...row } as never).returning();
      await fn({ tx: tx as never, ownerId: owner!.id, credsId: creds!.id });
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** The onboarding service with only the collaborators a test actually reaches. */
const svc = (tx: unknown, api: unknown = null) =>
  new ZatcaOnboardingService(tx as never, null as never, api as never, null as never, null as never);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. isOnboarded() — the one definition every gate is supposed to share.
 * ═══════════════════════════════════════════════════════════════════════ */

for (const c of CASES) {
  test(`QA1-A ${c.label} → onboarded=${c.onboarded}`, () => {
    assert.equal(isOnboarded(c.row as never), c.onboarded);
  });
}

test("QA1-A* the compliance clause is what produces those verdicts (mutation proof)", () => {
  // Run the identical inputs through the pre-fix function. If the clause were
  // removed from `isOnboarded`, the two would agree everywhere and this fails.
  let disagreements = 0;
  for (const c of CASES) {
    const now = isOnboarded(c.row as never);
    const then = isOnboardedPreFix(c.row as never);
    if (c.disagreesWithPreFix) {
      assert.notEqual(now, then, `${c.label}: the fix must change this verdict`);
      assert.equal(then, true, `${c.label}: the old code called this seller live`);
      disagreements += 1;
    } else {
      assert.equal(now, then, `${c.label}: the fix must NOT change this verdict`);
    }
  }
  assert.equal(disagreements, 2, "both compliance-slot states must be newly refused");
});

test("QA1-A1 the clause is scoped to non-sandbox — sandbox onboarding is untouched", () => {
  // Sandbox NEVER gets anything but a compliance CSID; ZATCA's developer portal
  // issues no production CSID for it. A clause that caught sandbox would refuse
  // every sandbox seller in the product.
  const sandboxRow = { activeEnvironment: "sandbox", prodSlotEnv: "compliance-production", ...SANDBOX_MATERIAL };
  assert.equal(isOnboarded(sandboxRow as never), true);
  // …and it is the ACTIVE environment that scopes it, not the slot label: the
  // same row pointed at production must be refused.
  assert.equal(isOnboarded({ ...sandboxRow, activeEnvironment: "production", ...PROD_MATERIAL } as never), false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The SQL twin in the admin 360 view must give the same answer.
 * ═══════════════════════════════════════════════════════════════════════ */

test("QA1-B the admin SQL twin agrees with isOnboarded() on every state", { skip }, async () => {
  for (const c of CASES) {
    await withRow(c.row, async ({ tx, credsId }) => {
      const res = await (tx as typeof db).execute(sql.raw(
        `select (${ONBOARDED_SQL}) as now, (${PRE_FIX_ONBOARDED_SQL}) as then
         from zatca_credentials z where z.id = ${credsId}`,
      )) as unknown as { rows: Array<{ now: boolean | null; then: boolean | null }> };
      const r = res.rows[0]!;
      assert.equal(
        r.now === true, c.onboarded,
        `admin SQL disagrees with isOnboarded() for: ${c.label}`,
      );
      // Mutation proof, in SQL this time.
      if (c.disagreesWithPreFix) {
        assert.notEqual(r.now === true, r.then === true, `${c.label}: the SQL clause must change this verdict`);
      } else {
        assert.equal(r.now === true, r.then === true, `${c.label}: the SQL clause must not change this verdict`);
      }
    });
  }
});

test("QA1-B* the copied predicate is still the one the admin view runs (drift check)", () => {
  // QA1-B proves the SQL SEMANTICS match `isOnboarded`. It proves that about a
  // COPY, so on its own it would keep passing after someone edited the
  // controller. Pin the text as well: the two must be the same predicate.
  const src = readFileSync(
    join(HERE, "../../admin/customer-overview.controller.ts"), "utf8",
  );
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  assert.ok(
    squash(src).includes(squash(ONBOARDED_SQL)),
    "customer-overview.controller.ts no longer contains this predicate — the admin 360 " +
    "view and isOnboarded() have drifted; re-copy it here and re-run QA1-B",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2b. issueComplianceCsid — the write that the whole fix rests on.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Enough of CsrService/ZatcaApiService for step 2 to complete. */
function onboardingStubs() {
  const csr = {
    generateCsr: async () => ({
      csrBase64: "Q1NS", csr: "-----BEGIN CERTIFICATE REQUEST-----", 
      privateKey: "PRIVATE-KEY", publicKey: "PUBLIC-KEY",
    }),
  };
  const api = {
    getComplianceCsid: async () => ({
      status: 200, headers: {}, raw: "",
      json: {
        binarySecurityToken: Buffer.from("COMPLIANCE-CERT-BODY").toString("base64"),
        secret: "compliance-secret", requestID: "1787837521875",
      },
    }),
  };
  return { csr, api };
}

const onboardingSvc = (tx: unknown) => {
  const { csr, api } = onboardingStubs();
  return new ZatcaOnboardingService(tx as never, csr as never, api as never, null as never, null as never);
};

for (const [env, slot] of [["production", "compliance-production"], ["simulation", "compliance-simulation"]] as const) {
  test(`QA1-H step 2 on ${env} stamps the slot "${slot}", not "${env}"`, { skip }, async () => {
    await withRow({ activeEnvironment: "sandbox", prodSlotEnv: null }, async ({ tx, ownerId, credsId }) => {
      await onboardingSvc(tx).issueComplianceCsid(userId, env, "123456", ownerId);
      const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
        .where(eq(zatcaCredentialsTable.id, credsId));
      assert.equal(row!.prodSlotEnv, slot, "a compliance CSID must never claim the final environment");
      assert.equal(row!.activeEnvironment, env, "…while the record still points at the slot it landed in");
      assert.ok(row!.prodCertPem, "the certificate IS stored — every column looks onboarded");
      assert.ok(row!.prodOnboardedAt, "…including the timestamp");
      // Which is the entire point: the columns are indistinguishable from a
      // finished onboarding, so the slot label is the only thing refusing.
      assert.equal(isOnboarded(row), false);
      assert.equal(isOnboardedPreFix(row), true, "the pre-fix code called this seller live");
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE DOORS. Can a document still be signed with a compliance certificate?
 *
 * `InvoiceService.issue()` has no onboarding check of its own — it calls
 * `getActiveCredentials()`, which deliberately still hands back the compliance
 * certificate (the compliance suite needs it). Everything therefore rests on
 * the callers refusing first, so the controller is driven directly with a stub
 * `issue()` that records whether it was reached. Asserting only that a call
 * throws would pass just as well for a refusal made after the signature.
 * ═══════════════════════════════════════════════════════════════════════ */

function harness() {
  const calls: unknown[] = [];
  const invoices = {
    issue: async (_uid: number, dto: unknown) => {
      calls.push(dto);
      return { invoice: { id: 1, status: "reported", submittedTo: "reporting" }, lines: [] };
    },
  } as unknown as InvoiceService;
  return {
    calls,
    controller: new InvoicesController(getDb() as never, invoices, {} as unknown as PdfService),
  };
}

const GOOD_BUYER = {
  name: "Buyer Co", vat: "399999999900003", id: "1010101010", idScheme: "CRN",
  street: "King Fahd Rd", buildingNo: "1234", district: "Olaya", city: "Riyadh", postalZone: "12345",
};
const body = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: `QA1-${Math.random().toString(36).slice(2, 10)}`,
  profile: "standard",
  lines: [{ id: "1", name: "Rent", quantity: 1, unitPrice: 100, vatPercent: 15, vatCategory: "S" }],
  buyer: GOOD_BUYER,
  ...over,
});

/**
 * The controller reads the seller through the module-level `getDb()`, not
 * through any transaction we could roll back, so these cases commit and clean
 * up after themselves.
 */
async function withCommittedRow(row: Row, fn: (ownerId: number) => Promise<void>) {
  const [owner] = await db.insert(ownersTable).values({
    userId, name: "مؤجر QA1 (gate)", type: "individual", idNumber: "1000009002",
    phone: "+966500009002", email: "qa1-gate@test.local",
    taxNumber: "300000000000003", status: "active",
  }).returning();
  const [creds] = await db.insert(zatcaCredentialsTable)
    .values({ userId, ownerId: owner!.id, ...PROFILE, ...row } as never).returning();
  try {
    await fn(owner!.id);
  } finally {
    await db.delete(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, creds!.id));
    await db.delete(ownersTable).where(eq(ownersTable.id, owner!.id));
  }
}

const STEP_TWO = { activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL };
const PROMOTED = { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL };

test("QA1-C0 baseline — a promoted seller's invoice does reach issue()", { skip }, async () => {
  // Without this the refusals below prove nothing: they would pass just as well
  // on a controller that refuses everything.
  await withCommittedRow(PROMOTED, async (ownerId) => {
    const { controller, calls } = harness();
    await controller.create(user, body({ ownerId }) as never);
    assert.equal(calls.length, 1);
  });
});

test("QA1-C1 a step-2 seller cannot issue an INVOICE — refused before issue()", { skip }, async () => {
  await withCommittedRow(STEP_TWO, async (ownerId) => {
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, body({ ownerId }) as never),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestException);
        const r = (e as BadRequestException).getResponse() as any;
        assert.equal(r.error, "invoice_not_ready");
        assert.equal(r.readiness.blockers[0].missing[0], "zatcaOnboardingIncomplete");
        return true;
      },
    );
    assert.equal(calls.length, 0, "the compliance certificate would have signed a real invoice");
  });
});

/*
 * ── FIXED (was finding #1) ───────────────────────────────────────────────
 * The seller gate on the contract-less path is still skipped for credit and
 * debit notes, and that is right: a note corrects an invoice that has already
 * gone out, and the exemption exists for a link revoked AFTER the original was
 * filed. What it could not do was tell that apart from a seller who was never
 * linked — so the refusal moved to where every caller must pass it, inside
 * `InvoiceService.issue()`, immediately after `getActiveCredentials`.
 *
 * The note exemption is gone. It was written on the premise that a note
 * corrects an invoice that already went out, so it must stay issuable even
 * after the link is revoked — but with a revoked link there is no certificate
 * ZATCA accepts, so such a note could never be filed. Both doors close now.
 * ─────────────────────────────────────────────────────────────────────────
 */
for (const docType of ["credit", "debit"] as const) {
  test(`QA1-C2 a ${docType} note from an un-onboarded seller is refused at the door`, { skip }, async () => {
    await withCommittedRow(STEP_TWO, async (ownerId) => {
      const { controller, calls } = harness();
      await assert.rejects(
        () => controller.create(user, body({ ownerId, docType, billingReferenceId: "INV-1" }) as never),
      );
      assert.equal(calls.length, 0, "nothing may reach the signer");
    });
  });
}

/**
 * The real `InvoiceService`, wired to the real onboarding service and the real
 * database. `builder`, `signer`, `api` and the translator are deliberately
 * null: the gate under test fires before any of them is touched, so reaching
 * one at all would prove the gate had already been passed.
 */
function realInvoiceService() {
  const onboarding = new ZatcaOnboardingService(
    getDb() as never, null as never, null as never, null as never, null as never,
  );
  return new InvoiceService(
    getDb() as never, null as never, null as never, null as never, onboarding, null as never,
  );
}

const issueDto = (ownerId: number, over: Record<string, unknown> = {}) => ({
  invoiceNumber: `QA1-ISSUE-${Math.random().toString(36).slice(2, 10)}`,
  profile: "standard" as const,
  ownerId,
  buyer: GOOD_BUYER,
  lines: [{ id: "1", name: "Rent", quantity: 1, unitPrice: 100, vatPercent: 15, vatCategory: "S" }],
  ...over,
});

const DOC_LABEL = { invoice: "an invoice", credit: "a credit note", debit: "a debit note" } as const;
for (const docType of ["invoice", "credit", "debit"] as const) {
  test(`QA1-C2b issue() refuses ${DOC_LABEL[docType]} from a step-2 seller`, { skip }, async () => {
    await withCommittedRow(STEP_TWO, async (ownerId) => {
      await assert.rejects(
        () => realInvoiceService().issue(userId, issueDto(ownerId, { docType, billingReferenceId: "INV-1" }) as never),
        (e: unknown) => {
          assert.ok(e instanceof ConflictException, `threw ${String(e)}`);
          assert.equal(((e as ConflictException).getResponse() as any).error, "zatca_not_onboarded");
          return true;
        },
      );
      // Nothing was written and no ICV was spent — the refusal is before the
      // signature, not after it.
      const rows = await db.select({ id: invoicesTable.id }).from(invoicesTable)
        .where(eq(invoicesTable.ownerId, ownerId));
      assert.equal(rows.length, 0);
    });
  });
}

test("QA1-C2c baseline — a promoted seller gets PAST that gate", { skip }, async () => {
  // Without this, QA1-C2b would pass just as well on a service that refuses
  // everything. A promoted seller must fail somewhere LATER (the null builder),
  // never with `zatca_not_onboarded`.
  await withCommittedRow(PROMOTED, async (ownerId) => {
    await assert.rejects(
      () => realInvoiceService().issue(userId, issueDto(ownerId) as never),
      (e: unknown) => {
        const code = (e as any)?.response?.error ?? (typeof (e as any)?.getResponse === "function"
          ? ((e as any).getResponse() as any)?.error : undefined);
        assert.notEqual(code, "zatca_not_onboarded", "the gate refuses a seller who has completed onboarding");
        return true;
      },
    );
  });
});

/*
 * ── OBSERVATION ──────────────────────────────────────────────────────────
 * The note exemption at the controller is kept on the stated grounds that "a
 * note corrects an invoice that already went out — it must stay issuable for a
 * link revoked AFTER the original was filed". The new gate inside `issue()`
 * uses `isOnboarded`, which returns false for `linkInvalidAt` as well as for a
 * compliance slot. So that case is refused too: the exemption forwards the note
 * and `issue()` stops it a moment later. The exemption is now unreachable — it
 * changes which error the caller sees, nothing more.
 *
 * Not necessarily wrong (both doors closed is a defensible answer), but it is
 * not what the comment says the code does. Pinned so the decision is explicit.
 * ─────────────────────────────────────────────────────────────────────────
 */
test("QA1-C5 a note under a REVOKED link is refused, at both doors", { skip }, async () => {
  const revoked = { ...PROMOTED, linkInvalidAt: new Date(), linkInvalidReason: "ZATCA 401" };
  await withCommittedRow(revoked, async (ownerId) => {
    // The controller refuses it now — the exemption that used to wave notes
    // through is gone, because a revoked link cannot sign anything ZATCA takes.
    const { controller, calls } = harness();
    await assert.rejects(
      () => controller.create(user, body({ ownerId, docType: "credit", billingReferenceId: "INV-1" }) as never),
    );
    assert.equal(calls.length, 0);
    // And issue() would refuse it too, so no other caller can be the gap.
    await assert.rejects(
      () => realInvoiceService().issue(userId, issueDto(ownerId, { docType: "credit", billingReferenceId: "INV-1" }) as never),
      (e: unknown) => {
        assert.equal(((e as ConflictException).getResponse() as any).error, "zatca_not_onboarded");
        return true;
      },
    );
  });
});

test("QA1-C3 getActiveCredentials still serves the compliance certificate — deliberately", { skip }, async () => {
  // It has to: the compliance suite signs with exactly this certificate, and
  // that is the step ZATCA requires before it will issue a production CSID.
  // Safe only because the one path that mints a REAL document now refuses the
  // row itself — which is QA1-C2b.
  await withCommittedRow(STEP_TWO, async (ownerId) => {
    const { decrypted, creds } = await svc(getDb()).getActiveCredentials(userId, ownerId);
    assert.equal(creds.prodSlotEnv, "compliance-production");
    assert.equal(decrypted.binarySecurityToken, "PROD-TOKEN");
    assert.equal(isOnboarded(creds), false, "…while the gate that guards real documents says no");
  });
});

test("QA1-C4 the same seller is refused by the billing mirror's gate", { skip }, async () => {
  // `runZatcaSubmission` uses `isOnboarded` rather than a local certificate
  // test, so the best-effort mirror on the plain-billing side is closed.
  await withRow(STEP_TWO, async ({ tx, ownerId }) => {
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.ownerId, ownerId));
    assert.equal(isOnboarded(row), false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. switchEnvironment — the manual door to "live".
 * ═══════════════════════════════════════════════════════════════════════ */

for (const slot of ["compliance-production", "compliance-simulation"] as const) {
  test(`QA1-D1 switchEnvironment("production") refuses a ${slot} slot`, { skip }, async () => {
    await withRow({ activeEnvironment: "simulation", prodSlotEnv: slot, ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
      await assert.rejects(
        () => svc(tx).switchEnvironment(userId, "production", ownerId),
        (e: unknown) => {
          assert.ok(e instanceof ConflictException);
          // Named, not merely thrown. Without this the test passes for the
          // wrong reason: strip the compliance guard and the row is still
          // refused a few lines later by the "test cycle incomplete" check —
          // a refusal that a single cleared invoice ANYWHERE on the account
          // makes go away, because that query filters on user_id alone.
          assert.match(
            String((e as ConflictException).message),
            /الشهادة الحالية للفحص فقط/,
            "refused, but not by the compliance-slot guard",
          );
          return true;
        },
      );
      const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
        .where(eq(zatcaCredentialsTable.id, credsId));
      assert.notEqual(row!.activeEnvironment, "production", "the pointer must not have moved");
    });
  });
}

test("QA1-D2 switchEnvironment('simulation') is ungated — but leaves the row un-onboarded", { skip }, async () => {
  // Nothing checks anything for a non-production target, so a step-2 seller can
  // point themselves at simulation. That is harmless only because `isOnboarded`
  // then refuses the row on the compliance slot — assert that, because it is
  // the single thing standing between this and a signed simulation document.
  await withRow({ activeEnvironment: "sandbox", prodSlotEnv: "compliance-simulation", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    await svc(tx).switchEnvironment(userId, "simulation", ownerId);
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.activeEnvironment, "simulation");
    assert.equal(isOnboarded(row), false);
    assert.equal(isOnboardedPreFix(row), true, "…which the pre-fix code did not do");
  });
});

test("QA1-D3 the test-cycle gate is scoped to the landlord, not the account", { skip }, async () => {
  // Was `eq(invoicesTable.userId, userId)` alone, so one landlord's completed
  // production cycle satisfied the gate for every other landlord on the
  // account — including ones that had never submitted anything.
  try {
    await db.transaction(async (tx) => {
      const mk = async (n: number, row: Row) => {
        const [o] = await tx.insert(ownersTable).values({
          userId, name: `مؤجر QA1-${n}`, type: "individual", idNumber: `10000090${n}0`,
          phone: `+9665000090${n}0`, email: `qa1-scope-${n}@test.local`,
          taxNumber: "300000000000003", status: "active",
        }).returning();
        await tx.insert(zatcaCredentialsTable)
          .values({ userId, ownerId: o!.id, ...PROFILE, ...row } as never);
        return o!.id;
      };
      // A: has run the full production test cycle. B: promoted, but has filed
      // nothing at all.
      const a = await mk(1, { ...PROMOTED, prodComplianceRequestId: null });
      const b = await mk(2, { ...PROMOTED, prodComplianceRequestId: null });
      const CYCLE = [
        { profile: "standard", docType: "invoice" }, { profile: "simplified", docType: "invoice" },
        { profile: "standard", docType: "credit" }, { profile: "standard", docType: "debit" },
      ] as const;
      let icv = 0;
      for (const d of CYCLE) {
        icv += 1;
        await tx.insert(invoicesTable).values({
          userId, ownerId: a, invoiceNumber: `A-${icv}`, uuid: `uuid-a-${icv}`,
          profile: d.profile, docType: d.docType, issueDate: "2026-01-01", issueTime: "10:00:00",
          icv, pih: "PIH", environment: "production", status: "cleared",
          sellerSnapshot: {}, totals: {}, unsignedXml: "<x/>",
        } as never);
      }
      // A passes.
      await svc(tx).switchEnvironment(userId, "production", a);
      // B must not inherit A's cycle.
      await assert.rejects(
        () => svc(tx).switchEnvironment(userId, "production", b),
        (e: unknown) => {
          assert.ok(e instanceof ConflictException);
          assert.match(String((e as ConflictException).message), /test cycle/i);
          return true;
        },
      );
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4b. GET /zatca/credentials — the settings checklist.
 * ═══════════════════════════════════════════════════════════════════════ */

const credsController = () =>
  new ZatcaOnboardingController(svc(getDb()) as never, null as never);

test("QA1-I GET /zatca/credentials does not call a compliance slot 'onboarded'", { skip }, async () => {
  // Was `!!c.prodCertPem` — a certificate alone, which a step-2 row has.
  await withCommittedRow(STEP_TWO, async (ownerId) => {
    const r = await credsController().getCreds(user, String(ownerId)) as any;
    assert.equal(r.production.onboarded, false);
  });
  await withCommittedRow(PROMOTED, async (ownerId) => {
    const r = await credsController().getCreds(user, String(ownerId)) as any;
    assert.equal(r.production.onboarded, true, "…while a promoted seller still reads as onboarded");
  });
});

test("QA1-I2 a sandbox seller is not reported as production-onboarded", { skip }, async () => {
  // `isOnboarded` alone would say true for a sandbox row, because sandbox is a
  // complete onboarding in its own right — the endpoint has to ask about the
  // PRODUCTION slot specifically.
  await withCommittedRow({ activeEnvironment: "sandbox", prodSlotEnv: null, ...SANDBOX_MATERIAL }, async (ownerId) => {
    const r = await credsController().getCreds(user, String(ownerId)) as any;
    assert.equal(r.sandbox.onboarded, true);
    assert.equal(r.production.onboarded, false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. issueProductionCsid — the promotion, its short-circuit, and its refusals.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A `ZatcaApiService` stand-in that records what it was asked for. */
function apiStub(reply: { status: number; json?: unknown; raw?: string }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    api: {
      getProductionCsid: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: reply.status, headers: {}, raw: reply.raw ?? "", json: reply.json ?? null };
      },
    },
  };
}

const CSID_OK = { status: 200, json: { binarySecurityToken: Buffer.from("PROMOTED-CERT-BODY").toString("base64"), secret: "prod-secret" } };

test("QA1-E0 baseline — promoting a compliance-production slot calls ZATCA and stamps 'production'", { skip }, async () => {
  await withRow({ activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    const { api, calls } = apiStub(CSID_OK);
    await svc(tx, api).issueProductionCsid(userId, "production", ownerId);
    assert.equal(calls.length, 1, "the promotion must actually reach ZATCA");
    assert.equal(calls[0]!.environment, "production");
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.prodSlotEnv, "production", "only a successful promotion earns this");
    assert.equal(row!.activeEnvironment, "production");
    assert.equal(
      row!.prodComplianceRequestId, null,
      "the compliance request id is SPENT — its absence is what proves the slot was promoted",
    );
    assert.equal(isOnboarded(row), true);
  });
});

test("QA1-E1 'Already-Generated' is a refusal, and leaves the slot marked compliance", { skip }, async () => {
  await withRow({ activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    const { api } = apiStub({ status: 400, raw: '{"errors":[{"code":"Already-Generated"}]}' });
    await assert.rejects(
      () => svc(tx, api).issueProductionCsid(userId, "production", ownerId),
      (e: unknown) => {
        assert.ok(e instanceof ConflictException);
        assert.equal(((e as ConflictException).getResponse() as any).error, "zatca_production_csid_exists");
        return true;
      },
    );
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    // The seller stays refused. Softening this into success is exactly how
    // owner 264 came to be marked live on a compliance certificate.
    assert.equal(row!.prodSlotEnv, "compliance-production");
    assert.equal(isOnboarded(row), false);
    assert.equal(isOnboardedPreFix(row), true, "…and the pre-fix code would have let them issue");
  });
});

/*
 * ── FIXED (was finding #2) ───────────────────────────────────────────────
 * The short-circuit used to fire on `prodSlotEnv === promotedSlot &&
 * prodCertPem && prodOnboardedAt` — byte for byte what the OLD compliance step
 * wrote — so the one endpoint that could repair a half-onboarded row returned
 * HTTP 200 with the compliance token and never contacted ZATCA. It now also
 * requires the compliance request id to be GONE, and a successful promotion is
 * what clears it. Three states, three different answers.
 * ─────────────────────────────────────────────────────────────────────────
 */
test("QA1-E2 a legacy step-2 row no longer short-circuits — it really promotes", { skip }, async () => {
  // `prodSlotEnv: "production"` over a compliance certificate is exactly the
  // row the old code left behind. The unspent compliance request id is the
  // thing that gives it away.
  await withRow({ activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    const { api, calls } = apiStub(CSID_OK);
    await svc(tx, api).issueProductionCsid(userId, "production", ownerId);
    assert.equal(calls.length, 1, "ZATCA must actually be asked — this row was never promoted");
    assert.equal(calls[0]!.complianceRequestId, "1787837521875");
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.notEqual(row!.prodCertPem, "CERT", "the compliance certificate has been replaced");
    assert.equal(row!.prodComplianceRequestId, null);
  });
});

test("QA1-E2b a genuinely promoted row DOES short-circuit", { skip }, async () => {
  // The case the short-circuit exists for: asking twice returns
  // "Already-Generated", which read as a failure on an onboarding that had
  // finished. A promoted row has no compliance request id left to spend.
  await withRow(
    { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL, prodComplianceRequestId: null },
    async ({ tx, ownerId }) => {
      const { api, calls } = apiStub(CSID_OK);
      const r = await svc(tx, api).issueProductionCsid(userId, "production", ownerId);
      assert.equal(calls.length, 0, "ZATCA must not be asked a second time");
      assert.equal(r.httpStatus, 200);
      assert.equal(r.binarySecurityToken, "PROD-TOKEN");
    },
  );
});

test("QA1-E2c …and it short-circuits BEFORE the 'run onboarding first' check", { skip }, async () => {
  // A promoted row's compliance request id is null, which is precisely what the
  // presence check treats as "never onboarded". Ordering is the whole fix here:
  // put the short-circuit after it and every promoted seller is told to start
  // over.
  await withRow(
    { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL, prodComplianceRequestId: null },
    async ({ tx, ownerId }) => {
      const { api } = apiStub(CSID_OK);
      const r = await svc(tx, api).issueProductionCsid(userId, "production", ownerId);
      assert.equal(r.httpStatus, 200, "refused with 'Run compliance onboarding first' — the order has regressed");
    },
  );
});

test("QA1-E3 a promoted-looking row with no token is refused, not returned as null", { skip }, async () => {
  // Was `creds.prodBinarySecurityToken!` — a typed `string` that could be null.
  await withRow(
    { activeEnvironment: "production", prodSlotEnv: "production",
      prodPrivateKeyEnc: encryptString("k"), prodSecretEnc: encryptString("s"),
      prodCertPem: "CERT", prodOnboardedAt: new Date(),
      prodBinarySecurityToken: null, prodComplianceRequestId: null },
    async ({ tx, ownerId }) => {
      const { api, calls } = apiStub(CSID_OK);
      await assert.rejects(
        () => svc(tx, api).issueProductionCsid(userId, "production", ownerId),
        ConflictException,
      );
      assert.equal(calls.length, 0);
    },
  );
});

/*
 * ── FIXED (was finding #3) ───────────────────────────────────────────────
 * `issueProductionCsid` now takes a full `ZatcaEnv`, so a simulation seller can
 * ask for the promotion they actually need. `promotedSlot` is derived from it,
 * and `activeEnvironment` still moves only for production — a rehearsal must
 * not switch anyone live.
 * ─────────────────────────────────────────────────────────────────────────
 */
test("QA1-E4 a simulation seller promotes on the simulation gateway and reads onboarded", { skip }, async () => {
  await withRow({ activeEnvironment: "simulation", prodSlotEnv: "compliance-simulation", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    const { api, calls } = apiStub(CSID_OK);
    await svc(tx, api).issueProductionCsid(userId, "simulation", ownerId);
    assert.equal(calls[0]!.environment, "simulation", "the simulation CSID must not be presented to /core");
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.prodSlotEnv, "simulation", "the lifecycle now reaches its own slot value");
    assert.equal(row!.activeEnvironment, "simulation", "a rehearsal must NOT switch the seller live");
    assert.equal(row!.prodComplianceRequestId, null);
    assert.equal(isOnboarded(row), true, "…and the seller can finally issue on simulation");
  });
});

test("QA1-E5 a sandbox promotion is labelled 'sandbox' and never reads as onboarded", { skip }, async () => {
  // No longer mislabelled "simulation". The asymmetry remains, though: the
  // SANDBOX compliance material is read and the result is written to the PROD
  // columns — see the report. Pinned here so a later change to that is visible.
  await withRow(
    { activeEnvironment: "sandbox", prodSlotEnv: "compliance-simulation", ...SANDBOX_MATERIAL, ...PROD_MATERIAL },
    async ({ tx, ownerId, credsId }) => {
      const { api, calls } = apiStub(CSID_OK);
      await svc(tx, api).issueProductionCsid(userId, "sandbox", ownerId);
      assert.equal(calls[0]!.environment, "sandbox");
      assert.equal(calls[0]!.binarySecurityToken, "SANDBOX-TOKEN");
      const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
        .where(eq(zatcaCredentialsTable.id, credsId));
      assert.equal(row!.prodSlotEnv, "sandbox");
      assert.equal(row!.activeEnvironment, "sandbox", "a sandbox promotion must not move the pointer");
      // And it stays un-onboarded even if the pointer is moved onto it. The
      // certificate in the prod columns came from the DEVELOPER PORTAL, so the
      // simulation gateway will refuse it — `isOnboarded` now says so rather
      // than letting one ungated switchEnvironment make the row look live.
      assert.equal(
        isOnboarded({ ...row!, activeEnvironment: "simulation" } as never), false,
        "a sandbox certificate in the prod slot must never read as onboarded",
      );
    },
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. unlink, and what the kept slot label means afterwards.
 * ═══════════════════════════════════════════════════════════════════════ */

test("QA1-F1 unlink of a step-2 row keeps the compliance label and reads un-onboarded", { skip }, async () => {
  await withRow({ activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.prodSlotEnv, "compliance-production", "kept — it describes the retained prodIcv/prodPih");
    assert.equal(row!.activeEnvironment, "sandbox");
    assert.equal(row!.prodCertPem, null);
    assert.equal(isOnboarded(row), false);
  });
});

test("QA1-F2 a kept compliance label does not block a later sandbox re-link", { skip }, async () => {
  // After the unlink above, the row still says "compliance-production" while
  // the seller re-onboards sandbox. The clause is scoped to non-sandbox, so the
  // stale label is inert — assert it, because a wider clause would strand every
  // seller who had ever abandoned a production onboarding.
  await withRow({ activeEnvironment: "production", prodSlotEnv: "compliance-production", ...PROD_MATERIAL }, async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    await (tx as typeof db).update(zatcaCredentialsTable)
      .set(SANDBOX_MATERIAL as never).where(eq(zatcaCredentialsTable.id, credsId));
    const [row] = await (tx as typeof db).select().from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.prodSlotEnv, "compliance-production");
    assert.equal(isOnboarded(row), true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. Back-compat: the rows that already exist.
 * ═══════════════════════════════════════════════════════════════════════ */

test("QA1-G a legacy step-2 row is indistinguishable from a promoted one", { skip }, async () => {
  // Column for column, what the OLD step 2 wrote and what a real promotion
  // writes are the same row. This test exists to state that plainly: the fix
  // protects onboardings performed after it and nothing else. Every row already
  // in production keeps whatever classification it has, right or wrong.
  const legacyStepTwo = { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL };
  const promoted = { activeEnvironment: "production", prodSlotEnv: "production", ...PROD_MATERIAL };
  assert.deepEqual(legacyStepTwo, promoted);
  assert.equal(isOnboarded(legacyStepTwo as never), true);
  assert.equal(
    isOnboarded(promoted as never), true,
    "both read live — only an external probe (a compliance submission, or an " +
    "invoices row that ever reached cleared/reported on production) can tell them apart",
  );
});
