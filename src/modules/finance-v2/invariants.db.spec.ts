import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { BackfillService } from "./backfill/backfill.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { legacyAccountingFor } from "./reports/legacy-accounting";
import { openInstallments } from "./overrides/terminate";
import { sqlOf } from "./hooks/sql";
import { riyadhToday } from "./dates";
import { addDays } from "./reports/core-math";
import { withTx } from "./db";

/**
 * Phase 5 property / invariant tests (DESIGN §11.1, §11.3): randomized but
 * seeded event sequences driven through the REAL legacy routes with the
 * Finance v2 hooks, recognizer and worker, on a throwaway schema.
 *
 * Every sequence is one synthetic account (one agent landlord with a 5 %
 * fee, the account-holder landlord, one tenant, three units) in owner or
 * manager mode, and a random mix of: contract creation (advance rent,
 * deposit collected / pending), due-date charges (recognizer ticks at random
 * points), invoices + approval (→ commission, approved and collected at
 * random), partial installment and invoice collections, credit notes (and
 * the commission credit drafts they raise), deposits received, advance-rent
 * receipt vouchers, expenses (some deleted), payouts (some deleted) and
 * terminations with a random disposition per open installment and a random
 * deposit / advance disposition.
 *
 * After each sequence:
 *   I1 trial balance debits = credits (and every entry balances);
 *   I2 the reconciliation report's eight checks are all zero (R3 n/a in owner mode);
 *   I3 no failed or stuck outbox rows; a second tick posts nothing (idempotent);
 *   I4 a backfill of the same history (ledger wiped, sources kept) reproduces
 *      the same balances per account and dimension, and I2 still holds;
 *   I5 a second backfill posts nothing.
 *
 *   FV2_PROP_SEQUENCES (default 200) and FV2_PROP_SEED (default 20260927) pick
 *   the run; a failure names the seed of the sequence, which replays alone with
 *   FV2_PROP_SEQUENCES=1 FV2_PROP_SEED=<seed>.
 *
 * Synthetic data only (public repo).
 */
const N = Number(process.env.FV2_PROP_SEQUENCES ?? 200);
const SEED = Number(process.env.FV2_PROP_SEED ?? 20260927);
const BASE_USER = 30000;

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}
type Rng = ReturnType<typeof prng>;

const h = (s: string | number) => Math.round(Number(s) * 100);
const sar = (n: number) => (n / 100).toFixed(2);
const utcToday = () => new Date().toISOString().slice(0, 10);
/** Every business date stays strictly before both "todays" (the legacy terminate stamps the UTC date, the recognizer the Riyadh one). */
const LAST = addDays([utcToday(), riyadhToday()].sort()[0]!, -1);
const TODAY = riyadhToday();
const dateBetween = (r: Rng, lo: string, hi: string) => {
  if (hi <= lo) return hi;
  const days = Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000);
  return addDays(lo, r.int(0, days));
};
const minD = (a: string, b: string) => (a < b ? a : b);
const maxD = (a: string, b: string) => (a > b ? a : b);

interface Stats {
  ops: Record<string, number>;
  refused: Record<string, number>;
  entries: number;
  sequences: number;
  byMode: Record<string, number>;
  rules: Record<string, number>;
  reasons: Record<string, number>;
}

const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "invoices.delete", "expenses.write", "expenses.approve",
  "contracts.view", "contracts.write"];

class SequenceFailure extends Error {}

/** The mode follows the seed, so a sequence replays alone in the same mode. */
const modeOf = (seed: number) => (seed % 2 === 0 ? "manager" : "owner") as "manager" | "owner";

function backfillOf(env: LegacyEnv): BackfillService {
  const periods = new PeriodsService(env.t.pool);
  return new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
    new FinanceSetupService(new ChartService(env.t.pool), periods));
}

/** The recognizer and the worker until neither has anything left (a release can follow only a posted charge). */
async function settle(env: LegacyEnv, U: number): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const rs = await env.recognizer.runAccount(U, TODAY);
    let moved = 0;
    for (let i = 0; i < 50; i++) {
      const w = await env.worker.runAccount(U);
      const n = w ? w.posted + w.skipped + w.failed + w.retry : 0;
      moved += n;
      if (!n) break;
    }
    if (rs.charges + rs.settlements + rs.releases + moved === 0) break;
  }
}

/**
 * A synthetic account (seedAccount) with the account holder ZATCA-linked too (unless `linkHolder` is false),
 * Finance v2 on in `mode`.
 */
async function setupAccount(env: LegacyEnv, U: number, mode: "owner" | "manager", before?: (s: Seed) => Promise<void>,
  opts: { linkHolder?: boolean } = {}): Promise<Seed> {
  const s: Seed = await seedAccount(env, U);
  // Dummy sandbox row for the holder, as the seed has for the agent (ZATCA is stubbed), so the holder's invoices approve.
  if (opts.linkHolder !== false) await env.q(
    `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
       seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
       industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
     select user_id, $2, active_environment, 'Synthetic Holder', '310000000000003', seller_street, seller_building_no, seller_district, seller_city,
       seller_postal_zone, serial_number, '310000000000003', organization_unit_name, location_address, industry_category, common_name,
       sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem
       from zatca_credentials where user_id = $1 and owner_id = $3`, [U, s.holder, s.agent]);
  if (before) await before(s);
  await enableV2(env, U, mode);
  return s;
}

