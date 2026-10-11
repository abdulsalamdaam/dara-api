/**
 * An Ejar import must not message anybody: no email, SMS or push — the
 * imported phones and emails belong to real people (staging is a copy of
 * production data).
 *
 * 1. Static: no file on the import path imports a sender. The path is the
 *    Ejar module, the writer's direct dependencies (installments, lookups
 *    resolution, rent VAT) and the finance-v2 attach hook.
 * 2. Runtime (needs DATABASE_URL, rolled back): a real import through the
 *    real runner, with every sender's entry point spied on, every outbound
 *    fetch recorded, and the notification tables counted before and after.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { count } from "drizzle-orm";
import { db, getPool, usersTable, notificationsTable, ownerNotificationsTable } from "@dara/database";

import { EmailService } from "../email/email.service";
import { TaqnyatService } from "../sms/taqnyat.service";
import { TwilioVerifyService } from "../twilio/twilio-verify.service";
import { EjarImportRunner, EjarImportService } from "./ejar.import.service";
import { DrizzleEjarLookupStore } from "./ejar.lookup.store";
import { UUID, invoicesFor, contractsFor } from "./__tests__/lookup-harness";

const SENDER_IMPORT = /from\s+["'][^"']*(email|sms|twilio|notifications|common\/push|common\/notify)[^"']*["']/i;

describe("the Ejar import sends no messages", () => {
  it("statically: nothing on the import path imports an email/SMS/push sender", () => {
    const files = [
      ...readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts")).map((f) => join(__dirname, f)),
      join(__dirname, "..", "contracts", "installments.ts"),
      join(__dirname, "..", "..", "common", "lookups-resolve.ts"),
      join(__dirname, "..", "..", "common", "usage-vat.ts"),
      join(__dirname, "..", "finance-v2", "hooks", "hooks.service.ts"),
      join(__dirname, "..", "finance-v2", "hooks", "classify.ts"),
      join(__dirname, "..", "finance-v2", "hooks", "facts-loader.ts"),
    ];
    for (const f of files) {
      const offending = readFileSync(f, "utf8").split("\n").filter((l) => /^\s*import\b/.test(l) && SENDER_IMPORT.test(l));
      assert.deepEqual(offending, [], f);
    }
  });
});

const HAS_DB = !!process.env.DATABASE_URL;
class Rollback extends Error {}

describe("the Ejar import sends no messages (database, rolled back)", { skip: !HAS_DB && "DATABASE_URL not set" }, () => {
  let userId = 0;
  before(async () => {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    userId = u?.id ?? 0;
  });
  after(async () => { await getPool().end(); });

  it("at runtime: no sender is called, nothing is fetched, no notification row is written", async () => {
    assert.ok(userId, "needs at least one user row");
    const called: string[] = [];
    const spies: Array<[any, string]> = [
      [EmailService.prototype, "send"],
      [TaqnyatService.prototype, "send"],
      [TwilioVerifyService.prototype, "start"],
    ];
    const originals = spies.map(([proto, m]) => proto[m]);
    spies.forEach(([proto, m]) => { proto[m] = async () => { called.push(m); return false; }; });
    // Every provider (Resend, Taqnyat, Twilio, Expo push) is an HTTP API; any
    // outbound fetch at all during the import is a failure.
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => { fetched.push(String(url)); throw new Error("no network during import"); }) as typeof fetch;
    try {
      const counts = await (async () => {
        let out: { before: number[]; after: number[] } | null = null;
        try {
          await db.transaction(async (tx) => {
            const t = tx as never as typeof db;
            const n = async () => [
              Number((await t.select({ c: count() }).from(notificationsTable))[0].c),
              Number((await t.select({ c: count() }).from(ownerNotificationsTable))[0].c),
            ];
            const before = await n();
            const store = new DrizzleEjarLookupStore(t as never);
            store.getLookup = async (_a, num) => ({
              id: 1, accountId: userId, contractNumber: num, ejarUuid: UUID, invoicesBody: invoicesFor(num),
              detailsBody: null, contractsBody: contractsFor(num), lookedUpBy: userId, createdAt: new Date(),
            });
            store.findImported = async () => null;
            store.scope = async () => ({ locked: false, idNumber: null });
            const res = await new EjarImportService(store, new EjarImportRunner(t as never)).import({ id: userId } as never, { contract_number: "10000000991" });
            assert.ok(res.contractId);
            out = { before, after: await n() };
            throw new Rollback();
          });
        } catch (e) {
          if (!(e instanceof Rollback)) throw e;
        }
        return out!;
      })();
      assert.deepEqual(counts.after, counts.before, "no notification rows");
    } finally {
      globalThis.fetch = realFetch;
      spies.forEach(([proto, m], i) => { proto[m] = originals[i]; });
    }
    assert.deepEqual(called, [], "no email / SMS / Twilio sender was called");
    assert.deepEqual(fetched, [], "nothing was fetched");
  });
});
