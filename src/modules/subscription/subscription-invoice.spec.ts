import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SubscriptionInvoiceService, subscriptionInvoiceNumber } from "./subscription-invoice.service";
import { renderSubscriptionInvoiceHtml } from "./subscription-invoice-template";

/** The service only needs its two collaborators when it renders or emails. */
const svc = new SubscriptionInvoiceService(null as any, null as any);

const paidRow = (over: Record<string, any> = {}) => ({
  id: 42, userId: 1, plan: "professional", billingCycle: "yearly", amount: "4830.00",
  currency: "SAR", status: "paid", paidAt: new Date("2026-09-03T10:00:00Z"),
  createdAt: new Date("2026-09-03T10:00:00Z"),
  invoiceNumber: null, invoiceIssuedAt: null, periodStart: null, periodEnd: null,
  moyasarInvoiceId: null, moyasarPaymentId: null, paymentUrl: null,
  updatedAt: new Date(), ...over,
}) as any;

const buyer = (over: Record<string, any> = {}) => ({
  user: { id: 1, name: "عبدالسلام", email: "a@example.com", companyId: null },
  company: undefined, ...over,
}) as any;

describe("subscriptionInvoiceNumber", () => {
  it("is stable, unique and zero-padded", () => {
    assert.equal(subscriptionInvoiceNumber(7), "SUB-000007");
    assert.equal(subscriptionInvoiceNumber(42), "SUB-000042");
    assert.equal(subscriptionInvoiceNumber(1234567), "SUB-1234567");
    // Derived from the row id, so calling it twice can never drift.
    assert.equal(subscriptionInvoiceNumber(42), subscriptionInvoiceNumber(42));
  });
});

/**
 * The charged amount is what Moyasar actually collected, so it is the TOTAL.
 * VAT comes out of it, never on top of it — an invoice stating a total larger
 * than the charge would overstate what the customer paid.
 */
describe("buildData — VAT is extracted from the charged amount", () => {
  it("never states a total other than the amount charged", () => {
    for (const amount of ["4830.00", "1.00", "250.00", "0.01", "3570.00"]) {
      const d = svc.buildData(paidRow({ amount }), buyer());
      assert.equal(d.total, Number(amount), amount);
      assert.ok(
        Math.abs(d.subtotal + d.vatAmount - d.total) < 0.005,
        `${amount}: ${d.subtotal} + ${d.vatAmount} != ${d.total}`,
      );
      assert.equal(d.lines[0].amount, d.subtotal);
    }
  });

  it("splits a 15%-inclusive amount the way ZATCA expects", () => {
    const d = svc.buildData(paidRow({ amount: "4830.00" }), buyer());
    assert.equal(d.subtotal, 4200);
    assert.equal(d.vatAmount, 630);
    assert.equal(d.vatRate, 15);
  });
});

describe("buildData — buyer identity", () => {
  it("prints the company's legal name and VAT when there is a company", () => {
    const d = svc.buildData(paidRow(), buyer({
      user: { id: 1, name: "ابراهيم", email: "a@example.com", companyId: 9 },
      company: { id: 9, name: "شركة العقيل", vatNumber: "310404305800003", district: "الفيصلية", city: "الدمام", postalCode: "32272" },
    }));
    assert.equal(d.buyer.name, "شركة العقيل");
    assert.equal(d.buyer.vatNumber, "310404305800003");
    assert.deepEqual(d.buyer.addressLines, ["الفيصلية", "الدمام 32272"]);
  });

  it("falls back to the account name for an individual with no company", () => {
    const d = svc.buildData(paidRow(), buyer());
    assert.equal(d.buyer.name, "عبدالسلام");
    assert.equal(d.buyer.vatNumber, null);
    assert.deepEqual(d.buyer.addressLines, []);
  });
});

describe("buildData — the period", () => {
  it("names the window the payment bought once it is stamped", () => {
    const d = svc.buildData(paidRow({
      periodStart: new Date("2026-09-03T10:00:00Z"),
      periodEnd: new Date("2027-09-02T10:00:00Z"),
    }), buyer());
    assert.match(d.lines[0].description, /من 2026\/09\/03 إلى 2027\/09\/02/);
  });

  it("omits it rather than inventing one on an unstamped row", () => {
    const d = svc.buildData(paidRow(), buyer());
    assert.doesNotMatch(d.lines[0].description, /إلى/);
  });
});

/**
 * The document is rendered by headless Chrome with no network, so a template
 * that referenced a remote asset would silently print a blank. Guard the two
 * things that must be inline, and that user-supplied text cannot break out.
 */
describe("renderSubscriptionInvoiceHtml", () => {
  it("inlines every asset — nothing is fetched at render time", () => {
    const html = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer()));
    assert.ok(html.includes("<svg"), "the lockup must be inline SVG");
    // The only http:// left may be the SVG xmlns, which is a namespace and not
    // a fetch. Anything that would actually load is a blank page in Chrome.
    for (const pattern of [/url\(\s*["']?https?:/i, /<link\b/i, /<img\b/i, /@import/i, /<script\b/i]) {
      assert.doesNotMatch(html, pattern, String(pattern));
    }
  });

  it("escapes a buyer name that contains markup", () => {
    const html = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer({
      user: { id: 1, name: `<script>x</script>`, email: null, companyId: null },
    })));
    assert.ok(!html.includes("<script>x</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
