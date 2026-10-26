import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { PlanUpgradeRequiredException } from "../../common/plan-features";
import { RentalOffersModule, RentalOffersPlanGuard } from "./rental-offers.module";
import { assertFreeMonths, formatOfferNumber, normalizeOffer, offerSeq } from "./rental-offers.normalize";

describe("normalizeOffer", () => {
  it("requires a client on create, not on patch", () => {
    assert.throws(() => normalizeOffer({}, false), BadRequestException);
    assert.throws(() => normalizeOffer({ clientName: "   " }, false), BadRequestException);
    assert.deepEqual(normalizeOffer({}, true), {});
  });

  it("normalises money, dates and enums", () => {
    const v = normalizeOffer({
      clientName: " شركة الأفق ", annualRent: "120000.456", depositAmount: "", durationMonths: 24,
      paymentFrequency: "quarterly", commissionType: "percent", commissionValue: 2.5,
      startDate: "2026-11-01T00:00:00Z", validUntil: "2026-11-15", issueDate: "2026-10-25",
    }, false);
    assert.equal(v.clientName, "شركة الأفق");
    assert.equal(v.annualRent, "120000.46");
    assert.equal(v.depositAmount, "0");
    assert.equal(v.startDate, "2026-11-01");
    assert.equal(v.commissionValue, "2.50");
  });

  it("refuses values the table would refuse", () => {
    for (const body of [
      { paymentFrequency: "weekly" }, { status: "expired" }, { commissionType: "x" },
      { durationMonths: 0 }, { durationMonths: 1.5 }, { annualRent: -1 }, { annualRent: "abc" },
      { startDate: "2026-13-40" }, { commissionType: "percent", commissionValue: 150 },
      { issueDate: "2026-10-25", validUntil: "2026-10-01" }, { escalationPercent: 101 },
      { fees: "nope" }, { terms: {} },
    ]) assert.throws(() => normalizeOffer(body, true), BadRequestException, JSON.stringify(body));
  });

  it("takes the contract wizard's cycle, fee and escalation keys", () => {
    const v = normalizeOffer({
      paymentFrequency: "semi_annual", escalationType: "amount", escalationAmount: "5000",
      fees: [{ typeKey: "services", label: "", amount: 1200, recurrence: "quarterly", vat: true }, { label: "x", amount: 1, recurrence: "weird" }],
    }, true);
    assert.equal(v.paymentFrequency, "semi_annual");
    assert.equal(v.escalationType, "amount");
    assert.equal(v.escalationAmount, "5000.00");
    assert.deepEqual(v.fees, [
      { typeKey: "services", label: "", amount: 1200, recurrence: "quarterly", vat: true },
      { typeKey: null, label: "x", amount: 1, recurrence: "one_time", vat: false },
    ]);
    for (const f of ["monthly", "semiannual", "custom"]) assert.throws(() => normalizeOffer({ paymentFrequency: f }, true), BadRequestException);
    assert.throws(() => normalizeOffer({ escalationType: "x" }, true), BadRequestException);
  });

  it("cleans fees, terms and the unit snapshot", () => {
    const v = normalizeOffer({
      fees: [{ label: "رسوم خدمات", amount: "1500", recurrence: "annual", vat: 1 }, { label: "", amount: 0 }],
      terms: ["  شرط  ", "", null],
      unitSnapshot: { propertyName: "برج", unitNumber: "401", floor: "4", evil: "<x>" },
    }, true);
    assert.deepEqual(v.fees, [{ typeKey: null, label: "رسوم خدمات", amount: 1500, recurrence: "annual", vat: true }]);
    assert.deepEqual(v.terms, ["شرط"]);
    assert.deepEqual(v.unitSnapshot, { propertyName: "برج", unitNumber: "401", floor: 4 });
  });

  it("free months must leave a paying month", () => {
    assert.throws(() => assertFreeMonths(12, 12), BadRequestException);
    assert.doesNotThrow(() => assertFreeMonths(12, 2));
  });

  it("numbers", () => {
    assert.equal(formatOfferNumber(2026, 7), "RO-2026-0007");
    assert.equal(offerSeq("RO-2026-0012", "RO-2026-"), 12);
    assert.equal(offerSeq("RO-2025-0012", "RO-2026-"), 0);
    assert.equal(offerSeq("RO-2026-abc", "RO-2026-"), 0);
  });
});

