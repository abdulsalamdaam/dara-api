import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import type { Fv2Client } from "./db";

/**
 * An explicit `audit_logs` row, written in the caller's transaction. The audit
 * interceptor skips POST (audit.module.ts), so every Finance v2 action that is
 * a POST (close, reopen, lock, approve, reverse, VAT lock …) records itself
 * (DESIGN §8.1 "Audit").
 */
export async function auditRow(c: Pick<Fv2Client, "query">, scope: number, actorId: number, entity: string, entityId: string | number, path: string, method = "POST") {
  await c.query(
    `insert into audit_logs (owner_user_id, actor_user_id, action, entity, entity_id, method, path) values ($1, $2, 'update', $3, $4, $5, $6)`,
    [scope, actorId, entity, String(entityId), method, path],
  );
}

/** A settings event row (finance_settings_events), the per-account finance history. */
export async function settingsEvent(c: Pick<Fv2Client, "query">, scope: number, actorId: number, field: string, oldV: unknown, newV: unknown, reason: string) {
  await c.query(
    `insert into finance_settings_events (account_user_id, actor_user_id, field, old_value, new_value, reason) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [scope, actorId, field, JSON.stringify(oldV ?? null), JSON.stringify(newV ?? null), reason],
  );
}

export function requireReason(body: any, field = "reason"): string {
  const r = typeof body?.[field] === "string" ? body[field].trim() : "";
  if (r.length < 5 || r.length > 500) throw new BadRequestException({ error: "REASON_REQUIRED", message: `${field} must be 5 to 500 characters` });
  return r;
}

export const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isoDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !ISO_DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new BadRequestException({ error: "BAD_DATE", message: `${field} must be a valid YYYY-MM-DD date` });
  }
  return v;
}

/** A ledger DB trigger error → an HTTP error the client can act on. Anything else is rethrown. */
export function mapLedgerError(err: any): never {
  if (err instanceof HttpException) throw err;
  const msg = String(err?.message ?? "");
  const code = err?.code;
  if (/period closed/.test(msg)) throw new ConflictException({ error: "PERIOD_CLOSED", message: "The accounting period does not accept this entry" });
  if (/VAT period locked/.test(msg)) throw new ConflictException({ error: "VAT_LOCKED", message: "The VAT period is locked" });
  if (/is inactive/.test(msg)) throw new ConflictException({ error: "ACCOUNT_INACTIVE", message: msg.replace(/^fv2: /, "") });
  if (/group account/.test(msg)) throw new BadRequestException({ error: "ACCOUNT_GROUP", message: msg.replace(/^fv2: /, "") });
  if (/not in this chart/.test(msg)) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: "Account not found" });
  if (/unbalanced|at least 2 required/.test(msg)) throw new BadRequestException({ error: "UNBALANCED", message: msg.replace(/^fv2: /, "") });
  if (code === "23505" && /journal_entries_one_opening/.test(String(err?.constraint ?? msg))) {
    throw new ConflictException({ error: "OPENING_EXISTS", message: "An opening entry is already posted" });
  }
  if (err?.code === "PERIOD_CLOSED" || err?.name === "RuleError") {
    throw new ConflictException({ error: err.code ?? "POST_ERROR", message: msg });
  }
  throw err;
}
