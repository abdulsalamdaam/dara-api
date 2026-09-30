import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { fv2DbSkip, withDb, type TestDb } from "./__tests__/with-db";
import { withTx } from "./db";
import { FinanceFlagService } from "./flag.service";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { FinanceSetupService } from "./setup.service";
import { FinanceV2AdminService } from "./admin.service";
import { JournalRepository } from "./journal.repository";
import { COA_TEMPLATE } from "./coa-template";
import { periodFor, riyadhToday } from "./dates";

/**
 * The admin switch against a real (throwaway, local) Postgres: validation,
 * the audit_logs row, the settings history, and the first-enable setup (chart
 * seed complete and hierarchy valid, periods, default cash/bank). Synthetic
 * rows only.
 */
describe("finance v2 admin toggle and first-enable seed (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let flag: FinanceFlagService;
  let admin: FinanceV2AdminService;
  let ids: { staff: number; company: number; individual: number; employee: number; ownerOnly: number };
  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const reason = "Beta for the synthetic test account";

  before(async () => {
    t = await withDb();
    const roles = (await q(`insert into roles (key) values ('super_admin'), ('user'), ('accountant') returning id, key`)).rows;
    const role = (k: string) => roles.find((r) => r.key === k).id;
    const mk = async (email: string, roleKey: string, extra: { owner?: number; type?: string } = {}) =>
      (await q(`insert into users (email, name, role_id, owner_user_id, user_type) values ($1, 'Synthetic', $2, $3, $4) returning id`,
        [email, role(roleKey), extra.owner ?? null, extra.type ?? "individual"])).rows[0].id as number;
    const staff = await mk("staff@example.test", "super_admin");
    const company = await mk("company@example.test", "user", { type: "company" });
    const individual = await mk("individual@example.test", "user");
    const employee = await mk("employee@example.test", "accountant", { owner: company });
    const ownerOnly = await mk("owner-only@example.test", "user");
    ids = { staff, company, individual, employee, ownerOnly };

    // company: its own landlord row plus a third-party landlord with an active contract
    const holder = (await q(`insert into owners (user_id, name, tax_number, is_account_holder) values ($1, 'Holder', '300000000000003', true) returning id`, [company])).rows[0].id;
    const third = (await q(`insert into owners (user_id, name, id_number) values ($1, 'Third party', '1000000001') returning id`, [company])).rows[0].id;
    for (const o of [holder, third]) {
      const p = (await q(`insert into properties (user_id, owner_id) values ($1, $2) returning id`, [company, o])).rows[0].id;
      const u = (await q(`insert into units (property_id) values ($1) returning id`, [p])).rows[0].id;
      const c = (await q(`insert into contracts (user_id, status) values ($1, 'active') returning id`, [company])).rows[0].id;
      await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c, u]);
    }
    // ownerOnly: two landlord rows of the same legal person (same VAT number)
    const h2 = (await q(`insert into owners (user_id, name, tax_number, is_account_holder) values ($1, 'Me', '311111111111113', true) returning id`, [ownerOnly])).rows[0].id;
    const dup = (await q(`insert into owners (user_id, name, tax_number) values ($1, 'Me (Ejar import)', '311111111111113') returning id`, [ownerOnly])).rows[0].id;
    for (const o of [h2, dup]) {
      const p = (await q(`insert into properties (user_id, owner_id) values ($1, $2) returning id`, [ownerOnly, o])).rows[0].id;
      const u = (await q(`insert into units (property_id) values ($1) returning id`, [p])).rows[0].id;
      const c = (await q(`insert into contracts (user_id, status) values ($1, 'active') returning id`, [ownerOnly])).rows[0].id;
      await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c, u]);
    }

    flag = new FinanceFlagService(t.pool);
    const periods = new PeriodsService(t.pool);
    const chart = new ChartService(t.pool);
    admin = new FinanceV2AdminService(t.pool, flag, new FinanceSetupService(chart, periods));
  });
  after(async () => { await t?.drop(); });

  it("validates the body: reason 5–500 characters, enabled boolean, known mode", async () => {
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "manager" }), BadRequestException);
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "manager", reason: "abc" }), BadRequestException);
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: "yes", reason }), BadRequestException);
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "landlord", reason }), BadRequestException);
  });

  it("refuses non-customer targets (400) and unknown ids (404)", async () => {
    await assert.rejects(admin.toggle(ids.staff, ids.employee, { enabled: true, accountingMode: "manager", reason }), BadRequestException);
    await assert.rejects(admin.toggle(ids.staff, ids.staff, { enabled: true, accountingMode: "manager", reason }), BadRequestException);
    await assert.rejects(admin.toggle(ids.staff, 999999, { enabled: true, accountingMode: "manager", reason }), NotFoundException);
  });

  it("requires a mode on the first enable", async () => {
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, reason }), /accountingMode is required/);
  });

  it("refuses Owner mode when a third-party landlord has an active contract; suggests manager", async () => {
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "owner", reason }), /Owner mode/);
    assert.equal(await admin.suggestMode(ids.company), "manager");
    assert.equal(await admin.suggestMode(ids.ownerOnly), "owner");
    assert.equal(await flag.isOn(ids.company), false, "a refused toggle writes nothing");
    assert.equal((await q(`select count(*)::int n from finance_settings`)).rows[0].n, 0);
  });

  it("enables: settings row, history, audit_logs under the TARGET account, and the flag reads on at once", async () => {
    assert.equal(await flag.isOn(ids.company), false); // primes the cache with "off"
    const res: any = await admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "manager", reason });
    assert.equal(res.settings.enabled, true);
    assert.equal(res.settings.accountingMode, "manager");
    assert.equal(res.firstEnable, true);
    assert.equal(res.backfill.suggested, true);
    assert.equal(await flag.isOn(ids.company), true, "cache invalidated by the toggle");

    const audit = (await q(`select * from audit_logs where entity = 'finance_v2'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].owner_user_id, ids.company);
    assert.equal(audit[0].actor_user_id, ids.staff);
    assert.equal(audit[0].action, "update");
    assert.equal(audit[0].entity_id, String(ids.company));
    assert.equal(audit[0].method, "PATCH");
    assert.equal(audit[0].path, `/admin/finance-v2/${ids.company}`);

    const ev = await admin.events(ids.company);
    assert.deepEqual(ev.map((e: any) => [e.field, e.oldValue, e.newValue, e.reason]).sort(), [
      ["accounting_mode", null, "manager", reason],
      ["finance_v2_enabled", null, true, reason],
    ]);
  });

  it("seeds the complete chart with a valid hierarchy", async () => {
    const rows = (await q(`select a.code, a.name_ar, a.name_en, a.type, a.normal_balance, a.system_key, a.is_group, a.is_template,
                                  p.code as parent_code, p.type as parent_type, p.is_group as parent_is_group
                             from accounts a left join accounts p on p.id = a.parent_id
                            where a.user_id = $1 order by a.code`, [ids.company])).rows;
    assert.equal(rows.length, 119);
    assert.equal(rows.filter((r) => r.is_group).length, 30);
    const tpl = new Map(COA_TEMPLATE.map((a) => [a.code, a]));
    for (const r of rows) {
      const a = tpl.get(r.code)!;
      assert.ok(a, r.code);
      assert.deepEqual([r.name_ar, r.name_en, r.type, r.normal_balance, r.system_key, r.is_group, r.parent_code, r.is_template],
        [a.nameAr, a.nameEn, a.type, a.normalBalance, a.systemKey, a.isGroup, a.parent, true], r.code);
      if (r.parent_code) {
        assert.equal(r.parent_type, r.type);
        assert.equal(r.parent_is_group, true);
      }
    }
    // no cycles: every account reaches a root within the depth of the chart
    const depth = (await q(`with recursive walk as (
        select id, parent_id, 0 as d from accounts where user_id = $1
        union all select w.id, a.parent_id, w.d + 1 from walk w join accounts a on a.id = w.parent_id where w.d < 10)
      select max(d)::int m from walk`, [ids.company])).rows[0].m;
    assert.ok(depth <= 4, `depth ${depth}`);
  });

  it("creates the current and previous fiscal years' periods, all open", async () => {
    const p = (await q(`select fiscal_year, status from fiscal_periods where user_id = $1`, [ids.company])).rows;
    const fy = periodFor(riyadhToday()).fiscalYear;
    assert.equal(p.length, 24);
    assert.deepEqual([...new Set(p.map((r) => r.fiscal_year))].sort(), [fy - 1, fy]);
    assert.ok(p.every((r) => r.status === "open"));
  });

  it("creates the default cash box (1111) and bank account (1113) and makes them the defaults", async () => {
    const b = (await q(`select b.id, b.kind, b.is_default, a.code, a.bank_account_id from bank_accounts b join accounts a on a.id = b.gl_account_id
                         where b.user_id = $1 order by b.kind`, [ids.company])).rows;
    assert.deepEqual(b.map((r) => [r.kind, r.code, r.is_default, r.bank_account_id === r.id]), [["bank", "1113", true, true], ["cash", "1111", true, true]]);
    const s = (await q(`select default_bank_account_id, default_cash_account_id from finance_settings where account_user_id = $1`, [ids.company])).rows[0];
    assert.equal(s.default_bank_account_id, b[0].id);
    assert.equal(s.default_cash_account_id, b[1].id);
  });

  it("off then on again is idempotent: no duplicate accounts, periods or bank accounts; history grows", async () => {
    await q(`update accounts set name_en = 'Renamed by the user' where user_id = $1 and code = '5280'`, [ids.company]);
    const off: any = await admin.toggle(ids.staff, ids.company, { enabled: false, reason: "Pause the beta for review" });
    assert.equal(off.settings.enabled, false);
    assert.equal(await flag.isOn(ids.company), false);
    await admin.toggle(ids.staff, ids.company, { enabled: true, reason: "Resume the beta after review" });
    const n = (await q(`select (select count(*) from accounts where user_id = $1)::int a, (select count(*) from fiscal_periods where user_id = $1)::int p,
                               (select count(*) from bank_accounts where user_id = $1)::int b`, [ids.company])).rows[0];
    assert.deepEqual(n, { a: 119, p: 24, b: 2 });
    assert.equal((await q(`select name_en from accounts where user_id = $1 and code = '5280'`, [ids.company])).rows[0].name_en, "Renamed by the user");
    assert.equal((await q(`select count(*)::int n from audit_logs where entity = 'finance_v2'`)).rows[0].n, 3);
    assert.equal((await admin.events(ids.company)).length, 4);
    assert.equal((await q(`select finance_v2_enabled, accounting_mode from finance_settings where account_user_id = $1`, [ids.company])).rows[0].accounting_mode, "manager");
  });

  it("refuses a mode change after the first posting (409)", async () => {
    const acc = (await q(`select code, id from accounts where user_id = $1 and code in ('1113','3100')`, [ids.company])).rows;
    const id = (c: string) => acc.find((r) => r.code === c).id;
    await withTx(t.pool, (c) => new JournalRepository(new PeriodsService(t.pool)).post(c, {
      userId: ids.company, entryDate: riyadhToday(), origin: "manual", sourceType: "manual_journal", sourceId: 1, event: "posted",
      lines: [{ accountId: id("1113"), debit: 100000 }, { accountId: id("3100"), credit: 100000 }],
    }));
    await assert.rejects(admin.toggle(ids.staff, ids.company, { enabled: true, accountingMode: "owner", reason }), ConflictException);
  });

  it("allows Owner mode for one legal person's several landlord rows", async () => {
    const res: any = await admin.toggle(ids.staff, ids.ownerOnly, { enabled: true, accountingMode: "owner", reason });
    assert.equal(res.settings.accountingMode, "owner");
  });

  it("lists customer accounts only, with their flag state", async () => {
    const list = await admin.listAccounts();
    const byId = new Map(list.map((r: any) => [r.id, r]));
    assert.ok(!byId.has(ids.staff) && !byId.has(ids.employee));
    assert.equal(byId.get(ids.company).enabled, true);
    assert.equal(byId.get(ids.individual).enabled, false);
  });

  it("a schema without finance_settings (0066 failed) reads off everywhere", async () => {
    const bare = await withDb({ migrate: false });
    try {
      const f = new FinanceFlagService(bare.pool);
      assert.equal(await f.isOn(1), false);
      assert.equal((await f.stateStrict(1)).on, false);
    } finally { await bare.drop(); }
  });
});
