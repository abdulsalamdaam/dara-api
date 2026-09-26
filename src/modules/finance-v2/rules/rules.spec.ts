import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COA_TEMPLATE } from "../coa-template";
import { fromHalalas, vatSplit } from "../money";
import { MemLedger, accKey } from "../__tests__/mem-ledger";
import {
  classifyCollection, EMPTY_STATE, NON_POSTING, releaseAmount, resolveTreatment, RULES, runRule, SYS,
  type OutboxPayload, type PostState, type RuleCode, type RuleLine, type Treatment, type VatCategory,
} from "./index";

/**
 * DESIGN §11.1 (a), (c), (i), (j) and the §4.5 worked example, on the pure
 * rules. Synthetic ids and amounts only.
 */
const DIMS = { ownerId: 7, propertyId: 3, unitId: 5, tenantId: 11, contractId: 13 };
const P = 101;
const s = (h: number) => fromHalalas(h);
const CATS: VatCategory[] = ["S", "Z", "E", "O"];
const AMOUNTS = [1, 99, 345_00, 6_900_00, 12_345_67, 999_999_99];

function group(cat: VatCategory, gross: number, nature: "rent" | "fee" | "other" = "rent") {
  const { net, vat } = cat === "S" ? vatSplit(gross) : { net: gross, vat: 0 };
  return { category: cat, rate: cat === "S" ? 15 : 0, net: s(net), vat: s(vat), nature, usage: "commercial" as const };
}

function doc(t: Treatment, cat: VatCategory, gross: number, nature: "rent" | "fee" | "other" = "rent") {
  return { date: "2026-08-01", treatment: t, dims: DIMS, documentId: 501, groups: [group(cat, gross, nature)], coverage: [{ paymentId: P, amount: s(gross) }], deferRent: true };
}

function inst(t: Treatment, cat: VatCategory, gross: number) {
  return { date: "2026-08-01", treatment: t, dims: DIMS, paymentId: P, gross: s(gross), category: cat, rate: cat === "S" ? 15 : 0, nature: "rent" as const, usage: "commercial" as const, deferRent: true };
}

function coll(t: Treatment, amount: number, cls: string, cat: VatCategory = "S") {
  return { date: "2026-08-10", treatment: t, dims: DIMS, collectionId: 701, amount: s(amount), cls, bank: { method: "bank_transfer" }, paymentId: P, category: cat, rate: cat === "S" ? 15 : 0, forfeitVat: cat === "Z" ? "O" : cat };
}

/** A state where installment P is charged by a due-date charge of `gross` (category cat). */
function chargedState(cat: VatCategory, gross: number): PostState {
  const { net, vat } = cat === "S" ? vatSplit(gross) : { net: gross, vat: 0 };
  return {
    charges: { [P]: { generation: 1, chargedBy: "due", documentId: null, amount: gross, vatAmount: vat, vatBase: vat ? net : null, entryId: 1 } },
    vatBooked: { [P]: cat === "S" ? Math.floor(vat / 2) : 0 }, baseBooked: { [P]: cat === "S" ? Math.floor(net / 2) : 0 },
    unreleased: { [P]: Math.floor(net / 3) }, writtenOff: [],
  };
}

type Case = { payload: OutboxPayload; state: PostState; dims?: boolean };

