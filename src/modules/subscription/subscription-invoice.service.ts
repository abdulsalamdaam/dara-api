import { Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { usersTable, companiesTable, subscriptionPaymentsTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { PdfService } from "../invoice/services/pdf.service";
import { EmailService } from "../email/email.service";
import { resolvePackage, type BillingCycle } from "../../common/packages";
import { daraSeller, SUBSCRIPTION_VAT_RATE } from "../../common/dara-seller";
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
    const rate = SUBSCRIPTION_VAT_RATE;
    const subtotal = Math.round((total / (1 + rate / 100)) * 100) / 100;
    const vatAmount = Math.round((total - subtotal) * 100) / 100;

    // The address is optional — most accounts have never filled one in, and an
    // absent one simply does not print. Prefer the structured national
    // address; fall back to the free-text one.
    const structured = [company?.district, company?.street, company?.buildingNumber]
      .map((v) => (v || "").trim()).filter(Boolean).join("، ");
    const cityLine = [company?.city, company?.postalCode].map((v) => (v || "").trim()).filter(Boolean).join(" ");
    const buyerAddress = [structured || (company?.address || "").trim(), cityLine]
      .map((v) => v.trim()).filter(Boolean);

    return {
      invoiceNumber: row.invoiceNumber || subscriptionInvoiceNumber(row.id),
      issueDate: printDate(row.invoiceIssuedAt ?? row.paidAt ?? row.createdAt),
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
      vatRate: rate,
      vatAmount,
      total,
      currencyLabel: row.currency === "SAR" ? "ر.س" : (row.currency || "ر.س"),
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
   * Stamp the invoice identity onto a freshly-paid row, render it, and email it
   * to the account holder.
   *
   * Called fire-and-forget from the activation path: a Moyasar webhook must be
   * answered in milliseconds, and this spawns Chrome. Every failure below is
   * therefore logged and swallowed — a subscription that activated but whose
   * receipt did not render is a nuisance; one that failed to activate because
   * the receipt did is an outage. The download endpoint re-renders on demand,
   * so nothing is lost permanently either way.
   */
  async issueAndEmail(db: Drizzle, paymentId: number, period: { start: Date; end: Date }): Promise<void> {
    try {
      const number = subscriptionInvoiceNumber(paymentId);
      const [row] = await db.update(subscriptionPaymentsTable)
        .set({ invoiceNumber: number, invoiceIssuedAt: new Date(), periodStart: period.start, periodEnd: period.end })
        .where(eq(subscriptionPaymentsTable.id, paymentId))
        .returning();
      if (!row) return;

      const buyer = await this.loadBuyer(db, row.userId);
      const to = buyer.user?.email;
      if (!to) {
        this.log.warn(`invoice ${number}: account ${row.userId} has no email — nothing to send`);
        return;
      }

      const pdf = await this.renderPdf(row, buyer);
      const pkg = resolvePackage(row.plan);
      await this.email.sendSubscriptionInvoice(
        to,
        buyer.company?.name || buyer.user?.name || "",
        {
          invoiceNumber: number,
          planLabel: pkg.labelAr,
          cycle: row.billingCycle === "yearly" ? "yearly" : "monthly",
          amount: Number(row.amount) || 0,
          currencyLabel: row.currency === "SAR" ? "ر.س" : (row.currency || "ر.س"),
          periodEnd: period.end,
        },
        pdf,
      );
      this.log.log(`invoice ${number} emailed to account ${row.userId}`);
    } catch (err: any) {
      this.log.error(`subscription invoice for payment ${paymentId} failed: ${err?.message || err}`);
    }
  }
}
