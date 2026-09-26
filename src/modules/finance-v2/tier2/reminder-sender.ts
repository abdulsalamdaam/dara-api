/**
 * Rent reminder senders (DESIGN §8.3 b). BUILT DISABLED.
 *
 * `ReminderSender` is the seam a real sender would plug into later, as a
 * separate, reviewed change. The ONLY binding registered today is
 * `DryRunReminderSender`: it writes a `reminder_log` row with
 * status = 'dry_run' and a HASHED recipient, and never calls Taqnyat, Expo
 * push, email or any network API. This file deliberately imports nothing from
 * the SMS, push or mail modules (a spec asserts it).
 *
 * Hard rule 5: even a future real sender, in any non-production environment,
 * must refuse every recipient not in REMINDER_RECIPIENT_ALLOWLIST (the
 * account holder only) — `recipientAllowed` is that check.
 */
import { createHash } from "node:crypto";

export const REMINDER_SENDER = Symbol("FV2_REMINDER_SENDER");

export type ReminderChannel = "sms" | "push";

export interface ReminderMessage {
  userId: number;
  paymentId: number;
  offsetDays: number;
  channel: ReminderChannel;
  /** Phone (sms) or push token; never stored in clear. */
  recipient: string;
  body: string;
}

export interface ReminderSendResult {
  status: "dry_run" | "sent" | "skipped" | "failed";
  /** False when this (installment, offset, channel) was already logged. */
  logged: boolean;
}

export interface ReminderSender {
  readonly kind: "dry_run";
  send(q: { query: (t: string, p?: unknown[]) => Promise<{ rowCount?: number | null }> }, m: ReminderMessage): Promise<ReminderSendResult>;
}

export const hashRecipient = (userId: number, channel: string, recipient: string): string =>
  createHash("sha256").update(`fv2-reminder|${userId}|${channel}|${recipient.trim()}`).digest("hex");

/** Writes the log row and nothing else. The recipient is hashed; the message body is not stored. */
export class DryRunReminderSender implements ReminderSender {
  readonly kind = "dry_run" as const;

  async send(q: { query: (t: string, p?: unknown[]) => Promise<{ rowCount?: number | null }> }, m: ReminderMessage): Promise<ReminderSendResult> {
    const r = await q.query(
      `insert into reminder_log (user_id, payment_id, offset_days, channel, status, recipient_hash)
       values ($1, $2, $3, $4, 'dry_run', $5)
       on conflict (payment_id, offset_days, channel) where status = 'dry_run' do nothing`,
      [m.userId, m.paymentId, m.offsetDays, m.channel, hashRecipient(m.userId, m.channel, m.recipient)],
    );
    return { status: "dry_run", logged: (r.rowCount ?? 0) > 0 };
  }
}

/**
 * The non-production recipient guard a real sender must apply: unless the
 * deployment explicitly declares itself production for reminders
 * (FINANCE_REMINDERS_PRODUCTION=1, set nowhere — staging also runs with
 * NODE_ENV=production, so NODE_ENV is NOT trusted), only addresses/numbers
 * listed in REMINDER_RECIPIENT_ALLOWLIST (comma-separated) may ever receive a
 * message; an empty list allows nobody.
 */
export function recipientAllowed(recipient: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FINANCE_REMINDERS_PRODUCTION === "1") return true;
  const list = String(env.REMINDER_RECIPIENT_ALLOWLIST ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.includes(recipient.trim().toLowerCase());
}

/** Gate 1: the environment switch. Set NOWHERE (staging and production leave it unset). */
export const envGateOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.FINANCE_REMINDERS_ENABLED === "1";