function cases(rule: RuleCode, t: Treatment, cat: VatCategory, amt: number): Case[] {
  const pay = (facts: any, state: PostState = EMPTY_STATE, dims = true): Case => ({ payload: { rule, facts, paymentIds: [P] }, state, dims });
  switch (rule) {
    case "E01": case "E07": return [pay(doc(t, cat, amt)), pay(doc(t, cat, amt), chargedState(cat, amt))];
    case "E08": return cat === "O" ? [pay(doc(t, "O", amt)), pay(doc(t, "O", amt), chargedState("O", amt))] : [];
    case "E06": return [pay(doc(t, cat, amt), chargedState(cat, amt)), pay(doc(t, cat, amt))];
    case "E15": case "E36": case "E17": return [pay(doc(t, cat, amt, "other"))];
    case "E02": return [pay(inst(t, cat, amt)), pay(inst(t, cat, amt), { ...EMPTY_STATE, vatBooked: { [P]: 1 }, baseBooked: { [P]: 7 } })];
    case "E05": return [pay(inst(t, cat, amt), chargedState(cat, amt))];
    case "E33": return [pay(inst(t, cat, amt), chargedState(cat, amt))];
    case "E35": return [pay({ date: "2026-08-31", treatment: t, dims: DIMS, paymentId: P, month: "2026-08", windowStart: "2026-08-10", windowEnd: "2026-11-09", category: cat, usage: "residential" }, { ...EMPTY_STATE, unreleased: { [P]: amt } })];
    case "E03": return [pay(coll(t, amt, "rent", cat))];
    case "E04": return [pay(coll(t, -amt, "rent", cat))];
    case "E09C": return [pay(coll(t, amt, "deposit_installment")), pay(coll(t, -amt, "deposit_installment"))];
    case "E12": return [pay(coll(t, amt, "deposit_conversion", cat))];
    case "E12B": return [pay(coll(t, amt, "deposit_offset"))];
    case "E16": return [pay(coll(t, amt, "commission_cash")), pay(coll(t, amt, "commission_deduction"))];
    case "E34": return [pay(coll(t, amt, "rent", cat)), pay(coll(t, -amt, "rent", cat), chargedState("S", amt * 2))];
    case "E09": case "E10": return [pay({ date: "2026-08-01", treatment: t, dims: DIMS, documentId: 601, amount: s(amt), bank: { method: "cash" } })];
    case "E11": return [pay({ date: "2026-08-01", treatment: t, dims: DIMS, amount: s(amt), forfeitVat: cat === "Z" ? "O" : cat })];
    case "E18": {
      const { net, vat } = cat === "S" ? vatSplit(amt) : { net: amt, vat: 0 };
      return [false, true].flatMap((recoverable) => (["company", "landlord"] as const).map((chargeTo) => pay({
        date: "2026-08-01", treatment: t, dims: DIMS, expenseId: 801, revision: 1, gross: s(amt), net: s(net), vat: s(vat), category: cat,
        rate: cat === "S" ? 15 : 0, recoverable, chargeTo, expenseAccount: { sys: SYS.expensePropertyOther }, bank: { bankAccountId: 3 },
      })));
    }
    case "E19": case "E20": case "E24": return [pay({ date: "2026-08-01", treatment: t, dims: DIMS, amount: s(amt), bank: {} })];
    case "E21": return [pay({ date: "2026-08-01", treatment: t, dims: DIMS, amount: s(amt), targetDims: { ...DIMS, contractId: 14 }, sameContract: false, sameLandlord: true })];
    case "E14": return [pay({ date: "2026-08-01" })];
    case "E28": return [pay({ date: "2026-08-01", lines: [{ accountId: 1, debit: s(amt), credit: "0" }, { accountId: 2, debit: "0", credit: s(amt) }] }, EMPTY_STATE, false)];
    case "E37": return [pay({ date: "2026-09-30", outputVat: s(amt), inputVat: s(Math.floor(amt / 3)) }, EMPTY_STATE, false), pay({ date: "2026-09-30", outputVat: s(amt), inputVat: s(amt * 2) }, EMPTY_STATE, false)];
  }
}

function assertWellFormed(lines: RuleLine[], label: string, dims: boolean) {
  assert.ok(lines.length >= 2, `${label}: at least 2 lines`);
  let d = 0;
  let c = 0;
  for (const l of lines) {
    assert.ok(Number.isSafeInteger(l.debit) && Number.isSafeInteger(l.credit), `${label}: integer halalas`);
    assert.ok(l.debit >= 0 && l.credit >= 0, `${label}: no negative side`);
    assert.ok((l.debit > 0) !== (l.credit > 0), `${label}: exactly one side`);
    if (dims) for (const [k, v] of Object.entries(DIMS)) assert.equal((l.dims as any)[k], v, `${label}: every line carries dim ${k}`);
    d += l.debit;
    c += l.credit;
  }
  assert.equal(d, c, `${label}: Σ debit = Σ credit`);
}

/** Agent invariant: per (tenant, contract), Σ(1122) + Σ(2122) (debit-positive) = 0, i.e. 1122 = −2122. */
function assertMirror(lines: RuleLine[], label: string) {
  const by = new Map<string, number>();
  for (const l of lines) {
    const k = accKey(l);
    if (k !== SYS.arAgency && k !== SYS.lpu) continue;
    const key = `${l.dims.tenantId}|${l.dims.contractId}`;
    by.set(key, (by.get(key) ?? 0) + l.debit - l.credit);
  }
  for (const [k, v] of by) assert.equal(v, 0, `${label}: agent mirror 1122 = −2122 for ${k}`);
}

