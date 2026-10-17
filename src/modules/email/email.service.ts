import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { rolesTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { STAFF_ROLE_KEYS } from "../../common/permissions";
import { resolvePackage, isBillingCycle, parseCycle, CYCLE_LABEL_AR, type BillingCycle } from "../../common/packages";

/**
 * Public URL of the brand logo used in the email layout. Gmail strips
 * data: URIs and many corporate filters block inline images, so we
 * always reference a hosted PNG. Defaults to the web project's
 * `/logo.png`; override via env when the asset moves.
 */
/**
 * One place the brand's domain is written down. Everything else in this file
 * derives from it, so a domain move is a single edit (or a single env var)
 * rather than a hunt through email bodies — which is exactly how the previous
 * domain ended up hardcoded in a dozen places.
 */
const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.com";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

/** Shown to recipients as the contact address in email bodies. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || `info@${SITE_DOMAIN}`;

/**
 * Hard ceiling on a single Resend call. Must stay well under the proxy
 * timeouts in front of the API (Cloudflare cuts at 100s) so a slow provider
 * surfaces as a fast, logged failure instead of a gateway error on login.
 */
const EMAIL_SEND_TIMEOUT_MS = Number(process.env.EMAIL_SEND_TIMEOUT_MS || 10_000);

const EMAIL_LOGO_URL =
  process.env.EMAIL_LOGO_URL || `${SITE_URL}/brand/dara-lockup-email.png`;

/**
 * Tenant mobile-app download links. Default to the marketing site until the
 * store listings go live; override per-store via env when published.
 */
const APP_IOS_URL = process.env.APP_IOS_URL || SITE_URL;
const APP_ANDROID_URL = process.env.APP_ANDROID_URL || SITE_URL;

/** Portal base URL — used to build email-verification links. */
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || `https://app.${SITE_DOMAIN}`;
/** Where an approved user signs in — the portal itself, not the landing page (which only redirects there). */
const APP_LOGIN_URL = `${APP_PUBLIC_URL.replace(/\/$/, "")}/login`;
export function buildVerifyEmailLink(token: string): string {
  return `${APP_PUBLIC_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Optional override of the configured "from" address. */
  from?: string;
  /**
   * `true` only for genuine bulk/marketing mail (newsletters, campaigns). When
   * set, the message carries List-Unsubscribe headers. Transactional mail (OTP,
   * welcome, verification, receipts) MUST leave this false — those headers are
   * what make Gmail classify a message as bulk/"newsletter"/Promotions.
   */
  marketing?: boolean;
  /** Resend tag for categorising the send (e.g. "otp", "welcome"). */
  category?: string;
  /**
   * Files to attach. Resend takes base64 in the JSON body, so keep these small
   * — a subscription invoice PDF is ~50-200 KB, which is fine; anything in the
   * megabytes belongs behind a download link instead.
   */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface MaintenanceEmailPayload {
  id: number;
  unitLabel: string | null;
  description: string;
  priority: string | null;
  status: string | null;
  tenantName?: string | null;
  tenantPhone?: string | null;
  propertyName?: string | null;
}

export interface ContactEmailPayload {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string;
  source: string | null;
}

/**
 * A self-serve registration that has just landed in the admin portal's
 * pending queue. Everything an admin needs to triage it without opening the
 * portal — who signed up, what they asked for, and when.
 */
export interface AdminRegistrationEmailPayload {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** "individual" | "company" — the account type chosen at sign-up. */
  userType: string | null;
  /** The plan picked on the landing page, if any (nothing is assigned yet). */
  desiredPackagePlan?: string | null;
  desiredBillingCycle?: string | null;
  createdAt?: Date | string | null;
}

/**
 * Resend wrapper. We hit the REST API directly (same pattern as the Twilio
 * service) to avoid pulling in another SDK. Failures are logged but never
 * thrown to the caller — email is best-effort and must not block user flows
 * like registration or contact-form submissions.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private readonly apiKey = process.env.RESEND_API_KEY || "";
  private readonly from = process.env.RESEND_FROM || `Dara <hello@${SITE_DOMAIN}>`;
  private readonly adminEmail = process.env.ADMIN_NOTIFY_EMAIL || "";
  /**
   * Default Reply-To. Sending `noreply@`-style addresses tanks deliverability;
   * giving every email a real mailbox to reply to keeps spam filters happier.
   */
  private readonly replyTo = process.env.RESEND_REPLY_TO || `info@${SITE_DOMAIN}`;
  /**
   * One-click List-Unsubscribe (RFC 8058). Pleases Gmail's bulk-sender
   * policy and adds ~1 point on mail-tester. The URL must accept a POST
   * with no body and the mailto must route to a real inbox.
   */
  private readonly listUnsubscribeUrl = process.env.LIST_UNSUBSCRIBE_URL || `${SITE_URL}/email/unsubscribe`;
  private readonly listUnsubscribeMailto = process.env.LIST_UNSUBSCRIBE_MAILTO || `unsubscribe@${SITE_DOMAIN}`;

  /**
   * Read-only DB access, used solely to resolve "who are the platform admins"
   * for `sendAdminNewRegistration`. `DatabaseModule` is `@Global`, so this
   * needs no change to `EmailModule`. `db` is a lazy proxy (see
   * `db/src/index.ts`) — importing this file still opens no connection.
   */
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Low-level send. Returns true on 2xx, false otherwise. Never throws. */
  async send(input: SendEmailInput): Promise<boolean> {
    if (!this.isConfigured()) {
      this.log.warn("Resend not configured (RESEND_API_KEY missing); skipping email");
      return false;
    }
    try {
      // List-Unsubscribe is added ONLY to genuine bulk/marketing mail. On
      // transactional mail (OTP, welcome, verification) these headers make Gmail
      // file the message as bulk/"newsletter"/Promotions — so we omit them and
      // tag the send as transactional instead.
      const customHeaders: Record<string, string> = {};
      if (input.marketing) {
        customHeaders["List-Unsubscribe"] = `<mailto:${this.listUnsubscribeMailto}?subject=unsubscribe>, <${this.listUnsubscribeUrl}>`;
        customHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      const fromAddress = input.from || this.from;
      this.log.log(`Resend send → from=${fromAddress} to=${Array.isArray(input.to) ? input.to.join(",") : input.to} subject=${input.subject} category=${input.category ?? (input.marketing ? "marketing" : "transactional")}`);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        // Node's fetch has no default request timeout — only undici's 300s
        // headers timeout. Login AWAITS this send, so a slow Resend used to
        // hold the request open for minutes, past every proxy timeout in
        // front of us (Cloudflare 100s, Traefik) and tying up a DB pool slot
        // the whole time. Email is best-effort; 10s then give up.
        signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: Array.isArray(input.to) ? input.to : [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          reply_to: input.replyTo || this.replyTo,
          headers: customHeaders,
          attachments: input.attachments?.length
            ? input.attachments.map((a) => ({
                filename: a.filename,
                content: a.content.toString("base64"),
                content_type: a.contentType,
              }))
            : undefined,
          tags: [{ name: "category", value: input.category || (input.marketing ? "marketing" : "transactional") }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log.error(`Resend send failed: ${res.status} ${body}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.log.error(`Resend send threw: ${err?.message || err}`);
      return false;
    }
  }

  /* ── Templates ─────────────────────────────────────────────── */

  /**
   * One-time login code. Sent in both languages so the user sees both
   * variants regardless of which app locale they're on.
   */
  async sendLoginOtp(to: string, code: string, ttlMinutes: number): Promise<boolean> {
    if (!to) return false;
    const safeCode = escapeHtml(code);
    const html = layout(`
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">لإكمال تسجيل الدخول إلى حسابك، أدخل الرمز التالي:</p>
      <div style="margin:24px 0;text-align:center;">
        <div style="display:inline-block;font-family:'SFMono-Regular',Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#010f35;padding:14px 28px;background:#f1f5f9;border-radius:12px;border:1px solid #e2e8f0;">
          ${safeCode}
        </div>
      </div>
      <p style="margin:0 0 6px;color:#64748b;font-size:13px;">
        الرمز صالح لمدة ${minutesAr(ttlMinutes)}. إذا لم تطلب تسجيل الدخول، يمكنك تجاهل هذه الرسالة.
      </p>
    `);
    return this.send({
      to,
      subject: "رمز تسجيل الدخول إلى دارا",
      html,
      text: `لإكمال تسجيل الدخول إلى حسابك، أدخل الرمز التالي: ${code}\nالرمز صالح لمدة ${minutesAr(ttlMinutes)}. إذا لم تطلب تسجيل الدخول، يمكنك تجاهل هذه الرسالة.`,
      category: "otp_login",
    });
  }

  /**
   * Email-verification via a 6-digit OTP code (replaces the verification
   * link). The user types the code on the verify page to confirm ownership.
   */
  async sendVerifyOtp(to: string, name: string, code: string, ttlMinutes: number, isEmployee = false): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const safeCode = escapeHtml(code);
    const intro = isEmployee
      ? "تمت إضافتك إلى فريق العمل في حساب على منصة دارا. لتأكيد بريدك الإلكتروني وتفعيل دخولك، أدخل الرمز التالي في صفحة التحقق:"
      : "شكرًا لتسجيلك في دارا. لتأكيد بريدك الإلكتروني، أدخل الرمز التالي:";
    const ignore = isEmployee
      ? "إذا وصلتك هذه الدعوة بالخطأ، يمكنك تجاهل الرسالة."
      : "إذا لم تطلب إنشاء حساب، يمكنك تجاهل هذه الرسالة.";
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">${intro}</p>
      <div style="margin:24px 0;text-align:center;">
        <div style="display:inline-block;font-family:'SFMono-Regular',Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#010f35;padding:14px 28px;background:#f1f5f9;border-radius:12px;border:1px solid #e2e8f0;">
          ${safeCode}
        </div>
      </div>
      <p style="margin:0 0 6px;color:#64748b;font-size:13px;">
        الرمز صالح لمدة ${minutesAr(ttlMinutes)}. ${ignore}
      </p>
    `);
    return this.send({
      to,
      subject: isEmployee ? "تأكيد بريدك الإلكتروني لتفعيل دخولك إلى دارا" : "تأكيد بريدك الإلكتروني في دارا",
      html,
      text: `${greetingAr(name)}،\n${intro} ${code}\n\nالرمز صالح لمدة ${minutesAr(ttlMinutes)}. ${ignore}`,
    });
  }

  /**
   * Welcome email for a freshly-added tenant: a friendly greeting plus a
   * nudge to download the mobile app. Sent only when the landlord opts in
   * (the "send welcome" checkbox) and the tenant has an email on file.
   */
  async sendTenantWelcome(to: string, name: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">هلا بك في <strong>دارا</strong>.</p>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">تابع عقد إيجارك ومدفوعاتك، وقدّم طلبات الصيانة من تطبيق واحد يجمع كل ما تحتاجه.</p>
      <p style="margin:16px 0 0;color:#334155;font-weight:700;">حمّل تطبيق دارا:</p>
      ${appButtons()}
      <p style="margin:16px 0 0;color:#64748b;font-size:13px;">
        للمساعدة والدعم، تواصل معنا على: ${SUPPORT_EMAIL}
      </p>
    `);
    return this.send({
      to,
      subject: "هلا بك في دارا | عقدك ومدفوعاتك في مكان واحد",
      html,
      text: `${greetingAr(name)}،\nهلا بك في دارا.\nتابع عقد إيجارك ومدفوعاتك، وقدّم طلبات الصيانة من تطبيق واحد يجمع كل ما تحتاجه.\n\nحمّل تطبيق دارا: iOS ${APP_IOS_URL} | Android ${APP_ANDROID_URL}\n\nللمساعدة والدعم، تواصل معنا على: ${SUPPORT_EMAIL}`,
    });
  }

  /**
   * Reminder nudging a tenant to download the app (e.g. when the landlord
   * sees they still haven't installed it). No-op when `to` is empty.
   */
  async sendAppDownloadReminder(to: string, name: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <h2 style="color:#010f35;margin:0 0 12px;font-size:18px;">متابعة إيجارك من تطبيق دارا أسهل لك</h2>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">تابع عقدك ومدفوعاتك، وقدّم طلبات الصيانة بسهولة من جوالك، في أي وقت.</p>
      <p style="margin:16px 0 0;color:#334155;font-weight:700;">حمّل تطبيق دارا:</p>
      ${appButtons()}
    `);
    return this.send({
      to,
      subject: "حمّل تطبيق دارا لمتابعة تفاصيل إيجارك بضغطة زر!",
      html,
      text: `${greetingAr(name)}،\nمتابعة إيجارك من تطبيق دارا أسهل لك\nتابع عقدك ومدفوعاتك، وقدّم طلبات الصيانة بسهولة من جوالك، في أي وقت.\n\nحمّل تطبيق دارا: iOS ${APP_IOS_URL} | Android ${APP_ANDROID_URL}`,
    });
  }

  async sendWelcome(to: string, name: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">مرحباً ${safeName} 👋</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        شكراً لتسجيلك في <strong>دارا</strong>. تم استلام طلبك بنجاح، وسيقوم فريقنا بمراجعة الحساب وتفعيله خلال وقت قصير.
      </p>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        سنرسل لك بريداً آخر فور تفعيل الحساب لتتمكّن من الدخول وإدارة عقاراتك.
      </p>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        إذا لم تقم أنت بالتسجيل، يمكنك تجاهل هذه الرسالة.
      </p>
    `);
    return this.send({
      to,
      subject: "أهلاً بك في دارا",
      html,
      text: `مرحباً ${name}، شكراً لتسجيلك في دارا. سيقوم فريقنا بمراجعة حسابك وتفعيله قريباً.`,
      category: "welcome",
    });
  }

  /**
   * Acknowledgment email back to the tenant (or whoever raised the request).
   * Separate from sendMaintenanceCreated which targets the admin/landlord.
   * No-op when `to` is empty — tenants without an email on file simply don't
   * get notified (we do not throw).
   */
  /**
   * Email-verification link. Sent on registration and when an owner adds an
   * employee (and on resend). `isEmployee` tweaks the copy.
   */
  async sendVerifyEmail(to: string, name: string, token: string, isEmployee = false): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const link = buildVerifyEmailLink(token);
    const intro = isEmployee
      ? "تمت إضافتك إلى فريق العمل في حساب على منصة <strong>دارا</strong>. لتفعيل دخولك، أكّد بريدك الإلكتروني من هنا:"
      : "شكرًا لتسجيلك في <strong>دارا</strong>. لإكمال طلبك، أكّد بريدك الإلكتروني من هنا:";
    const ignore = isEmployee
      ? "إذا وصلتك هذه الدعوة بالخطأ، يمكنك تجاهل الرسالة."
      : "إذا لم تطلب إنشاء حساب، يمكنك تجاهل هذه الرسالة.";
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">${intro}</p>
      <p style="margin:12px 0 24px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">
          تأكيد البريد الإلكتروني
        </a>
      </p>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px;">يمكنك أيضًا نسخ الرابط التالي ولصقه في المتصفح:</p>
      <p style="margin:0 0 16px;word-break:break-all;"><a href="${link}" style="color:#042698;font-size:13px;">${link}</a></p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;">الرابط صالح لمدة 7 أيام. ${ignore}</p>
    `);
    return this.send({
      to,
      subject: isEmployee ? "تأكيد بريدك الإلكتروني لتفعيل دخولك إلى دارا" : "تأكيد بريدك الإلكتروني في دارا",
      html,
      text: `${greetingAr(name)}،\n${intro.replace(/<\/?strong>/g, "")}\n${link}\n\nالرابط صالح لمدة 7 أيام. ${ignore}`,
    });
  }

  async sendMaintenanceAcknowledgment(to: string, payload: MaintenanceEmailPayload): Promise<boolean> {
    if (!to) return false;
    const html = layout(`
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">سجّلنا طلب الصيانة برقم <strong>${payload.id}</strong>، وسنتواصل معك بخصوصه في أقرب وقت ممكن.</p>
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">بيانات طلبك</div>
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("الأولوية", priorityLabel(payload.priority))}
      ${row("حالة الطلب", maintenanceStatusLabel(payload.status))}
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">تفاصيل طلبك</div>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">هذه رسالة تلقائية لتأكيد استلام طلبك، وما تحتاج ترد عليها.</p>
    `);
    return this.send({
      to,
      subject: `وصلنا طلب الصيانة رقم ${payload.id}`,
      html,
      text: `سجّلنا طلب الصيانة برقم ${payload.id}، وسنتواصل معك بخصوصه في أقرب وقت ممكن.\n\nالوحدة: ${payload.unitLabel || "—"}\nالأولوية: ${priorityLabel(payload.priority)}\nحالة الطلب: ${maintenanceStatusLabel(payload.status)}\n\nتفاصيل طلبك:\n${payload.description}`,
    });
  }

  /**
   * Fires when an admin/landlord transitions a maintenance ticket to a new
   * status (e.g. open → in_progress → completed). Keeps the tenant in the
   * loop. No-op when `to` is empty (tenant without an email on file).
   */
  async sendMaintenanceStatusChanged(to: string, payload: MaintenanceEmailPayload & { previousStatus?: string | null }): Promise<boolean> {
    if (!to) return false;
    const newLabel = maintenanceStatusLabel(payload.status);
    const done = payload.status === "completed";
    const html = layout(`
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">حالة طلبك رقم <strong>${payload.id}</strong> صارت «${escapeHtml(newLabel)}».</p>
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">بيانات طلبك</div>
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("الأولوية", priorityLabel(payload.priority))}
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">تفاصيل طلبك</div>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      ${done ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;">نبشرك، الصيانة اكتملت. إذا عندك أي ملاحظات، يسعدنا تواصلك معنا.</p>` : ""}
    `);
    return this.send({
      to,
      subject: `تحديث بخصوص طلب الصيانة رقم ${payload.id} | ${newLabel}`,
      html,
      text: `حالة طلبك رقم ${payload.id} صارت «${newLabel}».\n\nالوحدة: ${payload.unitLabel || "—"}\nالأولوية: ${priorityLabel(payload.priority)}\n\nتفاصيل طلبك:\n${payload.description}${done ? "\n\nنبشرك، الصيانة اكتملت. إذا عندك أي ملاحظات، يسعدنا تواصلك معنا." : ""}`,
    });
  }

  /**
   * The tax invoice for a subscription payment, with the PDF attached.
   *
   * Sent once, from the activation path, right after the payment is confirmed.
   * Transactional — never `marketing`, or Gmail files a receipt in Promotions.
   */
  async sendSubscriptionInvoice(
    to: string,
    name: string,
    payload: {
      invoiceNumber: string;
      planLabel: string;
      cycle: BillingCycle;
      amount: number;
      currencyLabel: string;
      periodEnd: Date;
    },
    pdf: Buffer,
  ): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const number = escapeHtml(payload.invoiceNumber);
    const plan = escapeHtml(payload.planLabel);
    const cycleLabel = CYCLE_LABEL_AR[parseCycle(payload.cycle)];
    const amount = `${payload.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escapeHtml(payload.currencyLabel)}`;
    const until = payload.periodEnd.toLocaleDateString("en-GB").replace(/\//g, "/");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">فاتورة اشتراكك 🧾</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        ${greetingAr(safeName)}،<br/>
        استلمنا دفعة اشتراكك في <strong>دارا</strong> بنجاح، وتجد الفاتورة الضريبية مرفقة بهذه الرسالة بصيغة PDF.
      </p>
      ${en("We've received your Dara subscription payment. Your tax invoice is attached as a PDF.")}
      <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;color:#334155;">
        <tr><td style="padding:8px 0;color:#64748b;">رقم الفاتورة</td><td style="padding:8px 0;text-align:left;font-weight:700;color:#010f35;">${number}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;">الباقة</td><td style="padding:8px 0;text-align:left;font-weight:700;color:#010f35;">${plan} — ${cycleLabel}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;">المبلغ المدفوع</td><td style="padding:8px 0;text-align:left;font-weight:700;color:#010f35;">${amount}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;">الاشتراك ساري حتى</td><td style="padding:8px 0;text-align:left;font-weight:700;color:#010f35;">${until}</td></tr>
      </table>
      <div style="margin:24px 0;text-align:center;">
        <a href="${APP_PUBLIC_URL.replace(/\/$/, "")}/dashboard" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">
          فتح لوحة التحكم · Open dashboard
        </a>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        يمكنك تنزيل هذه الفاتورة وفواتيرك السابقة في أي وقت من الإعدادات ← الاشتراك والفوترة.
        لأي استفسار عن الفوترة راسلنا على ${SUPPORT_EMAIL}.
      </p>
      ${en(`Download this and past invoices anytime from Settings → Subscription &amp; Billing. Billing questions: ${SUPPORT_EMAIL}.`, "muted")}
    `);
    return this.send({
      to,
      subject: `فاتورة اشتراك دارا · Dara subscription invoice ${payload.invoiceNumber}`,
      html,
      text: `استلمنا دفعة اشتراكك في دارا. رقم الفاتورة ${payload.invoiceNumber} — ${payload.planLabel} (${cycleLabel}) — ${amount}. الفاتورة الضريبية مرفقة بصيغة PDF.\n\nWe've received your Dara subscription payment (invoice ${payload.invoiceNumber}). Your tax invoice is attached as a PDF.`,
      category: "subscription-invoice",
      attachments: [{ filename: `${payload.invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }

  /**
   * Sent to the user once an admin approves their pending registration.
   */
  async sendRegistrationApproved(to: string, name: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <h2 style="color:#010f35;margin:0 0 12px;font-size:18px;">حسابك جاهز لإدارة عقاراتك</h2>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">فعّلنا حسابك في <strong>دارا</strong>. تقدر الحين تسجّل الدخول وتبدأ تدير عقاراتك بأدوات متكاملة في مكان واحد.</p>
      <div style="margin:24px 0;text-align:center;">
        <a href="${APP_LOGIN_URL}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">
          تسجيل الدخول
        </a>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">للمساعدة في الدخول إلى حسابك، تواصل معنا على: ${SUPPORT_EMAIL}</p>
    `);
    return this.send({
      to,
      subject: "تم تفعيل حسابك في دارا",
      html,
      text: `${greetingAr(name)}،\nحسابك جاهز لإدارة عقاراتك\nفعّلنا حسابك في دارا. تقدر الحين تسجّل الدخول وتبدأ تدير عقاراتك بأدوات متكاملة في مكان واحد.\n\nتسجيل الدخول: ${APP_LOGIN_URL}\n\nللمساعدة في الدخول إلى حسابك، تواصل معنا على: ${SUPPORT_EMAIL}`,
    });
  }

  /**
   * Sent to the user when an admin rejects their pending registration.
   * Optional `reason` is appended to the body when present.
   */
  async sendRegistrationRejected(to: string, name: string, reason?: string | null): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const safeReason = reason ? escapeHtml(reason) : "";
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">نعتذر منك، ما تمكّنا من قبول طلب تسجيلك في <strong>دارا</strong> حاليًا.</p>
      ${safeReason
        ? `<div style="margin-top:16px;padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
             <div style="color:#991b1b;font-size:12px;margin-bottom:6px;">سبب عدم القبول</div>
             <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${safeReason}</div>
           </div>`
        : ""}
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">إذا عندك أي استفسار عن طلبك، يسعدنا تواصلك معنا على: ${SUPPORT_EMAIL}</p>
    `);
    return this.send({
      to,
      subject: "تحديث بخصوص طلب تسجيلك في دارا",
      html,
      text: `${greetingAr(name)}،\nنعتذر منك، ما تمكّنا من قبول طلب تسجيلك في دارا حاليًا.${reason ? `\nسبب عدم القبول: ${reason}` : ""}\n\nإذا عندك أي استفسار عن طلبك، يسعدنا تواصلك معنا على: ${SUPPORT_EMAIL}`,
    });
  }

  /**
   * Acknowledgment back to the person who submitted the public contact form.
   * Separate from sendContactReceived which fires off to the admin/team.
   */
  async sendContactAck(to: string, payload: ContactEmailPayload): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(payload.name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">شكرًا لتواصلك مع <strong>دارا</strong>. استلمنا رسالتك برقم <strong>${payload.id}</strong>، وسيرد عليك فريقنا في أقرب وقت ممكن.</p>
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">نسخة من رسالتك:</div>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">لإضافة أي تفاصيل، تقدر ترد على هذا البريد مباشرة.</p>
    `);
    return this.send({
      to,
      subject: `استلمنا رسالتك | رقم ${payload.id}`,
      html,
      text: `${greetingAr(payload.name || "")}،\nشكرًا لتواصلك مع دارا. استلمنا رسالتك برقم ${payload.id}، وسيرد عليك فريقنا في أقرب وقت ممكن.\n\nنسخة من رسالتك:\n${payload.description}\n\nلإضافة أي تفاصيل، تقدر ترد على هذا البريد مباشرة.`,
    });
  }

  async sendMaintenanceCreated(payload: MaintenanceEmailPayload, to?: string): Promise<boolean> {
    const recipient = to || this.adminEmail;
    if (!recipient) {
      this.log.warn("sendMaintenanceCreated: no recipient (set ADMIN_NOTIFY_EMAIL)");
      return false;
    }
    const html = layout(`
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">سجّلنا طلب صيانة بالبيانات التالية:</p>
      ${row("رقم الطلب", String(payload.id))}
      ${row("العقار", payload.propertyName || "—")}
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("المستأجر", payload.tenantName || "—")}
      ${row("رقم التواصل", payload.tenantPhone || "—")}
      ${row("الأولوية", priorityLabel(payload.priority))}
      ${row("حالة الطلب", maintenanceStatusLabel(payload.status))}
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">تفاصيل الطلب:</div>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
    `);
    return this.send({
      to: recipient,
      subject: `وصلنا طلب صيانة جديد رقم ${payload.id} | ${payload.unitLabel || "—"}`,
      html,
    });
  }

  async sendContactReceived(payload: ContactEmailPayload, to?: string): Promise<boolean> {
    const recipient = to || this.adminEmail;
    if (!recipient) {
      this.log.warn("sendContactReceived: no recipient (set ADMIN_NOTIFY_EMAIL)");
      return false;
    }
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">وصلتك رسالة عبر نموذج التواصل</h1>
      ${row("رقم الرسالة", String(payload.id))}
      ${row("الاسم", payload.name || "—")}
      ${row("البريد الإلكتروني", payload.email || "—")}
      ${row("رقم الجوال", payload.phone || "—")}
      ${row("مصدر الرسالة", payload.source || "—")}
      <div style="margin:20px 0 8px;color:#010f35;font-size:14px;font-weight:700;">نص الرسالة</div>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
    `);
    return this.send({
      to: recipient,
      subject: `رسالة جديدة من ${payload.name || "—"} | رقم ${payload.id}`,
      html,
      replyTo: payload.email || undefined,
    });
  }

  /**
   * Who gets told that a registration is waiting: every active platform
   * admin, read from the database by ROLE rather than hardcoded, so adding
   * or removing an admin needs no deploy.
   *
   * There is no `users.role` column — the role key lives on `roles` and is
   * reached through `users.role_id`. `companyId IS NULL` restricts the match
   * to the system-wide presets: role keys are unique per (key, companyId),
   * so a company-scoped custom role could otherwise be called "admin" and
   * quietly join this list.
   *
   * `ADMIN_REGISTRATION_NOTIFY_EMAILS` (comma-separated) replaces the lookup
   * entirely — the escape hatch for staging, whose admin rows are a copy of
   * production's and therefore real people. Deliberately NOT
   * `ADMIN_NOTIFY_EMAIL`: that is one global address for maintenance and
   * contact-form mail, a different audience from the platform's own admins.
   */
  async adminRegistrationRecipients(): Promise<string[]> {
    const override = process.env.ADMIN_REGISTRATION_NOTIFY_EMAILS || "";
    if (override.trim()) return normaliseRecipients(override.split(","));
    try {
      const rows = await this.db
        .select({ email: usersTable.email })
        .from(usersTable)
        .innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(and(
          inArray(rolesTable.key, STAFF_ROLE_KEYS as unknown as string[]),
          isNull(rolesTable.companyId),
          isNull(rolesTable.deletedAt),
          eq(usersTable.isActive, true),
          isNull(usersTable.deletedAt),
        ));
      return normaliseRecipients(rows.map((r) => r.email));
    } catch (err: any) {
      // Never throw at the caller: this runs fire-and-forget off the back of
      // a registration, and a DB hiccup here must not surface there.
      this.log.error(`adminRegistrationRecipients failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Fires when a self-serve registration lands in the admin portal's pending
   * queue. Before this, nothing told anyone — an admin found out by opening
   * the portal and noticing the badge.
   *
   * Recipients default to every active platform admin
   * (`adminRegistrationRecipients`); pass `to` to target the send explicitly.
   * Like every other notification here it never throws — see `send`.
   */
  async sendAdminNewRegistration(payload: AdminRegistrationEmailPayload, to?: string[]): Promise<boolean> {
    const recipients = to?.length ? normaliseRecipients(to) : await this.adminRegistrationRecipients();
    if (!recipients.length) {
      this.log.warn(
        "sendAdminNewRegistration: no recipient — no active platform admin has an email "
        + "(and ADMIN_REGISTRATION_NOTIFY_EMAILS is unset); skipping",
      );
      return false;
    }
    const name = payload.name || "—";
    const typeLabel = payload.userType === "company" ? "منشأة" : payload.userType === "individual" ? "فرد" : "—";
    const planLabel = payload.desiredPackagePlan
      ? `${resolvePackage(payload.desiredPackagePlan).labelAr} (${payload.desiredPackagePlan})`
      : "لم يختر باقة";
    const cycleLabel = isBillingCycle(payload.desiredBillingCycle) ? CYCLE_LABEL_AR[payload.desiredBillingCycle] : "—";
    const when = riyadhTimestamp(payload.createdAt);
    const link = `${APP_PUBLIC_URL.replace(/\/$/, "")}/admin`;
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:20px;">طلب تسجيل جديد بانتظار المراجعة #${payload.id}</h1>
      <p style="margin:0 0 16px;color:#334155;line-height:1.7;">
        وصل طلب تسجيل جديد إلى <strong>دارا</strong>، وهو الآن في قائمة الطلبات المعلّقة بانتظار المراجعة والتفعيل.
      </p>
      ${row("الاسم", name)}
      ${row("البريد الإلكتروني", payload.email || "—")}
      ${row("الجوال", payload.phone || "—")}
      ${row("نوع الحساب", typeLabel)}
      ${row("الباقة المطلوبة", planLabel)}
      ${row("دورة الفوترة", cycleLabel)}
      ${row("تاريخ الطلب", `${when} (بتوقيت الرياض)`)}
      <div style="margin-top:24px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;font-size:14px;">مراجعة طلبات التسجيل</a>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        رسالة تلقائية إلى فريق دارا عند وصول كل طلب تسجيل جديد. يمكنك الرد على هذا البريد للتواصل مع مقدّم الطلب مباشرة.
      </p>
    `);
    return this.send({
      to: recipients,
      subject: `طلب تسجيل جديد #${payload.id} — ${name}`,
      html,
      text: [
        `طلب تسجيل جديد بانتظار المراجعة #${payload.id}`,
        `الاسم: ${name}`,
        `البريد الإلكتروني: ${payload.email || "—"}`,
        `الجوال: ${payload.phone || "—"}`,
        `نوع الحساب: ${typeLabel}`,
        `الباقة المطلوبة: ${planLabel}`,
        `دورة الفوترة: ${cycleLabel}`,
        `تاريخ الطلب: ${when} (بتوقيت الرياض)`,
        `مراجعة الطلبات: ${link}`,
      ].join("\n"),
      // Lets an admin reply straight to the person who registered, the same
      // way sendContactReceived does for the contact form.
      replyTo: payload.email || undefined,
      category: "admin_new_registration",
    });
  }

  /** Notify a customer that the support team replied to their ticket. */
  async sendSupportReply(to: string, name: string, ticketId: number, message: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const link = `${APP_PUBLIC_URL.replace(/\/$/, "")}/dashboard/settings?section=support`;
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">${greetingAr(safeName)}،</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">ردّ فريق الدعم على طلبك رقم <strong>${ticketId}</strong>:</p>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(message)}</div>
      </div>
      <p style="margin:20px 0 12px;color:#334155;line-height:1.7;">تقدر تطّلع على المحادثة وترد من هنا:</p>
      <div style="text-align:center;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">عرض المحادثة والرد</a>
      </div>
    `);
    return this.send({
      to,
      subject: `وصلك رد على طلب الدعم رقم ${ticketId}`,
      html,
      text: `${greetingAr(name)}،\nردّ فريق الدعم على طلبك رقم ${ticketId}:\n\n${message}\n\nتقدر تطّلع على المحادثة وترد من هنا: ${link}`,
    });
  }
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Normalise a set of addresses into a `to:` list — trim, lowercase, drop
 * blanks, drop duplicates. Order is preserved so the same input always logs
 * the same line.
 */
function normaliseRecipients(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = String(value ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * `YYYY-MM-DD HH:mm` in Riyadh time. Deliberately not `toLocaleString("ar-SA")`
 * — that renders a Hijri date, which is not what an admin is reconciling a
 * signup against. Falls back to "—" on an unparseable value.
 */
function riyadhTimestamp(value: Date | string | null | undefined): string {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * An English paragraph inside the RTL layout. `dir="ltr"` keeps trailing
 * punctuation and Latin runs in the right order; `tone` matches the muted /
 * faint footnote styles used for the Arabic lines it sits under. Trusted
 * template HTML only — escape any user value before passing it in.
 */
function en(html: string, tone: "body" | "muted" | "faint" = "body"): string {
  const style = tone === "muted" ? "margin:0 0 6px;color:#64748b;font-size:13px;"
    : tone === "faint" ? "margin:4px 0 0;color:#94a3b8;font-size:12px;"
    : "margin:0 0 12px;color:#334155;line-height:1.7;";
  return `<p dir="ltr" lang="en" style="${style}text-align:left;">${html}</p>`;
}

/** "يا هلا فلان", or just "يا هلا" when the name is blank (no dangling space). */
function greetingAr(name: string): string {
  const n = String(name ?? "").trim();
  return n ? `يا هلا ${n}` : "يا هلا";
}

/** Arabic count agreement for minutes: دقيقة واحدة / دقيقتين / 3–10 دقائق / 11+ دقيقة. */
function minutesAr(n: number): string {
  if (n === 1) return "دقيقة واحدة";
  if (n === 2) return "دقيقتين";
  if (n >= 3 && n <= 10) return `${n} دقائق`;
  return `${n} دقيقة`;
}


/** Same wording as the portal (dara-web `maintenance.*`), so the email matches the screen. */
const PRIORITY_AR: Record<string, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية", urgent: "عاجلة" };
const MAINTENANCE_STATUS_AR: Record<string, string> = {
  open:             "جديد",
  in_progress:      "قيد التنفيذ",
  pending_approval: "بانتظار الموافقة",
  completed:        "مكتمل",
  cancelled:        "ملغى",
};

/** The raw enum used to reach the recipient as "medium" / "open"; show the Arabic label instead. */
function priorityLabel(value: string | null | undefined): string {
  const v = String(value || "medium");
  return PRIORITY_AR[v] || v;
}

function maintenanceStatusLabel(value: string | null | undefined): string {
  const v = String(value || "open");
  return MAINTENANCE_STATUS_AR[v] || v;
}

/** Two app-store call-to-action buttons used in tenant-facing emails. */
function appButtons(): string {
  return `<div style="margin:24px 0;text-align:center;">
    <a href="${APP_IOS_URL}" style="display:inline-block;margin:4px 6px;background:#010f35;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;font-size:14px;">App Store · آب ستور</a>
    <a href="${APP_ANDROID_URL}" style="display:inline-block;margin:4px 6px;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;font-size:14px;">Google Play · جوجل بلاي</a>
  </div>`;
}

function row(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;">
    <span style="color:#64748b;font-size:13px;">${escapeHtml(label)}</span>
    <span style="color:#010f35;font-weight:500;">${escapeHtml(value)}</span>
  </div>`;
}

