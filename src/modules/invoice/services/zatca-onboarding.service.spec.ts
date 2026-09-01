/**
 * Unlinking a landlord from ZATCA.
 *
 * The interesting part of `unlink` is not what it clears — it is the three
 * things it deliberately KEEPS, each of which breaks a later re-link if it
 * goes: the row itself (the (user, owner) unique index has no `deleted_at`
 * predicate, so an insert would collide), the ICV counter and the PIH chain
 * head (`invoices` is unique on (user, owner, environment, icv), so a reset
 * counter collides with an invoice already submitted).
 *
 * Everything runs inside a transaction that is always rolled back, so it is
 * safe against any database. Skipped when DATABASE_URL is unset.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, getPool, usersTable, ownersTable, zatcaCredentialsTable, ZATCA_INITIAL_PIH } from "@dara/database";
import { ZatcaOnboardingService, nextEgsSerial } from "./zatca-onboarding.service";
import { checkInvoiceReadiness } from "../../../common/invoice-readiness";

const HAS_DB = !!process.env.DATABASE_URL;
class Rollback extends Error {}

let userId = 0;

before(async () => {
  if (!HAS_DB) return;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  userId = u?.id ?? 0;
});
after(async () => {
  if (HAS_DB) await getPool().end();
});

/**
 * `unlink` touches nothing but the database, so the CSR / API / builder /
 * signer collaborators are never reached. Constructing it with the transaction
 * alone keeps the test to the one method under examination.
 */
const svc = (tx: unknown) =>
  new ZatcaOnboardingService(tx as never, null as never, null as never, null as never, null as never);

/** A landlord onboarded on production, mid-chain — the hardest case to undo. */
const LIVE_CREDS = {
  activeEnvironment: "production" as const,
  prodSlotEnv: "production",
  sellerName: "Seller", sellerVatNumber: "300000000000003",
  sellerStreet: "S", sellerBuildingNo: "1", sellerDistrict: "D",
  sellerCity: "R", sellerPostalZone: "12211",
  serialNumber: "1-Dara|2-Test|3-0001",
  organizationIdentifier: "300000000000003",
  organizationUnitName: "Test Unit",
  locationAddress: "Riyadh",
  industryCategory: "Real Estate",
  commonName: "Dara Test",
  prodPrivateKeyEnc: "ENC-KEY", prodPublicKeyPem: "PUB", prodCsrPem: "CSR",
  prodBinarySecurityToken: "TOKEN", prodSecretEnc: "ENC-SECRET", prodCertPem: "CERT",
  prodComplianceRequestId: "1787837521875", prodOnboardedAt: new Date(),
  prodIcv: 42, prodPih: "MID-CHAIN-PIH",
  sandboxPrivateKeyEnc: "ENC-KEY-S", sandboxCertPem: "CERT-S",
  sandboxBinarySecurityToken: "TOKEN-S", sandboxSecretEnc: "ENC-SECRET-S",
  sandboxIcv: 7, sandboxPih: "SANDBOX-PIH",
};

/** Build a live landlord, run `fn`, then roll everything back. */
async function withLinkedLandlord(
  fn: (ctx: { tx: typeof db; ownerId: number; credsId: number }) => Promise<void>,
) {
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.insert(ownersTable).values({
        userId, name: "مؤجر الاختبار", type: "individual", idNumber: "1000000009",
        phone: "+966500000009", email: "unlink@test.local",
        taxNumber: "300000000000003", status: "active",
      }).returning();
      const [creds] = await tx.insert(zatcaCredentialsTable)
        .values({ userId, ownerId: owner!.id, ...LIVE_CREDS } as never).returning();
      await fn({ tx: tx as never, ownerId: owner!.id, credsId: creds!.id });
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

test("unlink wipes every certificate, key and secret in both slots", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    // The private key is the point: hiding the row would leave it on disk.
    for (const col of [
      "prodPrivateKeyEnc", "prodPublicKeyPem", "prodCsrPem", "prodBinarySecurityToken",
      "prodSecretEnc", "prodCertPem", "prodComplianceRequestId", "prodOnboardedAt",
      "sandboxPrivateKeyEnc", "sandboxPublicKeyPem", "sandboxCsrPem", "sandboxBinarySecurityToken",
      "sandboxSecretEnc", "sandboxCertPem", "sandboxComplianceRequestId", "sandboxOnboardedAt",
    ] as const) {
      assert.equal((row as Record<string, unknown>)[col], null, `${col} must not survive an unlink`);
    }
  });
});