/* Scripted Drizzle stand-in (same idea as maintenance.scope.spec.ts). */
type Op = { kind: string; table: string; calls: Array<[string, unknown[]]> };
function fakeDb(script: Record<string, Array<unknown[] | Error>> = {}) {
  const ops: Op[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const start = (kind: string, table?: unknown) => {
    const op: Op = { kind, table: table ? getTableName(table as any) : "", calls: [] };
    ops.push(op);
    let settled: Promise<unknown> | null = null;
    const run = () => (settled ??= (() => {
      const next = queues.get(`${op.kind}:${op.table}`)?.shift() ?? [];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    })());
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: any, rej: any) => run().then(res, rej);
        if (prop === "catch") return (rej: any) => run().catch(rej);
        return (...args: unknown[]) => {
          if (prop === "from" && !op.table) op.table = getTableName(args[0] as any);
          op.calls.push([prop, args]);
          return chain;
        };
      },
    });
    return chain;
  };
  return { db: { select: () => start("select"), update: (t: unknown) => start("update", t), insert: (t: unknown) => start("insert", t) } as any, ops };
}
const ctrl = (db: any) => { const [C] = Reflect.getMetadata("controllers", RentalOffersModule); return new C(db); };
const employee: any = { id: 77, ownerUserId: 34, permissions: [] };
const dialect = new PgDialect();
const whereSql = (op: Op) => {
  const w = op.calls.find(([m]) => m === "where");
  return w ? dialect.sqlToQuery(w[1][0] as any) : { sql: "", params: [] };
};
const valuesOf = (op: Op) => op.calls.find(([m]) => m === "values")?.[1][0] as any;

