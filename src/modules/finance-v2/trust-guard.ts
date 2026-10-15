import { ConflictException } from "@nestjs/common";
import type { Fv2Client, Fv2Pool } from "./db";
import type { LedgerEvent } from "./ledger-emitter.service";
import { PostingEngine } from "./posting.engine";
import { runRule, type OutboxPayload, type RuleLine } from "./rules";
import { LOCK_KEYS } from "./lock-keys";
import { fromHalalas, toHalalas } from "./money";
import { auditRow } from "./audit";

/**
 * The trust overdraw guard (حساب الأمانات, accountant 15 Oct 2026): a payment OUT of a trust
 * account (GL 1114, or any bank account flagged `is_trust`) larger than what that account holds
 * pays one client with another client's money.
 *
 * The accountant has not decided between "warn" and "block", so the policy lives HERE, in one line:
 *
 *  - `confirm` — refused with 409 TRUST_INSUFFICIENT unless the request says `allowTrustOverdraw: true`
 *                (the dialog's «أؤكد الصرف رغم عدم كفاية رصيد الأمانات»); a confirmed overdraw is audited;
 *  - `block`   — refused, flag or not.
 */
export type TrustOverdrawPolicy = "confirm" | "block";
export const TRUST_OVERDRAW_POLICY: TrustOverdrawPolicy = "confirm";

let policyOverride: TrustOverdrawPolicy | null = null;
/** The policy in force (TRUST_OVERDRAW_POLICY, unless a spec switched it). */
export function trustOverdrawPolicy(): TrustOverdrawPolicy {
  return policyOverride ?? TRUST_OVERDRAW_POLICY;
}
/** Specs only: run under another policy; null restores the constant. */
export function setTrustOverdrawPolicyForTests(p: TrustOverdrawPolicy | null): void {
  policyOverride = p;
}

/**
 * Only `loadState` and `resolveLines` are used, and both work on the CALLER's client alone (no pool, journal or
 * periods), so the preview needs none of the engine's injected services. Every read below runs on that client:
 * the caller holds advisory locks on it, and a second pool connection while holding one is how the pool deadlock
 * of createAuxPool's comment happened.
 */
const PREVIEW = new PostingEngine(undefined as never, undefined as never, undefined as never);

const REVERSAL = "reversal:";
type Key = string;
const keyOf = (sourceType: string, sourceId: number | string, event: string): Key => `${sourceType}|${Number(sourceId)}|${event}`;
type Effect = Map<number, number>;

const add = (m: Effect, gl: number, v: number) => { if (v) m.set(gl, (m.get(gl) ?? 0) + v); };

export interface TrustAccountAvailability {
  bankAccountId: number | null;
  glAccountId: number;
  glCode: string;
  nameAr: string;
  nameEn: string | null;
  isDefault: boolean;
  /** Posted ledger balance (debit-positive), halalas. */
  posted: number;
  /** Movements recorded but not yet posted by the worker (queued rows both ways, failed rows' outflows), halalas. */
  pending: number;
  /** posted + pending, halalas: what a new outflow may take. */
  available: number;
}

/** The trust GL accounts of a scope: every `is_trust` bank account's leaf, and the chart's trust_bank (1114). */
async function trustAccounts(c: Pick<Fv2Client, "query">, scope: number) {
  return (await c.query(
    `select a.id as gl, a.code, coalesce(b.name_ar, a.name_ar) as name_ar, coalesce(b.name_en, a.name_en) as name_en,
            b.id as bank_id, coalesce(b.is_default, false) as is_default
       from accounts a
       left join lateral (select id, name_ar, name_en, is_default from bank_accounts
                           where user_id = a.user_id and gl_account_id = a.id and is_trust order by is_default desc, id limit 1) b on true
      where a.user_id = $1
        and (a.system_key = 'trust_bank' or exists (select 1 from bank_accounts x where x.user_id = a.user_id and x.gl_account_id = a.id and x.is_trust))
      order by a.code`, [scope])).rows as Array<{ gl: number; code: string; name_ar: string; name_en: string | null; bank_id: number | null; is_default: boolean }>;
}

