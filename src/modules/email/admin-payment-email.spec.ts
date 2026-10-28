import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmailService } from "./email.service";

/**
 * The "a payment came in" admin email, rendered with the sender stubbed:
 * nothing leaves the machine. Addressed to the account holder's test mailbox.
 */
describe("admin payment email (stubbed sender)", () => {
  const TO = ["abdulsalam@daam.sa"];
  const svc = () => {
    const out: any[] = [];
    const e = new EmailService(null as any);
    (e as any).send = async (input: any) => { out.push(input); return true; };
    return { e, out };
  };
  const base = {
    paymentId: 42, plan: "professional", billingCycle: "yearly", amount: "1725.00", currency: "SAR",
    moyasarPaymentId: "pay_abc123", paidAt: new Date("2026-10-28T12:00:00Z"),
    accountId: 7, name: "<b>Ahmed</b>", email: "customer@example.com", phone: "+966500000000",
  };

  it("subscription: amount, customer, plan, Moyasar id, Riyadh time, admin link", async () => {
    const { e, out } = svc();
    assert.equal(await e.sendAdminPaymentReceived({ ...base, kind: "subscription", companyName: "شركة تجريبية" }, TO), true);
    const m = out[0];
    assert.deepEqual(m.to, TO);
    assert.equal(m.category, "admin_payment_received");
    assert.match(m.subject, /دفعة جديدة 1,725\.00 ر\.س — شركة تجريبية/);
    assert.match(m.html, /pay_abc123/);
    assert.match(m.html, /2026-10-28 15:00/);
    assert.match(m.html, /\/admin/);
    assert.match(m.html, /اشتراك باقة/);
    assert.equal(m.replyTo, "customer@example.com");
    assert.match(m.text, /حساب 7/);
  });

  it("add-on: shows the description instead of plan and cycle", async () => {
    const { e, out } = svc();
    await e.sendAdminPaymentReceived({ ...base, kind: "addon", description: "إضافة على الباقة: مستخدم إضافي × 2" }, TO);
    const m = out[0];
    assert.match(m.html, /إضافة على الحدود/);
    assert.match(m.html, /مستخدم إضافي × 2/);
    assert.ok(!m.html.includes("دورة الفوترة"), "no billing cycle row for an add-on");
  });

  it("escapes customer-supplied names", async () => {
    const { e, out } = svc();
    await e.sendAdminPaymentReceived({ ...base, kind: "subscription" }, TO);
    assert.ok(!out[0].html.includes("<b>Ahmed</b>"), "the name is escaped");
  });
});
