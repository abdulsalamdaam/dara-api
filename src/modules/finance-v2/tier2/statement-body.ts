/**
 * JSON body parser for the two bank-statement upload routes only.
 *
 * Nest's default JSON limit is 100 KB, but a statement carries its CSV text
 * (up to MAX_CSV_BYTES = 2 MB, 10,000 rows, statement-csv.ts): a 3,000-row
 * statement is ~180 KB and was refused with 413. main.ts mounts this before
 * Nest registers its own parser; it parses POST application/json on
 * `bank-statements/preview` and `bank-statements/import` up to 3 MB and marks
 * the request parsed (`req._body`), which body-parser honours. Every other
 * route keeps the 100 KB default.
 */
import { MAX_CSV_BYTES } from "./statement-csv";

/** The CSV limit plus room for JSON escaping and the other fields. */
export const STATEMENT_BODY_LIMIT = Math.ceil(MAX_CSV_BYTES * 1.5);

const PATHS = new Set(["/api/finance/v2/bank-statements/preview", "/api/finance/v2/bank-statements/import"]);

function reply(res: any, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ statusCode: status, message }));
}

/** Express middleware. Returns "passed" when it leaves the request to the next parser (for tests). */
export function fv2StatementBody(req: any, res: any, next: (err?: unknown) => void): "passed" | "reading" {
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  const type = String(req.headers?.["content-type"] ?? "");
  if (req.method !== "POST" || !PATHS.has(path) || !/^application\/json\b/i.test(type) || req._body) {
    next();
    return "passed";
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on("data", (c: Buffer) => {
    if (refused) return;
    size += c.length;
    if (size > STATEMENT_BODY_LIMIT) {
      refused = true;
      chunks.length = 0;
      reply(res, 413, "The statement is larger than 3 MB");
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (refused) return;
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      req.body = text.trim() ? JSON.parse(text) : {};
    } catch {
      reply(res, 400, "The request body is not valid JSON");
      return;
    }
    req._body = true;
    next();
  });
  req.on("error", (err: unknown) => {
    if (!refused) next(err);
  });
  return "reading";
}
