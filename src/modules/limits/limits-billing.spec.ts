import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addonCharge, addonDescription, remainingMonths } from "./limits-billing.service";
import { EmailService } from "../email/email.service";

const D = (s: string) => new Date(s);

describe("add-on pricing", () => {
  it("remainingMonths: calendar months to the period end, rounded up, at least 1", () => {
    const now = D("2026-10-26T10:00:00Z");
    assert.equal(remainingMonths(null, now), 1, "no end date → one month");
    assert.equal(remainingMonths(D("2026-10-20T00:00:00Z"), now), 1, "already ended → 1");
    assert.equal(remainingMonths(D("2026-10-27T00:00:00Z"), now), 1, "one day left → 1");
    assert.equal(remainingMonths(D("2026-11-26T10:00:00Z"), now), 1, "exactly one month");
    assert.equal(remainingMonths(D("2026-11-26T10:00:01Z"), now), 2, "a second over → 2");
    assert.equal(remainingMonths(D("2027-01-25T00:00:00Z"), now), 3);
    assert.equal(remainingMonths(D("2027-10-26T10:00:00Z"), now), 12, "a full year");
    assert.equal(remainingMonths(D("2026-02-28T00:00:00Z"), D("2026-01-31T00:00:00Z")), 1, "Jan 31 → Feb 28 is one month");
  });

  it("a seat add-on is the monthly price × remaining months, VAT on top", () => {
    const now = D("2026-10-26T10:00:00Z");
    const ends = D("2027-01-20T00:00:00Z"); // 3 months
    const c = addonCharge({ priceSar: "50.00", period: "subscription_period" }, ends, now, 15)!;
    assert.deepEqual(c, { net: 150, total: 172.5, vatRate: 15, months: 3 });
    const noVat = addonCharge({ priceSar: "50.00", period: "subscription_period" }, ends, now, null)!;
    assert.equal(noVat.total, 150);
  });

  it("a one-off pack is charged once, whatever the period", () => {
    const c = addonCharge({ priceSar: "99.99", period: "one_off" }, D("2027-10-01T00:00:00Z"), D("2026-10-26T00:00:00Z"), 15)!;
    assert.deepEqual(c, { net: 99.99, total: 114.99, vatRate: 15, months: 1 });
  });

  it("no price → no charge", () => {
    assert.equal(addonCharge({ priceSar: null, period: "one_off" }, null), null);
  });

  it("the invoice line names packs from the catalog, or the limit and quantity", () => {
    const seat = { key: "seat_1", limitKey: "users" as const, quantity: 1, priceSar: 50, period: "subscription_period" as const, labelAr: "مستخدم إضافي", labelEn: "Extra user", active: true };
    assert.equal(addonDescription({ limitKey: "users", quantity: 2, period: "subscription_period" }, seat, 3), "إضافة على الباقة: مستخدم إضافي × 2 — 3 أشهر");
    assert.equal(addonDescription({ limitKey: "users", quantity: 1, period: "subscription_period" }, seat, 1), "إضافة على الباقة: مستخدم إضافي — شهر واحد");
    const pack = { ...seat, key: "ejar_50", limitKey: "ejar_lookups" as const, quantity: 50, period: "one_off" as const, labelAr: "50 استعلام إيجار" };
    assert.equal(addonDescription({ limitKey: "ejar_lookups", quantity: 100, period: "one_off" }, pack, 1), "إضافة على الباقة: 50 استعلام إيجار × 2");
    assert.equal(addonDescription({ limitKey: "ejar_lookups", quantity: 30, period: "one_off" }, null, 1), "إضافة على الباقة: استعلامات إيجار +30");
  });
});

/**
 * The limit emails, rendered with the sender stubbed: nothing leaves the
 * machine. Addressed to the account holder's test mailbox only.
 */
describe("limit emails (stubbed sender)", () => {
  const TO = "abdulsalam@daam.sa";
  const svc = () => {
    const out: any[] = [];
    const e = new EmailService(null as any);
    (e as any).send = async (input: any) => { out.push(input); return true; };
    return { e, out };
  };

  it("offer: items, amount incl. VAT, the billing page and the expiry, AR + EN", async () => {
    const { e, out } = svc();
    const ok = await e.sendLimitAddonOffer(TO, "شركة تجريبية", {
      items: [{ labelAr: "مستخدم إضافي", labelEn: "Extra user", quantity: 2 }],
      amountInclVat: 172.5, expiresAt: D("2026-11-09T12:00:00Z"), note: "<b>x</b>",
    });
    assert.equal(ok, true);
    assert.equal(out.length, 1);
    const m = out[0];
    assert.equal(m.to, TO);
    assert.equal(m.category, "limits-addon-offer");
    assert.match(m.subject, /بانتظار الدفع/);
    assert.match(m.subject, /ready to pay/);
    assert.match(m.html, /مستخدم إضافي/);
    assert.match(m.html, /Extra user × 2/);
    assert.match(m.html, /172\.50 ر\.س/);
    assert.match(m.html, /2026-11-09/);
    assert.match(m.html, /\/dashboard\/settings\?section=billing/);
    assert.ok(!m.html.includes("<b>x</b>"), "the note is escaped");
    assert.match(m.text, /section=billing/);
  });

  it("limits changed: old → new per key, unlimited spelled out, the note", async () => {
    const { e, out } = svc();
    await e.sendLimitsChanged(TO, "", {
      changes: [
        { labelAr: "المستخدمون", labelEn: "Users", oldValue: 2, newValue: 5 },
        { labelAr: "المؤجرون", labelEn: "Landlords", oldValue: 1, newValue: null },
      ],
      note: "ترقية مؤقتة",
    });
    const m = out[0];
    assert.equal(m.category, "limits-changed");
    assert.match(m.html, /2 → 5/);
    assert.match(m.html, /1 → غير محدود · Unlimited/);
    assert.match(m.html, /ترقية مؤقتة/);
    assert.match(m.text, /Users\): 2 → 5/);
    assert.equal(await e.sendLimitsChanged(TO, "", { changes: [], note: null }), false, "nothing changed → nothing sent");
    assert.equal(out.length, 1);
  });

  it("expired: the item and the end date", async () => {
    const { e, out } = svc();
    await e.sendLimitAddonExpired(TO, "x", { items: [{ labelAr: "50 استعلام إيجار", labelEn: "50 Ejar lookups", quantity: 1 }], endedAt: D("2026-12-31T20:59:00Z") });
    const m = out[0];
    assert.equal(m.category, "limits-addon-expired");
    assert.match(m.html, /50 استعلام إيجار/);
    assert.match(m.html, /2026-12-31/);
  });

  it("the paid invoice email names an add-on item instead of the package", async () => {
    const { e, out } = svc();
    await e.sendSubscriptionInvoice(TO, "x", {
      invoiceNumber: "SUB-000007", planLabel: "أساسية", itemLabel: "إضافة على الباقة: مستخدم إضافي — شهر واحد",
      cycle: "quarterly", amount: 57.5, currencyLabel: "ر.س", periodEnd: D("2027-01-01T00:00:00Z"),
    }, Buffer.from("%PDF"));
    assert.match(out[0].html, /إضافة على الباقة: مستخدم إضافي/);
    assert.ok(!out[0].html.includes("أساسية"), "no package line on an add-on invoice");
  });
});