/** Signed effect (debit − credit, halalas) of one rule payload on the trust accounts, through the engine's own rule and resolution. */
async function payloadEffect(c: Fv2Client, scope: number, payload: OutboxPayload, trust: Set<number>): Promise<Effect> {
  const out: Effect = new Map();
  if (!payload || typeof payload !== "object" || !("rule" in payload) || !payload.rule) return out;
  try {
    const pids = ((payload as any).paymentIds ?? []).map(Number).filter((n: number) => Number.isInteger(n));
    const state = await PREVIEW.loadState(c, scope, pids);
    const r = runRule(payload, state);
    if (r.skip || !r.lines.length) return out;
    return linesEffect(c, scope, r.lines, trust);
  } catch {
    return out; // a payload the engine cannot post (yet) moves no money now
  }
}

/** Signed effect of rule lines (bank refs resolved as the engine would) on the trust accounts. */
async function linesEffect(c: Fv2Client, scope: number, lines: RuleLine[], trust: Set<number>): Promise<Effect> {
  const out: Effect = new Map();
  const { lines: resolved } = await PREVIEW.resolveLines(c, scope, lines);
  for (const l of resolved) if (trust.has(Number(l.accountId))) add(out, Number(l.accountId), Number(l.debit ?? 0) - Number(l.credit ?? 0));
  return out;
}

/** The effect of `reversal:<event>` once posted: minus the original entry's trust lines (none when it never posted). */
async function postedReversalEffect(c: Fv2Client, scope: number, sourceType: string, sourceId: number, event: string, trust: Set<number>): Promise<Effect> {
  const out: Effect = new Map();
  const r = await c.query(
    `select l.account_id, sum(l.debit - l.credit)::text as v from journal_entries e join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
      where e.user_id = $1 and e.source_type = $2 and e.source_id = $3 and e.event = $4 and e.status = 'posted' and l.account_id = any($5::int[])
      group by l.account_id`, [scope, sourceType, sourceId, event, [...trust]]);
  for (const x of r.rows) add(out, Number(x.account_id), -toHalalas(x.v));
  return out;
}

interface Snapshot {
  trust: Awaited<ReturnType<typeof trustAccounts>>;
  posted: Map<number, number>;
  pending: Map<number, number>;
}

/**
 * Posted balance and not-yet-posted outflows of every trust account, read on `c`.
 *
 * Posted: Σ(debit − credit) of the journal. Pending: the outbox rows the worker has not posted yet (pending or
 * failed — the money has moved even if its entry is late), each previewed through the engine. A fresh queued
 * row counts both ways: a collection recorded a second ago is money in the account, and the worker posts it within
 * seconds. A row that may never post — failed, retrying after an error, or blocked behind such a row — counts only
 * its outflow; the same holds for a reversal of a POSTED entry. A reversal whose original is also unposted cancels it. Both are read in ONE statement, so a row the worker posts meanwhile is counted exactly once. `own` rows
 * (and the originals that `ownReversals` undo) are left out: the caller counts them itself.
 */
async function snapshot(c: Fv2Client, scope: number, exclude: Set<Key>): Promise<Snapshot> {
  const trust = await trustAccounts(c, scope);
  const ids = trust.map((t) => Number(t.gl));
  const set = new Set(ids);
  const posted = new Map<number, number>();
  const pending = new Map<number, number>();
  if (!ids.length) return { trust, posted, pending };
  const [row] = (await c.query(
    `select (select coalesce(json_agg(json_build_object('gl', x.account_id, 'v', x.v)), '[]'::json)
               from (select account_id, sum(debit - credit)::text as v from journal_lines where user_id = $1 and account_id = any($2::int[]) group by account_id) x) as posted,
            (select coalesce(json_agg(json_build_object('st', o.source_type, 'sid', o.source_id, 'ev', o.event, 'payload', o.payload,
                                                        'sure', o.status = 'pending' and o.attempts = 0 and not o.stuck_blocker) order by o.id), '[]'::json)
               from (select x.id, x.source_type, x.source_id, x.event, x.status, x.attempts, x.payload,
                            exists (select 1 from ledger_outbox b where b.id = x.blocked_on and b.user_id = x.user_id
                                      and (b.status = 'failed' or b.attempts > 0)) as stuck_blocker
                       from ledger_outbox x
                      where x.user_id = $1 and x.status in ('pending','failed') order by x.id limit 2000) o) as pending`,
    [scope, ids])).rows;
  for (const p of row.posted as Array<{ gl: number; v: string }>) posted.set(Number(p.gl), toHalalas(p.v));

  const rows = (row.pending as Array<{ st: string; sid: number; ev: string; sure: boolean; payload: any }>)
    .filter((o) => !exclude.has(keyOf(o.st, o.sid, o.ev)));
  const keys = new Set(rows.map((o) => keyOf(o.st, o.sid, o.ev)));
  // An unposted reversal of an unposted original: the pair moves nothing.
  const cancelled = new Set<Key>();
  for (const o of rows) {
    if (!o.ev.startsWith(REVERSAL)) continue;
    const orig = keyOf(o.st, o.sid, o.ev.slice(REVERSAL.length));
    if (keys.has(orig)) { cancelled.add(orig); cancelled.add(keyOf(o.st, o.sid, o.ev)); }
  }
  for (const o of rows) {
    const k = keyOf(o.st, o.sid, o.ev);
    if (cancelled.has(k)) continue;
    // finance-v2: a fresh queued row posts within seconds: it counts both ways. One that may never post — failed, retrying
    // after an error (attempts > 0), or blocked behind such a row — counts only its outflow: money it would bring in is not there yet.
    if (o.ev.startsWith(REVERSAL)) {
      // Undoing a POSTED entry (the undo of a posted payout gives its money back to the books).
      for (const [gl, v] of await postedReversalEffect(c, scope, o.st, Number(o.sid), o.ev.slice(REVERSAL.length), set)) if (o.sure || v < 0) add(pending, gl, v);
      continue;
    }
    for (const [gl, v] of await payloadEffect(c, scope, o.payload, set)) if (o.sure || v < 0) add(pending, gl, v);
  }
  return { trust, posted, pending };
}