function layout(inner: string): string {
  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>دارا · Dara</title>
</head>
<body style="margin:0;padding:32px 16px;background:#eef2f7;font-family:-apple-system,'Segoe UI',Tahoma,Arial,'IBM Plex Sans Arabic',sans-serif;color:#010f35;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
    <!-- Logo header — soft brand-blue gradient banner -->
    <tr>
      <td style="background:linear-gradient(135deg,#eaf9ff 0%,#dbe4ea 100%);border-radius:16px 16px 0 0;padding:28px 24px;text-align:center;border:1px solid #e2e8f0;border-bottom:0;">
        <img src="${EMAIL_LOGO_URL}" alt="دارا · Dara" width="160" height="74" style="display:inline-block;height:auto;max-width:160px;border:0;outline:none;text-decoration:none;">
      </td>
    </tr>
    <!-- Main content card -->
    <tr>
      <td style="background:#ffffff;border-radius:0 0 16px 16px;border:1px solid #e2e8f0;border-top:0;padding:32px;line-height:1.65;">
        ${inner}
      </td>
    </tr>
    <!-- Footer -->
    <tr>
      <td style="padding:20px 8px 0;text-align:center;color:#94a3b8;font-size:12px;">
        <div style="margin-bottom:6px;">© ${new Date().getFullYear()} دارا · Dara — منصة إدارة العقارات</div>
        <div><a href="${SITE_URL}" style="color:#94a3b8;text-decoration:none;">${SITE_DOMAIN}</a></div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
