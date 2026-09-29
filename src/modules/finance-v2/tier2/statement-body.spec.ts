import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fv2StatementBody, STATEMENT_BODY_LIMIT } from "./statement-body";
import { MAX_CSV_BYTES } from "./statement-csv";

/** A fake express request/response pair; the body is streamed in 64 KB chunks. */
function call(path: string, body: string | null, opts: { method?: string; type?: string } = {}) {
  const req: any = new EventEmitter();
  req.method = opts.method ?? "POST";
  req.originalUrl = path;
  req.headers = { "content-type": opts.type ?? "application/json" };
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: string) { this.body = b; this.ended = true; } };
  return new Promise<{ req: any; res: any; next: boolean }>((resolve) => {
    const done = (next: boolean) => resolve({ req, res, next });
    const r = fv2StatementBody(req, res, () => done(true));
    if (body != null) {
      const buf = Buffer.from(body, "utf8");
      for (let i = 0; i < buf.length; i += 65536) req.emit("data", buf.subarray(i, i + 65536));
      req.emit("end");
    }
    if (r === "passed") done(true);
    setImmediate(() => { if (res.ended) done(false); });
  });
}

describe("fv2 bank-statement body parser (statements over Nest's 100 KB JSON default)", () => {
  const csv = `date,amount,description\n${Array.from({ length: 3000 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, "0")},${i + 1}.25,Synthetic transfer ${i}`).join("\n")}`;

  it("parses a ~100 KB+ statement on the preview and import routes (query string ignored)", async () => {
    assert.ok(csv.length > 100 * 1024, "bigger than the default limit");
    for (const p of ["/api/finance/v2/bank-statements/preview", "/api/finance/v2/bank-statements/import?x=1"]) {
      const { req, next } = await call(p, JSON.stringify({ csv, profileId: 3 }));
      assert.equal(next, true);
      assert.equal(req._body, true, "marked parsed, so the default parser skips it");
      assert.equal(req.body.csv, csv);
    }
  });

  it("covers the CSV limit the parser advertises, and refuses beyond it with 413", async () => {
    assert.ok(STATEMENT_BODY_LIMIT > MAX_CSV_BYTES * 1.2);
    const big = JSON.stringify({ csv: "x".repeat(STATEMENT_BODY_LIMIT + 1) });
    const { res, next } = await call("/api/finance/v2/bank-statements/preview", big);
    assert.equal(next, false);
    assert.equal(res.statusCode, 413);
  });

  it("leaves every other route, method and content type to the default parser", async () => {
    for (const [p, o] of [["/api/finance/v2/bank-accounts", {}], ["/api/finance/v2/bank-statements/preview", { method: "GET" }],
      ["/api/finance/v2/bank-statements/preview", { type: "text/plain" }], ["/api/payments", {}]] as const) {
      const { req, next } = await call(p, null, o as any);
      assert.equal(next, true);
      assert.equal(req._body, undefined, p);
    }
  });

  it("answers 400 on malformed JSON", async () => {
    const { res, next } = await call("/api/finance/v2/bank-statements/import", "{not json");
    assert.equal(next, false);
    assert.equal(res.statusCode, 400);
  });
});