async function runSequence(env: LegacyEnv, backfill: BackfillService, rec: ReconciliationService, idx: number, seed: number, stats: Stats) {
  const r = prng(seed);
  const U = BASE_USER + idx;
  const mode = modeOf(seed);
  // The account holder with every permission the finance capabilities derive from (write-offs need "approve").
  const user = { ...userOf(U), permissions: PERMS };
  const log: string[] = [`seed=${seed} user=${U} mode=${mode}`];
  const fail = (msg: string): never => {
    throw new SequenceFailure(`${msg}\n  replay: FV2_PROP_SEQUENCES=1 FV2_PROP_SEED=${seed}\n  ops: ${log.join(" | ")}`);
  };

  // Half the non-trust manager sequences leave the account holder unlinked: the account then issues no tax invoice of
  // its own, so its commission is drafted without VAT and approves (E15/E36); a linked account's commission is S-rated
  // and approves too, reported under the office's seller (finding 1, 5 Oct 2026); the holder's own invoices and free
  // invoices are still refused when unlinked.
  const linkHolder = !(mode === "manager" && seed % 4 === 2);
  const s = await setupAccount(env, U, mode, async (s) => {
    if (r.chance(0.3)) {
      // E1: sometimes the landlord carries the fee rather than the property.
      await env.q(`update owners set management_fee_percent = $2 where id = $1`, [s.agent, r.pick(["2.5", "5", "7.5"])]);
      await env.q(`update properties set management_fee_percent = null where id = $1`, [s.propA]);
    }
  }, { linkHolder });
  stats.byMode[mode] = (stats.byMode[mode] ?? 0) + 1;
  if (seed % 4 === 0) {
    // Every other manager-mode sequence keeps client money in a default trust account (agency_collections_to_trust):
    // agent collections, deposits, credit refunds and payouts must all use it, and R4 must agree account by account.
    await new BankAccountsService(env.t.pool as any).create(U, U, { kind: "bank", nameAr: "حساب العملاء", nameEn: "Client trust", isTrust: true, isDefault: true });
    await env.q(`update finance_settings set agency_collections_to_trust = true where account_user_id = $1`, [U]);
    stats.byMode.trust = (stats.byMode.trust ?? 0) + 1;
  }

  const tick = () => settle(env, U);

  /** Run a legacy action; a 4xx is a legitimate refusal (counted), anything else fails the sequence. */
  const act = async <T>(name: string, detail: string, fn: () => Promise<T>): Promise<T | null> => {
    stats.ops[name] = (stats.ops[name] ?? 0) + 1;
    try {
      const out = await fn();
      log.push(`${name}(${detail})`);
      return out;
    } catch (err: any) {
      const status = typeof err?.getStatus === "function" ? err.getStatus() : 0;
      if (status >= 400 && status < 500) {
        stats.refused[name] = (stats.refused[name] ?? 0) + 1;
        const body = typeof err?.getResponse === "function" ? err.getResponse() : null;
        const msg = typeof body === "string" ? body : [body?.error, body?.message].filter(Boolean).join(": ");
        log.push(`${name}(${detail})=>${status}${process.env.FV2_PROP_VERBOSE ? ` ${JSON.stringify(msg).slice(0, 160)}` : ""}`);
        const rk = `${name}:${status}:${String(Array.isArray(msg) ? msg[0] : msg).slice(0, 160)}`;
        stats.reasons[rk] = (stats.reasons[rk] ?? 0) + 1;
        return null;
      }
      log.push(`${name}(${detail})=>THREW`);
      fail(`action ${name} threw: ${err?.stack ?? err}`);
      return null;
    }
  };

  // ── Contracts ──
  const units = [s.unitA1, s.unitA2, s.unitH1];
  const nContracts = r.int(1, 3);
  const contracts: Array<{ id: number; start: string; end: string; vat: boolean }> = [];
  for (let k = 0; k < nContracts; k++) {
    const unit = units.splice(r.int(0, units.length - 1), 1)[0]!;
    const start = addDays(LAST, -r.int(20, 330));
    const months = r.pick([6, 12]);
    const [y, m, d] = start.split("-").map(Number);
    const endD = new Date(Date.UTC(y!, m! - 1 + months, d!));
    const end = addDays(endD.toISOString().slice(0, 10), -1);
    const rent = r.int(3, 90) * 100 + (r.chance(0.2) ? 50 : 0);
    const vat = r.chance(0.5);
    // The contract wizard snapshots the landlord (name, id number) from the unit's property owner.
    const landlord = unit === s.unitH1 ? { landlordName: "Synthetic Holder", landlordIdNumber: `70001${U}` } : { landlordName: "Synthetic Landlord A", landlordIdNumber: `70000${U}` };
    const body: any = {
      ...landlord,
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: start, endDate: end,
      monthlyRent: String(rent), paymentFrequency: r.pick(["monthly", "monthly", "quarterly"]), vatEnabled: vat,
    };
    if (r.chance(0.35)) {
      body.prepaidRent = String(r.int(1, Math.max(1, Math.floor(rent * 2 / 100))) * 100);
      body.prepaidMethod = r.pick(["bank_transfer", "cash"]);
    }
    const dep = r.pick(["none", "collected", "pending"] as const);
    if (dep !== "none") {
      body.depositAmount = String(r.int(5, 60) * 100);
      body.depositStatus = dep;
      body.depositMethod = r.pick(["bank_transfer", "cash"]);
      body.depositDueDate = start;
    }
    const c: any = await act("create_contract", `u${unit} ${start}..${end} ${rent} ${body.paymentFrequency} vat=${vat} adv=${body.prepaidRent ?? 0} dep=${dep}`, () => env.contracts.create(user, body));
    if (c?.id) contracts.push({ id: Number(c.id), start, end, vat });
    if (r.chance(0.5)) await tick();
  }
  if (!contracts.length) fail("no contract was created");

  // ── State readers ──
  const openRows = async (cid?: number) => env.q(
    `select p.id::int as id, p.contract_id::int as cid, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount,
            (p.amount - coalesce((select sum(pc.amount) from payment_collections pc where pc.payment_id = p.id), 0))::text as remaining
       from payments p join contracts c on c.id = p.contract_id
      where p.user_id = $1 and p.deleted_at is null and c.status::text not in ('terminated','cancelled')
        and p.status::text in ('pending','overdue','partially_paid') and coalesce(p.description, '') <> 'تأمين (وديعة)'
        and ($2::int is null or p.contract_id = $2)
      order by p.due_date, p.id`, [U, cid ?? null]);
  const docRemaining = async (kind: string) => env.q(
    `select si.id::int as id, si.number, si.kind, to_char(si.issue_date,'YYYY-MM-DD') as issued, si.total::text as total,
            (si.total + coalesce((select sum(case when n.type = 'credit' then -n.total else n.total end) from simple_invoices n
                                   where n.user_id = si.user_id and n.billing_reference = si.number and n.status = 'confirmed' and n.deleted_at is null), 0)
              - coalesce((select sum(pc.amount) from payment_collections pc where pc.invoice_id = si.id), 0))::text as remaining,
            (si.items->0->>'vat')::boolean as vat
       from simple_invoices si
      where si.user_id = $1 and si.deleted_at is null and si.status = 'confirmed' and si.type = 'invoice'
        and coalesce(si.kind, 'invoice') = $2
      order by si.id`, [U, kind]);

  const liveContracts = async () => {
    const ids = new Set((await env.q(`select id::int as id from contracts where user_id = $1 and status::text not in ('terminated','cancelled') and deleted_at is null`, [U])).map((x: any) => x.id));
    return contracts.filter((c) => ids.has(c.id));
  };

  // ── Operations ──
  const nOps = r.int(6, 16);
  const kinds = [
    "collect_installment", "collect_installment", "invoice", "invoice", "credit_note", "collect_invoice", "collect_deposit",
    "advance_voucher", "deposit_voucher", "expense", "expense_delete", "payout", "payout_delete", "terminate", "commission_credit",
    "free_invoice",
  ] as const;
  for (let op = 0; op < nOps; op++) {
    const kind = r.pick(kinds);
    switch (kind) {
      case "collect_installment": {
        const rows = (await openRows()).filter((x: any) => x.due <= LAST);
        if (!rows.length) break;
        const p = r.pick(rows);
        const rem = h(p.remaining);
        if (rem <= 0) break;
        const amt = r.chance(0.4) ? rem : r.int(1, Math.max(1, Math.floor(rem / 100))) * 100;
        const c = contracts.find((x) => x.id === p.cid)!;
        const date = dateBetween(r, maxD(c.start, addDays(p.due, -10)), LAST);
        await act(kind, `p${p.id} ${sar(Math.min(amt, rem))} ${date}`, () =>
          env.payments.addCollection(user, String(p.id), { amount: sar(Math.min(amt, rem)), collectedDate: date, method: r.pick(["cash", "bank_transfer"]) }));
        break;
      }
      case "invoice": {
        const rows = await env.q(
          `select p.id::int as id, p.contract_id::int as cid, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount, c.vat_enabled as vat
             from payments p join contracts c on c.id = p.contract_id
            where p.user_id = $1 and p.deleted_at is null and c.status::text not in ('terminated','cancelled')
              and p.status::text in ('pending','overdue','partially_paid') and coalesce(p.description, '') <> 'تأمين (وديعة)'
              and not exists (select 1 from simple_invoices si where si.user_id = p.user_id and si.deleted_at is null and si.status::text <> 'cancelled'
                               and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id)))
            order by p.due_date, p.id`, [U]);
        if (!rows.length) break;
        const p = r.pick(rows.slice(0, 4));
        const gross = h(p.amount);
        const vat = p.vat === true;
        const net = vat ? Math.round((gross * 100) / 115) : gross;
        const vatAmt = vat ? Math.round(net * 0.15) : 0;
        const c = contracts.find((x) => x.id === p.cid)!;
        const issue = dateBetween(r, maxD(c.start, addDays(p.due, -20)), minD(LAST, addDays(p.due, 15)));
        const inv: any = await act(kind, `p${p.id} ${sar(net)}+${sar(vatAmt)} ${issue}`, () => env.billing.create(user, {
          type: "invoice", paymentIds: [p.id], issueDate: issue,
          items: [{ description: "إيجار", quantity: 1, unitPrice: net / 100, amount: net / 100, vat }], total: (net + vatAmt) / 100,
        }));
        if (!inv?.id) break;
        const ap: any = await act("approve_invoice", `inv${inv.id}`, () => env.billing.approve(user, String(inv.id), { confirmations: { tenantNoVat: true } }));
        const com = ap?.commission;
        if (com?.id && r.chance(0.7)) {
          const ok = await act("approve_commission", `com${com.id}`, () => env.billing.approve(user, String(com.id), {}));
          if (ok && r.chance(0.6)) {
            await act("collect_commission", `com${com.id}`, () => env.billing.collect(user, String(com.id), { paidDate: dateBetween(r, issue, LAST), method: "bank_transfer" }));
          }
          if (ok && r.chance(0.4)) {
            // A credit note on the rent invoice right away drafts the commission credit (E36), approved at once.
            const part = Math.max(1, Math.floor(net / 100 / 4)) * 100;
            const crn: any = await act("credit_note", `inv${inv.id} ${sar(part)}`, () => env.billing.create(user, {
              type: "credit", billingReference: inv.number, issueDate: dateBetween(r, issue, LAST),
              items: [{ description: "خصم", quantity: 1, unitPrice: part / 100, amount: part / 100, vat }], total: (part + (vat ? Math.round(part * 0.15) : 0)) / 100,
            }));
            if (crn?.id && (await act("approve_credit", `crn${crn.id}`, () => env.billing.approve(user, String(crn.id), {})))) {
              const [ccn] = await env.q(`select id::int as id from simple_invoices where user_id = $1 and kind = 'commission' and type = 'credit' and status = 'draft'
                                           and deleted_at is null and notes like $2`, [U, `%${crn.number}%`]);
              if (ccn) await act("commission_credit", `ccn${ccn.id}`, () => env.billing.approve(user, String(ccn.id), {}));
            }
          }
        }
        break;
      }
      case "free_invoice": {
        // A free invoice to an external customer: the account's own sale (principal, seller 'account') in both modes;
        // collect_invoice picks it up like any invoice. Standard-rated or VAT-free (exempt as printed), never mixed.
        const vat = r.chance(0.6);
        const net = r.int(1, 40) * 100;
        const vatAmt = vat ? Math.round(net * 0.15) : 0;
        const issue = dateBetween(r, addDays(LAST, -200), LAST);
        const inv: any = await act(kind, `${sar(net)}+${sar(vatAmt)} ${issue}`, () => env.billing.create(user, {
          type: "invoice", issueDate: issue,
          client: { name: `Synthetic Customer ${r.int(1, 3)}`, type: "individual", email: `cust-${U}@example.test`, phone: "0500000009", idNumber: `10000${U}` },
          items: [{ description: r.pick(["خدمة استشارية", "خدمة إدارية"]), quantity: 1, unitPrice: net / 100, amount: net / 100, vat }], total: (net + vatAmt) / 100,
        }));
        if (inv?.id) await act("approve_free_invoice", `inv${inv.id}`, () => env.billing.approve(user, String(inv.id), { confirmations: { tenantNoVat: true } }));
        break;
      }
      case "credit_note": {
        const invs = (await docRemaining("invoice")).filter((x: any) => h(x.remaining) > 100);
        if (!invs.length) break;
        const inv = r.pick(invs);
        const vat = inv.vat === true;
        const maxNet = Math.floor(h(inv.remaining) / (vat ? 1.15 : 1) / 100);
        if (maxNet < 1) break;
        const net = r.int(1, maxNet) * 100;
        const total = net + (vat ? Math.round(net * 0.15) : 0);
        const crn: any = await act(kind, `inv${inv.id} ${sar(total)}`, () => env.billing.create(user, {
          type: "credit", billingReference: inv.number, issueDate: dateBetween(r, inv.issued, LAST),
          items: [{ description: "خصم", quantity: 1, unitPrice: net / 100, amount: net / 100, vat }], total: total / 100,
        }));
        if (crn?.id) await act("approve_credit", `crn${crn.id}`, () => env.billing.approve(user, String(crn.id), {}));
        break;
      }
      case "commission_credit": {
        const drafts = await env.q(`select id::int as id from simple_invoices where user_id = $1 and kind = 'commission' and type = 'credit' and status = 'draft' and deleted_at is null`, [U]);
        if (!drafts.length) break;
        const d = r.pick(drafts);
        await act(kind, `ccn${d.id}`, () => env.billing.approve(user, String(d.id), {}));
        break;
      }
      case "collect_invoice": {
        const invs = [...(await docRemaining("invoice")), ...(await docRemaining("commission"))].filter((x: any) => h(x.remaining) > 0);
        if (!invs.length) break;
        const inv = r.pick(invs);
        const rem = h(inv.remaining);
        const amt = r.chance(0.5) ? rem : Math.max(1, Math.floor(rem / 2 / 100)) * 100;
        await act(kind, `inv${inv.id} ${sar(Math.min(amt, rem))}`, () =>
          env.billing.collect(user, String(inv.id), { amount: Math.min(amt, rem) / 100, paidDate: dateBetween(r, inv.issued, LAST), method: r.pick(["cash", "bank_transfer"]) }));
        break;
      }
      case "collect_deposit": {
        const cs = await env.q(`select id::int as id, to_char(start_date,'YYYY-MM-DD') as start from contracts where user_id = $1 and deposit_status = 'pending' and status::text not in ('terminated','cancelled') and deleted_at is null`, [U]);
        if (!cs.length) break;
        const c = r.pick(cs);
        await act(kind, `c${c.id}`, () => env.contracts.collectDeposit(user, String(c.id), { paidDate: dateBetween(r, c.start, LAST), method: r.pick(["cash", "bank_transfer"]) }));
        break;
      }
      case "advance_voucher": {
        // Receipts go to running contracts (a voucher on an ended contract has no disposition left in either flow).
        const running = await liveContracts();
        if (!running.length) break;
        const c = r.pick(running);
        const amt = r.int(1, 40) * 100;
        await act(kind, `c${c.id} ${sar(amt)}`, () => env.billing.createReceiptVoucher(user, { contractId: c.id, amount: amt / 100, paidDate: dateBetween(r, c.start, LAST), countAsCollection: true }));
        break;
      }
      case "deposit_voucher": {
        // Receipts go to running contracts (a voucher on an ended contract has no disposition left in either flow).
        const running = await liveContracts();
        if (!running.length) break;
        const c = r.pick(running);
        const amt = r.int(1, 20) * 100;
        await act(kind, `c${c.id} ${sar(amt)}`, () => env.billing.createReceiptVoucher(user, { kind: "deposit", contractId: c.id, amount: amt / 100, paidDate: dateBetween(r, c.start, LAST) }));
        break;
      }
      case "expense": {
        const [owner, prop] = r.chance(0.5) ? [s.agent, s.propA] : [s.holder, s.propH];
        const amt = r.int(1, 30) * 100 + r.pick([0, 15, 50]);
        await act(kind, `o${owner} ${sar(amt)}`, () => env.reports.createExpense(user, {
          ownerId: owner, propertyId: prop, category: r.pick(["صيانة", "كهرباء", "نظافة"]), amount: amt / 100, expenseDate: dateBetween(r, addDays(LAST, -200), LAST),
        }));
        break;
      }
      case "expense_delete": {
        const xs = await env.q(`select id::int as id from expenses where user_id = $1 and deleted_at is null`, [U]);
        if (!xs.length) break;
        const x = r.pick(xs);
        await act(kind, `e${x.id}`, () => env.reports.deleteExpense(user, String(x.id)));
        break;
      }
      case "payout": {
        const amt = r.int(1, 30) * 100;
        await act(kind, `${sar(amt)}`, () => env.reports.createPayout(user, { ownerId: s.agent, amount: amt / 100, transferDate: dateBetween(r, addDays(LAST, -200), LAST), method: r.pick(["cash", "bank_transfer"]) }));
        break;
      }
      case "payout_delete": {
        const xs = await env.q(`select id::int as id from landlord_payouts where user_id = $1 and deleted_at is null`, [U]);
        if (!xs.length) break;
        const x = r.pick(xs);
        await act(kind, `po${x.id}`, () => env.reports.deletePayout(user, String(x.id)));
        break;
      }
      case "terminate": {
        const live = await env.q(`select id::int as id, to_char(start_date,'YYYY-MM-DD') as start from contracts where user_id = $1 and status::text not in ('terminated','cancelled') and deleted_at is null`, [U]);
        if (!live.length || !r.chance(0.6)) break;
        const c = r.pick(live);
        const open = await openInstallments(sqlOf(env.t.pool as any), U, c.id);
        const dispositions = open.map((o) => {
          const action = r.pick(o.allowed);
          return action === "collect"
            ? { paymentId: o.paymentId, action, date: dateBetween(r, maxD(c.start, addDays(o.dueDate, -10)), LAST), method: r.pick(["cash", "bank_transfer"]) }
            : { paymentId: o.paymentId, action, reason: action === "write_off" ? "synthetic" : undefined };
        });
        const body: any = { mode: r.pick(["cancelled", undefined]), dispositions };
        const dep = r.pick(["refund", "revenue", "forfeit", undefined]);
        if (dep) body.deposit = dep;
        if (r.chance(0.5)) body.advance = "refund";
        await act(kind, `c${c.id} ${dispositions.map((d) => ({ collect: "C", cancel: "X", write_off: "W" })[d.action]).join("")} dep=${dep ?? "-"} adv=${body.advance ?? "-"}`, () => env.contracts.terminate(user, String(c.id), body));
        break;
      }
    }
    if (r.chance(0.4)) await tick();
  }
  await tick();

  await checkInvariants(env, backfill, rec, U, mode, tick, fail, stats);
  stats.sequences++;
}

