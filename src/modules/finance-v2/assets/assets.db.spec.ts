import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { ChartService } from "../chart.service";
import { JournalExportService } from "../tier3/journal-export.service";
import { extractEvents, keyOf } from "../backfill/extract";
import { loadSettings } from "../hooks/facts-loader";
import { sqlOf } from "../hooks/sql";
import { AssetsService } from "./assets.service";
import { DepreciationJobService } from "./depreciation-job.service";

/**
 * DESIGN §8.5 fixed assets on a throwaway Postgres (synthetic data only).
 * "Today" is pinned with the service's clock.
 *
 * Hand-computed (Manager mode):
 *   A  computers, cost 12,000.00, no salvage, 12 months from 2026-01-01, paid from the default bank, linked to the holder's villa:
 *      FA01 Dr 1222 12,000 / Cr 1113; FA02 1,000.00 a month (Dr 5320 / Cr 1229).
 *      On 2026-07-10: Jan–Jun queued (6,000). Run for July → dep:2026-07 (1,000).
 *      Disposed 2026-07-15 for 7,000.00: July's 1,000 is reversed; the disposal books 15/31 × 1,000 = 483.87,
 *      removes 6,483.87 accumulated and the 12,000 cost; NBV 5,516.13 → gain 1,483.87 (Cr 4420).
 *   B  furniture, cost 3,100.00, salvage 100.00, 30 months from 2026-03-16, recorded already (mode none):
 *      base 3,000 → 100.00 a month; March 16/31 → 51.61. April is closed: dep:2026-04 posts on 2026-05-01, late.
 *      Voided: every B entry reversed.
 */
const U = 5701;
const OTHER = 5702;
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve"];
const user = { id: U, ownerUserId: null, ownerScopeId: null, email: "fv2-spec-5701@example.test", role: "user", permissions: PERMS } as any;