/** A reversal (mirror) nets to zero per account and per dim tuple (§11.1-c). */
function assertReversalNetsZero(lines: RuleLine[], label: string) {
  const mirror = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, vatBase: l.vatBase == null ? null : -l.vatBase }));
  const by = new Map<string, { amt: number; base: number }>();
  for (const l of [...lines, ...mirror]) {
    const k = `${accKey(l)}|${JSON.stringify(l.dims)}|${l.vatCategory ?? ""}|${l.taxRole ?? ""}`;
    const cur = by.get(k) ?? { amt: 0, base: 0 };
    by.set(k, { amt: cur.amt + l.debit - l.credit, base: cur.base + (l.vatBase ?? 0) });
  }
  for (const [k, v] of by) assert.deepEqual(v, { amt: 0, base: 0 }, `${label}: reversal nets to zero at ${k}`);
}

describe("fv2 posting rules: every rule balances in both modes (§11.1-a, c)", () => {
  const codes = Object.keys(RULES) as RuleCode[];

  it("covers every posting row of §4.4 (E01–E37), and lists the non-posting ones", () => {
    const all = ["E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E09", "E10", "E11", "E12", "E12b", "E13", "E14", "E15", "E16", "E17", "E18", "E19", "E20", "E21", "E22", "E23", "E24", "E25", "E26", "E27", "E28", "E29", "E30", "E31", "E32", "E33", "E34", "E35", "E36", "E37"];
    for (const e of all) {
      const covered = (RULES as any)[e.toUpperCase()] || NON_POSTING[e] || e === "E13"; // E13 posts as E03 per collection
      assert.ok(covered, `§4.4 row ${e} has no rule and no non-posting reason`);
    }
  });

  it("every system key a rule can resolve exists in the chart template", () => {
    const keys = new Set(COA_TEMPLATE.map((a) => a.systemKey).filter(Boolean));
    for (const k of Object.values(SYS)) assert.ok(keys.has(k), `system key ${k} missing from COA_TEMPLATE`);
    for (const k of Object.values(SYS)) assert.equal(COA_TEMPLATE.find((a) => a.systemKey === k)?.isGroup, false, `${k} must be a leaf`);
  });

  for (const mode of ["owner", "manager"] as const) {
    for (const landlord of [{ id: 7, isAccountHolder: true }, { id: 7, isAccountHolder: false }]) {
      const { treatment } = resolveTreatment(mode, landlord);
      it(`${mode} mode, ${landlord.isAccountHolder ? "account-holder" : "third-party"} landlord (${treatment})`, () => {
        const posted = new Set<string>();
        let n = 0;
        for (const rule of codes) {
          for (const cat of CATS) {
            for (const amt of AMOUNTS) {
              for (const c of cases(rule, treatment, cat, amt)) {
                const label = `${rule}/${treatment}/${cat}/${amt}`;
                const out = runRule(c.payload, c.state);
                if (out.skip) continue;
                n++;
                posted.add(rule);
                assertWellFormed(out.lines, label, c.dims !== false && rule !== "E21");
                if (treatment === "agent" && rule !== "E21") assertMirror(out.lines, label);
                assertReversalNetsZero(out.lines, label);
                // VAT convention: every taxRole line has a base; VAT lines are S.
                for (const l of out.lines) if (l.taxRole) assert.ok(l.vatBase != null, `${label}: taxRole line carries vat_base`);
              }
            }
          }
        }
        assert.ok(n > 500, `ran ${n} postings`);
        const skippedByDesign: Record<Treatment, string[]> = { principal: ["E14", "E15", "E16", "E36"], agent: ["E14", "E35"] };
        for (const rule of codes) {
          if (skippedByDesign[treatment].includes(rule)) assert.ok(!posted.has(rule), `${rule} should skip for ${treatment}`);
          else assert.ok(posted.has(rule), `${rule} never posted for ${treatment}`);
        }
      });
    }
  }

  it("E21 keeps the per-contract agent mirror across contracts", () => {
    const out = runRule({ rule: "E21", facts: { date: "2026-08-01", treatment: "agent", dims: DIMS, amount: "100.00", targetDims: { ...DIMS, contractId: 14 }, sameContract: false, sameLandlord: true } }, EMPTY_STATE);
    assertMirror(out.lines, "E21");
    assert.throws(() => runRule({ rule: "E21", facts: { date: "2026-08-01", treatment: "agent", dims: DIMS, amount: "1.00", targetDims: DIMS, sameContract: false, sameLandlord: false } }, EMPTY_STATE), /between landlords/);
  });

  it("E21 moves the credit FROM the source contract TO the target: source AR up (less credit), target AR down (debt settled)", () => {
    // Source contract 13 holds the tenant's credit (AR −1,000); target contract 14 owes 300. Applying 300
    // must leave source −700 and target 0, i.e. Dr AR(source) / Cr AR(target), with 2122 mirroring it (agent).
    for (const t of ["principal", "agent"] as const) {
      const out = runRule({ rule: "E21", facts: { date: "2026-08-01", treatment: t, dims: { ...DIMS, contractId: 13 }, amount: "300.00",
        targetDims: { ...DIMS, contractId: 14 }, sameContract: false, sameLandlord: true } }, EMPTY_STATE);
      const ar = t === "agent" ? "tenant_receivable_agency" : "tenant_receivable";
      const net = (key: string, contract: number) => out.lines
        .filter((l) => "sys" in l.account && l.account.sys === key && l.dims.contractId === contract)
        .reduce((a, l) => a + l.debit - l.credit, 0);
      assert.equal(net(ar, 13), 30000, `${t}: the source's credit shrinks`);
      assert.equal(net(ar, 14), -30000, `${t}: the target's debt shrinks`);
      if (t === "agent") {
        assert.equal(net("landlord_payable_uncollected", 13), -30000, "2122 mirrors 1122 on the source");
        assert.equal(net("landlord_payable_uncollected", 14), 30000, "2122 mirrors 1122 on the target");
      }
    }
  });

  it("skips with reasons where §4.4 says skip", () => {
    const skip = (rule: RuleCode, facts: any, st: PostState = EMPTY_STATE) => runRule({ rule, facts, paymentIds: [P] }, st).skip;
    assert.equal(skip("E15", doc("principal", "S", 34500, "other")), "self_commission");
    assert.equal(skip("E16", coll("agent", 100, "commission_deduction")), "settled_by_deduction");
    assert.equal(skip("E05", inst("principal", "S", 690000), { ...chargedState("S", 690000), charges: { [P]: { ...chargedState("S", 690000).charges[P]!, chargedBy: "document" } } }), "cancelled_but_invoiced");
    assert.equal(skip("E05", inst("principal", "S", 690000), { ...chargedState("S", 690000), writtenOff: [P] }), "written_off");
    // Cutover: a marker with no entry came from the opening balance, which already holds the AR.
    const opening: PostState = { ...chargedState("S", 690000), charges: { [P]: { ...chargedState("S", 690000).charges[P]!, entryId: null } } };
    for (const t of ["principal", "agent"] as Treatment[]) {
      assert.equal(skip("E01", doc(t, "S", 690000), opening), "covered_by_opening", t);
      assert.equal(runRule({ rule: "E01", facts: doc(t, "S", 690000), paymentIds: [P] }, chargedState("S", 690000)).skip, undefined, t);
    }
    assert.equal(skip("E05", inst("principal", "S", 690000)), "not_charged");
    assert.equal(skip("E02", inst("principal", "S", 690000), chargedState("S", 690000)), "already_charged");
    assert.equal(skip("E34", coll("principal", 100, "rent", "S"), chargedState("S", 690000)), "already_charged");
    assert.equal(skip("E34", coll("principal", 100, "rent", "O")), "not_standard_rated");
    assert.equal(skip("E09", { date: "2026-08-01", treatment: "principal", dims: DIMS, documentId: 1, amount: "0", bank: {} }), "fully_linked");
    assert.equal(skip("E21", { date: "2026-08-01", treatment: "principal", dims: DIMS, amount: "1.00", targetDims: DIMS, sameContract: true, sameLandlord: true }), "allocation_only");
    assert.throws(() => runRule({ rule: "E33", facts: inst("principal", "S", 100), paymentIds: [P] }, EMPTY_STATE), /not charged/);
    assert.throws(() => runRule({ rule: "E08", facts: doc("principal", "S", 690000), paymentIds: [P] }, EMPTY_STATE), /rent receipt/);
    assert.throws(() => runRule({ rule: "E03", facts: coll("principal", -100, "rent") }, EMPTY_STATE), /E04/);
  });
});