test("unlink keeps prodSlotEnv — it describes the counters, not the erased cert", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    // Simulation and production share prodIcv/prodPih, so this column is the
    // only record of which chain the retained counter belongs to. Clearing it
    // would make that unknowable — and it is harmless to keep, because every
    // reader gates on prodCertPem or activeEnvironment, both cleared above.
    assert.equal(row!.prodSlotEnv, "production");
    assert.equal(row!.prodCertPem, null, "…while the certificate it described is gone");
  });
});

test("unlink leaves the active environment on a slot that is at least consistent", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    // Back to the insert-time default. A pointer left on "production" over an
    // empty slot is the failure mode that blocked every invoice for owner 264.
    assert.equal(row!.activeEnvironment, "sandbox");
  });
});

test("unlink keeps the ICV counter and the PIH chain head", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    // Not credentials — the position in a sequence ZATCA requires to be
    // monotonic, and that `invoices` enforces with a unique index. Zeroing it
    // makes the first invoice after a re-link collide with a submitted one.
    assert.equal(row!.prodIcv, 42);
    assert.equal(row!.prodPih, "MID-CHAIN-PIH");
    assert.equal(row!.sandboxIcv, 7);
    assert.equal(row!.sandboxPih, "SANDBOX-PIH");
    assert.notEqual(row!.prodPih, ZATCA_INITIAL_PIH);
  });
});

test("unlink keeps the row and the seller profile, so re-linking is an update", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.deletedAt, null, "a soft-deleted row still occupies the (user, owner) unique slot");
    assert.equal(row!.sellerVatNumber, "300000000000003");
    assert.equal(row!.serialNumber, "1-Dara|2-Test|3-0001");
    // getCredentials is what upsertProfile consults before choosing insert vs
    // update — it must still find this row.
    const found = await svc(tx).getCredentials(userId, ownerId);
    assert.ok(found, "an unlinked landlord must still be found, or re-linking inserts and collides");
    assert.equal(found!.id, credsId);
  });
});

test("a landlord with no row of its own has nothing to unlink, and the account-level seller survives", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.insert(ownersTable).values({
        userId, name: "مؤجر بلا ربط", type: "individual", idNumber: "1000000010",
        phone: "+966500000010", email: "inherit@test.local",
        taxNumber: "300000000000003", status: "active",
      }).returning();
      // The legacy account-level row: ownerId null, and the only one there is.
      const [acct] = await tx.insert(zatcaCredentialsTable)
        .values({ userId, ownerId: null, ...LIVE_CREDS } as never).returning();

      await assert.rejects(
        () => svc(tx as never).unlink(userId, owner!.id),
        /لا يوجد ربط/,
        "a landlord with no row of its own has nothing to unlink",
      );
      const [still] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, acct!.id));
      assert.equal(still!.prodCertPem, "CERT", "the account-level certificate must be untouched");
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
});

test("unlink is scoped to the account — one account cannot unlink another's landlord", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    // The one authorization property worth pinning: `credsWhere` filters on
    // userId, and the controller passes `scopeId(user)` — so a landlord id
    // guessed from another account resolves to nothing rather than to a row.
    const otherAccount = userId + 1_000_000;
    await assert.rejects(() => svc(tx).unlink(otherAccount, ownerId), /لا يوجد ربط/);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.prodCertPem, "CERT", "the certificate must be untouched by a foreign account");
  });
});

/* ── Link health: when ZATCA cuts the link from the other side ─────────────
 * The taxpayer removes our EGS device in the Fatoora portal, or ZATCA revokes
 * the CSID. Nothing notifies us and the row still holds a certificate, a key
 * and a secret — so without a flag every check passes and every invoice is
 * signed into a void.
 */

test("markLinkInvalid flags the link without destroying the credentials", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).markLinkInvalid(userId, ownerId, "ZATCA رفضت بيانات الربط (401)");
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    assert.ok(row!.linkInvalidAt, "the flag is what makes the state knowable");
    assert.match(row!.linkInvalidReason ?? "", /401/);
    // A 403 can also be a gateway or IP problem. Deleting a seller's private
    // key on the strength of one HTTP status is not an automatic decision —
    // flagging is reversible, erasing is not.
    assert.equal(row!.prodCertPem, "CERT");
    assert.equal(row!.prodPrivateKeyEnc, "ENC-KEY");
  });
});

