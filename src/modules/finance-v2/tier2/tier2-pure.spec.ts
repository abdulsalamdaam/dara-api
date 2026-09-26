import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprints, parseAmount, parseStatement, parseStatementDate, splitCsv } from "./statement-csv";
import { autoMatch, autoPick, candidates } from "./match";
import { envGateOn, hashRecipient, recipientAllowed } from "./reminder-sender";
import { FinanceV2Tier2Controller } from "../controllers/tier2.controller";

/** Pure tier-2 helpers (DESIGN §8.3). All values synthetic. */
describe("fv2 tier 2: statement CSV", () => {
  it("splits quoted fields, doubled quotes, CRLF and a BOM", () => {
    assert.deepEqual(splitCsv('﻿a,"b, c","d ""q"""\r\n1,2,3\n'), [["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
    assert.deepEqual(splitCsv("x;y\n1;2", ";"), [["x", "y"], ["1", "2"]]);
  });

  it("amounts: separators, brackets, trailing minus, Arabic-Indic digits, SAR", () => {
    assert.equal(parseAmount("1,234.50"), 123450);
    assert.equal(parseAmount("(700.00)"), -70000);
    assert.equal(parseAmount("15.00-"), -1500);
    assert.equal(parseAmount("٢٬٥٠٠٫٠٠"), 250000);
    assert.equal(parseAmount("SAR 10"), 1000);
    assert.equal(parseAmount(""), null);
    assert.throws(() => parseAmount("12.345"));
  });

  it("dates: every supported format; Hijri refused with its own code; impossible dates refused", () => {
    assert.equal(parseStatementDate("05/03/2026", "DD/MM/YYYY"), "2026-03-05");
    assert.equal(parseStatementDate("03/05/2026", "MM/DD/YYYY"), "2026-03-05");
    assert.equal(parseStatementDate("2026-03-05", "YYYY-MM-DD"), "2026-03-05");
    assert.equal(parseStatementDate("٠٥/٠٣/٢٠٢٦", "DD/MM/YYYY"), "2026-03-05");
    assert.equal(parseStatementDate("2026-03-05 14:22", "YYYY-MM-DD"), "2026-03-05");
    assert.throws(() => parseStatementDate("15/09/1447", "DD/MM/YYYY"), (e: any) => e.code === "HIJRI_DATE");
    assert.throws(() => parseStatementDate("31/02/2026", "DD/MM/YYYY"), (e: any) => e.code === "BAD_DATE");
  });

  it("a signed amount column, or debit/credit columns; zero rows skipped; errors listed by line", () => {
    const csv = "Date,Details,Ref,Debit,Credit,Balance\n01/03/2026,Transfer in,RC-1,,1000.00,1000.00\n02/03/2026,Fee,,15.00,,985.00\n02/03/2026,Info,,,,985.00\nbad,Row,,1,,\n";
    const r = parseStatement(csv, { delimiter: ",", skipRows: 0, dateCol: "Date", dateFormat: "DD/MM/YYYY", descCol: "Details", refCol: "Ref", debitCol: "Debit", creditCol: "Credit", balanceCol: "Balance" });
    assert.deepEqual(r.lines.map((l) => [l.lineNo, l.txnDate, l.amount, l.reference, l.runningBalance]), [[2, "2026-03-01", 100000, "RC-1", 100000], [3, "2026-03-02", -1500, null, 98500]]);
    assert.equal(r.zero, 1);
    assert.deepEqual(r.errors.map((e) => [e.lineNo, e.error]), [[5, "BAD_DATE"]]);
    const s = parseStatement("x\n2026-03-01;-70\n", { delimiter: ";", skipRows: 1, dateCol: "1", dateFormat: "YYYY-MM-DD", amountCol: "2" });
    assert.deepEqual(s.lines.map((l) => l.amount), [-7000]);
  });

  it("fingerprints: identical lines in one file differ by occurrence; a re-import gives the same prints", () => {
    const l = { lineNo: 1, txnDate: "2026-03-01", description: "Fee", reference: null, amount: -1500, runningBalance: null };
    const a = fingerprints(7, [l, { ...l, lineNo: 2 }]);
    assert.notEqual(a[0], a[1]);
    assert.deepEqual(fingerprints(7, [l, { ...l, lineNo: 9 }]), a);
    assert.notDeepEqual(fingerprints(8, [l]), [a[0]]);
  });
});

describe("fv2 tier 2: auto-match scoring", () => {
  const line = { id: 1, txnDate: "2026-03-05", amount: 100000, description: "Transfer RC-7001", reference: null };
  it("exact amount only, within 3 days; 100 − 10·days, +50 on a reference hit", () => {
    const sc = candidates(line, [
      { id: 10, entryDate: "2026-03-05", amount: 100000, refs: ["RC-7002"] },
      { id: 11, entryDate: "2026-03-06", amount: 100000, refs: ["RC-7001"] },
      { id: 12, entryDate: "2026-03-05", amount: 100001, refs: [] },
      { id: 13, entryDate: "2026-03-09", amount: 100000, refs: [] },
      { id: 14, entryDate: "2026-03-05", amount: -100000, refs: [] },
    ]);
    assert.deepEqual(sc.map((s) => [s.journalLineId, s.score]), [[11, 140], [10, 100]]);
  });
  it("a tie at the top, or a best below 70, is only a suggestion", () => {
    assert.equal(autoPick([{ journalLineId: 1, score: 100, days: 0, refHit: false }, { journalLineId: 2, score: 100, days: 0, refHit: false }]), null);
    assert.equal(autoPick([{ journalLineId: 1, score: 60, days: 4, refHit: false }]), null);
    assert.equal(autoPick([{ journalLineId: 1, score: 70, days: 3, refHit: false }])?.journalLineId, 1);
  });
  it("greedy 1:1 over a statement: a claimed ledger line leaves the pool", () => {
    const lines = [line, { ...line, id: 2, txnDate: "2026-03-06", description: "Transfer RC-7002" }];
    const pool = [{ id: 10, entryDate: "2026-03-05", amount: 100000, refs: ["RC-7001"] }, { id: 11, entryDate: "2026-03-05", amount: 100000, refs: ["RC-7002"] }];
    assert.deepEqual(autoMatch(lines, pool).map((m) => [m.statementLineId, m.journalLineId]), [[1, 10], [2, 11]]);
  });
});

describe("fv2 tier 2: reminders are built disabled", () => {
  it("gate 1 is off unless FINANCE_REMINDERS_ENABLED is exactly '1'", () => {
    assert.equal(envGateOn({}), false);
    assert.equal(envGateOn({ FINANCE_REMINDERS_ENABLED: "true" }), false);
    assert.equal(envGateOn({ FINANCE_REMINDERS_ENABLED: "1" }), true);
  });
  it("outside declared production only the allowlist may receive (NODE_ENV=production is not trusted)", () => {
    assert.equal(recipientAllowed("+966500000000", { NODE_ENV: "production" }), false);
    assert.equal(recipientAllowed("x@example.test", { REMINDER_RECIPIENT_ALLOWLIST: "x@example.test" }), true);
    assert.equal(recipientAllowed("y@example.test", { REMINDER_RECIPIENT_ALLOWLIST: "x@example.test" }), false);
  });
  it("recipients are hashed, never stored in clear", () => {
    const h = hashRecipient(1, "sms", "0500000000");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes("0500000000"));
  });
  it("the reminder code imports no SMS, push, mail or HTTP client", () => {
    for (const f of readdirSync(__dirname).filter((x) => /^remind.*\.ts$/.test(x) && !x.endsWith(".spec.ts"))) {
      const src = readFileSync(join(__dirname, f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) assert.ok(!/sms|taqnyat|push|mail|resend|smtp|axios|node-fetch|expo/i.test(i), `${f} imports ${i}`);
      assert.ok(!/\bfetch\(/.test(src), `${f} calls fetch`);
    }
  });
});

describe("fv2 tier 2 routes: every handler needs a capability", () => {
  it("tier2 controller", () => {
    for (const k of Object.getOwnPropertyNames(FinanceV2Tier2Controller.prototype).filter((x) => x !== "constructor")) {
      assert.ok(Reflect.getMetadata("fv2:capability", (FinanceV2Tier2Controller.prototype as any)[k]), `FinanceV2Tier2Controller.${k} has no capability`);
    }
  });
});