describe("fv2 mode resolution and collection classification (§4.2, §4.4.1)", () => {
  it("resolves principal/agent per landlord", () => {
    assert.equal(resolveTreatment("owner", { id: 1, isAccountHolder: false }).treatment, "principal");
    assert.equal(resolveTreatment("manager", { id: 1, isAccountHolder: true }).treatment, "principal");
    assert.equal(resolveTreatment("manager", { id: 2, isAccountHolder: false }).treatment, "agent");
    assert.deepEqual(resolveTreatment("manager", null), { treatment: "agent", ownerId: null, warnings: ["landlord_unresolved"] });
  });

  it("classifies collections in the §4.4.1 order", () => {
    assert.equal(classifyCollection({ amount: 1, metaClassification: "deposit_offset", documentKind: "deposit", paymentId: 1 }).rule, "E12B");
    assert.equal(classifyCollection({ amount: 1, metaClassification: "deposit_conversion" }).rule, "E12");
    assert.equal(classifyCollection({ amount: 1, metaClassification: "commission_cash", documentKind: "commission" }).rule, "E16");
    assert.equal(classifyCollection({ amount: 1, documentKind: "deposit", paymentId: 1, paymentIsDeposit: true }).rule, "E09C");
    assert.equal(classifyCollection({ amount: 1, documentKind: "deposit", paymentId: 1, paymentIsDeposit: false }).rule, "E03");
    const conv = classifyCollection({ amount: 1, documentKind: "deposit", looksLikeTerminateConversion: true });
    assert.deepEqual([conv.rule, conv.warnings], ["E12", ["inferred_classification"]]);
    assert.equal(classifyCollection({ amount: 1, documentKind: "deposit" }).rule, null);
    const com = classifyCollection({ amount: 1, documentKind: "commission" });
    assert.deepEqual([com.rule, com.cls], ["E16", "commission_deduction"]);
    assert.equal(classifyCollection({ amount: 1, paymentId: 3, paymentIsDeposit: true }).rule, "E09C");
    assert.equal(classifyCollection({ amount: -5, paymentId: 3 }).rule, "E04");
    const rent = classifyCollection({ amount: 5, paymentId: 3 });
    assert.deepEqual([rent.rule, rent.advanceVatCandidate], ["E03", true]);
    assert.equal(classifyCollection({ amount: 5, paymentId: null }).advanceVatCandidate, false);
  });
});