/**
 * Net balance per account and dimension set (debit-positive, halalas), and, for the VAT return, the VAT base and
 * amount per dimension set, category and tax role across accounts (the return reads tax_role lines whatever their
 * account; which of 2131 / 4120 carries a reversed base is not a VAT figure).
 */
/**
 * I1–I5 for one account after its history ran (see the header). `fail` throws with the replay context.
 */
async function checkInvariants(env: LegacyEnv, backfill: BackfillService, rec: ReconciliationService, U: number, mode: "owner" | "manager",
  tick: () => Promise<void>, fail: (m: string) => never, stats: Stats | null): Promise<void> {
  await tick();
  // ── I3: nothing failed or stuck; a second tick is a no-op ──
  const outboxBad = async () => (await env.q(`select id, status, last_error from ledger_outbox where user_id = $1 and status in ('pending','failed')`, [U]));
  const bad = await outboxBad();
  if (bad.length) fail(`I3 outbox rows not posted: ${JSON.stringify(bad.slice(0, 5))}`);
  const count = async () => Number((await env.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]))[0].n);
  const n1 = await count();
  const lastOutbox = Number((await env.q(`select coalesce(max(id), 0) as m from ledger_outbox where user_id = $1`, [U]))[0].m);
  await tick();
  if ((await count()) !== n1) {
    const extra = await env.q(`select source_type, source_id, event, payload->>'rule' as rule, status, occurred_on::text as d from ledger_outbox where user_id = $1 and id > $2`, [U, lastOutbox]);
    fail(`I3 a second tick posted more entries: ${JSON.stringify(extra)}`);
  }
  if (stats) {
    stats.entries += n1;
    for (const x of await env.q(`select payload->>'rule' as rule, count(*)::int as n from ledger_outbox where user_id = $1 and status = 'posted' group by 1`, [U])) {
      stats.rules[x.rule ?? "reversal"] = (stats.rules[x.rule ?? "reversal"] ?? 0) + Number(x.n);
    }
  }

  // ── I1 ──
  await assertBalanced(env, U, fail);
  // ── I2 ──
  await assertReconciled(rec, U, mode, "live", fail);

  // ── I4: backfill of the same history reproduces the balances ──
  const before = await balances(env, U);
  if (process.env.FV2_PROP_KEEP) {
    // Debug aid: keep the live ledger beside the rebuilt one.
    await env.q(`create table if not exists live_entries as select * from journal_entries with no data`);
    await env.q(`create table if not exists live_lines as select * from journal_lines with no data`);
    await env.q(`create table if not exists live_outbox as select * from ledger_outbox with no data`);
    await env.q(`insert into live_entries select * from journal_entries where user_id = $1`, [U]);
    await env.q(`insert into live_lines select * from journal_lines where user_id = $1`, [U]);
    await env.q(`insert into live_outbox select * from ledger_outbox where user_id = $1`, [U]);
  }
  await withTx(env.t.pool, async (c) => {
    await c.query(`select set_config('fv2.purge', 'on', true)`);
    for (const t of ["journal_lines", "journal_entries", "ledger_outbox", "finance_installment_charges", "finance_installment_vat_points", "finance_backfill_runs"]) {
      await c.query(`delete from ${t} where user_id = $1`, [U]);
    }
    await c.query(`update finance_settings set ledger_started_at = null where account_user_id = $1`, [U]);
  });
  env.flag.invalidate(U);
  const first = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: false, today: TODAY });
  if (first.failed.length || first.pending) fail(`I4 backfill failed events: ${JSON.stringify(first.failed.slice(0, 5))} pending ${first.pending}`);
  const after = await balances(env, U);
  const diff = diffBalances(before, after);
  if (diff.length) fail(`I4 backfill balances differ from live (key live backfill):\n    ${diff.join("\n    ")}`);
  await assertBalanced(env, U, fail);
  await assertReconciled(rec, U, mode, "backfill", fail);
  // ── I5 ──
  const second = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: false, today: TODAY });
  if (second.events.new !== 0 || second.entries.count !== 0) fail(`I5 second backfill posted ${second.events.new} events / ${second.entries.count} entries`);
}


