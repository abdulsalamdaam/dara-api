import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usersTable, companiesTable, subscriptionPaymentsTable } from "@dara/database";

import { SubscriptionInvoiceService, subscriptionInvoiceNumber } from "./subscription-invoice.service";
import { renderSubscriptionInvoiceHtml } from "./subscription-invoice-template";
import { buildPhase1Tlv } from "../../common/zatca-qr";
import { vatRateMatchesAmounts } from "../../common/dara-seller";

/** The service only needs its three collaborators when it renders or emails. */
const svc = new SubscriptionInvoiceService(null as any, null as any, null as any);

const paidRow = (over: Record<string, any> = {}) => ({
  id: 42, userId: 1, plan: "professional", billingCycle: "yearly", amount: "4830.00",
  currency: "SAR", status: "paid", paidAt: new Date("2026-09-04T10:00:00Z"),
  createdAt: new Date("2026-09-04T10:00:00Z"),
  invoiceNumber: null, invoiceIssuedAt: null, invoiceEmailedAt: null,
  periodStart: new Date("2026-09-04T10:00:00Z"), periodEnd: new Date("2027-09-03T10:00:00Z"),
  moyasarInvoiceId: null, moyasarPaymentId: null, paymentUrl: null,
  updatedAt: new Date(), ...over,
}) as any;

const buyer = (over: Record<string, any> = {}) => ({
  user: { id: 1, name: "عبدالسلام", email: "a@example.com", companyId: null },
  company: undefined, ...over,
}) as any;

const SELLER = { name: "شركة دام التقنية", vat: "300000000000003", crn: "1010101010" };

/**
 * Run `fn` with the given environment, restoring whatever was there before.
 * The document's whole shape hangs off `DARA_SELLER_VAT`, so nearly every test
 * below has to state which mode it is asserting.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A VAT-registered seller — the tax-invoice mode. */
const asTaxInvoice = (fn: () => void, extra: Record<string, string | undefined> = {}) =>
  withEnv({ DARA_SELLER_NAME: SELLER.name, DARA_SELLER_VAT: SELLER.vat, DARA_SELLER_CRN: undefined, ...extra }, fn);

/** No VAT registration — today's state, and the plain-invoice mode. */
const asPlainInvoice = (fn: () => void) =>
  withEnv({ DARA_SELLER_NAME: SELLER.name, DARA_SELLER_VAT: undefined, DARA_SELLER_CRN: undefined }, fn);

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
    asTaxInvoice(() => {
      for (const amount of ["1.00", "50.00", "250.00", "350.00", "2550.00", "3570.00", "4830.00", "0.01"]) {
        const d = svc.buildData(paidRow({ amount }), buyer());
        assert.equal(d.total, Number(amount), amount);
        assert.ok(
          Math.abs(d.subtotal + (d.vat?.amount ?? 0) - d.total) < 0.005,
          `${amount}: ${d.subtotal} + ${d.vat?.amount} != ${d.total}`,
        );
        assert.equal(d.lines[0].amount, d.subtotal);
      }
    });
  });

  it("splits a 15%-inclusive amount the way ZATCA expects", () => {
    asTaxInvoice(() => {
      const d = svc.buildData(paidRow({ amount: "4830.00" }), buyer());
      assert.equal(d.subtotal, 4200);
      assert.equal(d.vat?.amount, 630);
      assert.equal(d.vat?.rate, 15);
    });
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
    asPlainInvoice(() => {
      const d = svc.buildData(paidRow(), buyer());
      assert.deepEqual(d.buyer.addressLines, []);
      const h = renderSubscriptionInvoiceHtml(d);
      assert.ok(h.includes("فاتورة إلى"), "the block still names the customer");
      assert.ok(h.includes("عبدالسلام"));
      assert.ok(!h.includes('class="ln"'), "no empty address line is emitted");
    });
  });

  it("never leaves the name blank", () => {
    const d = svc.buildData(paidRow(), buyer({ user: { id: 1, name: null, email: null, companyId: null } }));
    assert.ok(d.buyer.name.trim().length > 0);
  });
});

