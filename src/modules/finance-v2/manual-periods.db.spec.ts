import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { ManualJournalsService } from "./manual-journals.service";
import { JournalQueryService } from "./journal-query.service";
import { PeriodCloseService } from "./period-close.service";
import { VatReturnsService } from "./vat-returns.service";
import { BackfillService } from "./backfill/backfill.service";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";

/**
 * Steps 7 and 8 (DESIGN §8.1, §6.7, §7.5): manual journals and the opening
 * entry, the manual reversal, fiscal-period close / reopen / lock / year
 * close, and the VAT-return lock, against a real Postgres. Synthetic data.
 */
const U = 7101;
const OTHER = 7102;
const ALL = ["reports.view", "payments.view", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete", "payments.write"];
const holder = { id: U, ownerUserId: null, ownerScopeId: null, role: "user", permissions: ALL } as any;
// Accountants (employees): draft + approve, but not settings (no invoices.delete).
const empA = { id: 9101, ownerUserId: U, ownerScopeId: null, role: "employee", permissions: ALL.filter((p) => p !== "invoices.delete") } as any;
const empB = { id: 9102, ownerUserId: U, ownerScopeId: null, role: "employee", permissions: ALL.filter((p) => p !== "invoices.delete") } as any;

const err = (code: string, status?: number) => (e: any) => {
  const body = e?.getResponse?.();
  if (status && e?.getStatus?.() !== status) return false;
  return body?.error === code;
};

describe("finance v2 manual journals, opening entry, periods and VAT lock (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let mj: ManualJournalsService, jq: JournalQueryService, pc: PeriodCloseService, vat: VatReturnsService;
  let acc: Record<string, number>;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await seedAccount(env, OTHER);
    await enableV2(env, U, "manager");
    await enableV2(env, OTHER, "manager");
    const periods = new PeriodsService(env.t.pool);
    const journal = new JournalRepository(periods);
    const backfill = new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
      new FinanceSetupService(new ChartService(env.t.pool), periods));
    mj = new ManualJournalsService(env.t.pool, journal, periods);
    jq = new JournalQueryService(env.t.pool, env.engine);
    pc = new PeriodCloseService(env.t.pool, periods, journal, env.worker, env.recognizer, backfill);
    vat = new VatReturnsService(env.t.pool, periods, journal, env.engine);
    const rows = await env.q(`select code, id from accounts where user_id = $1`, [U]);
    acc = Object.fromEntries(rows.map((r: any) => [r.code, r.id]));
  });

  after(async () => {
    await env?.t.drop();
  });

  const draft = (over: any = {}) => ({
    entryDate: "2026-02-10", memo: "Synthetic adjustment",
    lines: [{ accountId: acc["5190"], debit: "250.00", credit: "0", propertyId: s.propH }, { accountId: acc["1113"], debit: "0", credit: "250.00" }],
    ...over,
  });

  it("validation: balance, one side per line, leaf/active/in-scope accounts, scoped dimensions, own attachment", async () => {
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10" }, { accountId: acc["1113"], credit: "9.99" }] })), err("UNBALANCED", 400));
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10", credit: "10" }, { accountId: acc["1113"], credit: "0" }] })), err("BAD_LINE", 400));
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10.001" }, { accountId: acc["1113"], credit: "10.001" }] })), err("BAD_AMOUNT", 400));
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["1000"], debit: "10" }, { accountId: acc["1113"], credit: "10" }] })), err("ACCOUNT_GROUP", 400));
    const foreign = (await env.q(`select id from accounts where user_id = $1 and code = '5190'`, [OTHER]))[0].id;
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: foreign, debit: "10" }, { accountId: acc["1113"], credit: "10" }] })), err("ACCOUNT_NOT_FOUND", 404));
    const otherTenant = (await env.q(`select id from tenants where user_id = $1`, [OTHER]))[0].id;
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10", tenantId: otherTenant }, { accountId: acc["1113"], credit: "10" }] })), err("DIMENSION_NOT_FOUND", 404));
    await assert.rejects(mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10", paymentId: 1 }, { accountId: acc["1113"], credit: "10" }] })), err("BAD_LINE", 400));
    await assert.rejects(mj.create(U, empA, draft({ attachmentKey: `acct/${OTHER}/journals/x.pdf` })), err("ATTACHMENT_FORBIDDEN", 403));
    await assert.rejects(mj.create(U, empA, draft({ entryDate: "2026-02-30" })), err("BAD_DATE", 400));
    await assert.rejects(mj.create(U, empA, draft({ memo: " " })), err("MEMO_REQUIRED", 400));
  });

  it("lifecycle: draft → submitted → approved by someone else posts at once, keyed manual_journal,<id>,posted", async () => {
    const d = await mj.create(U, empA, draft());
    assert.equal(d.status, "draft");
    assert.equal(d.total, "250.00");
    await assert.rejects(mj.approve(U, empB, d.id), err("NOT_SUBMITTED", 409));
    await mj.submit(U, empA, d.id);
    await assert.rejects(mj.approve(U, empA, d.id), err("SAME_APPROVER", 403));
    const p: any = await mj.approve(U, empB, d.id);
    assert.equal(p.status, "posted");
    assert.match(p.entryNo, /^JV-2026-\d{6}$/);
    const [e] = await env.q(`select origin, source_type, event, to_char(entry_date,'YYYY-MM-DD') as d, total::text as t, created_by from journal_entries where id = $1`, [p.postedEntryId]);
    assert.deepEqual([e.origin, e.source_type, e.event, e.d, e.t, e.created_by], ["manual", "manual_journal", "posted", "2026-02-10", "250.00", empB.id]);
    const lines = await env.q(`select property_id, debit::text as d from journal_lines where entry_id = $1 order by line_no`, [p.postedEntryId]);
    assert.deepEqual(lines.map((l: any) => [l.property_id, l.d]), [[s.propH, "250.00"], [null, "0.00"]]);
    const [a] = await env.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_manual_journal' and entity_id = $2`, [U, String(d.id)]);
    assert.equal(a.n, 2, "submit and approve are audited");
    await assert.rejects(mj.update(U, empA, d.id, { memo: "changed" }), err("NOT_EDITABLE", 409));
    await assert.rejects(mj.void(U, empA, d.id), err("NOT_VOIDABLE", 409));
  });

  it("the account holder may approve their own draft; over 10,000 SAR needs an attachment", async () => {
    const big = draft({ lines: [{ accountId: acc["5190"], debit: "10000.01" }, { accountId: acc["1113"], credit: "10000.01" }] });
    const d = await mj.create(U, holder, big);
    await mj.submit(U, holder, d.id);
    await assert.rejects(mj.approve(U, holder, d.id), err("ATTACHMENT_REQUIRED", 400));
    await mj.update(U, holder, d.id, { attachmentKey: `acct/${U}/journals/support.pdf` }).catch(() => undefined);
    // Submitted journals are not editable: reject, fix, resubmit.
    await mj.reject(U, holder, d.id, { reason: "attach the invoice" });
    await mj.update(U, holder, d.id, { attachmentKey: `acct/${U}/journals/support.pdf` });
    await mj.submit(U, holder, d.id);
    const p: any = await mj.approve(U, holder, d.id);
    assert.equal(p.status, "posted");
    const exact = await mj.create(U, empA, draft({ lines: [{ accountId: acc["5190"], debit: "10000.00" }, { accountId: acc["1113"], credit: "10000.00" }] }));
    await mj.submit(U, empA, exact.id);
    assert.equal(((await mj.approve(U, empB, exact.id)) as any).status, "posted", "exactly 10,000 needs none");
  });

  it("reject and void before posting; reversal of a posted manual entry voids the journal; auto entries are not reversed by hand", async () => {
    const d = await mj.create(U, empA, draft());
    await mj.submit(U, empA, d.id);
    await assert.rejects(mj.reject(U, empB, d.id, { reason: "no" }), err("REASON_REQUIRED", 400));
    assert.equal((await mj.reject(U, empB, d.id, { reason: "wrong account" })).status, "rejected");
    assert.equal((await mj.void(U, empA, d.id)).status, "void");

    const x = await mj.create(U, empA, draft({ entryDate: "2026-02-12" }));
    await mj.submit(U, empA, x.id);
    const p: any = await mj.approve(U, empB, x.id);
    await assert.rejects(jq.reverse(U, empB, p.postedEntryId, { date: "2026-02-11" }), err("BAD_DATE", 400));
    const r: any = await jq.reverse(U, empB, p.postedEntryId, { date: "2026-02-20", reason: "posted twice" });
    assert.ok(r.reversalId);
    const [orig] = await env.q(`select status from journal_entries where id = $1`, [p.postedEntryId]);
    assert.equal(orig.status, "reversed");
    assert.equal((await mj.get(U, x.id)).status, "void");
    const [net] = await env.q(`select coalesce(sum(debit - credit), 0)::text as n from journal_lines where entry_id in ($1, $2) and account_id = $3`, [p.postedEntryId, r.reversalId, acc["5190"]]);
    assert.equal(net.n, "0.00");
    await assert.rejects(jq.reverse(U, empB, p.postedEntryId, {}), err("ALREADY_REVERSED", 409));
    await assert.rejects(jq.reverse(OTHER, empB, p.postedEntryId, {}), (e: any) => e.getStatus?.() === 404);

    const detail: any = await jq.get(U, p.postedEntryId);
    assert.equal(detail.lines.length, 2);
    assert.equal(detail.source.type, "manual_journal");
    const list: any = await jq.list(U, { accountId: acc["5190"], from: "2026-02-01", to: "2026-02-28" });
    assert.ok(list.total >= 3);
  });

  it("opening entry: kind opening (installment dims allowed), one posted per account, dated before every other entry", async () => {
    const V = 7103;
    const sv = await seedAccount(env, V);
    await enableV2(env, V, "manager");
    const a = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [V])).map((r: any) => [r.code, r.id]));
    const vh = { ...holder, id: V };
    const body = {
      entryDate: "2025-12-31", memo: "Opening balances",
      lines: [
        { accountId: a["1113"], debit: "5000.00" },
        { accountId: a["1121"], debit: "1200.00", tenantId: sv.tenant },
        { accountId: a["2141"], credit: "3000.00", tenantId: sv.tenant },
        { accountId: a["3900"], credit: "3200.00" },
      ],
    };
    const o = await mj.create(V, vh, body, "opening");
    await mj.submit(V, vh, o.id);
    const p: any = await mj.approve(V, vh, o.id);
    const [e] = await env.q(`select origin, source_type from journal_entries where id = $1`, [p.postedEntryId]);
    assert.deepEqual([e.origin, e.source_type], ["opening", "opening_balance"]);
    const o2 = await mj.create(V, vh, body, "opening");
    await mj.submit(V, vh, o2.id);
    await assert.rejects(mj.approve(V, vh, o2.id), err("OPENING_EXISTS", 409));
    // Correct it: reverse, then a later-dated opening is refused while an ordinary entry precedes it.
    const m = await mj.create(V, vh, { ...draft(), entryDate: "2026-01-05", lines: [{ accountId: a["5190"], debit: "1" }, { accountId: a["1113"], credit: "1" }] });
    await mj.submit(V, vh, m.id);
    await mj.approve(V, vh, m.id);
    await jq.reverse(V, vh, p.postedEntryId, { date: "2026-01-06" });
    const late = await mj.create(V, vh, { ...body, entryDate: "2026-01-10" }, "opening");
    await mj.submit(V, vh, late.id);
    await assert.rejects(mj.approve(V, vh, late.id), err("OPENING_NOT_FIRST", 409));
    assert.equal(((await mj.approve(V, vh, o2.id)) as any).status, "posted", "after the reversal a new opening posts");
  });

  it("period close: refuses an unended month, an earlier open month, pending postings and submitted journals; closes with a TB hash", async () => {
    const TODAY = "2026-04-15";
    const [p1] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-01-01'`, [U]);
    const [p2] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-02-01'`, [U]);
    const [p4] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-04-01'`, [U]);
    await assert.rejects(pc.close(U, holder, p4.id, {}, TODAY), err("PERIOD_NOT_ENDED", 409));
    // The previous fiscal year's periods were created by the switch; close them first.
    for (const r of await env.q(`select id from fiscal_periods where user_id = $1 and starts_on < '2026-01-01' order by starts_on`, [U])) {
      await pc.close(U, holder, r.id, {}, TODAY);
    }
    await assert.rejects(pc.close(U, holder, p2.id, {}, TODAY), err("EARLIER_PERIOD_OPEN", 409));
    // A pending outbox row dated in January blocks the close.
    await env.q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload, next_attempt_at)
                 values ($1, 'expense', 999001, 'rev:1', '2026-01-20', '{"rule":"E18","facts":{"date":"2026-01-20"}}', now() + interval '1 day')`, [U]);
    await assert.rejects(pc.close(U, holder, p1.id, {}, TODAY), err("PENDING_POSTINGS", 409));
    await env.q(`update ledger_outbox set status = 'dismissed' where user_id = $1 and source_id = 999001`, [U]);
    const sub = await mj.create(U, empA, draft({ entryDate: "2026-01-15" }));
    await mj.submit(U, empA, sub.id);
    await assert.rejects(pc.close(U, holder, p1.id, {}, TODAY), err("MANUAL_PENDING_APPROVAL", 409));
    await mj.approve(U, empB, sub.id);
    const d = await mj.create(U, empA, draft({ entryDate: "2026-01-16" }));
    const res: any = await pc.close(U, holder, p1.id, {}, TODAY);
    assert.equal(res.period.status, "closed");
    assert.deepEqual(res.warnings, [{ code: "manual_drafts", count: 1 }]);
    const [ev] = await env.q(`select new_value from finance_settings_events where account_user_id = $1 and field = 'period_close' order by id desc limit 1`, [U]);
    assert.match(ev.new_value.tbHash, /^[0-9a-f]{64}$/);
    await mj.void(U, empA, d.id);
  });

  it("a closed period: automatic events post late into the next open month; manual adjustments need the settings capability", async () => {
    // An automatic event dated in closed January routes to February, flagged late.
    const [pl] = await env.q(`select id from payments limit 1`);
    await env.emitter.emit({ fv2: true, userId: U }, {
      sourceType: "landlord_payout", sourceId: 424242, event: "created", occurredOn: "2026-01-25",
      payload: { rule: "E19", facts: { date: "2026-01-25", treatment: "agent", dims: { ownerId: s.agent }, warnings: [], amount: "10.00", bank: {} } },
    });
    void pl;
    await env.worker.runAccount(U);
    const [e] = await env.q(`select to_char(entry_date,'YYYY-MM-DD') as d, to_char(original_date,'YYYY-MM-DD') as od, is_late, warnings
                               from journal_entries where user_id = $1 and source_type = 'landlord_payout' and source_id = 424242`, [U]);
    assert.deepEqual([e.d, e.od, e.is_late, e.warnings.includes("late_posting")], ["2026-02-01", "2026-01-25", true, true]);
    const [auto] = await env.q(`select id from journal_entries where user_id = $1 and source_id = 424242`, [U]);
    await assert.rejects(jq.reverse(U, holder, auto.id, {}), err("NOT_MANUAL", 409));
    const late: any = await jq.list(U, { late: "true" });
    assert.ok(late.items.some((x: any) => x.sourceId === 424242));

    const adj = await mj.create(U, empA, draft({ entryDate: "2026-01-31" }));
    await mj.submit(U, empA, adj.id);
    await assert.rejects(mj.approve(U, empB, adj.id), err("PERIOD_CLOSED", 409));
    const ok: any = await mj.approve(U, holder, adj.id);
    const [x] = await env.q(`select to_char(entry_date,'YYYY-MM-DD') as d, is_late from journal_entries where id = $1`, [ok.postedEntryId]);
    assert.deepEqual([x.d, x.is_late], ["2026-01-31", false], "a manual journal is never moved");
  });

  it("reopen (reason; not when a later month is closed), lock (from closed only, irreversible)", async () => {
    const TODAY = "2026-04-15";
    const [p1] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-01-01'`, [U]);
    const [p2] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-02-01'`, [U]);
    await assert.rejects(pc.lock(U, holder, p2.id, { reason: "audited year" }), err("PERIOD_NOT_CLOSED", 409));
    await pc.close(U, holder, p2.id, {}, TODAY);
    await assert.rejects(pc.reopen(U, holder, p1.id, { reason: "late invoice" }), err("LATER_PERIOD_CLOSED", 409));
    await assert.rejects(pc.reopen(U, holder, p2.id, { reason: "x" }), err("REASON_REQUIRED", 400));
    assert.equal((await pc.reopen(U, holder, p2.id, { reason: "late supplier invoice" })).status, "open");
    await pc.close(U, holder, p2.id, {}, TODAY);
    assert.equal((await pc.lock(U, holder, p1.id, { reason: "audited" })).status, "locked");
    await assert.rejects(pc.reopen(U, holder, p1.id, { reason: "try again" }), err("PERIOD_LOCKED", 409));
    await assert.rejects(mj.create(U, empA, draft({ entryDate: "2026-01-20" })), err("PERIOD_LOCKED", 409));
    const [a] = await env.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_period'`, [U]);
    assert.ok(a.n >= 5);
  });

  it("VAT return lock: settlement E37 posted, the months VAT-locked, VAT lines then route late; locked return is frozen", async () => {
    // Output VAT in Q2: an invoice-like manual cannot carry VAT, so post a synthetic E01 through the engine.
    await env.emitter.emit({ fv2: true, userId: U }, {
      sourceType: "simple_invoice", sourceId: 525252, event: "confirmed", occurredOn: "2026-05-10",
      payload: { rule: "E01", facts: { date: "2026-05-10", treatment: "principal", dims: { ownerId: s.holder, tenantId: s.tenant }, warnings: [], memo: "INV-SYN",
        documentId: 525252, groups: [{ category: "S", rate: 15, net: "1000.00", vat: "150.00", nature: "other", usage: null }], coverage: [], deferRent: true } },
    });
    await env.worker.runAccount(U);
    const before: any = await vat.get(U, "2026-Q2");
    assert.equal(before.box6Vat, "150.00");
    await assert.rejects(vat.put(U, holder, "2026-Q2", { box14: "5000.01" }), err("BOX14_LIMIT", 400));
    const locked: any = await vat.put(U, holder, "2026-Q2", { box14: "0", box15: "0", lock: true });
    assert.equal(locked.locked, true);
    const [st] = await env.q(`select e.id, to_char(e.entry_date,'YYYY-MM-DD') as d from journal_entries e where e.user_id = $1 and e.source_type = 'vat_return' and e.event = 'settled'`, [U]);
    assert.equal(st.d, "2026-06-30");
    const [ov] = await env.q(`select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
                               where l.user_id = $1 and a.system_key = 'output_vat' and l.entry_date between '2026-04-01' and '2026-06-30'`, [U]);
    assert.equal(ov.b, "0.00", "output VAT cleared to the settlement account");
    const months = await env.q(`select count(*)::int as n from fiscal_periods where user_id = $1 and starts_on between '2026-04-01' and '2026-06-30' and vat_locked_at is not null and status = 'open'`, [U]);
    assert.equal(months[0].n, 3, "VAT-locked, not status-locked");
    await env.emitter.emit({ fv2: true, userId: U }, {
      sourceType: "simple_invoice", sourceId: 525253, event: "confirmed", occurredOn: "2026-05-20",
      payload: { rule: "E01", facts: { date: "2026-05-20", treatment: "principal", dims: { ownerId: s.holder }, warnings: [], memo: "INV-SYN2",
        documentId: 525253, groups: [{ category: "S", rate: 15, net: "100.00", vat: "15.00", nature: "other", usage: null }], coverage: [], deferRent: true } },
    });
    await env.worker.runAccount(U);
    const [late] = await env.q(`select to_char(entry_date,'YYYY-MM-DD') as d, is_late from journal_entries where user_id = $1 and source_id = 525253`, [U]);
    assert.deepEqual([late.d, late.is_late], ["2026-07-01", true]);
    await assert.rejects(vat.put(U, holder, "2026-Q2", { box14: "10" }), err("VAT_RETURN_LOCKED", 409));
  });

  it("year close: periods 1–11 closed first; the closing entry moves the P&L to 3300 and closes period 12", async () => {
    const FY_TODAY = "2027-02-01";
    await assert.rejects(pc.closeYear(U, holder, { fiscalYear: 2026 }, FY_TODAY), err("EARLIER_PERIOD_OPEN", 409));
    // An expense written without its enqueue (a crash gap): the catch-up check refuses the close.
    const [mar] = await env.q(`select id from fiscal_periods where user_id = $1 and starts_on = '2026-03-01'`, [U]);
    const [x] = await env.q(`insert into expenses (user_id, property_id, category, amount, expense_date) values ($1, $2, 'صيانة', '12.00', '2026-03-10') returning id`, [U, s.propH]);
    await assert.rejects(pc.close(U, holder, mar.id, {}, FY_TODAY), (e: any) => e.getResponse?.().error === "MISSING_POSTINGS" && e.getResponse().sample[0].sourceId === x.id);
    await env.q(`update expenses set deleted_at = now() where id = $1`, [x.id]);
    for (const r of await env.q(`select id from fiscal_periods where user_id = $1 and fiscal_year = 2026 and period_no between 2 and 11 and status = 'open' order by starts_on`, [U])) {
      await pc.close(U, holder, r.id, {}, FY_TODAY);
    }
    const res: any = await pc.closeYear(U, holder, { fiscalYear: 2026 }, FY_TODAY);
    assert.ok(res.closingEntry?.id);
    assert.equal(res.period.status, "closed");
    const [pl] = await env.q(
      `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.type in ('revenue','expense') and l.entry_date between '2026-01-01' and '2026-12-31'`, [U]);
    assert.equal(pl.b, "0.00");
    const [e] = await env.q(`select origin from journal_entries where id = $1`, [res.closingEntry.id]);
    assert.equal(e.origin, "closing");
    await assert.rejects(pc.closeYear(U, holder, { fiscalYear: 2026 }, FY_TODAY), err("YEAR_CLOSED", 409));
    const [p12] = await env.q(`select id from fiscal_periods where user_id = $1 and fiscal_year = 2026 and period_no = 12`, [U]);
    await assert.rejects(pc.reopen(U, holder, p12.id, { reason: "late adjustment" }), err("YEAR_CLOSED", 409));
  });
});