const RENT_DEFERRAL = new Set(["unearned_rent", "rent_revenue_residential", "rent_revenue_commercial"]);

async function balances(env: LegacyEnv, U: number): Promise<Map<string, number>> {
  const rows = await env.q(
    `select a.code, l.owner_id, l.property_id, l.tenant_id, l.contract_id, l.vat_category, l.tax_role, a.system_key,
            sum(l.debit - l.credit)::text as b, coalesce(sum(l.vat_base), 0)::text as base
       from journal_lines l join accounts a on a.id = l.account_id
      where l.user_id = $1 group by 1, 2, 3, 4, 5, 6, 7, 8`, [U]);
  const m = new Map<string, number>();
  const add = (k: string, v: number) => { if (v !== 0) m.set(k, (m.get(k) ?? 0) + v); };
  for (const r of rows) {
    const dims = `o${r.owner_id ?? "-"}|p${r.property_id ?? "-"}|t${r.tenant_id ?? "-"}|c${r.contract_id ?? "-"}`;
    // Straight-line timing is path-dependent: live posting releases 2131 month by month as it goes, and a document
    // back-dated before releases already posted cannot move them; the backfill posts in date order. What must agree is
    // unearned + earned rent together (per contract), not the split at a moment inside a coverage window.
    const code = RENT_DEFERRAL.has(r.system_key) ? "2131+41xx" : r.code;
    add(`${code}|${dims}`, h(r.b));
    if (r.tax_role) add(`vat-base|${dims}|${r.vat_category ?? "-"}|${r.tax_role}`, h(r.base));
  }
  for (const [k, v] of [...m]) if (v === 0) m.delete(k);
  return m;
}

