/**
 * An in-memory stand-in for the posting engine, for pure rule specs: it keeps
 * entries and charge markers, derives PostState exactly as PostingEngine.loadState
 * does from the DB, runs the rule, performs reverse-and-replace, and applies
 * effects. Synthetic data only.
 */
import { runRule, SYS, type OutboxPayload, type PostState, type RuleLine, type RuleOutput, type ActiveCharge } from "../rules";

export interface MemEntry { key: string; date: string; lines: RuleLine[]; status: "posted" | "reversed"; reversalOf?: string }

export function accKey(l: RuleLine): string {
  const a = l.account;
  if ("sys" in a) return a.sys;
  if ("id" in a) return `id:${a.id}`;
  return a.bank.bankAccountId ? `bank:${a.bank.bankAccountId}` : String(a.bank.method).toLowerCase() === "cash" ? "cash" : "bank_default";
}

export class MemLedger {
  entries = new Map<string, MemEntry>();
  charges = new Map<number, Array<ActiveCharge & { entryKey: string; reversed: boolean }>>();
  writtenOff: number[] = [];
  outcomes: Array<{ key: string; out: RuleOutput }> = [];

  private lines(): RuleLine[] {
    return [...this.entries.values()].flatMap((e) => e.lines);
  }

  state(pids: number[]): PostState {
    const s: PostState = { charges: {}, vatBooked: {}, baseBooked: {}, unreleased: {}, writtenOff: this.writtenOff.filter((p) => pids.includes(p)) };
    for (const p of pids) {
      const active = (this.charges.get(p) ?? []).find((c) => !c.reversed);
      if (active) s.charges[p] = active;
    }
    for (const l of this.lines()) {
      const p = l.dims.paymentId;
      if (p == null || !pids.includes(p)) continue;
      if (l.docClass === "advance" && l.taxRole === "output") {
        s.vatBooked[p] = (s.vatBooked[p] ?? 0) + l.credit - l.debit;
        s.baseBooked[p] = (s.baseBooked[p] ?? 0) + (l.vatBase ?? 0);
      }
      if (accKey(l) === SYS.ur) s.unreleased[p] = (s.unreleased[p] ?? 0) + l.credit - l.debit;
    }
    return s;
  }

  /** Post one event like the worker would. Returns the rule output. */
  post(key: string, payload: OutboxPayload): RuleOutput {
    if (this.entries.has(key)) throw new Error(`duplicate key ${key}`);
    const pids = payload.paymentIds ?? [];
    const st = this.state(pids);
    const out = runRule(payload, st);
    this.outcomes.push({ key, out });
    if (out.skip) return out;
    for (const p of out.replaceDueCharges ?? []) {
      const ch = st.charges[p]!;
      const ck = (ch as any).entryKey as string;
      this.reverse(ck, out.date);
      for (const c of this.charges.get(p) ?? []) if (!c.reversed) c.reversed = true;
    }
    this.entries.set(key, { key, date: out.date, lines: out.lines, status: "posted" });
    for (const e of out.effects) {
      if (e.kind === "charge") {
        const list = this.charges.get(e.paymentId) ?? [];
        const vatLine = out.lines.find((l) => l.taxRole === "output" && l.vatCategory === "S" && l.dims.paymentId === e.paymentId);
        list.push({
          generation: list.length + 1, chargedBy: e.chargedBy, documentId: e.documentId, amount: e.amount, vatAmount: e.vatAmount,
          vatBase: vatLine?.vatBase ?? null, entryId: this.entries.size, entryKey: key, reversed: false, // non-null: a null entryId means "from the opening balance"
        });
        this.charges.set(e.paymentId, list);
      } else if (e.kind === "uncharge") {
        for (const c of this.charges.get(e.paymentId) ?? []) c.reversed = true;
      }
    }
    return out;
  }

  /** The engine's mirror reversal: key `<source>,reversal:<event>`. */
  reverse(key: string, date: string): MemEntry {
    const orig = this.entries.get(key);
    if (!orig || orig.status !== "posted") throw new Error(`cannot reverse ${key}`);
    const [st, sid, ...ev] = key.split(",");
    const rk = `${st},${sid},reversal:${ev.join(",")}`;
    const rev: MemEntry = {
      key: rk, date, status: "posted", reversalOf: key,
      lines: orig.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, vatBase: l.vatBase == null ? l.vatBase : -l.vatBase })),
    };
    orig.status = "reversed";
    this.entries.set(rk, rev);
    for (const list of this.charges.values()) for (const c of list) if (c.entryKey === key) c.reversed = true;
    return rev;
  }

  /** Balance (debit − credit) of an account key, optionally filtered by line. */
  balance(account: string, where: (l: RuleLine) => boolean = () => true): number {
    return this.lines().filter((l) => accKey(l) === account && where(l)).reduce((s, l) => s + l.debit - l.credit, 0);
  }

  trialBalance(): { debit: number; credit: number } {
    return this.lines().reduce((t, l) => ({ debit: t.debit + l.debit, credit: t.credit + l.credit }), { debit: 0, credit: 0 });
  }
}