describe("fv2 worked example §4.5 (synthetic values)", () => {
  const inv = (t: Treatment) => ({ date: "2026-08-01", treatment: t, dims: DIMS, documentId: 1, groups: [{ category: "S", rate: 15, net: "6000.00", vat: "900.00", nature: "rent", usage: "commercial" }], coverage: [{ paymentId: P, amount: "6900.00" }], deferRent: true });
  const com = { date: "2026-08-01", treatment: "agent", dims: DIMS, documentId: 2, groups: [{ category: "S", rate: 15, net: "300.00", vat: "45.00", nature: "other" }], coverage: [], deferRent: true };
  const crn = (t: Treatment) => ({ ...inv(t), date: "2026-08-20", documentId: 3, groups: [{ category: "S", rate: 15, net: "1000.00", vat: "150.00", nature: "rent", usage: "commercial" }] });
  const col = (t: Treatment) => ({ date: "2026-08-10", treatment: t, dims: DIMS, collectionId: 9, amount: "3000.00", cls: "rent", bank: { method: "bank_transfer" }, paymentId: P });

  it("Manager mode, agent landlord", () => {
    const m = new MemLedger();
    m.post("simple_invoice,1,confirmed", { rule: "E01", facts: inv("agent"), paymentIds: [P] });
    m.post("simple_invoice,2,confirmed", { rule: "E15", facts: com });
    m.post("payment_collection,9,collected", { rule: "E03", facts: col("agent"), paymentIds: [P] });
    m.post("simple_invoice,3,confirmed", { rule: "E06", facts: crn("agent"), paymentIds: [P] });
    m.post("simple_invoice,4,confirmed", { rule: "E36", facts: { ...com, date: "2026-08-20", documentId: 4, groups: [{ category: "S", rate: 15, net: "50.00", vat: "7.50", nature: "other" }] } });
    assert.equal(m.balance(SYS.arAgency), 275000);
    assert.equal(m.balance(SYS.lpu), -275000);
    assert.equal(m.balance(SYS.lp), -271250);
    assert.equal(m.balance(SYS.commission), -25000);
    assert.equal(m.balance(SYS.outputVat), -3750);
    assert.equal(m.balance(SYS.ur), 0);
    const tb = m.trialBalance();
    assert.equal(tb.debit, tb.credit);
    // The E01 lines exactly as §4.5 prints them.
    const e01 = m.entries.get("simple_invoice,1,confirmed")!.lines.map((l) => [accKey(l), l.debit, l.credit]);
    assert.deepEqual(e01, [[SYS.arAgency, 690000, 0], [SYS.lpu, 0, 600000], [SYS.lpu, 0, 90000]]);
  });

  it("Owner mode (principal, straight-line)", () => {
    const m = new MemLedger();
    m.post("simple_invoice,1,confirmed", { rule: "E01", facts: inv("principal"), paymentIds: [P] });
    assert.equal(m.post("simple_invoice,2,confirmed", { rule: "E15", facts: { ...com, treatment: "principal" } }).skip, "self_commission");
    m.post("payment_collection,9,collected", { rule: "E03", facts: col("principal"), paymentIds: [P] });
    m.post("simple_invoice,3,confirmed", { rule: "E06", facts: crn("principal"), paymentIds: [P] });
    const rel = m.post("payment,101,release:2026-08", { rule: "E35", facts: { date: "2026-08-31", treatment: "principal", dims: DIMS, paymentId: P, month: "2026-08", windowStart: "2026-08-01", windowEnd: "2026-08-31", category: "S", usage: "commercial" }, paymentIds: [P] });
    assert.equal(rel.date, "2026-08-31");
    assert.equal(m.balance(SYS.ar), 275000);
    assert.equal(m.balance(SYS.ur), 0);
    assert.equal(m.balance(SYS.revCommercial), -500000);
    assert.equal(m.balance(SYS.outputVat), -75000);
  });
});