function diffBalances(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) out.push(`${k} ${sar(a.get(k) ?? 0)} ${sar(b.get(k) ?? 0)}`);
  }
  return out.sort();
}

async function assertBalanced(env: LegacyEnv, U: number, fail: (m: string) => never) {
  const [tb] = await env.q(`select coalesce(sum(debit), 0)::text as d, coalesce(sum(credit), 0)::text as c from journal_lines where user_id = $1`, [U]);
  if (tb.d !== tb.c) fail(`I1 trial balance ${tb.d} ≠ ${tb.c}`);
  const unbalanced = await env.q(`select entry_id from journal_lines where user_id = $1 group by entry_id having sum(debit) <> sum(credit) limit 3`, [U]);
  if (unbalanced.length) fail(`I1 unbalanced entries ${JSON.stringify(unbalanced)}`);
}

/**
 * The part of an R3 difference its explanations account for (ledger − legacy dues):
 *  - E11 a forfeited deposit kept for the landlord is landlord money in 2121; the dues report ignores forfeits;
 *  - E36 a commission credit note gives the landlord back commission; the dues report sums every confirmed
 *    commission-kind document as commission, credit notes included, so it moves the other way: twice the note.
 * Any other explanation with items is not accounted for here, so it leaves a residual and fails the sequence.
 */