/**
 * The two document modes, asserted as whole shapes rather than as individual
 * fields — the heading, the seller block, the VAT row and the QR are four faces
 * of one decision (`isTaxInvoice`), and the failure that matters is any one of
 * them drifting away from the others. A document headed «فاتورة ضريبية» with no
 * seller registration on it is the defect these tests exist to catch.
 */
describe("the document says which kind of document it is — TAX INVOICE", () => {
  const render = (extra: Record<string, string | undefined> = {}) => {
    let h = "";
    asTaxInvoice(() => { h = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer())); }, extra);
    return h;
  };

  it("is headed «فاتورة ضريبية»", () => {
    assert.match(render(), /<h1>فاتورة ضريبية<\/h1>/);
  });

  it("names a registered seller — the block that makes the heading true", () => {
    const h = render();
    assert.ok(h.includes("صادرة من"), "a seller block must be printed");
    assert.ok(h.includes(SELLER.name));
    assert.ok(h.includes("الرقم الضريبي"));
    assert.ok(h.includes(SELLER.vat));
  });

  it("prints the CR when one is configured, and nothing when it is not", () => {
    assert.ok(!render().includes("السجل التجاري"), "no CR configured, no CR line");
    const withCr = render({ DARA_SELLER_CRN: SELLER.crn });
    assert.ok(withCr.includes("السجل التجاري"));
    assert.ok(withCr.includes(SELLER.crn));
  });

  it("states VAT and draws the ZATCA QR", () => {
    const h = render();
    assert.ok(h.includes("ضريبة القيمة المضافة"));
    assert.ok(!h.includes('<div class="qr"></div>'), "the QR slot must not be empty");
  });
});

describe("the document says which kind of document it is — PLAIN INVOICE", () => {
  const build = () => {
    let out: any;
    asPlainInvoice(() => { out = svc.buildData(paidRow(), buyer()); });
    return out;
  };
  const render = () => {
    let h = "";
    asPlainInvoice(() => { h = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer())); });
    return h;
  };

  /**
   * The whole point. With no seller VAT number we cannot back the claim, so we
   * must not make it — and «فاتورة ضريبية» must not survive anywhere on the
   * page, heading or closing note.
   */
  it("is headed «فاتورة» and never calls itself a tax invoice", () => {
    const h = render();
    assert.match(h, /<h1>فاتورة<\/h1>/);
    assert.ok(!h.includes("فاتورة ضريبية"), "an unregistered seller issues no tax invoice");
  });

  it("omits VAT entirely — not a 0% line", () => {
    const d = build();
    assert.equal(d.vat, null, "there is no VAT line to print");
    const h = render();
    assert.ok(!h.includes("ضريبة القيمة المضافة"), "no VAT row, at any rate");
    // Only two rows in the totals table: the sum and the grand total.
    assert.equal((h.match(/<td class="k">/g) || []).length, 2, "no third totals row slipped in");
  });

  it("states the amount charged as the total, with nothing extracted from it", () => {
    const d = build();
    assert.equal(d.total, 4830);
    assert.equal(d.subtotal, 4830, "nothing is netted off an invoice that charges no VAT");
    assert.equal(d.lines[0].amount, 4830);
    assert.ok(render().includes("4,830.00"));
  });

  it("carries no seller registration block and no QR", () => {
    const h = render();
    for (const label of ["صادرة من", "الرقم الضريبي", "السجل التجاري"]) {
      assert.ok(!h.includes(label), `${label} does not belong on a document that is not a tax invoice`);
    }
    assert.ok(h.includes('<div class="qr"></div>'), "the QR slot must be empty");
  });

  it("still states the invoice number, the date, the line and the total", () => {
    const h = render();
    assert.ok(h.includes("SUB-000042"));
    assert.ok(h.includes("2026/9/4"));
    assert.ok(h.includes("4,830.00"));
  });
});