/** What the request itself takes out of each trust account (net, halalas > 0), from the events it is about to emit and/or direct lines. */
async function ownOutflow(
  c: Fv2Client, scope: number, trust: Set<number>,
  own: { events?: LedgerEvent[]; lines?: Array<{ accountId: number; debit: number; credit: number }> },
): Promise<{ need: Map<number, number>; exclude: Set<Key> }> {
  const net: Effect = new Map();
  const exclude = new Set<Key>();
  const events = own.events ?? [];
  const ownKeys = new Set(events.map((e) => keyOf(e.sourceType, e.sourceId, e.event)));
  for (const e of events) {
    exclude.add(keyOf(e.sourceType, e.sourceId, e.event));
    if (e.event.startsWith(REVERSAL)) {
      const origEvent = e.event.slice(REVERSAL.length);
      const origKey = keyOf(e.sourceType, e.sourceId, origEvent);
      if (ownKeys.has(origKey)) continue;
      const [o] = (await c.query(
        `select status, payload from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`,
        [scope, e.sourceType, e.sourceId, origEvent])).rows;
      if (o && (o.status === "pending" || o.status === "failed")) {
        exclude.add(origKey); // undone before it ever posted: neither moves money
        continue;
      }
      for (const [gl, v] of await postedReversalEffect(c, scope, e.sourceType, e.sourceId, origEvent, trust)) add(net, gl, v);
      continue;
    }
    for (const [gl, v] of await payloadEffect(c, scope, e.payload as OutboxPayload, trust)) add(net, gl, v);
  }
  for (const l of own.lines ?? []) if (trust.has(Number(l.accountId))) add(net, Number(l.accountId), Number(l.debit) - Number(l.credit));
  const need = new Map<number, number>();
  for (const [gl, v] of net) if (v < 0) need.set(gl, -v);
  return { need, exclude };
}

async function ledgerStarted(c: Pick<Fv2Client, "query">, scope: number): Promise<boolean> {
  const [s] = (await c.query(
    `select finance_v2_enabled and ledger_started_at is not null as started from finance_settings where account_user_id = $1`, [scope])).rows;
  return s?.started === true;
}

export interface TrustCheck {
  /** True when a trust account went below zero because the request confirmed it (policy `confirm`). */
  overdrawn: boolean;
  shortfalls: Array<{ glAccountId: number; glCode: string; available: string; required: string }>;
}

/**
 * The guard. Call it INSIDE the request's transaction, on its client, after the source rows are written and
 * BEFORE the events are emitted (or, for a direct journal post, with its lines). It takes the per-account
 * trust lock first, so two outflows — of any kind — that each fit alone but not together are serialised: the
 * second reads the first's committed outbox row as pending and is refused.
 *
 * No trust account touched, or the ledger not started (nothing is posted, so no balance is known) → no-op.
 * Short and not confirmed (or policy `block`) → 409 TRUST_INSUFFICIENT {available, required, glCode, policy}.
 * Short and confirmed → an audit row `finance_v2_trust_overdraw`, and `overdrawn: true`.
 */
