/**
 * The chain head never sits behind the documents ZATCA accepted.
 *
 * Reproduces the 23 Sep 2026 staging incident: a landlord whose credentials
 * row was created fresh (counter 0, seed PIH) while three accepted sandbox
 * invoices (ICV 1–3) of the same chain were still live. `issue()` signed ICV 1,
 * ZATCA accepted it, the counter was committed — and the insert then collided
 * on `invoices_user_owner_env_icv_uniq`. Filed with ZATCA, lost locally.
 *
 * The pure cases always run. The database cases commit real rows (the chain
 * lock and `getActiveCredentials` read through the module pool, not a
 * transaction we could roll back) and delete them afterwards; they are skipped
 * when DATABASE_URL is unset. The builder, signer and ZATCA API are stubs — the
 * question here is which ICV and PIH they are HANDED, not what they do with
 * them, so no signing code is exercised or changed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, getDb, getPool, usersTable, ownersTable, invoicesTable, zatcaCredentialsTable, ZATCA_INITIAL_PIH,
} from "@dara/database";
import { reconcileChainHead, ACCEPTED_NOT_RECORDED_NOTE } from "./chain-head";

process.env.APP_ENCRYPTION_KEY ??= "chain-head-spec-only-key";

/* ── pure ─────────────────────────────────────────────────────────────── */

test("no accepted document: the stored counter stands", () => {
  assert.deepEqual(reconcileChainHead({ icv: 0, pih: "SEED" }, null), { icv: 0, pih: "SEED", healed: false });
});

test("counter level with, or ahead of, the last accepted document: the counter stands", () => {
  assert.deepEqual(
    reconcileChainHead({ icv: 3, pih: "H3" }, { icv: 3, invoiceHash: "H3" }),
    { icv: 3, pih: "H3", healed: false },
  );
  // Ahead is normal after a soft-deleted reset or a rejected tail.
  assert.deepEqual(
    reconcileChainHead({ icv: 7, pih: "H7" }, { icv: 3, invoiceHash: "H3" }),
    { icv: 7, pih: "H7", healed: false },
  );
});

test("counter BEHIND the last accepted document: continue from that document and its hash", () => {
  assert.deepEqual(
    reconcileChainHead({ icv: 0, pih: "SEED" }, { icv: 3, invoiceHash: "H3" }),
    { icv: 3, pih: "H3", healed: true },
  );
});

test("an accepted tail with no hash is refused, never chained onto a guess", () => {
  assert.throws(() => reconcileChainHead({ icv: 0, pih: "SEED" }, { icv: 3, invoiceHash: null }), /no stored hash/);
});

/* ── database ─────────────────────────────────────────────────────────── */

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && "DATABASE_URL not set";

let userId = 0;
before(async () => {
  if (!HAS_DB) return;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  userId = u?.id ?? 0;
});
after(async () => {
  if (HAS_DB) await getPool().end();
});

const PROFILE = {
  sellerName: "Chain Seller", sellerVatNumber: "300000000000003",
  sellerStreet: "S", sellerBuildingNo: "1234", sellerDistrict: "D",
  sellerCity: "Riyadh", sellerPostalZone: "12211",
  serialNumber: "1-Dara|2-PMS|3-9101",
  organizationIdentifier: "300000000000003",
  organizationUnitName: "Chain Unit",
  locationAddress: "Riyadh", industryCategory: "Real Estate",
  commonName: "Dara Chain",
};

async function sandboxCreds() {
  const { encryptString } = await import("../../../common/crypto/encryption");
  return {
    activeEnvironment: "sandbox" as const,
    sandboxPrivateKeyEnc: encryptString("KEY"), sandboxCertPem: "CERT",
    sandboxBinarySecurityToken: Buffer.from("CERTBODY").toString("base64"),
    sandboxSecretEnc: encryptString("SECRET"), sandboxOnboardedAt: new Date(),
    // What a freshly inserted row carries: the column defaults.
    sandboxIcv: 0, sandboxPih: ZATCA_INITIAL_PIH,
  };
}

/** An accepted sandbox invoice already on file for this seller. */
function acceptedRow(ownerId: number, icv: number, env: "sandbox" | "production" = "sandbox") {
  return {
    userId, ownerId, invoiceNumber: `CHAIN-${ownerId}-${env}-${icv}`, uuid: `uuid-${ownerId}-${env}-${icv}`,
    profile: "simplified" as const, issueDate: "2026-06-26", issueTime: "05:04:54",
    icv, pih: icv === 1 ? ZATCA_INITIAL_PIH : `H${icv - 1}`, environment: env,
    sellerSnapshot: {} as never, totals: {} as never, unsignedXml: "<x/>",
    invoiceHash: `H${icv}`, status: "reported" as const,
  };
}

