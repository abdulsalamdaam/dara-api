import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";

import { validateReceiptVoucher } from "./billing.module";

/**
 * `POST /simple-invoices/receipt-voucher` writes its row `status: "confirmed"`
 * — issued, immutable, undeletable, submittable — without ever running the
 * invoice-readiness gate, on the grounds that a سند قبض is not a tax document.
 * It ran no validation at all to make that true. These are the requests that
 * used to be accepted.
 */
describe("validateReceiptVoucher — the total has to follow from the lines", () => {
  it("refuses the request that minted ~999,899 of VAT out of nothing", () => {
    // The one from the audit, verbatim. `total` was taken from the request
    // while `subtotal` was derived from the items, and VAT is read everywhere
    // downstream as total − subtotal — so this stored a confirmed tax document
    // claiming almost a million riyals of VAT against a hundred riyals of
    // goods, on a path with no gate and no way to delete the result.
    assert.throws(
      () => validateReceiptVoucher({ amount: 999999, items: [{ amount: 100, vat: true }] }),
      BadRequestException,
    );
  });

  it("refuses a total that overshoots its lines by a single riyal", () => {
    // Not only the spectacular case: any gap is money the document invents.
    assert.throws(() => validateReceiptVoucher({ amount: 101, items: [{ amount: 100 }] }), BadRequestException);
  });

  it("refuses a total that undershoots its lines", () => {
    // The other direction matters too — the collections recorded below the
    // handler are distributed against `amount`, so a voucher whose lines say
    // more than was received settles installments with money nobody paid.
    assert.throws(() => validateReceiptVoucher({ amount: 50, items: [{ amount: 100 }] }), BadRequestException);
  });

  it("accepts a voucher whose lines add up", () => {
    const v = validateReceiptVoucher({ amount: 300, items: [{ amount: 100 }, { amount: 200 }] });
    assert.equal(v.amount, 300);
    assert.equal(v.subtotal, 300);
  });

  it("does not ask a plain voucher for 15% it never charged", () => {
    // `normalizeItems` defaults a line with no `vat` flag to TRUE, which is the
    // legacy behaviour on the INVOICE path. If the voucher path inherited that,
    // every existing caller — the web sends no items and no flags — would start
    // being refused for not adding VAT to a receipt. Voucher lines are forced
    // exempt, so the rule reduces to "the amount received is the sum of what it
    // is a receipt for".
    const v = validateReceiptVoucher({ amount: 100, items: [{ amount: 100 }] });
    assert.equal(v.items.every((it) => it.vat === false), true);
  });

  it("builds a single exempt line when the caller sends none", () => {
    // The shape every real caller uses today (the web sends amount + a
    // description). It must keep working exactly as before.
    const v = validateReceiptVoucher({ amount: 2500, description: "دفعة إيجار" });
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0]!.amount, 2500);
    assert.equal(v.items[0]!.vat, false);
    assert.equal(v.subtotal, 2500);
  });

  it("refuses negative figures", () => {
    // A negative receipt is a refund wearing a receipt's number, and it would
    // subtract from the installment it is recorded against.
    assert.throws(() => validateReceiptVoucher({ amount: -100 }), BadRequestException);
    assert.throws(
      () => validateReceiptVoucher({ amount: 0, items: [{ amount: -100 }, { amount: 100 }] }),
      BadRequestException,
    );
  });

  it("refuses a missing or unreadable amount", () => {
    for (const amount of [undefined, null, 0, "abc", NaN, Infinity]) {
      assert.throws(() => validateReceiptVoucher({ amount }), BadRequestException, String(amount));
    }
  });
});

/**
 * The kind is what buys this path its exemption from the readiness gate, so it
 * cannot be the caller's to choose. It was `body?.kind ?? "receipt"` with no
 * check whatsoever.
 */
describe("validateReceiptVoucher — the kind decides whether a gate applies", () => {
  it("refuses the one-call route to a confirmed tax invoice", () => {
    // `kind: "invoice"` is a TAX invoice. Through this endpoint it arrived
    // already confirmed, having faced neither the create-time nor the
    // approve-time readiness gate, and was then submittable to ZATCA.
    assert.throws(() => validateReceiptVoucher({ amount: 100, kind: "invoice" }), BadRequestException);
  });

  it("refuses every other kind the product knows, and one it does not", () => {
    // `manual` and `commission` are real kinds elsewhere in the module — they
    // are simply not vouchers. An unrecognised string must be refused for the
    // same reason: it used to be stored verbatim and to skip the gates.
    for (const kind of ["manual", "commission", "credit", "anything", "receipts", 42]) {
      assert.throws(() => validateReceiptVoucher({ amount: 100, kind }), BadRequestException, String(kind));
    }
  });

  it("defaults to a receipt when the caller says nothing", () => {
    // Which is every caller in the product today, including `create()`'s
    // diversion of a deposit installment.
    assert.equal(validateReceiptVoucher({ amount: 100 }).kind, "receipt");
    assert.equal(validateReceiptVoucher({ amount: 100, kind: null }).kind, "receipt");
    assert.equal(validateReceiptVoucher({ amount: 100, kind: "" }).kind, "receipt");
  });

  it("allows the two kinds a voucher can honestly be", () => {
    assert.equal(validateReceiptVoucher({ amount: 100, kind: "receipt" }).kind, "receipt");
    assert.equal(validateReceiptVoucher({ amount: 100, kind: " deposit " }).kind, "deposit");
  });
});