describe("fv2 straight-line releases sum exactly (§11.1-i)", () => {
  const run = (net: number, windowStart: string, windowEnd: string, creditAfter?: { month: string; amount: number }) => {
    const m = new MemLedger();
    m.post("payment,101,charge", { rule: "E02", facts: { ...inst("principal", "O", net), date: windowStart }, paymentIds: [P] });
    const months: string[] = [];
    for (let [y, mo] = windowStart.split("-").map(Number); `${y}-${String(mo).padStart(2, "0")}` <= windowEnd.slice(0, 7); mo === 12 ? (y++, (mo = 1)) : mo++) {
      months.push(`${y}-${String(mo).padStart(2, "0")}`);
    }
    const releases: number[] = [];
    for (const month of months) {
      const out = m.post(`payment,101,release:${month}`, { rule: "E35", facts: { date: `${month}-28`, treatment: "principal", dims: DIMS, paymentId: P, month, windowStart, windowEnd, category: "O", usage: "commercial" }, paymentIds: [P] });
      releases.push(out.skip ? 0 : out.lines[0].debit);
      if (creditAfter?.month === month) {
        m.post("simple_invoice,9,confirmed", { rule: "E06", facts: { date: `${month}-28`, treatment: "principal", dims: DIMS, documentId: 9, groups: [{ category: "O", rate: 0, net: s(creditAfter.amount), vat: "0", nature: "rent", usage: "commercial" }], coverage: [{ paymentId: P, amount: s(net) }], deferRent: true }, paymentIds: [P] });
      }
    }
    return { m, releases };
  };

  for (const [label, start, end] of [
    ["monthly", "2026-08-01", "2026-08-31"],
    ["quarterly from mid-month", "2026-08-15", "2026-11-14"],
    ["semi-annual", "2026-07-01", "2026-12-31"],
    ["annual across a year end", "2026-03-15", "2027-03-14"],
    ["early termination (ended_on)", "2026-03-15", "2026-06-10"],
  ] as const) {
    it(label, () => {
      for (const net of [1, 100, 1_200_000, 1_234_567, 99_999_999]) {
        const { m, releases } = run(net, start, end);
        assert.equal(releases.reduce((a, b) => a + b, 0), net, `${label} ${net}: releases sum to the net charge`);
        assert.equal(m.balance(SYS.ur), 0);
        assert.equal(m.balance(SYS.revCommercial), -net);
      }
    });
  }

  it("a mid-window credit note lowers the releases after it", () => {
    const { m, releases } = run(1_200_000, "2026-03-15", "2027-03-14", { month: "2026-08", amount: 100_000 });
    assert.equal(releases.reduce((a, b) => a + b, 0), 1_100_000);
    assert.equal(m.balance(SYS.ur), 0);
    assert.equal(m.balance(SYS.revCommercial), -1_100_000);
    assert.equal(m.balance(SYS.ar), 1_100_000);
  });

  it("pro-rates by days, the last month taking the remainder", () => {
    assert.deepEqual(releaseAmount(92_00, "2026-08", "2026-08-01", "2026-10-31"), { amount: 31_00, date: "2026-08-31" });
    assert.deepEqual(releaseAmount(61_00, "2026-09", "2026-08-01", "2026-10-31"), { amount: 30_00, date: "2026-09-30" });
    assert.deepEqual(releaseAmount(31_01, "2026-10", "2026-08-01", "2026-10-31"), { amount: 31_01, date: "2026-10-31" });
    assert.equal(releaseAmount(100, "2026-12", "2026-08-01", "2026-10-31"), null);
    assert.equal(releaseAmount(0, "2026-08", "2026-08-01", "2026-10-31"), null);
  });
});