/**
 * An auditor recomputing the VAT line must not find it inconsistent. The
 * charged amount is VAT-inclusive, so the split does not always reproduce the
 * configured rate at the two decimals the document prints — and where it does
 * not, the document states the label without a percentage rather than a
 * percentage that is wrong.
 */
describe("the VAT rate is printed only when the printed figures reproduce it", () => {
  it("agrees with the rate recovered from the two amounts, to two decimals", () => {
    // 4200 × 15% = 630 exactly.
    assert.equal(vatRateMatchesAmounts(4200, 630, 15), true);
    // 217.39 + 32.61 = 250.00; 32.61 / 217.39 = 14.9998% → 15.00%.
    assert.equal(vatRateMatchesAmounts(217.39, 32.61, 15), true);
    // 0.87 + 0.13 = 1.00; 0.13 / 0.87 = 14.94%, which is not 15%.
    assert.equal(vatRateMatchesAmounts(0.87, 0.13, 15), false);
    // Nothing to divide by — no rate can be recovered, so none is claimed.
    assert.equal(vatRateMatchesAmounts(0, 0, 15), false);
  });

  it("prints «(15%)» on a split that really is 15%", () => {
    asTaxInvoice(() => {
      const d = svc.buildData(paidRow({ amount: "4830.00" }), buyer());
      assert.equal(d.vat?.ratePrinted, true);
      const h = renderSubscriptionInvoiceHtml(d);
      assert.ok(h.includes("ضريبة القيمة المضافة (15%)"), "the rate holds, so state it");
    });
  });

  it("drops the percentage on the 1.00 SAR charge, whose split is 14.94%", () => {
    asTaxInvoice(() => {
      const d = svc.buildData(paidRow({ amount: "1.00" }), buyer());
      assert.equal(d.subtotal, 0.87);
      assert.equal(d.vat?.amount, 0.13);
      assert.equal(d.vat?.ratePrinted, false);
      const h = renderSubscriptionInvoiceHtml(d);
      assert.ok(h.includes("ضريبة القيمة المضافة:"), "the VAT line is still stated");
      assert.ok(!h.includes("(15%)"), "but not at a rate the figures contradict");
      // Any rate at all, not just 15 — the label carries no parenthesis.
      assert.doesNotMatch(h, /ضريبة القيمة المضافة\s*\(/, "and at no other rate either");
    });
  });
});

describe("renderSubscriptionInvoiceHtml — rendering hygiene", () => {
  const html = () => {
    let h = "";
    asPlainInvoice(() => { h = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer())); });
    return h;
  };

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
    asPlainInvoice(() => {
      const h = renderSubscriptionInvoiceHtml({
        ...svc.buildData(paidRow(), buyer()),
        lines: [{ description: "<script>x</script>", quantity: 1, unitPrice: 1, amount: 1 }],
      });
      assert.ok(!h.includes("<script>x</script>"));
      assert.ok(h.includes("&lt;script&gt;"));
    });
  });

  it("escapes a seller name that contains markup", () => {
    asTaxInvoice(() => {
      const h = renderSubscriptionInvoiceHtml(svc.buildData(paidRow(), buyer()));
      assert.ok(!h.includes("<b>x</b>"));
    }, { DARA_SELLER_NAME: "<b>x</b>" });
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
  it("is drawn on the document when the VAT number is configured", () => {
    asTaxInvoice(() => {
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
    asTaxInvoice(() => {
      const d = svc.buildData(paidRow({ amount: "4830.00" }), buyer());
      const tags = decodeTlv(buildPhase1Tlv({
        sellerName: SELLER.name, vatNumber: SELLER.vat,
        timestamp: new Date(paidRow().paidAt).toISOString(),
        totalWithVat: d.total.toFixed(2), vatTotal: (d.vat?.amount ?? 0).toFixed(2),
      }));
      assert.equal(tags[1], SELLER.name);
      assert.equal(tags[2], SELLER.vat);
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(tags[3]), `tag 3 must be ISO-8601, got ${tags[3]}`);
      assert.equal(tags[4], "4830.00");
      assert.equal(tags[5], "630.00");
      assert.equal(Number(tags[4]), d.total);
      assert.equal(Number(tags[5]), d.vat?.amount);
    });
  });

  /**
   * A QR scanning to an empty VAT registration looks official and certifies
   * nothing, so an unconfigured seller must produce NO code rather than a
   * hollow one.
   */
  it("is omitted entirely when the VAT number is not configured", () => {
    asPlainInvoice(() => {
      const d = svc.buildData(paidRow(), buyer());
      assert.equal(d.qrSvg, null);
      // The container stays (it anchors the totals to the left) but is empty.
      assert.ok(renderSubscriptionInvoiceHtml(d).includes('<div class="qr"></div>'), "the QR slot must be empty");
    });
  });
});

/* ── issue(): the send is checked, and a dry run touches nothing ───────────── */

/**
 * A Drizzle stand-in covering exactly the two shapes the service uses:
 * `select().from(t).where()` and `update(t).set(v).where()`, the latter both
 * awaited directly and with `.returning()`. Every `set` is recorded, so a test
 * can assert what was written — and, for the dry run, that nothing was.
 */
function fakeDb(opts: { row: any; user?: any; company?: any }) {
  const writes: any[] = [];
  let current: any = opts.row ? { ...opts.row } : undefined;
  const db: any = {
    select: () => ({
      from: (t: any) => ({
        where: async () => {
          if (t === subscriptionPaymentsTable) return current ? [current] : [];
          if (t === usersTable) return opts.user ? [opts.user] : [];
          if (t === companiesTable) return opts.company ? [opts.company] : [];
          return [];
        },
      }),
    }),
    update: (_t: any) => ({
      set: (values: any) => ({
        where: (_w: any) => {
          writes.push(values);
          current = { ...current, ...values };
          const p: any = Promise.resolve([current]);
          p.returning = async () => [current];
          return p;
        },
      }),
    }),
  };
  return { db, writes, row: () => current };
}

function harness(opts: { sent: boolean; row?: any }) {
  // `row: null` means "no such payment", so it must not fall back to a default.
  const row = "row" in opts ? opts.row : paidRow();
  const sends: any[] = [];
  const logs: any[] = [];
  const pdf = { htmlToPdf: async (_html: string) => Buffer.from("%PDF-1.4 pretend\n") } as any;
  const email = {
    isConfigured: () => opts.sent,
    sendSubscriptionInvoice: async (to: string, name: string, payload: any) => {
      sends.push({ to, name, payload });
      return opts.sent;
    },
  } as any;
  const appLog = { record: (e: any) => logs.push(e) } as any;
  const store = fakeDb({
    row,
    user: { id: 1, name: "عبدالسلام", email: "a@example.com", companyId: null },
  });
  return { svc: new SubscriptionInvoiceService(pdf, email, appLog), sends, logs, ...store };
}

describe("issue() — a send that did not happen is never logged as one", () => {
  /**
   * `EmailService.send` returns false both when RESEND_API_KEY is missing and
   * when Resend answers non-2xx, and never throws. The boolean used to be
   * discarded and the success line logged unconditionally, so a total failure
   * was indistinguishable from a delivery.
   */
  it("reports failure, stamps no delivery, and records it where an admin can see it", async () => {
    const h = harness({ sent: false });
    const res = await h.svc.issue(h.db, 42, {});

    assert.equal(res.ok, false);
    assert.equal(res.reason, "send_failed");
    assert.ok(!h.writes.some((w) => "invoiceEmailedAt" in w), "nothing may claim the invoice was delivered");
    assert.equal(h.row().invoiceEmailedAt, null);

    const failure = h.logs.find((l) => l.event === "subscription_invoice_email_failed");
    assert.ok(failure, "the failure must reach app_logs, not only stdout");
    assert.equal(failure.level, "error");
    assert.equal(failure.meta.paymentId, 42, "findable by payment id");
    assert.equal(failure.meta.invoiceNumber, "SUB-000042", "and by invoice number");
    assert.equal(failure.userId, 1);
  });

  it("still stamps the number, so the failure is legible and the document retrievable", async () => {
    const h = harness({ sent: false });
    await h.svc.issue(h.db, 42, {});
    // Numbered but not delivered — the state the new column exists to express.
    assert.equal(h.row().invoiceNumber, "SUB-000042");
    assert.ok(h.row().invoiceIssuedAt instanceof Date);
    assert.equal(h.row().invoiceEmailedAt, null);
  });

  it("stamps the delivery only once the sender confirms it", async () => {
    const h = harness({ sent: true });
    const res = await h.svc.issue(h.db, 42, {});
    assert.equal(res.ok, true);
    assert.ok(h.writes.some((w) => w.invoiceEmailedAt instanceof Date), "a confirmed send is recorded");
    assert.ok(!h.logs.some((l) => l.event === "subscription_invoice_email_failed"));
  });

  it("sends to an explicit recipient when one is given, never to the account", async () => {
    const h = harness({ sent: true });
    await h.svc.issue(h.db, 42, { to: "abdulsalam@daam.sa" });
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].to, "abdulsalam@daam.sa");
  });

  it("refuses a row that is not paid, and one that does not exist", async () => {
    const pending = harness({ sent: true, row: paidRow({ status: "pending" }) });
    assert.equal((await pending.svc.issue(pending.db, 42, {})).reason, "not_paid");
    assert.equal(pending.writes.length, 0);

    const missing = harness({ sent: true, row: null });
    assert.equal((await missing.svc.issue(missing.db, 42, {})).reason, "no_row");
  });

  it("re-issues an already-numbered row without re-dating it", async () => {
    const issuedAt = new Date("2026-06-01T00:00:00Z");
    const h = harness({ sent: true, row: paidRow({ invoiceNumber: "SUB-000042", invoiceIssuedAt: issuedAt }) });
    const res = await h.svc.issue(h.db, 42, {});
    assert.equal(res.ok, true);
    assert.equal(res.invoiceNumber, "SUB-000042");
    assert.equal(h.row().invoiceIssuedAt.getTime(), issuedAt.getTime(), "the customer's copy must not be re-dated");
  });
});