async function drain(env: LegacyEnv, u = U) {
  for (let i = 0; i < 20; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 fixed assets: register, depreciation, disposal, schedule, external codes (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let svc: AssetsService;
  let chart: ChartService;
  let acc: Record<string, number>;
  let A: any, B: any, C: any;

  const bal = async (code: string, extra = "", p: unknown[] = []) => (await env.q(
    `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
      where l.user_id = $1 and a.code = $2 ${extra}`, [U, code, ...p]))[0].b;
  const assetBal = (code: string, id: number) => bal(code, `and exists (select 1 from journal_entries e where e.id = l.entry_id and e.source_type = 'fixed_asset' and e.source_id = $3)`, [id]);
  const entry = async (id: number, event: string) => (await env.q(
    `select e.entry_no, to_char(e.entry_date,'YYYY-MM-DD') as entry_date, to_char(e.original_date,'YYYY-MM-DD') as original_date, e.is_late, e.status, e.warnings,
            (select json_agg(json_build_object('code', a.code, 'dr', l.debit::text, 'cr', l.credit::text, 'property', l.property_id) order by l.line_no)
               from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = e.id) as lines
       from journal_entries e where e.user_id = $1 and e.source_type = 'fixed_asset' and e.source_id = $2 and e.event = $3`, [U, id, event]))[0];
  const outboxCount = async () => (await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_type = 'fixed_asset'`, [U]))[0].n;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await seedAccount(env, OTHER);
    await enableV2(env, U, "manager");
    await enableV2(env, OTHER, "manager");
    chart = new ChartService(env.t.pool as any);
    svc = new AssetsService(env.t.pool as any, env.emitter, new BankAccountsService(env.t.pool as any), chart);
    svc.clock = () => "2026-07-10";
    acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
  });

  after(async () => {
    await env?.t.drop();
  });

  it("the chart top-up adds the three §8.5 accounts to an older chart, once, and leaves a full chart alone", async () => {
    assert.ok(acc["1224"] && acc["5340"] && acc["5350"], "a new chart has them from the template");
    assert.equal(await chart.topUp(env.t.pool as any, U), 0);
    // an older chart: only the parent groups exist
    const OLD = 5703;
    for (const [code, type, nb, parent] of [["1000", "asset", "debit", null], ["1200", "asset", "debit", "1000"], ["1220", "asset", "debit", "1200"],
      ["5000", "expense", "debit", null], ["5300", "expense", "debit", "5000"]] as const) {
      await env.q(`insert into accounts (user_id, code, name_ar, name_en, type, normal_balance, parent_id, is_group, is_template)
                   values ($1, $2, $2, $2, $3, $4, (select id from accounts where user_id = $1 and code = $5), true, true)`, [OLD, code, type, nb, parent]);
    }
    assert.equal(await chart.topUp(env.t.pool as any, OLD), 3);
    assert.equal(await chart.topUp(env.t.pool as any, OLD), 0, "idempotent");
    const rows = await env.q(`select a.code, p.code as parent, a.is_group from accounts a join accounts p on p.id = a.parent_id where a.user_id = $1 and a.code in ('1224','5340','5350') order by 1`, [OLD]);
    assert.deepEqual(rows.map((r: any) => [r.code, r.parent, r.is_group]), [["1224", "1220", false], ["5340", "5300", false], ["5350", "5300", false]]);
  });

  it("defaults per category; validation (land, salvage, accounts, another account's property)", async () => {
    const d = await svc.defaults(U);
    const comp = d.categories.find((c) => c.key === "computers")!;
    assert.deepEqual([comp.assetAccountId, comp.accumAccountId, comp.expenseAccountId, comp.lifeMonths], [acc["1222"], acc["1229"], acc["5320"], 36]);
    const land = d.categories.find((c) => c.key === "land")!;
    assert.deepEqual([land.assetAccountId, land.accumAccountId, land.depreciable], [acc["1211"], null, false]);
    const base = { nameAr: "جهاز", category: "computers", acquisitionDate: "2026-01-01", cost: "1000" };
    const e1: any = await attempt(() => svc.create(U, user, { ...base, category: "land", usefulLifeMonths: 12 }));
    assert.deepEqual([e1.status, e1.body.error], [400, "BAD_LIFE"]);
    const e2: any = await attempt(() => svc.create(U, user, { ...base, salvageValue: "1200" }));
    assert.deepEqual([e2.status, e2.body.error], [400, "BAD_AMOUNT"]);
    const e3: any = await attempt(() => svc.create(U, user, { ...base, assetAccountId: acc["1113"] }));
    assert.deepEqual([e3.status, e3.body.error], [400, "BAD_ACCOUNT"], "a bank account is not a cost account");
    const e4: any = await attempt(() => svc.create(U, user, { ...base, accumAccountId: acc["5320"] }));
    assert.deepEqual([e4.status, e4.body.error], [400, "BAD_ACCOUNT"]);
    const otherProp = (await env.q(`select id from properties where user_id = $1 limit 1`, [OTHER]))[0].id;
    const e5: any = await attempt(() => svc.create(U, user, { ...base, propertyId: otherProp }));
    assert.equal(e5.status, 404);
    assert.equal(await outboxCount(), 0, "nothing queued by a refused create");
  });

  it("register A (paid from the bank): acquisition + every ended month queued at once; posts with the property dimension", async () => {
    A = await svc.create(U, user, {
      nameAr: "أجهزة حاسب", nameEn: "Computers", category: "computers", propertyId: s.propH, acquisitionDate: "2026-01-01",
      cost: "12000", usefulLifeMonths: 12, acquisitionMode: "bank",
    });
    assert.deepEqual([A.number, A.status, A.monthlyCharge, A.fullyDepreciatedIn, A.posted], ["FA-000001", "active", "1000.00", "2026-12", true]);
    const ev = (await env.q(`select event from ledger_outbox where user_id = $1 and source_type = 'fixed_asset' and source_id = $2 order by event`, [U, A.id])).map((r: any) => r.event);
    assert.deepEqual(ev, ["acquired", "dep:2026-01", "dep:2026-02", "dep:2026-03", "dep:2026-04", "dep:2026-05", "dep:2026-06"], "July has not ended on 2026-07-10");
    await drain(env);
    const acq = await entry(A.id, "acquired");
    assert.deepEqual(acq.lines.map((l: any) => [l.code, l.dr, l.cr, l.property]), [["1222", "12000.00", "0.00", s.propH], ["1113", "0.00", "12000.00", s.propH]]);
    const jun = await entry(A.id, "dep:2026-06");
    assert.equal(jun.entry_date, "2026-06-30", "dated the month end");
    assert.deepEqual(jun.lines.map((l: any) => [l.code, l.dr, l.cr]), [["5320", "1000.00", "0.00"], ["1229", "0.00", "1000.00"]]);
    assert.equal(await assetBal("1229", A.id), "-6000.00");
    const got = await svc.get(U, A.id);
    assert.deepEqual([got.accumulated, got.nbv, got.lastPostedMonth], ["6000.00", "6000.00", "2026-06"]);
    assert.deepEqual(got.schedule.slice(0, 7).map((r: any) => [r.month, r.charge, r.state]),
      [["2026-01", "1000.00", "posted"], ["2026-02", "1000.00", "posted"], ["2026-03", "1000.00", "posted"], ["2026-04", "1000.00", "posted"],
        ["2026-05", "1000.00", "posted"], ["2026-06", "1000.00", "posted"], ["2026-07", "1000.00", "not_queued"]]);
    assert.equal(((await attempt(() => svc.get(OTHER, A.id))) as any).status, 404, "another account's asset");
  });

  it("the monthly run is idempotent per asset and month; the current month can be run, a future one cannot", async () => {
    const pre = await svc.preview(U, { month: "2026-06" });
    assert.equal(pre.count, 0);
    const again = await svc.runMonth(U, user.id, "2026-06", "manual");
    assert.deepEqual([again.queued, again.total], [0, "0.00"], "a repeated run queues nothing");
    const p7 = await svc.preview(U, { month: "2026-07" });
    assert.deepEqual(p7.rows.map((r: any) => [r.number, r.event, r.amount, r.late]), [["FA-000001", "dep:2026-07", "1000.00", false]]);
    const r7 = await svc.runMonth(U, user.id, "2026-07", "manual");
    assert.deepEqual([r7.queued, r7.assets, r7.total], [1, 1, "1000.00"]);
    assert.equal((await svc.runMonth(U, user.id, "2026-07", "manual")).queued, 0);
    const fut: any = await attempt(() => svc.runMonth(U, user.id, "2026-08", "manual"));
    assert.deepEqual([fut.status, fut.body.error], [400, "FUTURE_MONTH"]);
    await drain(env);
    const runs = await svc.runs(U);
    assert.deepEqual(runs.runs.map((r: any) => [r.month, r.trigger, r.queued]), [["2026-07", "manual", 0], ["2026-07", "manual", 1], ["2026-06", "manual", 0]]);
    assert.deepEqual(runs.months.find((m: any) => m.month === "2026-07"), { month: "2026-07", entries: 1, total: "1000.00", posted: 1, pending: 0, failed: 0, reversed: 0, late: 0 });
  });

  it("a closed period: the month's depreciation moves to the next open period, flagged late (B)", async () => {
    await env.q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = '2026-04-01'`, [U]);
    B = await svc.create(U, user, {
      nameAr: "أثاث المكتب", category: "furniture", acquisitionDate: "2026-03-16", cost: "3100", salvageValue: "100", usefulLifeMonths: 30,
    });
    const p = await svc.preview(U, { month: "2026-06" });
    assert.equal(p.count, 0, "create queued B's ended months already");
    await drain(env);
    const mar = await entry(B.id, "dep:2026-03");
    assert.deepEqual(mar.lines.map((l: any) => [l.code, l.dr, l.cr]), [["5320", "51.61", "0.00"], ["1229", "0.00", "51.61"]], "16/31 of 100.00");
    const apr = await entry(B.id, "dep:2026-04");
    assert.deepEqual([apr.entry_date, apr.original_date, apr.is_late, apr.warnings.includes("late_posting")], ["2026-05-01", "2026-04-30", true, true]);
    assert.equal((await entry(B.id, "dep:2026-05")).entry_date, "2026-05-31");
    assert.equal(await entry(B.id, "acquired"), undefined, "mode none: no acquisition entry");
    const runs = await svc.runs(U);
    assert.equal(runs.months.find((m: any) => m.month === "2026-04").late, 1);
  });

  it("financial fields freeze once anything is queued; descriptive edits and delete-before-posting work", async () => {
    C = await svc.create(U, user, { nameAr: "سيارة", category: "vehicles", acquisitionDate: "2026-07-05", cost: "60000", usefulLifeMonths: 60 });
    assert.equal(C.posted, false, "July has not ended: nothing queued yet");
    C = await svc.update(U, user, C.id, { cost: "61000" });
    assert.deepEqual([C.cost, C.monthlyCharge], ["61000.00", "1016.67"]);
    await svc.runMonth(U, user.id, "2026-07", "manual");
    const frozen: any = await attempt(() => svc.update(U, user, C.id, { cost: "62000" }));
    assert.deepEqual([frozen.status, frozen.body.error, frozen.body.fields], [409, "ASSET_POSTED", ["cost"]]);
    C = await svc.update(U, user, C.id, { nameEn: "Company car", notes: "plate 1234" });
    assert.equal(C.nameEn, "Company car");
    assert.equal(((await attempt(() => svc.remove(U, user, C.id))) as any).body.error, "ASSET_POSTED");
    const D = await svc.create(U, user, { nameAr: "مسودة", category: "equipment", acquisitionDate: "2026-07-09", cost: "500" });
    assert.deepEqual(await svc.remove(U, user, D.id), { ok: true });
    await drain(env);
  });

  it("disposal mid-life (A, 2026-07-15, proceeds 7,000): July reversed, the part month booked, gain 1,483.87, A off the books", async () => {
    svc.clock = () => "2026-07-20";
    const bad1: any = await attempt(() => svc.dispose(U, user, A.id, { date: "2026-07-25", proceeds: "7000" }));
    assert.deepEqual([bad1.status, bad1.body.error], [400, "BAD_DATE"], "not in the future");
    A = await svc.dispose(U, user, A.id, { date: "2026-07-15", proceeds: "7000", note: "sold" });
    assert.equal(A.status, "disposed");
    assert.deepEqual(A.disposal, { date: "2026-07-15", proceeds: "7000.00", partial: "483.87", accumulated: "6483.87", nbv: "5516.13", gain: "1483.87", state: "pending", entryId: null, entryNo: null });
    await drain(env);
    const d = await entry(A.id, "disposed");
    assert.deepEqual(d.lines.map((l: any) => [l.code, l.dr, l.cr]), [
      ["5320", "483.87", "0.00"], ["1229", "0.00", "483.87"], ["1229", "6483.87", "0.00"], ["1113", "7000.00", "0.00"], ["1222", "0.00", "12000.00"], ["4420", "0.00", "1483.87"],
    ]);
    assert.equal((await entry(A.id, "dep:2026-07")).status, "reversed");
    assert.equal((await entry(A.id, "reversal:dep:2026-07")).entry_date, "2026-07-31", "a reversal is never dated before its original");
    for (const code of ["1222", "1229"]) assert.equal(await assetBal(code, A.id), "0.00", `${code} is clear for A`);
    assert.equal(await assetBal("5320", A.id), "6483.87", "Jan–Jun + 15 days of July");
    assert.equal(await assetBal("1113", A.id), "-5000.00", "paid 12,000, received 7,000");
    const got = await svc.get(U, A.id);
    assert.deepEqual([got.accumulated, got.nbv, got.schedule.length, got.schedule.at(-1).month], ["0.00", "0.00", 6, "2026-06"]);
    assert.equal(((await attempt(() => svc.dispose(U, user, A.id, { date: "2026-07-16" }))) as any).body.error, "ASSET_NOT_ACTIVE");
    // the next run adds nothing for A
    assert.equal((await svc.preview(U, { month: "2026-07" })).rows.filter((r: any) => r.assetId === A.id).length, 0);
  });

  it("void (B): every entry of the asset reversed; B leaves the list", async () => {
    const noReason: any = await attempt(() => svc.void(U, user, B.id, {}));
    assert.equal(noReason.body.error, "REASON_REQUIRED");
    B = await svc.void(U, user, B.id, { reason: "entered twice" });
    await drain(env);
    for (const code of ["1229", "5320"]) assert.equal(await assetBal(code, B.id), "0.00");
    const open = (await env.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'fixed_asset' and source_id = $2 and status = 'posted' and reversal_of is null`, [U, B.id]))[0].n;
    assert.equal(open, 0);
    assert.deepEqual((await svc.list(U)).rows.map((r) => r.number), ["FA-000003", "FA-000001"], "void assets are hidden by default");
    assert.equal((await svc.list(U, { status: "all" })).rows.length, 3);
  });

  it("the asset schedule ties: cost and accumulated roll forward to the NBV", async () => {
    const r = await svc.scheduleReport(U, { from: "2026-01-01", to: "2026-07-31" });
    const a = r.rows.find((x: any) => x.id === A.id)!;
    assert.deepEqual([a.costOpen, a.additions, a.disposals, a.costClose, a.accOpen, a.depreciation, a.accRemoved, a.accClose, a.nbvClose],
      ["0.00", "12000.00", "12000.00", "0.00", "0.00", "6483.87", "6483.87", "0.00", "0.00"]);
    const c = r.rows.find((x: any) => x.id === C.id)!;
    assert.deepEqual([c.costOpen, c.additions, c.costClose, c.depreciation, c.accClose, c.nbvClose], ["0.00", "61000.00", "61000.00", "885.48", "885.48", "60114.52"],
      "61,000 / 60 × 27/31 in July (bought on the 5th)");
    assert.equal(r.rows.some((x: any) => x.id === B.id), false, "void left out");
    // A later window: A was disposed before it
    const r2 = await svc.scheduleReport(U, { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(r2.rows.map((x: any) => x.id), [C.id]);
    assert.deepEqual([r2.rows[0].costOpen, r2.rows[0].accOpen], ["61000.00", "885.48"]);
    const t = r.totals;
    assert.equal(t.nbvClose, (Number(t.costClose) - Number(t.accClose)).toFixed(2));
  });

  it("backfill/catch-up extraction reproduces the asset keys: nothing new to queue", async () => {
    const st = (await loadSettings(sqlOf(env.t.pool as any), U))!;
    const ex = await extractEvents(sqlOf(env.t.pool as any), U, st, { today: "2026-07-20" });
    const mine = ex.events.filter((e) => e.sourceType === "fixed_asset");
    assert.ok(mine.length > 0);
    const have = new Set((await env.q(`select source_type || '|' || source_id || '|' || event as k from ledger_outbox where user_id = $1`, [U])).map((r: any) => r.k));
    assert.deepEqual(mine.filter((e) => !have.has(keyOf(e))).map(keyOf), []);
  });

  it("the daily job: flag on + ledger started + assets; kill switches", async () => {
    const job = new DepreciationJobService(svc);
    assert.equal(await svc.jobAccounts().then((x) => x.includes(U)), true);
    assert.equal((await job.runAll("2026-08-02"))[U], 0, "C's July was run by hand already; August has not ended");
    assert.equal((await job.runAll("2026-09-01"))[U], 1, "on 1 September: C's August");
    assert.equal((await job.runAll("2026-09-01"))[U], 0, "a second run the same day queues nothing");
    const auto = (await svc.runs(U)).runs.filter((r: any) => r.trigger === "auto");
    assert.deepEqual(auto.map((r: any) => [r.month, r.queued, r.runBy]), [["2026-08", 1, null]], "an auto run is logged only when it queued something");
    process.env.FINANCE_V2_DEPRECIATION_DISABLED = "1";
    assert.equal(DepreciationJobService.disabled(), true);
    delete process.env.FINANCE_V2_DEPRECIATION_DISABLED;
  });

  it("external account codes: set, shown in the chart, exported (standard column 24, external preset, Excel); cleared; validated", async () => {
    const bank = await chart.update(U, acc["1113"], { externalCode: " EXT-1113 " }, user.id);
    assert.equal(bank.externalCode, "EXT-1113");
    await chart.update(U, acc["1222"], { externalCode: "1-02-001" }, user.id);
    assert.equal((await chart.list(U)).find((a) => a.id === acc["1113"])!.externalCode, "EXT-1113");
    const bad: any = await attempt(() => chart.update(U, acc["1113"], { externalCode: "a\u0007b" }));
    assert.deepEqual([bad.status, bad.body.error], [400, "BAD_EXTERNAL_CODE"]);
    const exp = new JournalExportService(env.t.pool as any);
    const csv = (await exp.csv(U, { from: "2026-01-01", to: "2026-01-31" })).body;
    const [head, ...rows] = csv.slice(1).trim().split("\r\n");
    assert.equal(head.split(",").at(-1), "account_code_external");
    const acqRow = rows.find((r) => r.includes("FA-000001") && r.split(",")[3] === "1222")!;
    assert.equal(acqRow.split(",").at(-1), "1-02-001");
    const ext = (await exp.csv(U, { from: "2026-01-01", to: "2026-01-31", preset: "external" })).body.slice(1).split("\r\n");
    assert.equal(ext[0], "date,entry_no,account_code_external,account_code,account_name,debit,credit,cost_center,party,reference,memo");
    assert.ok(ext.some((r) => r.split(",").slice(2, 4).join(",") === "EXT-1113,1113" && r.includes("FA-000001")), "the bank line of A's purchase, reference FA-000001");
    const x = await exp.xlsx(U, { from: "2026-01-01", to: "2026-01-31", preset: "external" });
    assert.equal(x.body.readUInt32LE(0), 0x04034b50);
    assert.equal(x.filename, "dara-journal_2026-01-01_2026-01-31.xlsx");
    assert.equal(x.debit, x.credit);
    // the other account's export never sees these codes
    await chart.update(U, acc["1113"], { externalCode: "" }, user.id);
    assert.equal((await chart.list(U)).find((a) => a.id === acc["1113"])!.externalCode, null);
  });
});
