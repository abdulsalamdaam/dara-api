import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { phoneOtpTokensTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { TaqnyatService } from "./taqnyat.service";

/**
 * Phone-OTP for the mobile app's two login paths (tenant and landlord).
 *
 * Taqnyat sends text; everything about the code itself lives here, mirroring
 * the email-OTP flow so the two login paths behave identically:
 *
 *   - 4 digits (the SMS is short and the code is typed on a phone keypad),
 *     stored as a bcrypt hash and never in plaintext
 *   - 10-minute expiry, single use, 5 wrong attempts and the row is burned
 *   - a 60-second resend cooldown enforced in the DB, so a restart can't
 *     reset it and a loop can't spend the SMS balance
 *   - the code is bound to (phone, purpose), so a tenant code cannot be
 *     replayed against the landlord login
 *
 * Dev bypass: SMS_DEV_BYPASS=true (or the legacy TWILIO_DEV_BYPASS) accepts a
 * fixed code and sends nothing, for staging QA. Never enable it in production —
 * these flows are a full login, so a bypass here is an authentication bypass.
 */

export type OtpPurpose = "tenant" | "user";

export const PHONE_OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
export const DEV_BYPASS_CODE = "1234";

export function smsBypassEnabled(): boolean {
  return process.env.SMS_DEV_BYPASS === "true" || process.env.TWILIO_DEV_BYPASS === "true";
}

@Injectable()
export class PhoneOtpService {
  private readonly log = new Logger(PhoneOtpService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly sms: TaqnyatService,
  ) {}

  /** E.164 (+9665XXXXXXXX) — the form stored on the token row. */
  normalizePhone(raw: string): string {
    const digits = this.sms.normalizeRecipient(raw);
    return digits ? `+${digits}` : "";
  }

  private message(code: string): string {
    // Kept to one short line: Arabic body + the code on its own, so it reads
    // well in a notification preview and stays inside a single SMS segment.
    return `رمز الدخول إلى دارا: ${code}\nصالح لمدة ${PHONE_OTP_TTL_MIN} دقائق. لا تشاركه مع أحد.`;
  }

  /**
   * Issue and send a code. Returns quietly (without sending) when the caller
   * has decided the number should get a generic response — the caller owns
   * "does this number exist", this owns "send a code".
   */
  async start(rawPhone: string, purpose: OtpPurpose, ip?: string): Promise<void> {
    const phone = this.normalizePhone(rawPhone);
    if (!phone) throw new BadRequestException("رقم الجوال غير صالح");

    if (smsBypassEnabled()) {
      this.log.warn(`[SMS_DEV_BYPASS] ${purpose} OTP for ${phone} — nothing sent, accept ${DEV_BYPASS_CODE}`);
      return;
    }

    // Resend cooldown, enforced against the last row rather than in memory.
    const [recent] = await this.db
      .select({ createdAt: phoneOtpTokensTable.createdAt })
      .from(phoneOtpTokensTable)
      .where(and(
        eq(phoneOtpTokensTable.phone, phone),
        eq(phoneOtpTokensTable.purpose, purpose),
        gt(phoneOtpTokensTable.createdAt, new Date(Date.now() - RESEND_COOLDOWN_SEC * 1000)),
      ))
      .orderBy(desc(phoneOtpTokensTable.createdAt))
      .limit(1);
    if (recent) {
      const waitSec = Math.max(1, RESEND_COOLDOWN_SEC - Math.floor((Date.now() - new Date(recent.createdAt).getTime()) / 1000));
      throw new BadRequestException({
        code: "OTP_COOLDOWN",
        message: `انتظر ${waitSec} ثانية قبل طلب رمز جديد.`,
        retryAfterSeconds: waitSec,
      });
    }

    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    const codeHash = await bcrypt.hash(code, 8);

    // Send FIRST, store second: a stored code the user never received is a
    // dead end they can only escape by waiting out the cooldown.
    await this.sms.send(phone, this.message(code));

    await this.db.insert(phoneOtpTokensTable).values({
      phone,
      purpose,
      codeHash,
      expiresAt: new Date(Date.now() + PHONE_OTP_TTL_MIN * 60_000),
      ip: ip ?? null,
    });
  }

  /**
   * Check a code and consume it. Returns false for wrong/expired/exhausted —
   * the caller turns that into its own 401 so the message matches its flow.
   */
  async check(rawPhone: string, code: string, purpose: OtpPurpose): Promise<boolean> {
    const phone = this.normalizePhone(rawPhone);
    const entered = (code || "").trim();
    if (!phone || !entered) return false;

    if (smsBypassEnabled()) return entered === DEV_BYPASS_CODE;

    const [token] = await this.db
      .select()
      .from(phoneOtpTokensTable)
      .where(and(
        eq(phoneOtpTokensTable.phone, phone),
        eq(phoneOtpTokensTable.purpose, purpose),
        gt(phoneOtpTokensTable.expiresAt, new Date()),
        isNull(phoneOtpTokensTable.consumedAt),
      ))
      .orderBy(desc(phoneOtpTokensTable.createdAt))
      .limit(1);
    if (!token) return false;

    if ((token.attempts ?? 0) >= MAX_ATTEMPTS) {
      // Burn it rather than leaving an exhausted row to be guessed at.
      await this.db.update(phoneOtpTokensTable)
        .set({ consumedAt: new Date() })
        .where(eq(phoneOtpTokensTable.id, token.id));
      return false;
    }

    const ok = await bcrypt.compare(entered, token.codeHash);
    if (!ok) {
      await this.db.update(phoneOtpTokensTable)
        .set({ attempts: sql`${phoneOtpTokensTable.attempts} + 1` })
        .where(eq(phoneOtpTokensTable.id, token.id));
      return false;
    }

    await this.db.update(phoneOtpTokensTable)
      .set({ consumedAt: new Date() })
      .where(eq(phoneOtpTokensTable.id, token.id));
    return true;
  }
}