function explainedR3(c: any): number {
  const sum = (code: string) => (c.explanations.find((e: any) => e.code === code)?.items ?? []).reduce((t: number, i: any) => t + h(i.amount), 0);
  return sum("forfeited_deposits_kept_for_landlord_E11") + 2 * sum("commission_credit_notes_E36");
}

async function assertReconciled(rec: ReconciliationService, U: number, mode: string, phase: string, fail: (m: string) => never) {
  const r: any = await rec.reconciliation(U, { asOf: TODAY, lang: "en" });
  // R7 only lists sub-ledger findings (e.g. VAT charged with no tax invoice yet): no figure to be zero.
  // R3 compares 2121 with the LEGACY dues report, which by design (DESIGN §7.10) differs by the listed, quantified
  // explanations; what must be zero is the part they do not explain.
  const r3Residual = (c: any) => h(c.difference) - explainedR3(c);
  // The accountant's checks R9–R21 hold too, except R18/R19 (invoicing discipline, not a ledger property: the
  // sequences leave due installments uninvoiced on purpose); a check that does not apply (no trust account,
  // no bank statement, Owner mode) is fine.
  const policy = new Set(["R18", "R19"]);
  const extra = (c: any) => Number(c.id.slice(1)) >= 9;
  const bad = r.checks.filter((c: any) => !(c.status === "ok" || (c.id === "R3" && mode === "owner" && c.status === "not_applicable")
    || (c.id === "R7" && c.difference == null) || (c.id === "R3" && c.status === "difference" && r3Residual(c) === 0)
    || (extra(c) && c.status === "not_applicable") || policy.has(c.id)));
  const nonZero = r.checks.filter((c: any) => c.difference != null && !["R3", "R6"].includes(c.id) && !policy.has(c.id) && h(c.difference) !== 0);
  if (bad.length || nonZero.length) {
    fail(`I2 (${phase}) reconciliation: ${JSON.stringify([...new Set([...bad, ...nonZero])].map((c: any) => ({
      id: c.id, status: c.status, ledger: c.ledger, sub: c.subLedger, diff: c.difference, rows: c.rows.slice(0, 4), expl: c.explanations,
    })))}`);
  }
}