describe("RentalOffersController", () => {
  it("create: numbers per ACCOUNT, links a unit only through the account's own property", async () => {
    const { db, ops } = fakeDb({
      "select:units": [[{ id: 9, propertyId: 3 }]],
      "select:rental_offers": [[{ number: "RO-2026-0001" }, { number: "RO-2026-0004" }, { number: "junk" }]],
      "insert:rental_offers": [[{ id: 1, status: "draft", validUntil: null }]],
    });
    const year = new Date().getFullYear();
    await ctrl(db).create(employee, { clientName: "شركة", unitId: 9, propertyId: 999, userId: 1 });
    const unitQ = whereSql(ops.find((o) => o.table === "units")!);
    assert.ok(unitQ.params.includes(34), "unit checked against the account owner");
    const v = valuesOf(ops.find((o) => o.kind === "insert")!);
    assert.equal(v.userId, 34);
    assert.equal(v.createdBy, 77);
    assert.equal(v.propertyId, 3, "property comes from the unit, not the body");
    assert.equal(v.unitId, 9);
    if (year === 2026) assert.equal(v.number, "RO-2026-0005");
  });

  it("create: an offer without a unit is refused", async () => {
    const { db, ops } = fakeDb();
    await assert.rejects(ctrl(db).create(employee, { clientName: "شركة" }), BadRequestException);
    await assert.rejects(ctrl(db).create(employee, { clientName: "شركة", unitId: "" }), BadRequestException);
    assert.equal(ops.length, 0);
  });

  it("update: a unit cannot be unlinked", async () => {
    const prev = { id: 5, status: "draft", durationMonths: 12, freeMonths: 0, sentAt: null };
    await assert.rejects(ctrl(fakeDb({ "select:rental_offers": [[prev]] }).db).update(employee, "5", { unitId: null }), BadRequestException);
  });

  it("create: another account's unit is refused before anything is written", async () => {
    const { db, ops } = fakeDb({ "select:units": [[]] });
    await assert.rejects(ctrl(db).create(employee, { clientName: "شركة", unitId: 9 }), BadRequestException);
    assert.equal(ops.filter((o) => o.kind === "insert").length, 0);
  });

  it("create: a number collision retries with the next number", async () => {
    const dup = Object.assign(new Error("dup"), { code: "23505" });
    const { db, ops } = fakeDb({
      "select:units": [[{ id: 9, propertyId: 3 }]],
      "select:rental_offers": [[], []],
      "insert:rental_offers": [dup, [{ id: 2, status: "draft", validUntil: null }]],
    });
    const row = await ctrl(db).create(employee, { clientName: "شركة", unitId: 9 });
    assert.equal(row.id, 2);
    const inserts = ops.filter((o) => o.kind === "insert").map((o) => valuesOf(o).number);
    assert.notEqual(inserts[0], inserts[1]);
  });

  it("get/update/delete are scoped to the account", async () => {
    const { db, ops } = fakeDb({ "select:rental_offers": [[]] });
    await assert.rejects(ctrl(db).get(employee, "5"), NotFoundException);
    assert.ok(whereSql(ops[0]).params.includes(34));
    await assert.rejects(ctrl(fakeDb().db).update(employee, "abc", { title: "x" }), NotFoundException);
    const d = fakeDb();
    await ctrl(d.db).remove(employee, "5");
    assert.ok(whereSql(d.ops[0]).params.includes(34));
  });

  it("update: empty patch is a 400; a free period longer than the stored term is refused", async () => {
    const prev = { id: 5, status: "draft", durationMonths: 12, freeMonths: 0, sentAt: null };
    await assert.rejects(ctrl(fakeDb({ "select:rental_offers": [[prev]] }).db).update(employee, "5", {}), BadRequestException);
    await assert.rejects(ctrl(fakeDb({ "select:rental_offers": [[prev]] }).db).update(employee, "5", { freeMonths: 12 }), BadRequestException);
  });

  it("update: marking sent stamps sent_at; expired is derived on read", async () => {
    const prev = { id: 5, status: "draft", durationMonths: 12, freeMonths: 0, sentAt: null };
    const { db, ops } = fakeDb({
      "select:rental_offers": [[prev]],
      "update:rental_offers": [[{ ...prev, status: "sent", validUntil: "2000-01-01" }]],
    });
    const row = await ctrl(db).update(employee, "5", { status: "sent" });
    const set = ops.find((o) => o.kind === "update")!.calls.find(([m]) => m === "set")![1][0] as any;
    assert.ok(set.sentAt instanceof Date);
    assert.equal(row.status, "sent");
    assert.equal(row.effectiveStatus, "expired");
  });

  it("duplicate: a fresh draft with a new number, same terms", async () => {
    const src = { id: 5, userId: 34, number: "RO-2026-0001", status: "accepted", sentAt: new Date(), decidedAt: new Date(), terms: ["a"], clientName: "c", validUntil: null };
    const { db, ops } = fakeDb({
      "select:rental_offers": [[src], [{ number: "RO-2026-0001" }]],
      "insert:rental_offers": [[{ ...src, id: 6, status: "draft" }]],
    });
    await ctrl(db).duplicate(employee, "5");
    const v = valuesOf(ops.find((o) => o.kind === "insert")!);
    assert.equal(v.status, "draft");
    assert.deepEqual(v.terms, ["a"]);
    assert.equal(v.sentAt, undefined);
    assert.equal(v.id, undefined);
    assert.notEqual(v.number, "RO-2026-0001");
  });
});

describe("RentalOffersPlanGuard (package)", () => {
  const guardFor = (plan: string | null, seen: number[] = []) => {
    const g = new (class extends RentalOffersPlanGuard {
      protected planOf(id: number) { seen.push(id); return Promise.resolve(plan); }
    })({} as any);
    return g;
  };
  const ctxOf = (user: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

  it("offices and companies pass; the plan is the ACCOUNT OWNER's", async () => {
    for (const p of ["professional", "enterprise", "broker", null]) {
      const seen: number[] = [];
      assert.equal(await guardFor(p, seen).canActivate(ctxOf(employee)), true, String(p));
      assert.deepEqual(seen, [34]);
    }
  });

  it("tenant and عقاري get 403 PLAN_UPGRADE_REQUIRED (feature rental_offers)", async () => {
    for (const p of ["tenant", "basic"]) {
      await assert.rejects(guardFor(p).canActivate(ctxOf(employee)), (e: any) => {
        assert.ok(e instanceof PlanUpgradeRequiredException);
        const body = e.getResponse() as any;
        assert.equal(body.code, "PLAN_UPGRADE_REQUIRED");
        assert.equal(body.feature, "rental_offers");
        assert.equal(body.requiredPlan, "professional");
        return true;
      });
    }
  });

  it("the controller carries the guard", () => {
    const [C] = Reflect.getMetadata("controllers", RentalOffersModule);
    assert.ok((Reflect.getMetadata("__guards__", C) as unknown[]).includes(RentalOffersPlanGuard));
  });
});
