/**
 * Bank statement auto-match scoring (DESIGN §8.3 a). Pure.
 *
 * Candidates for a statement line are UNMATCHED journal lines on the bank
 * account's GL account with exactly the same signed amount in halalas (money
 * in = a debit) and a date at most 3 days apart. Score = 100 − 10 × days,
 * plus 50 when the line's reference or description contains one of the
 * journal line's document numbers (RV-, PV-, INV-, JV-, RFND- …) or the
 * payer's IBAN tail. A UNIQUE best candidate scoring ≥ 70 is matched
 * automatically; anything else stays a suggestion.
 */
export interface StatementLineIn {
  id: number;
  txnDate: string;
  amount: number;
  description: string | null;
  reference: string | null;
}

export interface JournalLineIn {
  id: number;
  entryDate: string;
  /** debit − credit on the bank GL account, halalas. */
  amount: number;
  /** Document numbers and references this line can be recognised by. */
  refs: string[];
}

export interface Scored {
  journalLineId: number;
  score: number;
  days: number;
  refHit: boolean;
}

export const MAX_DAYS = 3;
export const AUTO_THRESHOLD = 70;

export function dayDiff(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, "");

export function refHit(line: Pick<StatementLineIn, "description" | "reference">, refs: string[]): boolean {
  const hay = norm(`${line.reference ?? ""} ${line.description ?? ""}`);
  if (!hay) return false;
  return refs.some((r) => {
    const n = norm(r ?? "");
    return n.length >= 4 && hay.includes(n);
  });
}

export function candidates(line: StatementLineIn, pool: JournalLineIn[]): Scored[] {
  const out: Scored[] = [];
  for (const j of pool) {
    if (j.amount !== line.amount) continue;
    const days = dayDiff(line.txnDate, j.entryDate);
    if (days > MAX_DAYS) continue;
    const hit = refHit(line, j.refs);
    out.push({ journalLineId: j.id, days, refHit: hit, score: 100 - 10 * days + (hit ? 50 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || a.days - b.days || a.journalLineId - b.journalLineId);
}

/** The auto-match decision for one line: the unique best candidate at or above the threshold, else null. */
export function autoPick(scored: Scored[]): Scored | null {
  const [best, second] = scored;
  if (!best || best.score < AUTO_THRESHOLD) return null;
  if (second && second.score === best.score) return null;
  return best;
}

/**
 * Greedy auto-match over a statement: lines in order, each taking its unique
 * best unclaimed candidate. A journal line claimed by an earlier line is out of
 * the pool for later ones, so the result is 1:1.
 */
export function autoMatch(lines: StatementLineIn[], pool: JournalLineIn[]): Array<{ statementLineId: number; journalLineId: number; score: number }> {
  const taken = new Set<number>();
  const out: Array<{ statementLineId: number; journalLineId: number; score: number }> = [];
  for (const l of [...lines].sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.id - b.id)) {
    const pick = autoPick(candidates(l, pool.filter((j) => !taken.has(j.id))));
    if (!pick) continue;
    taken.add(pick.journalLineId);
    out.push({ statementLineId: l.id, journalLineId: pick.journalLineId, score: pick.score });
  }
  return out;
}