describe(`finance v2 property / invariant sequences (real Postgres, real legacy routes; ${N} sequences from seed ${SEED})`, { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let backfill: BackfillService;
  let rec: ReconciliationService;
  const stats: Stats = { ops: {}, refused: {}, entries: 0, sequences: 0, byMode: {}, rules: {}, reasons: {} };

  before(async () => {
    env = await legacyEnv("wired");
    backfill = backfillOf(env);
    rec = new ReconciliationService(env.t.pool, legacyAccountingFor(env.db));
  });

  after(async () => {
    // Printed so a run's coverage lands in the log beside its seed.
    console.log(`fv2 property run: seed ${SEED}, ${stats.sequences}/${N} sequences passed, by mode ${JSON.stringify(stats.byMode)}, ${stats.entries} entries`);
    console.log(`  ops ${JSON.stringify(stats.ops)}`);
    console.log(`  refused (4xx) ${JSON.stringify(stats.refused)}`);
    console.log(`  refusal reasons ${JSON.stringify(stats.reasons)}`);
    console.log(`  posted by rule ${JSON.stringify(Object.fromEntries(Object.entries(stats.rules).sort()))}`);
    if (process.env.FV2_PROP_KEEP) console.log(`  kept schema ${env.t.schema}`);
    else await env?.t.drop();
  });

  for (let i = 0; i < N; i++) {
    const seed = SEED + i;
    it(`sequence ${i} (seed ${seed}, ${modeOf(seed)} mode): TB balances, R1–R8 zero, no failed outbox, backfill reproduces and is idempotent`, async () => {
      await runSequence(env, backfill, rec, i, seed, stats);
    });
  }

  it("covered the event kinds the brief names, in both modes", () => {
    assert.equal(stats.sequences, N);
    if (N < 50) return;
    for (const k of ["create_contract", "collect_installment", "invoice", "credit_note", "collect_invoice", "collect_deposit", "advance_voucher",
      "expense", "payout", "terminate", "approve_commission", "free_invoice"]) assert.ok((stats.ops[k] ?? 0) > 0, `never ran ${k}`);
    assert.ok((stats.ops.approve_free_invoice ?? 0) > (stats.refused.approve_free_invoice ?? 0), "some free invoices were approved");
    // E16 is absent by design: a collected commission settles by deduction from the landlord's payable (skip settled_by_deduction).
    for (const rule of ["E01", "E02", "E03", "E04", "E05", "E06", "E09", "E10", "E11", "E12", "E15", "E18", "E19", "E24", "E34", "E35", "E36"]) {
      assert.ok((stats.rules[rule] ?? 0) > 0, `never posted ${rule}: ${JSON.stringify(stats.rules)}`);
    }
  });
});

/**
 * The engine and report bugs the property run found, each pinned as a fixed scenario (dates relative to today) that
 * must satisfy I1–I5. Each failed before its fix.
 */
