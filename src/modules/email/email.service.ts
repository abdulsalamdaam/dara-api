import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { rolesTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { STAFF_ROLE_KEYS } from "../../common/permissions";
import { resolvePackage } from "../../common/packages";

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
const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.net";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

/** Shown to recipients as the contact address in email bodies. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || `hello@${SITE_DOMAIN}`;

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
  private readonly replyTo = process.env.RESEND_REPLY_TO || `hello@${SITE_DOMAIN}`;
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">رمز الدخول · Login code</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        استخدم الرمز التالي لإكمال تسجيل الدخول. صالح لمدة ${ttlMinutes} دقيقة.<br/>
        Use the code below to finish signing in. Valid for ${ttlMinutes} minutes.
      </p>
      <div style="margin:24px 0;text-align:center;">
        <div style="display:inline-block;font-family:'SFMono-Regular',Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#010f35;padding:14px 28px;background:#f1f5f9;border-radius:12px;border:1px solid #e2e8f0;">
          ${safeCode}
        </div>
      </div>
      <p style="margin:0 0 6px;color:#64748b;font-size:13px;">
        إذا لم تطلب هذا الرمز يمكنك تجاهل هذه الرسالة.<br/>
        If you didn't request this code, ignore this email.
      </p>
    `);
    return this.send({
      to,
      subject: `رمز الدخول · Dara login code: ${code}`,
      html,
      text: `Your Dara login code: ${code}\nValid for ${ttlMinutes} minutes.`,
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
      ? "تمت إضافتك كموظف. لتفعيل دخولك، أدخل رمز التأكيد التالي في صفحة التحقق."
      : "شكراً لتسجيلك في دارا. لتأكيد بريدك الإلكتروني، أدخل رمز التحقق التالي.";
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">مرحباً ${safeName} 👋</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        ${intro}<br/>
        Enter the verification code below to confirm your email. Valid for ${ttlMinutes} minutes.
      </p>
      <div style="margin:24px 0;text-align:center;">
        <div style="display:inline-block;font-family:'SFMono-Regular',Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#010f35;padding:14px 28px;background:#f1f5f9;border-radius:12px;border:1px solid #e2e8f0;">
          ${safeCode}
        </div>
      </div>
      <p style="margin:0 0 6px;color:#64748b;font-size:13px;">
        رمز التأكيد صالح لمدة ${ttlMinutes} دقيقة. إذا لم تطلب هذا، تجاهل الرسالة.<br/>
        If you didn't request this, you can ignore this email.
      </p>
    `);
    return this.send({
      to,
      subject: `رمز تأكيد البريد · Dara verification code: ${code}`,
      html,
      text: `مرحباً ${name}، رمز تأكيد بريدك في دارا: ${code} (صالح ${ttlMinutes} دقيقة).`,
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">مرحباً ${safeName} 👋</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        يسعدنا انضمامك إلى <strong>دارا</strong>. لمتابعة عقد إيجارك ومدفوعاتك وتقديم طلبات الصيانة بسهولة، حمّل تطبيق دارا على جوالك.
      </p>
      <p style="margin:0 0 4px;color:#334155;line-height:1.7;">
        Welcome aboard! Download the Dara app to follow your lease, payments and maintenance requests on the go.
      </p>
      ${appButtons()}
      <p style="margin:16px 0 0;color:#64748b;font-size:13px;">
        إذا واجهت أي مشكلة لا تتردد في التواصل معنا على ${SUPPORT_EMAIL}.
      </p>
    `);
    return this.send({
      to,
      subject: "أهلاً بك في دارا · Welcome to Dara",
      html,
      text: `مرحباً ${name}، يسعدنا انضمامك إلى دارا. حمّل التطبيق: iOS ${APP_IOS_URL} | Android ${APP_ANDROID_URL}`,
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">حمّل تطبيق دارا 📱</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        مرحباً ${safeName}، هذا تذكير ودّي بتحميل تطبيق <strong>دارا</strong>. عبر التطبيق يمكنك متابعة عقدك ومدفوعاتك وتقديم طلبات الصيانة في أي وقت.
      </p>
      <p style="margin:0 0 4px;color:#334155;line-height:1.7;">
        Hi ${safeName}, a friendly reminder to download the Dara app to manage your lease, payments and maintenance requests anytime.
      </p>
      ${appButtons()}
    `);
    return this.send({
      to,
      subject: "تذكير بتحميل تطبيق دارا · Get the Dara app",
      html,
      text: `${name}، حمّل تطبيق دارا: iOS ${APP_IOS_URL} | Android ${APP_ANDROID_URL}`,
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
      ? "تمت إضافتك كموظف في حساب على منصة <strong>دارا</strong>. لتفعيل دخولك، يرجى تأكيد بريدك الإلكتروني بالضغط على الزر أدناه."
      : "شكراً لتسجيلك في <strong>دارا</strong>. لإكمال طلبك، يرجى تأكيد بريدك الإلكتروني بالضغط على الزر أدناه، ثم سيقوم فريقنا بمراجعة الحساب وتفعيله.";
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">مرحباً ${safeName} 👋</h1>
      <p style="margin:0 0 18px;color:#334155;line-height:1.7;">${intro}</p>
      <p style="margin:0 0 24px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">
          تأكيد البريد الإلكتروني
        </a>
      </p>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px;">أو انسخ الرابط التالي والصقه في المتصفح:</p>
      <p style="margin:0 0 16px;word-break:break-all;"><a href="${link}" style="color:#042698;font-size:13px;">${link}</a></p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;">الرابط صالح لمدة 7 أيام. إذا لم تطلب هذا، يمكنك تجاهل الرسالة.</p>
    `);
    return this.send({
      to,
      subject: "تأكيد بريدك الإلكتروني · دارا",
      html,
      text: `مرحباً ${name}، يرجى تأكيد بريدك الإلكتروني عبر الرابط: ${link} (صالح 7 أيام).`,
    });
  }

  async sendMaintenanceAcknowledgment(to: string, payload: MaintenanceEmailPayload): Promise<boolean> {
    if (!to) return false;
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">تم استلام طلب الصيانة ✅</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        شكراً لتواصلك معنا. تم تسجيل طلب الصيانة الخاص بك (رقم <strong>#${payload.id}</strong>) وسيتم التواصل معك في أقرب وقت ممكن.
      </p>
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("الأولوية", payload.priority || "medium")}
      ${row("الحالة الحالية", payload.status || "open")}
      <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;margin-bottom:6px;">تفاصيل طلبك</div>
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        هذه رسالة تأكيد تلقائية — لا حاجة للرد عليها.
      </p>
    `);
    return this.send({
      to,
      subject: `تأكيد استلام طلب الصيانة #${payload.id}`,
      html,
      text: `تم استلام طلب الصيانة رقم #${payload.id}. سيتم التواصل معك قريباً.`,
    });
  }

  /**
   * Fires when an admin/landlord transitions a maintenance ticket to a new
   * status (e.g. open → in_progress → completed). Keeps the tenant in the
   * loop. No-op when `to` is empty (tenant without an email on file).
   */
  async sendMaintenanceStatusChanged(to: string, payload: MaintenanceEmailPayload & { previousStatus?: string | null }): Promise<boolean> {
    if (!to) return false;
    const statusLabels: Record<string, string> = {
      open:              "مفتوحة",
      in_progress:       "قيد التنفيذ",
      pending_approval:  "بانتظار الموافقة",
      completed:         "مكتملة",
      cancelled:         "ملغاة",
    };
    const newLabel = statusLabels[String(payload.status)] || String(payload.status || "—");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">تحديث على طلب الصيانة #${payload.id}</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        نود إعلامك بأن حالة طلب الصيانة الخاص بك قد تم تحديثها.
      </p>
      <div style="margin:16px 0;padding:14px 16px;background:linear-gradient(135deg,#eff6ff,#e0e7ff);border:1px solid #c7d2fe;border-radius:10px;text-align:center;">
        <div style="color:#475569;font-size:12px;margin-bottom:4px;">الحالة الحالية</div>
        <div style="color:#1e3a8a;font-size:20px;font-weight:700;">${escapeHtml(newLabel)}</div>
      </div>
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("الأولوية", payload.priority || "medium")}
      <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;margin-bottom:6px;">طلبك الأصلي</div>
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        ${payload.status === "completed"
          ? "تم إكمال الطلب. إذا كانت لديك أي ملاحظات يسعدنا تواصلك معنا."
          : "سنواصل تحديثك بأي تغييرات على هذا الطلب."}
      </p>
    `);
    return this.send({
      to,
      subject: `تحديث طلب الصيانة #${payload.id} — ${newLabel}`,
      html,
      text: `تم تحديث طلب الصيانة #${payload.id} إلى: ${newLabel}.`,
    });
  }

  /**
   * Sent to the user once an admin approves their pending registration.
   */
  async sendRegistrationApproved(to: string, name: string): Promise<boolean> {
    if (!to) return false;
    const safeName = escapeHtml(name || "");
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">تم تفعيل حسابك ✅</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        مرحباً ${safeName}،<br/>
        يسعدنا إعلامك بأن حسابك في <strong>دارا · Dara</strong> قد تم تفعيله بنجاح. يمكنك الآن تسجيل الدخول وإدارة عقاراتك.
      </p>
      <div style="margin:24px 0;text-align:center;">
        <a href="${SITE_URL}/login" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;">
          تسجيل الدخول
        </a>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        إذا واجهت أي مشكلة في الدخول لا تتردد في التواصل معنا على ${SUPPORT_EMAIL}.
      </p>
    `);
    return this.send({
      to,
      subject: "تم تفعيل حسابك في دارا · Account approved",
      html,
      text: `مرحباً ${name}، تم تفعيل حسابك في دارا. يمكنك الآن تسجيل الدخول عبر ${SITE_URL}/login`,
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">طلب التسجيل</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        ${safeName}،<br/>
        نعتذر، لم نتمكّن من قبول طلب تسجيلك في <strong>دارا · Dara</strong> في الوقت الحالي.
      </p>
      ${safeReason
        ? `<div style="margin-top:16px;padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
             <div style="color:#991b1b;font-size:12px;margin-bottom:6px;">السبب</div>
             <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${safeReason}</div>
           </div>`
        : ""}
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        إذا كان لديك أي استفسار يمكنك التواصل مع فريقنا على ${SUPPORT_EMAIL}.
      </p>
    `);
    return this.send({
      to,
      subject: "بشأن طلب تسجيلك في دارا",
      html,
      text: `${name}، نعتذر، لم نتمكّن من قبول طلب تسجيلك في دارا في الوقت الحالي.${reason ? ` السبب: ${reason}` : ""}`,
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:22px;">شكراً لتواصلك معنا</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        ${safeName ? `${safeName}، ` : ""}استلمنا رسالتك (رقم <strong>#${payload.id}</strong>) وسيقوم فريقنا بالرد عليك في أقرب وقت ممكن.
      </p>
      <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;margin-bottom:6px;">نسخة من رسالتك</div>
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        إذا أردت إضافة معلومات يمكنك الرد على هذا البريد مباشرة.
      </p>
    `);
    return this.send({
      to,
      subject: `استلمنا رسالتك #${payload.id} — دارا`,
      html,
      text: `استلمنا رسالتك رقم #${payload.id}. سنرد عليك قريباً.`,
    });
  }

  async sendMaintenanceCreated(payload: MaintenanceEmailPayload, to?: string): Promise<boolean> {
    const recipient = to || this.adminEmail;
    if (!recipient) {
      this.log.warn("sendMaintenanceCreated: no recipient (set ADMIN_NOTIFY_EMAIL)");
      return false;
    }
    const html = layout(`
      <h1 style="color:#010f35;margin:0 0 16px;font-size:20px;">طلب صيانة جديد #${payload.id}</h1>
      ${row("الوحدة", payload.unitLabel || "—")}
      ${row("العقار", payload.propertyName || "—")}
      ${row("المستأجر", payload.tenantName || "—")}
      ${row("رقم المستأجر", payload.tenantPhone || "—")}
      ${row("الأولوية", payload.priority || "medium")}
      ${row("الحالة", payload.status || "open")}
      <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;margin-bottom:6px;">الوصف</div>
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
    `);
    return this.send({
      to: recipient,
      subject: `طلب صيانة جديد #${payload.id} — ${payload.unitLabel || "وحدة"}`,
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:20px;">رسالة جديدة من نموذج التواصل #${payload.id}</h1>
      ${row("الاسم", payload.name || "—")}
      ${row("البريد", payload.email || "—")}
      ${row("الجوال", payload.phone || "—")}
      ${row("المصدر", payload.source || "—")}
      <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;margin-bottom:6px;">الرسالة</div>
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(payload.description)}</div>
      </div>
    `);
    return this.send({
      to: recipient,
      subject: `رسالة تواصل جديدة #${payload.id}${payload.name ? ` — ${payload.name}` : ""}`,
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
    const cycleLabel = payload.desiredBillingCycle === "yearly" ? "سنوي"
      : payload.desiredBillingCycle === "monthly" ? "شهري" : "—";
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
      <h1 style="color:#010f35;margin:0 0 16px;font-size:20px;">رد جديد على تذكرة الدعم #${ticketId}</h1>
      <p style="margin:0 0 12px;color:#334155;line-height:1.7;">
        ${safeName ? `${safeName}، ` : ""}وصلك رد من فريق الدعم على تذكرتك رقم <strong>#${ticketId}</strong>:
      </p>
      <div style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="color:#010f35;line-height:1.7;white-space:pre-wrap;">${escapeHtml(message)}</div>
      </div>
      <div style="margin-top:20px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#042698,#106cf8);color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;font-size:14px;">عرض المحادثة والرد</a>
      </div>
    `);
    return this.send({
      to,
      subject: `رد على تذكرة الدعم #${ticketId} — دارا`,
      html,
      text: `وصلك رد على تذكرة الدعم #${ticketId}:\n\n${message}`,
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
