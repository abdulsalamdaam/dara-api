import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, MIGRATION_0066, type TestDb } from "./__tests__/with-db";
import { withTx } from "./db";
import { fromHalalas, toHalalas } from "./money";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { JournalRepository, type LineInput } from "./journal.repository";

/**
 * 0066 against a real (throwaway, local) Postgres: the migration applies on a
 * fresh schema and re-applies as a no-op, and the ledger triggers refuse what
 * DESIGN §2.4 says they refuse. Synthetic ids only.
 */
describe("finance v2 migration and ledger triggers (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let periods: PeriodsService;
  let chart: ChartService;
  let repo: JournalRepository;
  const U = 9001;          // synthetic account scope
  const OTHER = 9002;
  const acc: Record<string, number> = {};

  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const code = (e: any) => e?.code;

  /** The entry total = Σ debit (1.00 when there are no lines, so the line-count check is what fires). */
  const sumDebits = (lines: Array<[number, string, string]>) => {
    const n = lines.reduce((s, [, d]) => s + toHalalas(d), 0);
    return fromHalalas(n || 100);
  };

  /** Insert an entry with raw SQL, bypassing the repository, in one transaction. */
  async function rawEntry(opts: { user?: number; date?: string; origin?: string; total?: string; key?: string; lines: Array<[number, string, string]> }) {
    return withTx(t.pool, async (c) => {
      const user = opts.user ?? U;
      const date = opts.date ?? "2026-03-10";
      const p = await periods.ensurePeriod(c, user, date);
      const e = await c.query(
        `insert into journal_entries (user_id, entry_no, entry_date, original_date, period_id, origin, source_type, source_id, event, total)
         values ($1, $2, $3, $3, $4, $5, 'test', 1, $6, $7) returning id`,
        [user, `T-${Math.random()}`, date, p.id, opts.origin ?? "auto", opts.key ?? `k${Math.random()}`, opts.total ?? sumDebits(opts.lines)],
      );
      const id = e.rows[0].id;
      let n = 0;
      for (const [a, d, cr] of opts.lines) {
        await c.query(`insert into journal_lines (entry_id, user_id, line_no, entry_date, account_id, debit, credit) values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, user, ++n, date, a, d, cr]);
      }
      return Number(id);
    });
  }

  const post = (lines: LineInput[], over: Partial<Parameters<JournalRepository["post"]>[1]> = {}) =>
    withTx(t.pool, (c) => repo.post(c, {
      userId: U, entryDate: "2026-03-15", origin: "auto", sourceType: "test", sourceId: 1, event: `e${Math.random()}`, lines, ...over,
    }));

  before(async () => {
    t = await withDb();
    await t.apply(MIGRATION_0066); // idempotent: a second pass is a no-op
    periods = new PeriodsService(t.pool);
    chart = new ChartService(t.pool);
    repo = new JournalRepository(periods);
    await withTx(t.pool, (c) => chart.seedChart(c, U));
    await withTx(t.pool, (c) => chart.seedChart(c, OTHER));
    const r = await q(`select code, id from accounts where user_id = $1`, [U]);
    for (const row of r.rows) acc[row.code] = row.id;
  });
  after(async () => { await t?.drop(); });

  describe("migration", () => {
    it("creates every Finance v2 table and trigger, alters no other table", async () => {
      const tables = (await q(`select table_name from information_schema.tables where table_schema = current_schema() order by 1`)).rows.map((r) => r.table_name);
      for (const name of ["finance_settings", "finance_settings_events", "accounts", "fiscal_periods", "journal_entries", "journal_lines",
        "ledger_outbox", "bank_accounts", "finance_collection_meta", "finance_expense_details", "finance_expense_category_map",
        "finance_payout_meta", "finance_deposit_refunds", "finance_installment_charges", "finance_installment_vat_points",
        "tenant_credit_actions", "finance_write_offs", "finance_ejar_settlements", "manual_journals", "finance_backfill_runs",
        "finance_contract_dims", "finance_vat_return_drafts"]) assert.ok(tables.includes(name), name);
      const triggers = (await q(`select distinct event_object_table as t, trigger_name as n from information_schema.triggers
                                   where trigger_schema = current_schema()`)).rows;
      const legacy = new Set(["users", "roles", "owners", "properties", "units", "contracts", "contract_units", "audit_logs"]);
      assert.ok(triggers.every((x) => !legacy.has(x.t)), "no trigger on a legacy table");
      for (const n of ["journal_lines_balanced", "journal_entries_balanced", "journal_lines_immutable", "journal_entries_immutable",
        "journal_lines_account_ok", "journal_entries_period_open", "journal_lines_vat_lock", "accounts_guard", "accounts_no_delete",
        "manual_journals_frozen"]) assert.ok(triggers.some((x) => x.n === n), n);
    });

    it("re-applies on a populated schema without error or change", async () => {
      const before = (await q(`select count(*)::int n from accounts`)).rows[0].n;
      await t.apply(MIGRATION_0066);
      assert.equal((await q(`select count(*)::int n from accounts`)).rows[0].n, before);
    });

    it("applies on a fresh schema with NO legacy tables (0066 depends on none)", async () => {
      const bare = await withDb({ legacy: false });
      try {
        await bare.apply(MIGRATION_0066);
        const n = (await bare.pool.query(`select count(*)::int n from information_schema.tables where table_schema = current_schema()`)).rows[0].n;
        assert.equal(n, 22 + 8 + 5, "22 tables from 0066, 8 from 0067 and 5 from 0069 (withDb applies them all; 0068 adds none)");
      } finally { await bare.drop(); }
    });

    it("refuses to adopt a pre-existing foreign table with a Finance v2 name (name-collision guard)", async () => {
      const x = await withDb({ legacy: false, migrate: false });
      try {
        await x.pool.query(`create table accounts (id serial primary key, name text)`);
        await assert.rejects(x.apply(MIGRATION_0066), /already exists and is not the Finance v2 table/);
        const n = (await x.pool.query(`select count(*)::int n from information_schema.tables where table_schema = current_schema()`)).rows[0].n;
        assert.equal(n, 1, "nothing else was created: the file is atomic");
      } finally { await x.drop(); }
    });
  });

  describe("balance (deferred constraint trigger)", () => {
    it("accepts a balanced entry", async () => {
      const id = await rawEntry({ lines: [[acc["1113"], "100.00", "0"], [acc["1121"], "0", "100.00"]] });
      assert.ok(id > 0);
    });
    it("rejects an unbalanced entry at commit", async () => {
      await assert.rejects(rawEntry({ lines: [[acc["1113"], "100.00", "0"], [acc["1121"], "0", "99.99"]] }),
        (e: any) => code(e) === "23514" && /unbalanced/.test(e.message));
    });
    it("rejects a one-line entry and an entry with no lines", async () => {
      await assert.rejects(rawEntry({ lines: [[acc["1113"], "100.00", "0"]] }), /at least 2 required/);
      await assert.rejects(rawEntry({ lines: [] }), /0 line\(s\)/);
    });
    it("rejects a total that differs from the lines", async () => {
      await assert.rejects(rawEntry({ total: "50.00", lines: [[acc["1113"], "100.00", "0"], [acc["1121"], "0", "100.00"]] }), /total/);
    });
    it("rejects a line with both or neither side", async () => {
      await assert.rejects(rawEntry({ lines: [[acc["1113"], "100.00", "100.00"], [acc["1121"], "0", "0"]] }), (e: any) => code(e) === "23514");
    });
    it("rejects a later transaction adding lines to a posted entry", async () => {
      const id = await rawEntry({ lines: [[acc["1113"], "100.00", "0"], [acc["1121"], "0", "100.00"]] });
      await assert.rejects(withTx(t.pool, async (c) => {
        await c.query(`insert into journal_lines (entry_id, user_id, line_no, entry_date, account_id, debit, credit) values ($1,$2,9,'2026-03-10',$3,5,0),($1,$2,10,'2026-03-10',$4,0,5)`,
          [id, U, acc["1113"], acc["1121"]]);
      }), /earlier transaction/, "refused at insert since 0068 (lines only in the entry's own transaction)");
    });
    it("the repository refuses an unbalanced entry before SQL", async () => {
      await assert.rejects(post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 99 }]), /unbalanced/);
    });
  });

  describe("immutability", () => {
    let id: number;
    before(async () => {
      id = await rawEntry({ lines: [[acc["1113"], "10.00", "0"], [acc["1121"], "0", "10.00"]] });
    });
    it("refuses UPDATE and DELETE of lines", async () => {
      await assert.rejects(q(`update journal_lines set debit = 11 where entry_id = $1 and line_no = 1`, [id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`delete from journal_lines where entry_id = $1`, [id]), (e: any) => code(e) === "55000");
    });
    it("refuses UPDATE and DELETE of entries, and TRUNCATE of either table", async () => {
      await assert.rejects(q(`update journal_entries set memo = 'x' where id = $1`, [id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`delete from journal_entries where id = $1`, [id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`truncate journal_lines cascade`), (e: any) => code(e) === "55000");
      await assert.rejects(q(`truncate journal_entries cascade`), (e: any) => code(e) === "55000");
    });
    it("permits only posted -> reversed with reversed_by, and a reversal nets to zero", async () => {
      const orig = await post([{ accountId: acc["1113"], debit: 12345 }, { accountId: acc["2151"], credit: 12345 }], { event: "rev-me" });
      await assert.rejects(q(`update journal_entries set status = 'reversed' where id = $1`, [orig.id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`update journal_entries set status = 'reversed', reversed_by = $1, memo = 'sneaky' where id = $1`, [orig.id]),
        (e: any) => code(e) === "55000");
      const other = await post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["2151"], credit: 100 }]);
      await assert.rejects(q(`update journal_entries set status = 'reversed', reversed_by = $2, reversed_at = now() where id = $1`, [orig.id, other.id]),
        (e: any) => code(e) === "55000", "reversed_by must be this entry's own reversal");
      const rev = await withTx(t.pool, (c) => repo.reverse(c, U, orig.id, { entryDate: "2026-03-20" }));
      assert.equal(rev.created, true);
      const s = (await q(`select status, reversed_by from journal_entries where id = $1`, [orig.id])).rows[0];
      assert.equal(s.status, "reversed");
      assert.equal(Number(s.reversed_by), rev.id);
      const net = (await q(`select account_id, sum(debit - credit)::text net from journal_lines where entry_id in ($1, $2) group by account_id`, [orig.id, rev.id])).rows;
      assert.ok(net.every((r) => r.net === "0.00"));
      await assert.rejects(withTx(t.pool, (c) => repo.reverse(c, U, orig.id, { entryDate: "2026-03-21" })), /already reversed/);
    });
  });

  describe("idempotency", () => {
    it("the same (source_type, source_id, event) posts once", async () => {
      const lines = [{ accountId: acc["1111"], debit: 500 }, { accountId: acc["1121"], credit: 500 }];
      const a = await post(lines, { sourceType: "payment_collection", sourceId: 77, event: "collected" });
      const b = await post(lines, { sourceType: "payment_collection", sourceId: 77, event: "collected" });
      assert.equal(a.created, true);
      assert.equal(b.created, false);
      assert.equal(b.id, a.id);
      assert.equal((await q(`select count(*)::int n from journal_entries where source_type = 'payment_collection' and source_id = 77`)).rows[0].n, 1);
      assert.match(a.entryNo, /^JV-2026-\d{6}$/);
    });
    it("a raw duplicate insert is refused by the unique index", async () => {
      await rawEntry({ key: "dup", lines: [[acc["1113"], "1.00", "0"], [acc["1121"], "0", "1.00"]] });
      await assert.rejects(rawEntry({ key: "dup", lines: [[acc["1113"], "1.00", "0"], [acc["1121"], "0", "1.00"]] }), (e: any) => code(e) === "23505");
    });
  });

  describe("periods", () => {
    it("refuses automatic postings into a closed period; accepts manual adjustments there", async () => {
      await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2026-01-10"));
      await q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = '2026-01-01'`, [U]);
      await assert.rejects(post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 100 }], { entryDate: "2026-01-15" }),
        (e: any) => code(e) === "55000" && /period closed/.test(e.message));
      await assert.rejects(post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 100 }], { entryDate: "2026-01-15", origin: "backfill" }),
        /period closed/);
      const m = await post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 100 }], { entryDate: "2026-01-15", origin: "manual" });
      assert.equal(m.created, true);
    });
    it("refuses everything in a locked period", async () => {
      await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2025-12-10"));
      await q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on = '2025-12-01'`, [U]);
      for (const origin of ["auto", "manual", "closing"] as const) {
        await assert.rejects(post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 100 }], { entryDate: "2025-12-31", origin }),
          /period closed/, origin);
      }
    });
    it("refuses an entry dated outside its period", async () => {
      await assert.rejects(withTx(t.pool, async (c) => {
        const p = await periods.ensurePeriod(c, U, "2026-04-01");
        await c.query(`insert into journal_entries (user_id, entry_no, entry_date, original_date, period_id, origin, source_type, source_id, event, total)
                       values ($1, 'X-1', '2026-05-01', '2026-05-01', $2, 'auto', 't', 1, 'x', 1)`, [U, p.id]);
      }), /outside period/);
    });
    it("refuses VAT-bearing lines in a VAT-locked month, allows non-VAT lines", async () => {
      await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2026-02-10"));
      await q(`update fiscal_periods set vat_locked_at = now() where user_id = $1 and starts_on = '2026-02-01'`, [U]);
      await assert.rejects(post([{ accountId: acc["1121"], debit: 115 }, { accountId: acc["2151"], credit: 15, taxRole: "output", vatCategory: "S" },
        { accountId: acc["4120"], credit: 100, vatCategory: "S" }], { entryDate: "2026-02-20" }), /VAT period locked/);
      const ok = await post([{ accountId: acc["1113"], debit: 100 }, { accountId: acc["1121"], credit: 100 }], { entryDate: "2026-02-20" });
      assert.equal(ok.created, true);
    });
    it("ensurePeriod is idempotent", async () => {
      const a = await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2026-06-03"));
      const b = await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2026-06-30"));
      assert.equal(a.id, b.id);
      assert.deepEqual([a.startsOn, a.endsOn, a.periodNo, a.fiscalYear], ["2026-06-01", "2026-06-30", 6, 2026]);
    });
    it("a period's dates are fixed, locked is terminal, a VAT lock is never lifted, and periods are never deleted", async () => {
      const p = await withTx(t.pool, (c) => periods.ensurePeriod(c, U, "2026-06-10"));
      await assert.rejects(q(`update fiscal_periods set starts_on = '2026-07-01', ends_on = '2026-07-31' where id = $1`, [p.id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`update fiscal_periods set user_id = $2 where id = $1`, [p.id, OTHER]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`delete from fiscal_periods where id = $1`, [p.id]), (e: any) => code(e) === "55000");
      await assert.rejects(q(`update fiscal_periods set status = 'open' where user_id = $1 and starts_on = '2025-12-01'`, [U]), /locked/);
      await assert.rejects(q(`update fiscal_periods set vat_locked_at = null where user_id = $1 and starts_on = '2026-02-01'`, [U]), /VAT-locked/);
      await q(`update fiscal_periods set status = 'closed' where id = $1`, [p.id]);
      await q(`update fiscal_periods set status = 'open' where id = $1`, [p.id]);
    });
  });

  describe("postable accounts and scoping", () => {
    it("refuses posting to a group account", async () => {
      await assert.rejects(post([{ accountId: acc["1110"], debit: 100 }, { accountId: acc["1121"], credit: 100 }]), /group account/);
    });
    it("refuses posting to an inactive account", async () => {
      await q(`update accounts set is_active = false where id = $1`, [acc["1221"]]);
      await assert.rejects(post([{ accountId: acc["1221"], debit: 100 }, { accountId: acc["1113"], credit: 100 }]), /inactive/);
      await q(`update accounts set is_active = true where id = $1`, [acc["1221"]]);
    });
    it("refuses another account's chart (composite FK / scope)", async () => {
      const foreign = (await q(`select id from accounts where user_id = $1 and code = '1113'`, [OTHER])).rows[0].id;
      await assert.rejects(post([{ accountId: foreign, debit: 100 }, { accountId: acc["1121"], credit: 100 }]), /not in this chart/);
    });
  });

  describe("chart guards", () => {
    it("locks type, normal balance, system key and code once an account has postings", async () => {
      await post([{ accountId: acc["1112"], debit: 100 }, { accountId: acc["1121"], credit: 100 }]);
      await assert.rejects(q(`update accounts set type = 'expense' where id = $1`, [acc["1112"]]), /locked/);
      await assert.rejects(q(`update accounts set normal_balance = 'credit' where id = $1`, [acc["1112"]]), /locked/);
      await assert.rejects(q(`update accounts set system_key = 'x' where id = $1`, [acc["1112"]]), /locked/);
      await assert.rejects(q(`update accounts set code = '1119' where id = $1`, [acc["1112"]]), /locked/);
      await q(`update accounts set name_en = 'Petty cash (HQ)' where id = $1`, [acc["1112"]]);
    });
    it("refuses a group with postings or a system key, and a child under a leaf or system account", async () => {
      await assert.rejects(q(`update accounts set is_group = true where id = $1`, [acc["1121"]]), /cannot be a group/);
      await assert.rejects(q(`insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id) values ($1,'112101','أ','a','asset','debit',$2)`,
        [U, acc["1121"]]), /not a group/);
    });
    it("refuses a parent of another type, another chart, or a cycle", async () => {
      await assert.rejects(q(`insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id) values ($1,'111001','أ','a','expense','debit',$2)`,
        [U, acc["1110"]]), /type/);
      const foreignGroup = (await q(`select id from accounts where user_id = $1 and code = '1110'`, [OTHER])).rows[0].id;
      await assert.rejects(q(`insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id) values ($1,'111002','أ','a','asset','debit',$2)`,
        [U, foreignGroup]), /another chart/);
      await assert.rejects(q(`update accounts set parent_id = $1 where id = $2`, [acc["1110"], acc["1100"]]), /cycle/);
    });
    it("refuses deleting a template account or one with postings; the service deletes a fresh user account", async () => {
      await assert.rejects(q(`delete from accounts where id = $1`, [acc["5280"]]), /template/);
      const created = await chart.create(U, 1, { parentId: acc["5200"], nameAr: "مصروفات ضيافة", nameEn: "Hospitality" });
      assert.equal(created.code, "520001");
      assert.equal(created.type, "expense");
      assert.deepEqual(await chart.remove(U, created.id), { ok: true });
    });
    it("the service turns a leaf without postings into a group, and refuses one with a system key", async () => {
      const sub = await chart.create(U, 1, { parentId: acc["1221"], nameAr: "أثاث المكتب", nameEn: "Office furniture" });
      assert.equal(sub.code, "122101");
      assert.equal((await chart.get(U, acc["1221"])).isGroup, true);
      await assert.rejects(chart.create(U, 1, { parentId: acc["1113"], nameAr: "بنك", nameEn: "Bank" }), /sibling/);
      await assert.rejects(chart.update(U, acc["2151"], { isActive: false }), /automatic posting/);
      await assert.rejects(chart.get(OTHER, acc["1221"]), /not found/i);
    });
  });

  describe("manual journals", () => {
    it("a posted manual journal is frozen until its entry is reversed, then may only be voided", async () => {
      const e = await post([{ accountId: acc["1113"], debit: 700 }, { accountId: acc["3100"], credit: 700 }], { origin: "manual", event: "mj" });
      const mj = (await q(`insert into manual_journals (user_id, entry_date, memo, lines, created_by, status, posted_entry_id)
                           values ($1, '2026-03-15', 'capital', '[]', 1, 'posted', $2) returning id`, [U, e.id])).rows[0].id;
      await assert.rejects(q(`update manual_journals set memo = 'x' where id = $1`, [mj]), /correct it with a reversal/);
      await assert.rejects(q(`update manual_journals set status = 'void' where id = $1`, [mj]), /correct it with a reversal/);
      await assert.rejects(q(`delete from manual_journals where id = $1`, [mj]), /correct it with a reversal/);
      await withTx(t.pool, (c) => repo.reverse(c, U, e.id, { entryDate: "2026-03-16" }));
      await q(`update manual_journals set status = 'void' where id = $1`, [mj]);
    });
  });

  describe("purge (the only delete path)", () => {
    it("fv2_purge_account removes one account's rows and nothing else", async () => {
      const P = 9003;
      await withTx(t.pool, (c) => chart.seedChart(c, P));
      const a = (await q(`select id from accounts where user_id = $1 and code = '1113'`, [P])).rows[0].id;
      const b = (await q(`select id from accounts where user_id = $1 and code = '3100'`, [P])).rows[0].id;
      await withTx(t.pool, (c) => repo.post(c, { userId: P, entryDate: "2026-03-01", origin: "manual", sourceType: "t", sourceId: 1, event: "x",
        lines: [{ accountId: a, debit: 100 }, { accountId: b, credit: 100 }] }));
      const otherBefore = (await q(`select count(*)::int n from journal_lines where user_id <> $1`, [P])).rows[0].n;
      await q(`select fv2_purge_account($1)`, [P]);
      for (const tbl of ["journal_lines", "journal_entries", "accounts", "fiscal_periods"]) {
        assert.equal((await q(`select count(*)::int n from ${tbl} where user_id = $1`, [P])).rows[0].n, 0, tbl);
      }
      assert.equal((await q(`select count(*)::int n from journal_lines where user_id <> $1`, [P])).rows[0].n, otherBefore);
      // the guard is back on afterwards, in the same session
      await assert.rejects(q(`delete from accounts where user_id = $1 and code = '5280'`, [U]), /template/);
    });
  });
});
