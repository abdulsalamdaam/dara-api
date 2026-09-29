import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { withTx } from "./db";
import { ManualJournalsService } from "./manual-journals.service";
import { PeriodCloseService } from "./period-close.service";
import { BackfillService } from "./backfill/backfill.service";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { contractCtx } from "./hooks/facts-loader";
import { sqlOf } from "./hooks/sql";

/**
 * The three Phase-2 gaps closed in the tier-3 round, against a real
 * (throwaway, local) Postgres. Synthetic data only.
 *
 *  1. The balance trigger's per-transaction marker (`fv2.chk_<id>`) could be
 *     set by the session itself, skipping the check. Hardened in 0068.
 *  2. A manual adjustment approved into a CLOSED fiscal year left the year's
 *     P&L open (the closing entry was not refreshed).
 *  3. A contract terminated before Finance v2 was enabled lost its landlord
 *     dimension (contract_units are hard-deleted on terminate).
 */
const ALL = ["reports.view", "payments.view", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete", "payments.write"];
const holderOf = (id: number) => ({ id, ownerUserId: null, ownerScopeId: null, role: "user", permissions: ALL }) as any;

describe("finance v2 Phase-2 gaps (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let journal: JournalRepository;
  let periods: PeriodsService;
  let mj: ManualJournalsService;
  let pc: PeriodCloseService;

  before(async () => {
    env = await legacyEnv("wired");
    periods = new PeriodsService(env.t.pool);
    journal = new JournalRepository(periods);
    const backfill = new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
      new FinanceSetupService(new ChartService(env.t.pool), periods));
    mj = new ManualJournalsService(env.t.pool, journal, periods);
    pc = new PeriodCloseService(env.t.pool, periods, journal, env.worker, env.recognizer, backfill);
  });

  after(async () => {
    await env?.t.drop();
  });

  // ── 1. Balance check cannot be skipped from the session ──────────────────
  describe("balance trigger hardening", () => {
    const U = 7401;
    let acc: Record<string, number>;
    before(async () => {
      await seedAccount(env, U);
      await enableV2(env, U, "manager");
      acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
    });

    const newEntry = async (c: any, total: string) => {
      const p = await periods.ensurePeriod(c, U, "2026-03-10");
      const e = await c.query(
        `insert into journal_entries (user_id, entry_no, entry_date, original_date, period_id, origin, source_type, source_id, event, total)
         values ($1, $2, '2026-03-10', '2026-03-10', $3, 'auto', 'test', 1, $4, $5) returning id`,
        [U, `T-${Math.random()}`, p.id, `k${Math.random()}`, total]);
      return Number(e.rows[0].id);
    };
    const line = (c: any, id: number, n: number, account: number, d: string, cr: string) => c.query(
      `insert into journal_lines (entry_id, user_id, line_no, entry_date, account_id, debit, credit) values ($1, $2, $3, '2026-03-10', $4, $5, $6)`,
      [id, U, n, account, d, cr]);

    it("an unbalanced entry is refused even when the session pre-sets the per-entry marker", async () => {
      await assert.rejects(withTx(env.t.pool, async (c) => {
        const id = await newEntry(c, "100.00");
        await c.query(`select set_config('fv2.chk_' || $1::text, '1', true)`, [id]);
        await line(c, id, 1, acc["1113"], "100.00", "0");
        await line(c, id, 2, acc["1121"], "0", "1.00");
      }), (e: any) => e?.code === "23514" && /unbalanced/.test(e.message));
      assert.equal((await env.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'test'`, [U]))[0].n, 0);
    });

    it("a later transaction cannot add lines to a posted entry, marker or not", async () => {
      const id = await withTx(env.t.pool, async (c) => {
        const x = await newEntry(c, "50.00");
        await line(c, x, 1, acc["1113"], "50.00", "0");
        await line(c, x, 2, acc["1121"], "0", "50.00");
        return x;
      });
      await assert.rejects(withTx(env.t.pool, async (c) => {
        await c.query(`select set_config('fv2.chk_' || $1::text, '1', true)`, [id]);
        await line(c, id, 3, acc["1113"], "7.00", "0");
      }), (e: any) => /earlier transaction|immutable/.test(e.message));
      const [n] = await env.q(`select count(*)::int as n, sum(debit)::text as d from journal_lines where entry_id = $1`, [id]);
      assert.deepEqual([n.n, n.d], [2, "50.00"]);
    });

    it("legitimate flows are unaffected: many entries in one transaction, and a balanced entry with many lines", async () => {
      await withTx(env.t.pool, async (c) => {
        for (let i = 0; i < 20; i++) {
          await journal.post(c, { userId: U, entryDate: "2026-03-12", origin: "auto", sourceType: "test_many", sourceId: i, event: "x",
            lines: [{ accountId: acc["1113"], debit: 100 + i }, { accountId: acc["1121"], credit: 100 + i }] });
        }
        const lines = Array.from({ length: 60 }, (_, i) => ({ accountId: acc["1121"], credit: 1 + i }));
        const total = lines.reduce((s, l) => s + l.credit, 0);
        await journal.post(c, { userId: U, entryDate: "2026-03-12", origin: "auto", sourceType: "test_many", sourceId: 99, event: "wide",
          lines: [{ accountId: acc["1113"], debit: total }, ...lines] });
      });
      assert.equal((await env.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'test_many'`, [U]))[0].n, 21);
    });
  });

  // ── 2. Year-end closing entry refresh ─────────────────────────────────────
  describe("an adjustment into a closed year refreshes the year-end close", () => {
    const U = 7402;
    const holder = holderOf(U);
    let acc: Record<string, number>;
    const pl2025 = async () => (await env.q(
      `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.type in ('revenue','expense') and l.entry_date between '2025-01-01' and '2025-12-31'`, [U]))[0].b;
    const re = async () => (await env.q(
      `select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.code = '3300'`, [U]))[0].b;
    const post = async (entryDate: string, lines: any[]) => {
      const d = await mj.create(U, holder, { entryDate, memo: "Synthetic adjustment", lines });
      await mj.submit(U, holder, d.id);
      return mj.approve(U, holder, d.id);
    };

    before(async () => {
      await env.q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co Y', 'company')`, [U, `fv2-spec-${U}@example.test`]);
      await enableV2(env, U, "manager");
      acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
      // FY2025: revenue 1,000 and an expense 400 → profit 600.
      await post("2025-03-10", [{ accountId: acc["1113"], debit: "1000.00" }, { accountId: acc["4390"], credit: "1000.00" }]);
      await post("2025-06-10", [{ accountId: acc["5290"], debit: "400.00" }, { accountId: acc["1113"], credit: "400.00" }]);
      await withTx(env.t.pool, (c) => periods.ensureFiscalYear(c, U, 2025));
      await env.q(`update fiscal_periods set status = 'closed' where user_id = $1 and fiscal_year = 2025 and period_no < 12`, [U]);
      const res: any = await pc.closeYear(U, holder, { fiscalYear: 2025 }, "2026-02-01");
      assert.ok(res.closingEntry?.id);
      assert.equal(await pl2025(), "0.00");
      assert.equal(await re(), "600.00");
    });

    it("a P&L adjustment approved into a closed month of the closed year is closed to 3300 in the same transaction", async () => {
      const r: any = await post("2025-11-15", [{ accountId: acc["5110"], debit: "300.00" }, { accountId: acc["1113"], credit: "300.00" }]);
      assert.equal(r.status, "posted");
      assert.equal(await pl2025(), "0.00", "the year's P&L stays closed");
      assert.equal(await re(), "300.00", "600 − 300");
      const adj = await env.q(
        `select e.origin, e.event, to_char(e.entry_date,'YYYY-MM-DD') as d, e.source_type, e.source_id::int as fy from journal_entries e
          where e.user_id = $1 and e.event like 'closing:adj:%'`, [U]);
      assert.equal(adj.length, 1);
      assert.deepEqual([adj[0].origin, adj[0].d, adj[0].source_type, adj[0].fy], ["closing", "2025-12-31", "fiscal_year", 2025]);
      assert.equal(adj[0].event, `closing:adj:${r.postedEntryId}`);
    });

    it("a balance-sheet-only adjustment needs no refresh", async () => {
      await post("2025-10-05", [{ accountId: acc["1113"], debit: "20.00" }, { accountId: acc["1121"], credit: "20.00" }]);
      assert.equal((await env.q(`select count(*)::int as n from journal_entries where user_id = $1 and event like 'closing:adj:%'`, [U]))[0].n, 1);
    });

    it("when period 12 of the closed year is locked, a P&L adjustment is refused (409) and nothing posts", async () => {
      const [p12] = await env.q(`select id from fiscal_periods where user_id = $1 and fiscal_year = 2025 and period_no = 12`, [U]);
      await pc.lock(U, holder, p12.id, { reason: "audited" });
      const before = (await env.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]))[0].n;
      await assert.rejects(post("2025-11-20", [{ accountId: acc["5110"], debit: "5.00" }, { accountId: acc["1113"], credit: "5.00" }]),
        (e: any) => e?.getStatus?.() === 409 && e.getResponse().error === "YEAR_CLOSING_LOCKED");
      assert.equal((await env.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]))[0].n, before);
      assert.equal(await pl2025(), "0.00");
    });
  });

  // ── 3. Landlord dimension of a contract terminated before enable ─────────
  describe("terminated-contract landlord dimension fallback", () => {
    const U = 7403;
    const U1 = 7404; // an account with a single landlord
    let s: Seed;
    let s1: Seed;
    let cTax: number, cLedger: number, cSole: number;
    const user = { ...userOf(U), permissions: ALL };
    const user1 = { ...userOf(U1), permissions: ALL };
    const mk = (u: any, seed: Seed, unit: number) => env.contracts.create(u, {
      unitIds: [unit], tenantId: seed.tenant, tenantName: "Synthetic Tenant", startDate: "2025-01-01", endDate: "2025-12-31",
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
    });

    before(async () => {
      s = await seedAccount(env, U);
      s1 = await seedAccount(env, U1);
      // U1 keeps only its account-holder landlord.
      await env.q(`update owners set deleted_at = now() where id = $1`, [s1.agent]);
      await env.q(`update properties set owner_id = $2 where id = $1`, [s1.propA, s1.holder]);
      // Flag OFF: the contracts are created and terminated before Finance v2 exists for the account.
      cTax = (await mk(user, s, s.unitA1)).id;
      cLedger = (await mk(user, s, s.unitA2)).id;
      cSole = (await mk(user1, s1, s1.unitA1)).id;
      await env.q(`update contracts set landlord_tax_number = '300000000000003' where id = $1`, [cTax]);
      for (const [u, c] of [[user, cTax], [user, cLedger], [user1, cSole]] as const) await env.contracts.terminate(u, String(c), {});
      assert.equal((await env.q(`select count(*)::int as n from contract_units where contract_id = any($1::int[])`, [[cTax, cLedger, cSole]]))[0].n, 0);
      await enableV2(env, U, "manager");
      await enableV2(env, U1, "manager");
    });

    it("resolves the landlord by the contract's landlord VAT number", async () => {
      const ctx = await contractCtx(sqlOf(env.t.pool as any), U, "manager", cTax);
      assert.equal(ctx?.ownerId, s.agent);
      assert.equal(ctx?.treatment, "agent");
      assert.ok(ctx?.warnings.includes("dimension_inferred"));
      assert.ok(!ctx?.warnings.includes("landlord_unresolved"));
    });

    it("fills a stored null landlord from the ledger's history of the contract (e.g. the opening entry)", async () => {
      const [d0] = await env.q(`select owner_id, property_id from finance_contract_dims where contract_id = $1`, [cLedger]);
      assert.deepEqual([d0.owner_id, d0.property_id], [null, null], "captured at enable with nothing to go on");
      const acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
      await withTx(env.t.pool, (c) => journal.post(c, {
        userId: U, entryDate: "2025-12-31", origin: "manual", sourceType: "test_opening", sourceId: 1, event: "posted",
        lines: [
          { accountId: acc["1122"], debit: 50000, ownerId: s.agent, propertyId: s.propA, contractId: cLedger, tenantId: s.tenant },
          { accountId: acc["2122"], credit: 50000, ownerId: s.agent, propertyId: s.propA, contractId: cLedger, tenantId: s.tenant },
        ],
      }));
      const ctx = await contractCtx(sqlOf(env.t.pool as any), U, "manager", cLedger);
      assert.deepEqual([ctx?.ownerId, ctx?.propertyId, ctx?.treatment], [s.agent, s.propA, "agent"]);
      assert.ok(ctx?.warnings.includes("dimension_inferred"));
      const [d1] = await env.q(`select owner_id, property_id from finance_contract_dims where contract_id = $1`, [cLedger]);
      assert.deepEqual([d1.owner_id, d1.property_id], [s.agent, s.propA], "the filled nulls are stored");
    });

    it("an account with a single landlord resolves to it", async () => {
      const ctx = await contractCtx(sqlOf(env.t.pool as any), U1, "manager", cSole);
      assert.deepEqual([ctx?.ownerId, ctx?.treatment], [s1.holder, "principal"]);
      assert.ok(ctx?.warnings.includes("dimension_inferred"));
    });

    it("a contract whose units are known is not marked inferred", async () => {
      const c = (await mk(user, s, s.unitH1)).id;
      const ctx = await contractCtx(sqlOf(env.t.pool as any), U, "manager", c);
      assert.deepEqual([ctx?.ownerId, ctx?.propertyId], [s.holder, s.propH]);
      assert.ok(!ctx?.warnings.includes("dimension_inferred"));
    });
  });
});