describe("fv2 reverse-and-replace and advance VAT (§11.1-j, §4.1)", () => {
  /** Σ vat_base and Σ VAT on report lines, per category. */
  const vatReport = (m: MemLedger) => {
    const r: Record<string, { base: number; vat: number }> = {};
    for (const e of m.entries.values()) for (const l of e.lines) {
      if (!l.taxRole) continue;
      const k = l.vatCategory!;
      r[k] ??= { base: 0, vat: 0 };
      r[k].base += l.vatBase ?? 0;
      if (k === "S") r[k].vat += l.credit - l.debit;
    }
    return r;
  };

  it("an O due-date charge followed by an S invoice ends as the invoice only", () => {
    const m = new MemLedger();
    m.post("payment,101,charge", { rule: "E02", facts: inst("principal", "O", 600000), paymentIds: [P] });
    m.post("payment,101,release:2026-08", { rule: "E35", facts: { date: "2026-08-31", treatment: "principal", dims: DIMS, paymentId: P, month: "2026-08", windowStart: "2026-08-01", windowEnd: "2026-10-31", category: "O", usage: "commercial" }, paymentIds: [P] });
    const out = m.post("simple_invoice,501,confirmed", { rule: "E01", facts: { ...doc("principal", "S", 690000), date: "2026-09-05" }, paymentIds: [P] });
    assert.deepEqual(out.replaceDueCharges, [P]);
    assert.equal(m.entries.get("payment,101,charge")!.status, "reversed");
    assert.ok(m.entries.has("payment,101,reversal:charge"));
    assert.equal(m.balance(SYS.ar), 690000);
    assert.equal(m.balance(SYS.outputVat), -90000);
    const rep = vatReport(m);
    assert.deepEqual(rep.O, { base: 0, vat: 0 });
    assert.deepEqual(rep.S, { base: 600000, vat: 90000 });
    // Revenue already released stays; 2131 holds the rest of the document's net.
    const released = 600000 * 31 / 92;
    assert.equal(m.balance(SYS.ur), -(600000 - Math.round(released)));
    assert.equal(m.trialBalance().debit, m.trialBalance().credit);
  });

  it("an E charge followed by an S invoice", () => {
    const m = new MemLedger();
    m.post("payment,101,charge", { rule: "E02", facts: inst("principal", "E", 600000), paymentIds: [P] });
    m.post("simple_invoice,501,confirmed", { rule: "E01", facts: doc("principal", "S", 690000), paymentIds: [P] });
    const rep = vatReport(m);
    assert.deepEqual(rep.E, { base: 0, vat: 0 });
    assert.deepEqual(rep.S, { base: 600000, vat: 90000 });
    assert.equal(m.balance(SYS.ar), 690000);
  });

  it("a document for less than the charge leaves the difference off AR", () => {
    const m = new MemLedger();
    m.post("payment,101,charge", { rule: "E02", facts: inst("agent", "S", 690000), paymentIds: [P] });
    m.post("simple_invoice,501,confirmed", { rule: "E01", facts: doc("agent", "S", 575000), paymentIds: [P] });
    assert.equal(m.balance(SYS.arAgency), 575000);
    assert.equal(m.balance(SYS.lpu), -575000);
    assert.deepEqual(vatReport(m).S, { base: 500000, vat: 75000 });
  });

  it("advance VAT on an uncharged S installment is counted once when the charge follows", () => {
    for (const t of ["principal", "agent"] as const) {
      const m = new MemLedger();
      const ar = t === "agent" ? SYS.arAgency : SYS.ar;
      m.post("payment_collection,701,collected", { rule: "E03", facts: coll(t, 345000, "rent"), paymentIds: [P] });
      m.post("payment_collection,701,advance_vat", { rule: "E34", facts: coll(t, 345000, "rent"), paymentIds: [P] });
      assert.deepEqual(vatReport(m).S, { base: 300000, vat: 45000 });
      m.post("payment,101,charge", { rule: "E02", facts: inst(t, "S", 690000), paymentIds: [P] });
      assert.deepEqual(vatReport(m).S, { base: 600000, vat: 90000 }, t);
      assert.equal(m.balance(ar), 345000, `${t}: the tenant owes the rest`);
      // An invoice later replaces the due charge, still netting the advance once.
      m.post("simple_invoice,501,confirmed", { rule: "E01", facts: doc(t, "S", 690000), paymentIds: [P] });
      assert.deepEqual(vatReport(m).S, { base: 600000, vat: 90000 }, `${t} after invoice`);
      assert.equal(m.balance(ar), 345000);
      // A negative collection reverses the matching advance VAT.
      const neg = runRule({ rule: "E34", facts: coll(t, -345000, "rent"), paymentIds: [P] }, m.state([P]));
      assert.equal(neg.lines.find((l) => l.taxRole)!.debit, 45000);
    }
  });

  it("E05 cancels exactly what the charge booked, splitting 2131 and revenue", () => {
    const m = new MemLedger();
    m.post("payment,101,charge", { rule: "E02", facts: inst("principal", "S", 690000), paymentIds: [P] });
    m.post("payment,101,release:2026-08", { rule: "E35", facts: { date: "2026-08-31", treatment: "principal", dims: DIMS, paymentId: P, month: "2026-08", windowStart: "2026-08-01", windowEnd: "2026-09-30", category: "S", usage: "commercial" }, paymentIds: [P] });
    m.post("payment,101,charge_cancelled", { rule: "E05", facts: { ...inst("principal", "S", 690000), date: "2026-09-02" }, paymentIds: [P] });
    for (const k of [SYS.ar, SYS.ur, SYS.outputVat, SYS.revCommercial]) assert.equal(m.balance(k), 0, k);
    assert.deepEqual(vatReport(m).S, { base: 0, vat: 0 });
  });
});