export async function assertTrustCovers(
  c: Fv2Client,
  scope: number,
  own: { events?: LedgerEvent[]; lines?: Array<{ accountId: number; debit: number; credit: number }> },
  opts: { allow?: unknown; actorId?: number | null; source?: string } = {},
): Promise<TrustCheck> {
  const none: TrustCheck = { overdrawn: false, shortfalls: [] };
  if (!(own.events?.length || own.lines?.length)) return none;
  if (!(await ledgerStarted(c, scope))) return none;
  const trustRows = await trustAccounts(c, scope);
  if (!trustRows.length) return none;
  const trust = new Set(trustRows.map((t) => Number(t.gl)));
  const { need, exclude } = await ownOutflow(c, scope, trust, own);
  if (!need.size) return none;

  await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.TRUST_OUTFLOW]);
  const snap = await snapshot(c, scope, exclude);
  const policy = trustOverdrawPolicy();
  const shortfalls: TrustCheck["shortfalls"] = [];
  for (const [gl, required] of need) {
    const available = (snap.posted.get(gl) ?? 0) + (snap.pending.get(gl) ?? 0);
    if (required <= available) continue;
    const t = snap.trust.find((x) => Number(x.gl) === gl);
    shortfalls.push({ glAccountId: gl, glCode: t?.code ?? "", available: fromHalalas(available), required: fromHalalas(required) });
  }
  if (!shortfalls.length) return none;
  const allowed = policy === "confirm" && opts.allow === true;
  if (!allowed) {
    const s = shortfalls[0];
    throw new ConflictException({
      error: "TRUST_INSUFFICIENT",
      message: `رصيد حساب الأمانات لا يكفي: المتاح ${s.available} والمطلوب ${s.required}`
        + (policy === "block" ? " — لا يُسمح بالصرف بأكثر من الرصيد" : "")
        + ` · The trust account balance is not enough: available ${s.available}, required ${s.required}`
        + (policy === "block" ? " — paying out more than the balance is not allowed" : ""),
      available: s.available, required: s.required, glCode: s.glCode, policy, shortfalls,
    });
  }
  if (opts.actorId != null) {
    await auditRow(c, scope, opts.actorId, "finance_v2_trust_overdraw", shortfalls.map((s) => `${s.glCode}:${s.available}/${s.required}`).join(","),
      opts.source ?? "/finance/v2");
  }
  return { overdrawn: true, shortfalls };
}

/** GET /finance/v2/bank-accounts/trust-available: what each trust account can pay out now (read-only, no lock). */
export async function trustAvailability(pool: Fv2Pool, scope: number): Promise<{ policy: TrustOverdrawPolicy; started: boolean; accounts: Array<Omit<TrustAccountAvailability, "posted" | "pending" | "available"> & { posted: string; pending: string; available: string }> }> {
  const c = await pool.connect();
  try {
    const started = await ledgerStarted(c, scope);
    if (!started) return { policy: trustOverdrawPolicy(), started, accounts: [] };
    const snap = await snapshot(c as Fv2Client, scope, new Set());
    return {
      policy: trustOverdrawPolicy(),
      started,
      accounts: snap.trust.map((t) => {
        const gl = Number(t.gl);
        const posted = snap.posted.get(gl) ?? 0;
        const pending = snap.pending.get(gl) ?? 0;
        return {
          bankAccountId: t.bank_id == null ? null : Number(t.bank_id), glAccountId: gl, glCode: t.code, nameAr: t.name_ar, nameEn: t.name_en ?? null,
          isDefault: t.is_default === true, posted: fromHalalas(posted), pending: fromHalalas(pending), available: fromHalalas(posted + pending),
        };
      }),
    };
  } finally {
    c.release();
  }
}

/** Rule lines for a refund the legacy handler is about to write (the terminate pre-check): one credit per bank ref. */
export function creditLines(parts: Array<{ bank: { bankAccountId?: number | null; method?: string | null; agency?: boolean }; amount: number }>): RuleLine[] {
  return parts.filter((p) => p.amount > 0).map((p) => ({ account: { bank: p.bank }, debit: 0, credit: p.amount, dims: {} }));
}

/** Resolve rule lines on `c` (bank refs → GL) for `assertTrustCovers({ lines })`. */
export async function resolveForGuard(c: Fv2Client, scope: number, lines: RuleLine[]) {
  if (!lines.length) return [];
  const { lines: resolved } = await PREVIEW.resolveLines(c, scope, lines);
  return resolved.map((l) => ({ accountId: Number(l.accountId), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0) }));
}