async function withSellers(n: number, fn: (ownerIds: number[]) => Promise<void>) {
  const owners = await db.insert(ownersTable).values(Array.from({ length: n }, (_, i) => ({
    userId, name: `مؤجر السلسلة ${i}`, type: "individual" as const, idNumber: `10000091${String(i).padStart(2, "0")}`,
    phone: `+9665000091${String(i).padStart(2, "0")}`, email: `chain-${i}@test.local`,
    taxNumber: "300000000000003", status: "active" as const,
  }))).returning();
  const ids = owners.map((o) => o.id);
  try {
    await fn(ids);
  } finally {
    await db.delete(invoicesTable).where(inArray(invoicesTable.ownerId, ids));
    await db.delete(zatcaCredentialsTable).where(inArray(zatcaCredentialsTable.ownerId, ids));
    await db.delete(ownersTable).where(inArray(ownersTable.id, ids));
  }
}

/**
 * The real InvoiceService and onboarding service over the real database, with
 * the builder, signer and ZATCA API replaced by recorders. `onSubmit` runs
 * while "ZATCA" is being called — i.e. after signing, before the insert.
 */
async function harness(onSubmit?: (icv: number) => Promise<void>) {
  const { InvoiceService } = await import("./invoice.service");
  const { ZatcaOnboardingService } = await import("./zatca-onboarding.service");
  const built: { icv: number; pih: string }[] = [];
  const builder = {
    build: (i: { icv: number; pih: string }) => {
      built.push({ icv: i.icv, pih: i.pih });
      return {
        xml: `<Invoice icv="${i.icv}"/>`, uuid: `u-${i.icv}-${Math.random().toString(36).slice(2, 8)}`,
        totals: { taxInclusive: 115, taxAmount: 15 },
        computedLines: [{
          id: "1", name: "Rent", unitCode: "PCE", quantity: 1, unitPrice: 100, vatCategory: "S", vatPercent: 15,
          _lineNet: 100, _lineVat: 15, _lineTotalIncVat: 115,
        }],
      };
    },
  };
  let lastIcv = 0;
  const signer = {
    signInvoice: async () => ({
      signedXml: `<signed icv="${lastIcv}"/>`, invoiceHashBase64: `NEW-${lastIcv}`,
      qrBase64: "QR", signatureValueBase64: "SIG",
    }),
  };
  const api = {
    complianceInvoice: async () => {
      await onSubmit?.(lastIcv);
      return { status: 200, json: { validationResults: { status: "PASS" } }, raw: "", headers: {} };
    },
  };
  const trackingBuilder = {
    build: (i: { icv: number; pih: string }) => { lastIcv = i.icv; return builder.build(i); },
  };
  const onboarding = new ZatcaOnboardingService(getDb() as never, null as never, null as never, null as never, null as never);
  const svc = new InvoiceService(getDb() as never, trackingBuilder as never, signer as never, api as never, onboarding);
  return { svc, onboarding, built };
}

const dto = (ownerId: number) => ({
  invoiceNumber: `CHAIN-NEW-${Math.random().toString(36).slice(2, 10)}`,
  ownerId,
  profile: "simplified" as const,
  lines: [{ id: "1", name: "Rent", quantity: 1, unitPrice: 100, vatPercent: 15, vatCategory: "S" as const }],
});

test("a fresh counter behind accepted invoices continues the chain instead of colliding", { skip }, async () => {
  await withSellers(1, async ([ownerId]) => {
    await db.insert(zatcaCredentialsTable).values({ userId, ownerId, ...PROFILE, ...(await sandboxCreds()) } as never);
    await db.insert(invoicesTable).values([1, 2, 3].map((icv) => acceptedRow(ownerId!, icv)));

    const { svc, built } = await harness();
    const { invoice } = await svc.issue(userId, dto(ownerId!) as never);

    assert.deepEqual(built, [{ icv: 4, pih: "H3" }], "must sign ICV 4 chained onto the last accepted document");
    assert.equal(invoice.icv, 4);
    assert.equal(invoice.pih, "H3");
    assert.equal(invoice.status, "submitted");
    const [c] = await db.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.ownerId, ownerId!));
    assert.equal(c!.sandboxIcv, 4);
    assert.equal(c!.sandboxPih, "NEW-4");
  });
});

