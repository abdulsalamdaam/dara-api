import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv } from "./__tests__/legacy-env";
import { EjarImportRunner } from "../ejar/ejar.import.service";
import type { ImportPlan } from "../ejar/ejar.import.writer";
import { SYS } from "./rules/system-keys";

/**
 * Customer report (ClickUp z8rcteqtt4, 4 Nov 2026): an Ejar contract imported with
 * four installments Ejar reports paid showed no rent revenue and nothing settled.
 * The import only stamped the rows `settled_external`; their charge (E02), the
 * settlement (E33) and the monthly releases (E35) waited for the recognizer's
 * nightly runs at 00:10 (two of them: E33 and E35 need the posted charge). The
 * import now catches the account up once it has committed, so the test runs
 * neither the recognizer nor the worker itself.
 * Synthetic values only (public repo).
 */
const U = 5311;
const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}-01`);

function plan(holderIdNumber: string): ImportPlan {
  const party = (group: "lessor" | "tenant", name: string, idNumber: string) => ({
    group, role: group, isRepresentative: false, name, partyType: "individual", idType: "national_id", idNumber,
    phone: group === "tenant" ? "500000000" : null, email: group === "tenant" ? "ejar-catchup@example.test" : null,
    unifiedNumber: null, registrationNumber: null, organizationType: null, vat: null, nationality: null, raw: { role: group, name },
  });
  return {
    contractNumber: "FINQA-EJ-CATCHUP",
    landlord: { party: party("lessor", "Synthetic Holder", holderIdNumber), rep: null },
    tenant: { party: party("tenant", "Synthetic Ejar Tenant", "1900000311"), rep: null },
    property: { create: { p: { ejarId: "prop-catchup", name: "Synthetic Catch-up Property", propertyUsage: "commercial" }, overrides: {}, deed: null } },
    unit: { ejar: { units: [{ ejarId: "unit-catchup", unitNumber: "EJ-1", unitUsage: "commercial" }], raw: {}, overrides: { status: "rented" }, linkIds: [] } },
    contract: {
      startDate: "2025-01-01", endDate: "2025-12-31", status: "active", signingDate: null, monthlyRent: "3000",
      customSchedule: months.map((d) => ({ dueDate: d, amount: "3000" })), frequencyHint: "monthly",
      depositAmount: "0", vatFallback: false, notes: null, ejarRaw: null,
    },
    additionalFees: [],
    invoices: months.slice(0, 4).map((d, i) => ({
      id: `CU-${i}`, number: `EJ-CU-${i}`, dueDate: d, issueDate: d, lateDate: null, amount: "3000", remaining: "0", status: "مدفوعة", scheduleNumber: null,
    })) as never,
  };
}

describe("finance v2: an Ejar import reaches the ledger at once, not at the nightly run", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let contractId: number;

  before(async () => {
    env = await legacyEnv("wired");
    env.hooks.recognizer = env.recognizer; // as FinanceV2Module hands them over
    env.hooks.worker = env.worker;
    const seed = await seedAccount(env, U);
    for (const [key, ar] of [["commercial", "تجاري"]]) {
      const [x] = await env.q(`select 1 from lookups where category = 'property_usage' and key = $1`, [key]);
      if (!x) await env.q(`insert into lookups (category, key, label_ar, label_en) values ('property_usage', $1, $2, $1)`, [key, ar]);
    }
    await enableV2(env, U, "manager");
    const holderId = (await env.q(`select id_number from owners where id = $1`, [seed.holder]))[0].id_number;
    const runner = new EjarImportRunner(env.db as never);
    (runner as any).fv2h = env.hooks;
    contractId = (await runner.run(userOf(U).id, plan(holderId))).contractId as number;
  });

  after(async () => { await env?.t.drop(); });

  it("the four Ejar-paid installments are settled (E33) right after the import", async () => {
    const rows = await env.q(
      `select count(*)::int as n from ledger_outbox o join payments p on p.id = o.source_id
        where o.user_id = $1 and o.source_type = 'payment' and o.event = 'settled_external' and o.status = 'posted' and p.contract_id = $2`,
      [U, contractId],
    );
    assert.equal(rows[0].n, 4);
  });

  it("rent revenue for the months already passed is booked, with the tenant on every line", async () => {
    const [r] = await env.q(
      `select coalesce(sum(l.credit - l.debit), 0)::numeric as rev, count(*) filter (where l.tenant_id is null)::int as no_tenant
         from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.system_key like 'rent_revenue%' and l.contract_id = $2`,
      [U, contractId],
    );
    assert.ok(Number(r.rev) > 0, `revenue booked (${r.rev})`);
    assert.equal(r.no_tenant, 0);
    const [ur] = await env.q(
      `select coalesce(sum(l.credit - l.debit), 0)::numeric as bal from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.system_key = $2 and l.contract_id = $3`,
      [U, SYS.ur, contractId],
    );
    assert.equal(Number(ur.bal), 0, "a 2025 contract is fully earned: nothing left in unearned rent");
  });
});
