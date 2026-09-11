import { Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { usersTable, companiesTable, subscriptionPaymentsTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { PdfService } from "../invoice/services/pdf.service";
import { EmailService } from "../email/email.service";
import { resolvePackage, type BillingCycle } from "../../common/packages";
import { daraSeller, isTaxInvoice, vatRateMatchesAmounts, SUBSCRIPTION_VAT_RATE } from "../../common/dara-seller";
import { nextEndDate } from "../../common/subscription";
import { AppLogService } from "../../common/logging/app-log.service";
import { invoiceQrSvg } from "../../common/zatca-qr";
import { renderSubscriptionInvoiceHtml, type SubscriptionInvoiceData } from "./subscription-invoice-template";

type PaymentRow = typeof subscriptionPaymentsTable.$inferSelect;
type UserRow = typeof usersTable.$inferSelect;
type CompanyRow = typeof companiesTable.$inferSelect;

/**
 * The buyer as printed. A landlord account's legal identity — the registered
 * name, the VAT number, the national address — lives on `companies`, not on
 * `users`; `users` only has the login name. An individual account has no
 * company row at all, so every field here is optional and the name falls back
 * to the account name.
 */
export interface SubscriptionBuyer {
  user: UserRow | undefined;
  company: CompanyRow | undefined;
}

/** How `issue()` should behave. Everything optional; the defaults are the live path. */
export interface IssueInvoiceOptions {
  /**
   * The subscription window this payment bought. Only used when the row does
   * not already carry one — a retro-issued invoice for a payment activated
   * before these columns existed reconstructs it from `paidAt` + the cycle.
   */
  period?: { start: Date; end: Date };
  /**
   * Send to this address instead of the account holder's. Exists so a test can
   * be pointed at our own mailbox rather than a customer's.
   */
  to?: string | null;
  /**
   * Render and resolve everything, then stop: no email, no database write at
   * all. The only safe way to exercise this against real rows.
   */
  dryRun?: boolean;
}

/** What one issue attempt did. `ok` means a CONFIRMED send, or a completed dry run. */
export interface IssueInvoiceResult {
  ok: boolean;
  paymentId: number;
  invoiceNumber: string;
  dryRun: boolean;
  /** `no_row` | `not_paid` | `no_recipient` | `send_failed` — absent when ok. */
  reason?: string;
  /** Where it went, or would have gone. */
  to?: string | null;
  pdfBytes?: number;
  /** ISO timestamp of the confirmed send; on a dry run, the row's existing one. */
  emailedAt?: string | null;
  /** The resolved document, returned on a dry run so it can be inspected. */
  data?: SubscriptionInvoiceData;
}

/** `SUB-000042` — derived from the row id, so it is unique and stable. */
export function subscriptionInvoiceNumber(paymentId: number): string {
  return `SUB-${String(paymentId).padStart(6, "0")}`;
}

/** `YYYY/M/D`, the format the printed document uses. */
function printDate(d: Date | null | undefined): string {
  const x = d ?? new Date();
  return `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`;
}

/** `YYYY/MM/DD`, for the period inside the line description. */
function isoDate(d: Date | null | undefined): string {
  const x = d ?? new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}/${p(x.getMonth() + 1)}/${p(x.getDate())}`;
}

@Injectable()
export class SubscriptionInvoiceService {
  private readonly log = new Logger("SubscriptionInvoice");

  constructor(
    private readonly pdf: PdfService,
    private readonly email: EmailService,
    /**
     * Failures go to `app_logs`, not only to stdout. A container's stdout dies
     * with the container and nobody reads it; `app_logs` is what the admin
     * portal shows, which is where somebody will actually notice that a paying
     * customer never received their invoice.
     */
    private readonly appLog: AppLogService,
  ) {}

  /**
   * Turn a paid payment row into the data the template prints.
   *
   * The charged amount is treated as VAT-INCLUSIVE: it is what Moyasar actually
   * collected, so the total on the invoice must equal it to the halala. VAT is
   * therefore extracted from the amount rather than added on top — inventing a
   * larger total would state that we charged more than we did.
   */
  buildData(row: PaymentRow, buyer: SubscriptionBuyer): SubscriptionInvoiceData {
    const { user: owner, company } = buyer;
    const seller = daraSeller();
    const pkg = resolvePackage(row.plan);
    const cycle = (row.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
    const cycleLabel = cycle === "yearly" ? "سنوي" : "شهري";

    const total = Number(row.amount) || 0;

    // Tax invoice or plain invoice — the one decision, taken in one place (see
    // `isTaxInvoice`). On a tax invoice the charged amount is VAT-INCLUSIVE, so
    // VAT is EXTRACTED from it rather than added on top: the total must equal
    // what Moyasar collected, to the halala. With no seller VAT registration
    // there is no VAT to extract and no VAT line — the amount charged is simply
    // the amount, net and gross alike.
    const taxInvoice = isTaxInvoice(seller);
    const rate = SUBSCRIPTION_VAT_RATE;
    const subtotal = taxInvoice ? Math.round((total / (1 + rate / 100)) * 100) / 100 : total;
    const vatAmount = taxInvoice ? Math.round((total - subtotal) * 100) / 100 : 0;

    // The address is optional — most accounts have never filled one in, and an
    // absent one simply does not print. Prefer the structured national
    // address; fall back to the free-text one.
    const structured = [company?.district, company?.street, company?.buildingNumber]
      .map((v) => (v || "").trim()).filter(Boolean).join("، ");
    const cityLine = [company?.city, company?.postalCode].map((v) => (v || "").trim()).filter(Boolean).join(" ");
    const buyerAddress = [structured || (company?.address || "").trim(), cityLine]
      .map((v) => v.trim()).filter(Boolean);

    // ZATCA Phase-1 QR: seller name, VAT number, ISO-8601 timestamp, total
    // with VAT, VAT total. Emitted only when the VAT number is configured —
    // a QR that scans to an empty registration is worse than none, because it
    // looks official and certifies nothing.
    const issuedAt = row.invoiceIssuedAt ?? row.paidAt ?? row.createdAt ?? new Date();
    const qr = taxInvoice
      ? invoiceQrSvg({
          sellerName: seller.name,
          vatNumber: seller.vatNumber!,
          issueDate: issuedAt,
          totalWithVat: total,
          vatTotal: vatAmount,
          sizePx: 220,
        })
      : null;
    if (!qr) {
      // Not an error: this is the plain-invoice mode, and the document says so
      // in its own heading. Logged because "why is there no QR" is a question
      // somebody will ask, and the answer is one environment variable.
      this.log.warn(
        `invoice ${row.invoiceNumber ?? row.id}: plain invoice, no VAT line and no ZATCA QR — DARA_SELLER_VAT is not set`,
      );
    }

    return {
      invoiceNumber: row.invoiceNumber || subscriptionInvoiceNumber(row.id),
      issueDate: printDate(row.invoiceIssuedAt ?? row.paidAt ?? row.createdAt),
      taxInvoice,
      seller,
      buyer: {
        // A company account is billed under its registered name; an individual
        // under their own. Never blank — the block would read as broken.
        name: company?.name || owner?.name || "—",
        addressLines: buyerAddress,
      },
      lines: [{
        // The package and its cycle — no dates. The line is meant to read at a
        // glance, and the period it covers is already implied by the issue
        // date and the cycle.
        description: `اشتراك باقة «${pkg.labelAr}» — ${cycleLabel}`,
        quantity: 1,
        unitPrice: subtotal,
        amount: subtotal,
      }],
      subtotal,
      vat: taxInvoice
        ? { rate, amount: vatAmount, ratePrinted: vatRateMatchesAmounts(subtotal, vatAmount, rate) }
        : null,
      total,
      currencyLabel: row.currency === "SAR" ? "ر.س" : (row.currency || "ر.س"),
      qrSvg: qr,
    };
  }

  /** Render the PDF for a payment row. Throws if no headless browser exists. */
  async renderPdf(row: PaymentRow, buyer: SubscriptionBuyer): Promise<Buffer> {
    return this.pdf.htmlToPdf(renderSubscriptionInvoiceHtml(this.buildData(row, buyer)));
  }

  /**
   * The account being billed: who to address the invoice to, and who to email
   * it to. An individual account has no `companies` row at all, so every field
   * on it is optional.
   */
  async loadBuyer(db: Drizzle, userId: number): Promise<SubscriptionBuyer> {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    const company = user?.companyId
      ? (await db.select().from(companiesTable).where(eq(companiesTable.id, user.companyId)))[0]
      : undefined;
    return { user, company };
  }

  /**
   * Issue the invoice for a paid payment row: stamp it, render it, email it,
   * and record whether the email actually left.
   *
   * **The stamp and the send are two separate facts, and the row now says so.**
   * `invoice_number` / `invoice_issued_at` are written FIRST and on purpose:
   * the number is derived from the row id, the download endpoint re-renders
   * from it on demand, and a customer who has the PDF must keep getting the
   * same document back — so the identity has to be committed before anything
   * that can fail. What used to be wrong was that this was the ONLY thing
   * written: a render or a send that failed after it left a row that looked
   * issued, with nothing to retry from and nothing to show that a paying
   * customer had never received anything. `invoice_emailed_at` is written only
   * after the sender CONFIRMS a send, so "numbered" and "delivered" are two
   * different states you can tell apart in the data — and the admin re-issue
   * endpoint exists to move a row from the first to the second.
   */
  async issue(db: Drizzle, paymentId: number, opts: IssueInvoiceOptions = {}): Promise<IssueInvoiceResult> {
    const number = subscriptionInvoiceNumber(paymentId);
    const base = { paymentId, invoiceNumber: number, dryRun: !!opts.dryRun };

    const [existing] = await db.select().from(subscriptionPaymentsTable)
      .where(eq(subscriptionPaymentsTable.id, paymentId));
    if (!existing) return { ...base, ok: false, reason: "no_row" };
    // An invoice states that money was received. Never issue one for a row
    // that has not been confirmed paid.
    if (existing.status !== "paid") return { ...base, ok: false, reason: "not_paid" };

    const buyer = await this.loadBuyer(db, existing.userId);
    // An explicit recipient overrides the account's own address — that is how
    // this is tested without a message reaching a customer.
    const to = (opts.to || buyer.user?.email || "").trim() || null;

    if (opts.dryRun) {
      // Renders the document it WOULD send, off the row as it stands plus the
      // identity it would be stamped with. Writes nothing and sends nothing —
      // the point is to be able to look at the result on real data safely.
      const preview: PaymentRow = {
        ...existing,
        invoiceNumber: existing.invoiceNumber || number,
        invoiceIssuedAt: existing.invoiceIssuedAt ?? existing.paidAt ?? existing.createdAt ?? new Date(),
      };
      const data = this.buildData(preview, buyer);
      const pdf = await this.pdf.htmlToPdf(renderSubscriptionInvoiceHtml(data));
      return {
        ...base, ok: true, to, pdfBytes: pdf.length, data,
        emailedAt: existing.invoiceEmailedAt ? new Date(existing.invoiceEmailedAt).toISOString() : null,
      };
    }

    // Stamp the identity. Only what is MISSING is written: a row that already
    // carries a number, an issue date or a period keeps them, so re-issuing
    // after a failure reproduces the same document rather than re-dating it
    // under the customer.
    const cycle = (existing.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
    const periodStart = existing.periodStart ?? opts.period?.start ?? existing.paidAt ?? existing.createdAt ?? new Date();
    const periodEnd = existing.periodEnd ?? opts.period?.end ?? nextEndDate(cycle, periodStart);
    const [row] = await db.update(subscriptionPaymentsTable)
      .set({
        invoiceNumber: existing.invoiceNumber || number,
        invoiceIssuedAt: existing.invoiceIssuedAt ?? new Date(),
        periodStart,
        periodEnd,
      })
      .where(eq(subscriptionPaymentsTable.id, paymentId))
      .returning();
    if (!row) return { ...base, ok: false, reason: "no_row" };

    if (!to) {
      this.recordFailure(row, number, null, "no_recipient", "the account has no email address");
      return { ...base, ok: false, reason: "no_recipient", to: null };
    }

    const pdf = await this.renderPdf(row, buyer);
    const pkg = resolvePackage(row.plan);
    const sent = await this.email.sendSubscriptionInvoice(
      to,
      buyer.company?.name || buyer.user?.name || "",
      {
        invoiceNumber: number,
        planLabel: pkg.labelAr,
        cycle,
        amount: Number(row.amount) || 0,
        currencyLabel: row.currency === "SAR" ? "ر.س" : (row.currency || "ر.س"),
        periodEnd,
      },
      pdf,
    );

    // `sendSubscriptionInvoice` returns false both when RESEND_API_KEY is
    // missing and when Resend answers non-2xx, and it never throws. Discarding
    // it — which is what used to happen — made a total failure log exactly like
    // a success.
    if (!sent) {
      this.recordFailure(row, number, to, "send_failed", "the email provider did not accept the message");
      return { ...base, ok: false, reason: "send_failed", to, pdfBytes: pdf.length };
    }

    const emailedAt = new Date();
    await db.update(subscriptionPaymentsTable)
      .set({ invoiceEmailedAt: emailedAt })
      .where(eq(subscriptionPaymentsTable.id, paymentId));
    this.log.log(`invoice ${number} emailed to account ${row.userId}`);
    return { ...base, ok: true, to, pdfBytes: pdf.length, emailedAt: emailedAt.toISOString() };
  }

  /**
   * Stamp the invoice identity onto a freshly-paid row, render it, and email it
   * to the account holder.
   *
   * Called fire-and-forget from the activation path: a Moyasar webhook must be
   * answered in milliseconds, and this spawns Chrome. Every failure below is
   * therefore logged and swallowed — a subscription that activated but whose
   * receipt did not render is a nuisance; one that failed to activate because
   * the receipt did is an outage. The download endpoint re-renders on demand
   * and the admin re-issue endpoint can send it again, so nothing is lost
   * permanently either way.
   */
  async issueAndEmail(db: Drizzle, paymentId: number, period: { start: Date; end: Date }): Promise<void> {
    try {
      const result = await this.issue(db, paymentId, { period });
      if (!result.ok && result.reason !== "no_row" && result.reason !== "not_paid") {
        // `issue` has already written the detail to `app_logs`; this is the
        // stdout breadcrumb beside it.
        this.log.warn(`subscription invoice ${result.invoiceNumber} not delivered: ${result.reason}`);
      }
    } catch (err: any) {
      this.log.error(`subscription invoice for payment ${paymentId} failed: ${err?.message || err}`);
      this.appLog?.record({
        level: "error",
        event: "subscription_invoice_failed",
        context: "SubscriptionInvoice",
        userId: null,
        message: `subscription invoice ${subscriptionInvoiceNumber(paymentId)} could not be issued`,
        error: err,
        meta: { paymentId, invoiceNumber: subscriptionInvoiceNumber(paymentId), reason: "threw" },
      });
    }
  }

  /**
   * Record a non-delivery where somebody will see it.
   *
   * The Nest logger only reaches container stdout, which dies with the
   * container; `app_logs` is what the admin portal reads. The payment id and
   * the invoice number are both in the row so the failure can be looked up from
   * either end, and re-issued with
   * `POST /admin/subscription-payments/:id/issue-invoice`.
   */
  private recordFailure(
    row: PaymentRow, invoiceNumber: string, to: string | null, reason: string, detail: string,
  ): void {
    this.log.error(`invoice ${invoiceNumber} NOT emailed (${reason}): ${detail}`);
    this.appLog?.record({
      level: "error",
      event: "subscription_invoice_email_failed",
      context: "SubscriptionInvoice",
      userId: row.userId,
      message: `subscription invoice ${invoiceNumber} was not emailed — ${detail}`,
      meta: {
        paymentId: row.id,
        invoiceNumber,
        reason,
        to,
        moyasarPaymentId: row.moyasarPaymentId ?? null,
        amount: row.amount,
        emailConfigured: this.email?.isConfigured?.() ?? null,
      },
    });
  }
}