describe("finance v2 invariants — regressions found by the property run (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let backfill: BackfillService;
  let rec: ReconciliationService;
  const monthStart = (k: number) => {
    const [y, m] = LAST.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1 + k, 1)).toISOString().slice(0, 10);
  };
  const plusMonths = (d: string, k: number) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1 + k, day!)).toISOString().slice(0, 10);
  };
  const user = (U: number) => ({ ...userOf(U), permissions: PERMS });
  const fail = (label: string) => (m: string): never => assert.fail(`${label}: ${m}`);
  const rows = async (cid: number) => (await env.q(
    `select id::int as id, to_char(due_date,'YYYY-MM-DD') as due, amount::text as amount from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [cid]));
  /** Every open installment: the given action for the listed ones, cancel (or write off, when invoiced) for the rest. */
  const dispositions = async (U: number, cid: number, pick: Record<number, any>) =>
    (await openInstallments(sqlOf(env.t.pool as any), U, cid)).map((o) => pick[o.paymentId]
      ? { paymentId: o.paymentId, ...pick[o.paymentId] }
      : { paymentId: o.paymentId, action: o.allowed.includes("cancel") ? "cancel" : "write_off", reason: "synthetic" });
  const contract = async (U: number, s: Seed, unit: number, extra: Record<string, unknown>) => {
    const holder = unit === s.unitH1;
    return (await env.contracts.create(user(U), {
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", paymentFrequency: "monthly",
      landlordName: holder ? "Synthetic Holder" : "Synthetic Landlord A", landlordIdNumber: holder ? `70001${U}` : `70000${U}`, ...extra,
    })) as any;
  };

  before(async () => {
    env = await legacyEnv("wired");
    backfill = backfillOf(env);
    rec = new ReconciliationService(env.t.pool, legacyAccountingFor(env.db));
  });
  after(async () => { await env?.t.drop(); });

  it("aging / R1: writing off an installment a confirmed invoice covers clears the invoice's open item", async () => {
    const U = 39001;
    const s = await setupAccount(env, U, "owner");
    const c = await contract(U, s, s.unitH1, { startDate: monthStart(-3), endDate: plusMonths(monthStart(-3), 12), monthlyRent: "1000", vatEnabled: false });
    const [p1] = await rows(c.id);
    const inv: any = await env.billing.create(user(U), { type: "invoice", paymentIds: [p1.id], issueDate: p1.due,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 1000, amount: 1000, vat: false }], total: 1000 });
    await env.billing.approve(user(U), String(inv.id), { confirmations: { tenantNoVat: true } });
    await settle(env, U);
    await env.contracts.terminate(user(U), String(c.id), { dispositions: await dispositions(U, c.id, { [p1.id]: { action: "write_off", reason: "synthetic" } }) });
    await checkInvariants(env, backfill, rec, U, "owner", () => settle(env, U), fail("R-a"), null);
  });

  it("backfill: a written-off installment (stored cancelled) is still charged before E24 clears it", async () => {
    const U = 39002;
    const s = await setupAccount(env, U, "manager");
    const c = await contract(U, s, s.unitA1, { startDate: monthStart(-2), endDate: plusMonths(monthStart(-2), 12), monthlyRent: "1000", vatEnabled: true });
    await settle(env, U);
    const [p1] = await rows(c.id);
    await env.contracts.terminate(user(U), String(c.id), { dispositions: await dispositions(U, c.id, { [p1.id]: { action: "write_off", reason: "synthetic" } }) });
    await checkInvariants(env, backfill, rec, U, "manager", () => settle(env, U), fail("R-b"), null);
  });

  it("backfill: a cancelled installment that had a collection is charged and cancelled as live posting did (no advance VAT)", async () => {
    const U = 39003;
    const s = await setupAccount(env, U, "owner");
    const c = await contract(U, s, s.unitA2, { startDate: monthStart(-2), endDate: plusMonths(monthStart(-2), 6), monthlyRent: "800", vatEnabled: true });
    await settle(env, U);
    const [p1] = await rows(c.id);
    await env.payments.addCollection(user(U), String(p1.id), { amount: "40", collectedDate: addDays(p1.due, 3), method: "cash" });
    await settle(env, U);
    await env.contracts.terminate(user(U), String(c.id), { dispositions: await dispositions(U, c.id, { [p1.id]: { action: "cancel" } }) });
    await checkInvariants(env, backfill, rec, U, "owner", () => settle(env, U), fail("R-c"), null);
  });

  it("terminate: a write-off covers the advance refunded off the same installment, and the installment keeps its VAT", async () => {
    const U = 39004;
    const s = await setupAccount(env, U, "manager");
    // 1,150 a month with VAT; 1,700 prepaid → 1,150 on the first installment, 550 on the second.
    const c = await contract(U, s, s.unitA1, { startDate: monthStart(-2), endDate: plusMonths(monthStart(-2), 12), monthlyRent: "1000", vatEnabled: true,
      prepaidRent: "1700", prepaidMethod: "bank_transfer" });
    await settle(env, U);
    const [, p2] = await rows(c.id);
    await env.contracts.terminate(user(U), String(c.id), { advance: "refund", dispositions: await dispositions(U, c.id, { [p2.id]: { action: "write_off", reason: "synthetic" } }) });
    await settle(env, U);
    const [w] = await env.q(`select amount::text as amount from finance_write_offs where user_id = $1 and $2 = any(payment_ids)`, [U, p2.id]);
    assert.equal(w.amount, "1150.00", "600 remaining + 550 refunded");
    const [v] = await env.q(`select coalesce(sum(l.credit - l.debit), 0)::text as vat from journal_lines l where l.user_id = $1 and l.payment_id = $2 and l.tax_role = 'output' and l.vat_category = 'S'`, [U, p2.id]);
    assert.equal(v.vat, "150.00", "the supply happened: its VAT stays");
    await checkInvariants(env, backfill, rec, U, "manager", () => settle(env, U), fail("R-d"), null);
  });

  it("E05: a prepaid installment cancelled before the recognizer ever charged it loses its advance VAT, as a charged one does", async () => {
    const U = 39007;
    const s = await setupAccount(env, U, "owner");
    // Entered with a start two months back and ended at once: the prepaid 500 sits on the first installment (1,150), which
    // the recognizer has not charged yet; the backfill (which charges it at its due date) must land on the same figures.
    const c = await contract(U, s, s.unitA2, { startDate: monthStart(-2), endDate: plusMonths(monthStart(-2), 6), monthlyRent: "1000", vatEnabled: true,
      prepaidRent: "500", prepaidMethod: "cash" });
    const [p1] = await rows(c.id);
    await env.contracts.terminate(user(U), String(c.id), { dispositions: await dispositions(U, c.id, { [p1.id]: { action: "cancel" } }) });
    await checkInvariants(env, backfill, rec, U, "owner", () => settle(env, U), fail("R-g"), null);
    const [v] = await env.q(`select coalesce(sum(l.credit - l.debit), 0)::text as vat from journal_lines l where l.user_id = $1 and l.tax_role = 'output' and l.vat_category = 'S'`, [U]);
    assert.equal(v.vat, "0.00", "a cancelled supply carries no VAT");
  });

  it("R3: a payout to a landlord with no contract yet is missing from the dues report; the sub-ledger completes it", async () => {
    const U = 39005;
    await setupAccount(env, U, "manager");
    const [a] = await env.q(`select id from owners where user_id = $1 and not is_account_holder`, [U]);
    await env.reports.createPayout(user(U), { ownerId: a.id, amount: 25, transferDate: LAST, method: "bank_transfer" });
    await checkInvariants(env, backfill, rec, U, "manager", () => settle(env, U), fail("R-e"), null);
  });

  it("free invoice (external customer), manager mode with a trust account: the account's own sale; R1, R3, R4 and R5 hold", async () => {
    const U = 39008;
    const s = await setupAccount(env, U, "manager");
    await new BankAccountsService(env.t.pool as any).create(U, U, { kind: "bank", nameAr: "حساب العملاء", nameEn: "Client trust", isTrust: true, isDefault: true });
    await env.q(`update finance_settings set agency_collections_to_trust = true where account_user_id = $1`, [U]);
    void s;
    const client = { name: "Synthetic Customer", type: "individual", email: `cust-${U}@example.test`, phone: "0500000009", idNumber: `10000${U}` };
    const mk = async (items: any[], total: number) => {
      const d: any = await env.billing.create(user(U), { type: "invoice", issueDate: LAST, client, items, total });
      await env.billing.approve(user(U), String(d.id), { confirmations: { tenantNoVat: true } });
      return d;
    };
    const a = await mk([{ description: "خدمة استشارية", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], 1150);
    await mk([{ description: "خدمة إدارية", quantity: 1, unitPrice: 100, amount: 100, vat: false }], 100);
    await env.billing.collect(user(U), String(a.id), { amount: 600, paidDate: LAST, method: "bank_transfer" });
    await settle(env, U);
    const [agent] = await env.q(
      `select count(*)::int as n from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code in ('1122','2121','2122')`, [U]);
    assert.equal(agent.n, 0, "never agent money");
    await checkInvariants(env, backfill, rec, U, "manager", () => settle(env, U), fail("R-h"), null);
  });

  it("R1: an installment falling due today is not a receivable yet on either side (the recognizer charges it tomorrow)", async () => {
    const U = 39006;
    const s = await setupAccount(env, U, "owner");
    const start = plusMonths(TODAY, -1);
    await contract(U, s, s.unitH1, { startDate: start, endDate: addDays(plusMonths(start, 12), -1), monthlyRent: "1200", vatEnabled: false });
    await checkInvariants(env, backfill, rec, U, "owner", () => settle(env, U), fail("R-f"), null);
  });
});