test("another landlord's invoices, and another environment's, do not move this chain", { skip }, async () => {
  await withSellers(2, async ([mine, other]) => {
    await db.insert(zatcaCredentialsTable).values({ userId, ownerId: mine, ...PROFILE, ...(await sandboxCreds()) } as never);
    await db.insert(invoicesTable).values([
      ...[1, 2, 3, 4, 5].map((icv) => acceptedRow(other!, icv)),
      ...[1, 2].map((icv) => acceptedRow(mine!, icv, "production")),
    ]);
    const { svc, built } = await harness();
    await svc.issue(userId, dto(mine!) as never);
    assert.deepEqual(built, [{ icv: 1, pih: ZATCA_INITIAL_PIH }]);
  });
});

test("accepted by ZATCA but the insert fails: the document is quarantined, not lost, and the error says so", { skip }, async () => {
  await withSellers(1, async ([ownerId]) => {
    await db.insert(zatcaCredentialsTable).values({ userId, ownerId, ...PROFILE, ...(await sandboxCreds()) } as never);
    // A writer outside the lock takes the very ICV being submitted while ZATCA
    // is answering — the only way left for the insert to collide.
    const { svc } = await harness(async (icv) => {
      await db.insert(invoicesTable).values(acceptedRow(ownerId!, icv));
    });
    const number = `CHAIN-LOST-${Math.random().toString(36).slice(2, 8)}`;
    await assert.rejects(
      () => svc.issue(userId, { ...dto(ownerId!), invoiceNumber: number } as never),
      (e: unknown) => {
        assert.ok(e instanceof ConflictException, `threw ${String(e)}`);
        const r = (e as ConflictException).getResponse() as any;
        assert.equal(r.error, "zatca_accepted_not_recorded");
        assert.equal(r.icv, 1);
        assert.ok(r.quarantinedId, "the accepted document must be kept");
        assert.doesNotMatch(r.message, /insert into/i, "no SQL in what the user reads");
        return true;
      },
    );
    const [q] = await db.select().from(invoicesTable).where(eq(invoicesTable.invoiceNumber, number));
    assert.ok(q, "quarantine row written");
    assert.ok(q!.deletedAt, "soft-deleted so it cannot collide");
    assert.equal(q!.status, "submitted");
    assert.equal(q!.icv, 1);
    assert.match(q!.signedXml ?? "", /signed/);
    assert.ok(q!.notes?.startsWith(ACCEPTED_NOT_RECORDED_NOTE));
    // The chain moved for the document ZATCA holds — commit-first still holds.
    const [c] = await db.select().from(zatcaCredentialsTable).where(eq(zatcaCredentialsTable.ownerId, ownerId!));
    assert.equal(c!.sandboxIcv, 1);
  });
});

test("resetChain retires only its own landlord's invoices", { skip }, async () => {
  await withSellers(2, async ([a, b]) => {
    await db.insert(zatcaCredentialsTable).values([
      { userId, ownerId: a, ...PROFILE, ...(await sandboxCreds()), sandboxIcv: 2, sandboxPih: "H2" },
      { userId, ownerId: b, ...PROFILE, ...(await sandboxCreds()), sandboxIcv: 3, sandboxPih: "H3" },
    ] as never);
    await db.insert(invoicesTable).values([
      ...[1, 2].map((icv) => acceptedRow(a!, icv)),
      ...[1, 2, 3].map((icv) => acceptedRow(b!, icv)),
    ]);
    const { onboarding } = await harness();
    await onboarding.resetChain(userId, "sandbox", a!);

    const rows = await db.select({ ownerId: invoicesTable.ownerId, deletedAt: invoicesTable.deletedAt })
      .from(invoicesTable).where(inArray(invoicesTable.ownerId, [a!, b!]));
    assert.ok(rows.filter((r) => r.ownerId === a).every((r) => r.deletedAt), "A's chain retired");
    assert.ok(rows.filter((r) => r.ownerId === b).every((r) => !r.deletedAt), "B's filed invoices untouched");
    const [ca] = await db.select().from(zatcaCredentialsTable)
      .where(and(eq(zatcaCredentialsTable.userId, userId), eq(zatcaCredentialsTable.ownerId, a!)));
    assert.equal(ca!.sandboxIcv, 0);
  });
});

test("resetChain refuses production — a live EGS counter is never reset", { skip }, async () => {
  const { onboarding } = await harness();
  await assert.rejects(() => onboarding.resetChain(userId, "production", null), ConflictException);
});
