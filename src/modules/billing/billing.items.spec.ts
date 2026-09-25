import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeItems } from "./billing.module";

/**
 * `normalizeItems` is the one gate every billing line passes on its way to the
 * database and, later, to `zatcaLinesFromDoc`. Whatever it drops, ZATCA never
 * sees — which is how `vatCategory` once went missing and every VAT-free line
 * became "exempt, real estate". These pin down what it keeps of BT-120.
 */
describe("normalizeItems — the landlord's own out-of-scope wording (BT-120)", () => {
  const oos = { description: "رسوم حكومية مستردة", amount: 250, vat: false, vatCategory: "O", exemptionReason: "VATEX-SA-OOS" };

  it("keeps it on an O line, trimmed", () => {
    const [it0] = normalizeItems([{ ...oos, exemptionReasonText: "  رسوم مستردة بالتكلفة & <دون هامش>  " }]);
    assert.equal(it0.exemptionReasonText, "رسوم مستردة بالتكلفة & <دون هامش>");
    assert.equal(it0.exemptionReason, "VATEX-SA-OOS");
  });

  it("keeps it on an O line that states no code — OOS is O's only one", () => {
    const [it0] = normalizeItems([{ ...oos, exemptionReason: undefined, exemptionReasonText: "خارج النطاق" }]);
    assert.equal(it0.exemptionReasonText, "خارج النطاق");
  });

  it("caps it at 300 characters", () => {
    const [it0] = normalizeItems([{ ...oos, exemptionReasonText: "x".repeat(400) }]);
    assert.equal(it0.exemptionReasonText!.length, 300);
  });

  it("drops it when empty or not a string", () => {
    assert.equal("exemptionReasonText" in normalizeItems([{ ...oos, exemptionReasonText: "   " }])[0], false);
    assert.equal("exemptionReasonText" in normalizeItems([{ ...oos, exemptionReasonText: 7 }])[0], false);
    assert.equal("exemptionReasonText" in normalizeItems([oos])[0], false);
  });

  it("drops it on E and Z lines — their text is the code's official one", () => {
    const [e, z] = normalizeItems([
      { description: "إيجار سكني", amount: 1000, vat: false, vatCategory: "E", exemptionReason: "VATEX-SA-30", exemptionReasonText: "إيجار معفى" },
      { description: "خدمة مصدرة", amount: 500, vat: false, vatCategory: "Z", exemptionReason: "VATEX-SA-33", exemptionReasonText: "تصدير" },
    ]);
    assert.equal(e.exemptionReasonText, undefined);
    assert.equal(z.exemptionReasonText, undefined);
    assert.equal(e.exemptionReason, "VATEX-SA-30", "the code itself still travels");
  });

  it("drops it on a legacy line with no category (derived S or E, never O)", () => {
    const [legacy] = normalizeItems([{ description: "مياه", amount: 50, vat: false, exemptionReasonText: "خارج النطاق" }]);
    assert.equal(legacy.exemptionReasonText, undefined);
  });
});