test("clearLinkInvalid retires the flag once ZATCA accepts something again", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).markLinkInvalid(userId, ownerId, "transient 403");
    await svc(tx).clearLinkInvalid(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.linkInvalidAt, null);
    assert.equal(row!.linkInvalidReason, null);
  });
});

test("unlink clears the flag — it described a link that is now gone", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).markLinkInvalid(userId, ownerId, "ZATCA refused the credentials");
    await svc(tx).unlink(userId, ownerId);
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    // Left set, it would be a stale complaint about a link the user has just
    // deliberately removed, and would survive into their next onboarding.
    assert.equal(row!.linkInvalidAt, null);
    assert.equal(row!.linkInvalidReason, null);
  });
});

test("the flag is scoped like everything else — one account cannot flag another's", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId, credsId }) => {
    await svc(tx).markLinkInvalid(userId + 1_000_000, ownerId, "not yours");
    const [row] = await tx.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.id, credsId));
    assert.equal(row!.linkInvalidAt, null);
  });
});

/* ── A compliance certificate is not a production one ──────────────────────
 * Onboarding is four steps and step 2 hands back a COMPLIANCE CSID. Marking
 * the slot with the final environment there made a half-finished row
 * indistinguishable from a live one — same columns, same prodOnboardedAt —
 * so when step 4 failed the seller read as live while holding a certificate
 * /core refuses. That is how a real landlord ended up with a 401 on every
 * invoice and no device in Fatoora.
 */

test("a slot holding a compliance certificate does not read as onboarded", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  try {
    await db.transaction(async (tx) => {
      const [owner] = await tx.insert(ownersTable).values({
        userId, name: "مؤجر قيد الربط", type: "individual", idNumber: "1000000011",
        phone: "+966500000011", email: "midway@test.local",
        taxNumber: "300000000000003", status: "active",
      }).returning();
      // Exactly what issueComplianceCsid leaves behind for env=production.
      await tx.insert(zatcaCredentialsTable).values({
        userId, ownerId: owner!.id, ...LIVE_CREDS,
        activeEnvironment: "production", prodSlotEnv: "compliance-production",
      } as never);
      const r = await checkInvoiceReadiness(tx as never, userId, null, {
        client: { name: "ع", email: "b@t.local", phone: "+966500000012", idNumber: "1000000013", type: "individual" },
      });
      // Not merely "incomplete" — this is the state that used to pass.
      assert.ok(
        r.blockers.some((b) => b.entity === "zatca"),
        "a compliance certificate must never satisfy the ZATCA gate",
      );
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
});

test("promotion is not re-asked once the slot holds a real production CSID", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  await withLinkedLandlord(async ({ tx, ownerId }) => {
    // LIVE_CREDS is already prodSlotEnv "production" with a cert and an
    // onboardedAt, i.e. a finished promotion. Asking ZATCA again is what
    // returned "Already-Generated" and read to the user as a failure — so this
    // must short-circuit rather than make the call at all. The api collaborator
    // is null here, so any network attempt would throw instead.
    const r = await svc(tx).issueProductionCsid(userId, "production", ownerId);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.binarySecurityToken, "TOKEN");
  });
});

/* ── The EGS serial is what ZATCA calls a device ───────────────────────────
 * Deleting the unit in the Fatoora portal does not change the serial in our
 * CSR, so a re-onboard presented ZATCA the same device — the one it had
 * already issued a production CSID for and would never issue another against.
 */

test("re-onboarding presents a new EGS generation", { skip: false }, () => {
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-264"), "1-Dara|2-PMS|3-264-2");
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-264-2"), "1-Dara|2-PMS|3-264-3");
  // Two digits, not a string sort: the ninth re-link must not become "-91".
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-264-9"), "1-Dara|2-PMS|3-264-10");
  // Whitespace on a stored value must not produce a serial ZATCA reads
  // differently from the one we recorded.
  assert.equal(nextEgsSerial("  1-Dara|2-PMS|3-7  "), "1-Dara|2-PMS|3-7-2");
});

test("a landlord id containing digits is not mistaken for a generation", { skip: false }, () => {
  // "3-264" is the id segment; only a suffix AFTER it is a generation. Getting
  // this wrong would silently renumber the landlord rather than the device.
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-1024"), "1-Dara|2-PMS|3-1024-2");
  assert.equal(nextEgsSerial("1-Dara|2-PMS|3-1024-2"), "1-Dara|2-PMS|3-1024-3");
});