describe("issue({ dryRun: true }) — renders, returns, and writes nothing", () => {
  it("writes nothing to the database and sends nothing", async () => {
    const h = harness({ sent: true });
    const res = await h.svc.issue(h.db, 42, { dryRun: true });

    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.deepEqual(h.writes, [], "a dry run must not write a single column");
    assert.equal(h.sends.length, 0, "and must not send anything");
    assert.equal(h.row().invoiceNumber, null, "the row is untouched");
    assert.equal(h.row().invoiceEmailedAt, null);
  });

  it("returns the PDF's size and the resolved document, so it can be checked first", async () => {
    const h = harness({ sent: true });
    const res = await h.svc.issue(h.db, 42, { dryRun: true });
    assert.ok((res.pdfBytes ?? 0) > 0, "the PDF really was rendered");
    assert.equal(res.invoiceNumber, "SUB-000042");
    assert.equal(res.data?.invoiceNumber, "SUB-000042");
    assert.equal(res.data?.total, 4830);
  });

  it("reports the recipient it would have used, including an override", async () => {
    const h = harness({ sent: true });
    assert.equal((await h.svc.issue(h.db, 42, { dryRun: true })).to, "a@example.com");
    assert.equal((await h.svc.issue(h.db, 42, { dryRun: true, to: "abdulsalam@daam.sa" })).to, "abdulsalam@daam.sa");
  });
});
