import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

/**
 * Taqnyat (تقنيات, taqnyat.sa) SMS gateway — the product's SMS sender.
 *
 * Only three endpoints matter to us, all Bearer-authenticated against
 * https://api.taqnyat.sa:
 *   POST /v1/messages          send
 *   GET  /account/balance      credit + account status (no send, no cost)
 *   GET  /v1/messages/senders  the sender names approved for this account
 *
 * Two things about the payload that are easy to get wrong and fail silently-ish:
 *   - `recipients` must be international WITHOUT a leading + or 00
 *     (966501234567). Twilio wanted the opposite (+966…), so the normaliser
 *     below is not shared with the old one on purpose.
 *   - `sender` must be a name already approved on the account, and it is
 *     case-sensitive. A wrong one is a 400, not a silent drop — but the
 *     message text comes back in Arabic from the gateway, so it is logged.
 *
 * Unlike Twilio Verify this is a dumb pipe: it sends text and nothing else.
 * Generating, expiring and checking OTP codes is PhoneOtpService's job.
 */

const BASE_URL = (process.env.TAQNYAT_BASE_URL || "https://api.taqnyat.sa").replace(/\/$/, "");
/** Hard ceiling on a single gateway call, so a slow gateway can't hold the
 *  request past the proxy timeouts in front of the API. */
const TIMEOUT_MS = Number(process.env.TAQNYAT_TIMEOUT_MS || 10_000);

export interface TaqnyatSendResult {
  messageId?: number | string;
  cost?: number;
  currency?: string;
  accepted?: unknown;
  rejected?: unknown;
}

@Injectable()
export class TaqnyatService {
  private readonly log = new Logger(TaqnyatService.name);
  private get apiKey(): string { return process.env.TAQNYAT_API_KEY || ""; }
  private get sender(): string { return process.env.TAQNYAT_SENDER || ""; }

  /** Configured enough to send: a bearer token AND an approved sender name. */
  isConfigured(): boolean {
    return Boolean(this.apiKey && this.sender);
  }

  /**
   * Recipient format Taqnyat expects: digits only, country code first, no
   * plus and no leading zeros. Accepts the shapes Saudi numbers are stored in
   * across this database (+966…, 00966…, 05…, 5…).
   */
  normalizeRecipient(raw: string): string {
    let d = (raw || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("966")) return d;
    if (d.startsWith("0")) d = d.slice(1);
    // A bare 9-digit Saudi mobile (5XXXXXXXX) — the common stored form.
    if (d.length === 9 && d.startsWith("5")) return "966" + d;
    return d;
  }

  private async call<T>(path: string, init: RequestInit & { method: string }): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** Send one SMS. Throws on a rejected send — the caller must not report success. */
  async send(to: string, body: string): Promise<TaqnyatSendResult> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "خدمة الرسائل غير مُهيأة. Set TAQNYAT_API_KEY and TAQNYAT_SENDER.",
      );
    }
    const recipient = this.normalizeRecipient(to);
    const { status, json } = await this.call("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ recipients: [recipient], body, sender: this.sender }),
    });

    // 201 is the documented success. Anything else is a real failure: a 401 is
    // a bad token, a 400 usually an unapproved sender name or a malformed
    // number, and both must surface rather than look like a delivered code.
    if (status !== 201 && status !== 200) {
      this.log.error(`Taqnyat send failed: HTTP ${status} ${JSON.stringify(json)}`);
      if (status === 401) throw new ServiceUnavailableException("مفتاح خدمة الرسائل غير صالح.");
      throw new BadRequestException(json?.message || "تعذّر إرسال رمز التحقق");
    }
    // A 2xx can still reject the number (accepted: [], rejected: [966…]).
    const rejected = json?.rejected;
    const rejectedCount = Array.isArray(rejected) ? rejected.length : (typeof rejected === "string" && rejected.replace(/[[\]\s]/g, "") ? 1 : 0);
    if (rejectedCount > 0) {
      this.log.error(`Taqnyat rejected recipient: ${JSON.stringify(json)}`);
      throw new BadRequestException("رقم الجوال غير صالح لإرسال الرسائل");
    }
    this.log.log(`Taqnyat sent to ${recipient} (msg ${json?.messageId ?? "?"}, cost ${json?.cost ?? "?"} ${json?.currency ?? ""})`);
    return json ?? {};
  }

  /** Account status + remaining credit. Costs nothing; used by /health/sms. */
  async balance(): Promise<{ ok: boolean; status: number; accountStatus?: string; balance?: string; currency?: string; expiry?: string }> {
    if (!this.apiKey) return { ok: false, status: 0 };
    const { status, json } = await this.call("/account/balance", { method: "GET" });
    return {
      ok: status === 200,
      status,
      accountStatus: json?.accountStatus,
      balance: json?.balance,
      currency: json?.currency,
      expiry: json?.accountExpiryDate,
    };
  }

  /** Sender names approved on the account — the fix for a 400 on send. */
  async senders(): Promise<{ ok: boolean; status: number; senders: { senderName?: string; status?: string; destination?: string }[] }> {
    if (!this.apiKey) return { ok: false, status: 0, senders: [] };
    const { status, json } = await this.call("/v1/messages/senders", { method: "GET" });
    return { ok: status === 200, status, senders: Array.isArray(json?.senders) ? json.senders : [] };
  }
}
