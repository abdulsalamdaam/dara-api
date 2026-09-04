import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SubscriptionInvoiceService, subscriptionInvoiceNumber } from "./subscription-invoice.service";
import { renderSubscriptionInvoiceHtml } from "./subscription-invoice-template";
import { buildPhase1Tlv } from "../../common/zatca-qr";

/** The service only needs its two collaborators when it renders or emails. */
const svc = new SubscriptionInvoiceService(null as any, null as any);

const paidRow = (over: Record<string, any> = {}) => ({
  id: 42, userId: 1, plan: "professional", billingCycle: "yearly", amount: "4830.00",
  currency: "SAR", status: "paid", paidAt: new Date("2026-09-04T10:00:00Z"),
  createdAt: new Date("2026-09-04T10:00:00Z"),
  invoiceNumber: null, invoiceIssuedAt: null,
  periodStart: new Date("2026-09-04T10:00:00Z"), periodEnd: new Date("2027-09-03T10:00:00Z"),
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

/** The line reads at a glance: the package and its cycle, and no dates. */
describe("buildData — the line describes the package, not the period", () => {
  it("names the package and the cycle", () => {
    const d = svc.buildData(paidRow(), buyer());
    assert.match(d.lines[0].description, /باقة/);
    assert.match(d.lines[0].description, /سنوي/);
  });

  it("says شهري for a monthly cycle", () => {
    assert.match(svc.buildData(paidRow({ billingCycle: "monthly" }), buyer()).lines[0].description, /شهري/);
  });

  it("states no period, even when the row carries one", () => {
    const d = svc.buildData(paidRow(), buyer());
    assert.doesNotMatch(d.lines[0].description, /\d{4}\/\d{2}\/\d{2}/, "no dates belong in the line");
    assert.doesNotMatch(d.lines[0].description, /إلى/);
  });
});

/**
 * The document names NEITHER party — no recipient block, no seller block, no
 * registration numbers. That is the design as specified, so it is asserted
 * rather than left to be quietly undone by someone restoring a "missing"
 * field.
 */
describe("buildData — who the invoice is addressed to", () => {
  it("uses the company's registered name when the account has one", () => {
    const d = svc.buildData(paidRow(), buyer({
      user: { id: 1, name: "ابراهيم", email: "a@example.com", companyId: 9 },
      company: { id: 9, name: "شركة العقيل للاستثمار العقاري", district: "الفيصلية", city: "الدمام", postalCode: "32272" },
    }));
    assert.equal(d.buyer.name, "شركة العقيل للاستثمار العقاري");
    assert.deepEqual(d.buyer.addressLines, ["الفيصلية", "الدمام 32272"]);
  });

  it("uses the person's own name for an individual with no company", () => {
    assert.equal(svc.buildData(paidRow(), buyer()).buyer.name, "عبدالسلام");
  });

  /** The address is optional; an account without one must simply not print it. */
  it("leaves the address out entirely when there is none", () => {
    const d = svc.buildData(paidRow(), buyer());
    assert.deepEqual(d.buyer.addressLines, []);
    const h = renderSubscriptionInvoiceHtml(d);
    assert.ok(h.includes("فاتورة إلى"), "the block still names the customer");
    assert.ok(h.includes("عبدالسلام"));
    assert.ok(!h.includes('class="ln"'), "no empty address line is emitted");
  });

  it("never leaves the name blank", () => {
    const d = svc.buildData(paidRow(), buyer({ user: { id: 1, name: null, email: null, companyId: null } }));
    assert.ok(d.buyer.name.trim().length > 0);
  });
});

describe("renderSubscriptionInvoiceHtml — no registration numbers, either side", () => {
  const html = () => renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer()));

  it("carries no seller block and no registration numbers", () => {
    const h = html();
    for (const label of ["صادرة من", "الرقم الضريبي", "السجل التجاري"]) {
      assert.ok(!h.includes(label), `${label} does not belong on this document`);
    }
  });

  it("still states the invoice number, the date, the line and the total", () => {
    const h = html();
    assert.ok(h.includes("SUB-000042"));
    assert.ok(h.includes("2026/9/4"));
    assert.ok(h.includes("فاتورة ضريبية"));
    assert.ok(h.includes("4,830.00"));
  });

  it("inlines every asset — nothing is fetched at render time", () => {
    const h = html();
    assert.ok(h.includes("<svg"), "the lockup must be inline SVG");
    // The only http:// left may be the SVG xmlns, which is a namespace and not
    // a fetch. Anything that would actually load is a blank page in Chrome.
    for (const pattern of [/url\(\s*["']?https?:/i, /<link\b/i, /<img\b/i, /@import/i, /<script\b/i]) {
      assert.doesNotMatch(h, pattern, String(pattern));
    }
  });

  it("escapes a package label that contains markup", () => {
    const h = renderSubscriptionInvoiceHtml({
      ...svc.buildData(paidRow(), buyer()),
      lines: [{ description: "<script>x</script>", quantity: 1, unitPrice: 1, amount: 1 }],
    });
    assert.ok(!h.includes("<script>x</script>"));
    assert.ok(h.includes("&lt;script&gt;"));
  });
});

/**
 * Decode a Phase-1 TLV payload back into its five tags, so a test can assert
 * what a scanner would actually read rather than just that a QR was drawn.
 */
function decodeTlv(b64: string): Record<number, string> {
  const buf = Buffer.from(b64, "base64");
  const out: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString("utf8");
    i += 2 + len;
  }
  return out;
}

describe("the ZATCA Phase-1 QR", () => {
  const SELLER = { name: "شركة دام التقنية", vat: "300000000000003" };

  const withVat = (fn: () => void) => {
    const prevName = process.env.DARA_SELLER_NAME;
    const prevVat = process.env.DARA_SELLER_VAT;
    process.env.DARA_SELLER_NAME = SELLER.name;
    process.env.DARA_SELLER_VAT = SELLER.vat;
    try { fn(); } finally {
      if (prevName === undefined) delete process.env.DARA_SELLER_NAME; else process.env.DARA_SELLER_NAME = prevName;
      if (prevVat === undefined) delete process.env.DARA_SELLER_VAT; else process.env.DARA_SELLER_VAT = prevVat;
    }
  };

  it("is drawn on the document when the VAT number is configured", () => {
    withVat(() => {
      const d = svc.buildData(paidRow(), buyer());
      assert.ok(d.qrSvg, "a QR must be produced");
      assert.ok(renderSubscriptionInvoiceHtml(d).includes("<svg"), "and reach the page");
    });
  });

  /**
   * The five mandatory tags, decoded the way ZATCA's own app decodes them.
   * Tag 4 must equal the amount actually charged and tag 5 the VAT inside it —
   * a QR disagreeing with the printed totals is a failed audit, not a cosmetic
   * bug.
   */
  it("encodes the five mandatory tags, and they agree with the printed totals", () => {
    withVat(() => {
      const d = svc.buildData(paidRow({ amount: "4830.00" }), buyer());
      const tags = decodeTlv(buildPhase1Tlv({
        sellerName: SELLER.name, vatNumber: SELLER.vat,
        timestamp: new Date(paidRow().paidAt).toISOString(),
        totalWithVat: d.total.toFixed(2), vatTotal: d.vatAmount.toFixed(2),
      }));
      assert.equal(tags[1], SELLER.name);
      assert.equal(tags[2], SELLER.vat);
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(tags[3]), `tag 3 must be ISO-8601, got ${tags[3]}`);
      assert.equal(tags[4], "4830.00");
      assert.equal(tags[5], "630.00");
      assert.equal(Number(tags[4]), d.total);
      assert.equal(Number(tags[5]), d.vatAmount);
    });
  });

  /**
   * A QR scanning to an empty VAT registration looks official and certifies
   * nothing, so an unconfigured seller must produce NO code rather than a
   * hollow one.
   */
  it("is omitted entirely when the VAT number is not configured", () => {
    const prev = process.env.DARA_SELLER_VAT;
    delete process.env.DARA_SELLER_VAT;
    try {
      const d = svc.buildData(paidRow(), buyer());
      assert.equal(d.qrSvg, null);
      // The container stays (it anchors the totals to the left) but is empty.
      assert.ok(renderSubscriptionInvoiceHtml(d).includes('<div class="qr"></div>'), "the QR slot must be empty");
    } finally {
      if (prev !== undefined) process.env.DARA_SELLER_VAT = prev;
    }
  });
});