describe("fv2 VAT settlement E37 with the §8.2(b) apportionment", () => {
  const lines = (f: any) => RULES.E37(f, EMPTY_STATE).lines.map((l) => [accKey(l), l.debit, l.credit]);
  it("a positive adjustment (more recoverable than booked) credits 5500 and lowers the payable", () => {
    assert.deepEqual(lines({ date: "2026-03-31", outputVat: "2940.00", inputVat: "210.00", apportionment: "30.00" }), [
      [SYS.outputVat, 294000, 0], [SYS.inputVat, 0, 21000], [SYS.vatNonRecoverable, 0, 3000], [SYS.vatSettlement, 0, 270000],
    ]);
  });
  it("a negative adjustment expenses the unrecoverable part and raises the payable; still balanced", () => {
    const out = RULES.E37({ date: "2026-03-31", outputVat: "1000.00", inputVat: "300.00", apportionment: "-50.00" }, EMPTY_STATE);
    assert.deepEqual(out.lines.map((l) => [accKey(l), l.debit, l.credit]), [
      [SYS.outputVat, 100000, 0], [SYS.inputVat, 0, 30000], [SYS.vatNonRecoverable, 5000, 0], [SYS.vatSettlement, 0, 75000],
    ]);
    assert.ok(out.lines.every((l) => !l.taxRole), "no tax_role: the settlement is exempt from the VAT lock");
  });
  it("a refund position with an adjustment debits 1152", () => {
    assert.deepEqual(lines({ date: "2026-03-31", outputVat: "100.00", inputVat: "300.00", apportionment: "20.00" }), [
      [SYS.outputVat, 10000, 0], [SYS.inputVat, 0, 30000], [SYS.vatNonRecoverable, 0, 2000], [SYS.vatRefundable, 22000, 0],
    ]);
  });
});

describe("fv2 a document partly covered by the opening balance (§6.7 gap)", () => {
  const Q = 102;
  // Two installments of 6,900 (6,000 + 900): P is in the opening balance (marker, no entry), Q is not charged.
  const twoDoc = (t: Treatment) => ({
    date: "2026-08-01", treatment: t, dims: DIMS, documentId: 502, deferRent: true,
    groups: [group("S", 1_380_000)], coverage: [{ paymentId: P, amount: s(690_000) }, { paymentId: Q, amount: s(690_000) }],
  });
  const openingP: PostState = {
    ...EMPTY_STATE,
    charges: { [P]: { generation: 1, chargedBy: "due", documentId: null, amount: 690_000, vatAmount: 90_000, vatBase: 600_000, entryId: null } },
  };
  for (const t of ["principal", "agent"] as Treatment[]) {
    it(`charges only the share of the installments not in the opening (${t})`, () => {
      const out = runRule({ rule: "E01", facts: twoDoc(t), paymentIds: [P, Q] }, openingP);
      assert.equal(out.skip, undefined);
      assertWellFormed(out.lines, `partly ${t}`, true);
      const arKey = t === "agent" ? SYS.arAgency : SYS.ar;
      const ar = out.lines.filter((l) => accKey(l) === arKey).reduce((a, l) => a + l.debit - l.credit, 0);
      assert.equal(ar, 690_000, "AR is charged once: only Q's 6,900");
      const vat = out.lines.filter((l) => l.taxRole === "output" && l.vatCategory === "S").reduce((a, l) => a + l.credit - l.debit, 0);
      assert.equal(vat, 90_000, "VAT only on Q's share");
      assert.deepEqual(out.effects.filter((e) => e.kind === "charge").map((e: any) => e.paymentId), [Q], "P keeps its opening marker");
      assert.ok(out.warnings.includes("partly_covered_by_opening"));
    });
  }
});
