/**
 * R4 (VAT rules, Oct 2026): the brokerage / agency fee (السعي, AGF-) is the
 * OFFICE's supply to the TENANT — seller = the office, buyer = the tenant — and
 * follows the same rules as the office's commission (commission-approve.ts):
 *
 *  - office NOT VAT-registered → O, no VAT, "not a tax invoice"; approves; never
 *    sent to ZATCA.
 *  - office registered, NOT linked → 15% tax invoice, HELD as a draft: approval
 *    is refused (409, OFFICE_NOT_LINKED) until the office links to Fatoora.
 *  - office registered AND linked → 15% tax invoice; approves when the office's
 *    seller identity is complete, then is reported to ZATCA under the office's
 *    standalone seller with the tenant as buyer — standard for a company tenant
 *    (VAT number, or CR when unregistered), simplified for an individual (R3).
 *
 * The one verdict is `agencyFeeRouting` (office-supply.ts).
 */
import { ConflictException } from "@nestjs/common";
import type { Sql } from "../hooks/sql";
import { toHalalas } from "../money";
import { agencyFeeRouting, type OfficeSupplyMarker } from "../office-supply";
import { officeOf, type CommissionSellerIssue } from "./commission-approve";

const carriesVat = (doc: { subtotal?: unknown; total?: unknown }) => toHalalas(String(doc.total ?? "0")) > toHalalas(String(doc.subtotal ?? "0"));

/** The blockers on approving an agency-fee document (pure, for the spec). */
export function agencyFeeBlockers(
  doc: { subtotal?: unknown; total?: unknown },
  office: { vatRegistered: boolean; zatcaLinked: boolean; seller: { name: string | null; vat: string | null } | null },
): CommissionSellerIssue[] {
  const tax = carriesVat(doc);
  const route = agencyFeeRouting(office);
  if (tax && !office.vatRegistered) {
    return [{
      code: "OFFICE_NOT_VAT_REGISTERED",
      message: "المكتب غير مسجّل في ضريبة القيمة المضافة، فلا يصدر فاتورة ضريبية؛ احذف الضريبة من مستند أتعاب الوساطة · "
        + "The office is not VAT-registered, so it issues no tax invoice: remove the VAT from this brokerage-fee document",
    }];
  }
  if (!tax && route.carriesVat) {
    return [{
      code: "AGENCY_FEE_VAT_MISSING",
      message: "المكتب مسجّل ضريبياً ويلزمه إصدار فاتورة ضريبية بنسبة 15% لأتعاب الوساطة، وهذا المستند بلا ضريبة (أُنشئ قبل التعديل)؛ ألغِه وأعد إصداره · "
        + "The office is VAT-registered and must issue a 15% tax invoice for the brokerage fee; this document carries no VAT (created before the change): cancel it and issue it again",
    }];
  }
  if (!tax) return [];
  if (route.approve === "hold_not_linked") {
    return [{
      code: "OFFICE_NOT_LINKED",
      message: "المكتب مسجّل ضريبياً فتصدر أتعاب الوساطة فاتورة ضريبية بنسبة 15%، لكنه غير مرتبط بهيئة الزكاة بعد؛ تبقى الفاتورة مسودة حتى يُربط المكتب بمنصة فاتورة ثم تُعتمد · "
        + "The office is VAT-registered, so the brokerage fee is a 15% tax invoice, but it is not linked to ZATCA yet: the invoice stays a draft until the office is linked to Fatoora, then it can be approved",
    }];
  }
  if (!office.seller?.name || !office.seller?.vat) {
    return [{
      code: "OFFICE_SELLER_INCOMPLETE",
      message: "بيانات المكتب كبائع في إعدادات هيئة الزكاة ناقصة (الاسم أو الرقم الضريبي) · "
        + "The office's seller details in the ZATCA settings are incomplete (name or VAT number)",
    }];
  }
  return [];
}

/** The approve guard for an `agency_fee` document (v2 approve, before anything is written). */
export async function guardAgencyFeeApprove(q: Sql, scope: number, doc: any): Promise<void> {
  if (doc?.kind !== "agency_fee" || doc?.type !== "invoice") return;
  const office = await officeOf(q, scope);
  const blockers = agencyFeeBlockers(doc, office);
  if (!blockers.length) return;
  throw new ConflictException({
    error: "FINANCE_V2_TAX_DOC_NOT_REPORTABLE",
    code: blockers[0].code,
    message: blockers.map((b) => b.message).join(" — "),
    linked: office.zatcaLinked,
    blockers,
  });
}

/**
 * The document the ZATCA submission should see for an agency fee, or null
 * (any other document; a non-VAT fee, which is never sent; an office that is
 * not registered and linked). Filed as a free invoice under the office's
 * standalone seller (contractId null → resolveStandaloneSellerId), the tenant
 * as buyer — the tenants row first, the contract's tenant snapshot as the
 * fallback for identity and address — with the R3 marker.
 */
export async function agencyFeeZatcaDocV2(q: Sql, scope: number, doc: any): Promise<any | null> {
  if (doc?.kind !== "agency_fee" || !carriesVat(doc)) return null;
  const office = await officeOf(q, scope);
  if (!agencyFeeRouting(office).sendToZatca) return null;
  const [c] = doc.contractId
    ? await q.rows(
      `select tenant_type, tenant_name, tenant_id_number, tenant_tax_number, tenant_address, tenant_postal_code,
              tenant_additional_number, tenant_building_number
         from contracts where id = $1 and user_id = $2`,
      [doc.contractId, scope])
    : [];
  const [t] = doc.tenantId
    ? await q.rows(`select type::text as type from tenants where id = $1 and user_id = $2`, [doc.tenantId, scope])
    : [];
  const pick = (v: unknown) => (v == null || String(v).trim() === "" ? undefined : String(v).trim());
  const client: Record<string, unknown> = { ...(doc.client ?? {}) };
  const fallback: Record<string, unknown> = {
    name: pick(c?.tenant_name ?? doc.tenantName), type: pick(t?.type ?? c?.tenant_type), idNumber: pick(c?.tenant_id_number),
    vatNumber: pick(c?.tenant_tax_number), street: pick(c?.tenant_address), postalCode: pick(c?.tenant_postal_code),
    additionalNumber: pick(c?.tenant_additional_number), buildingNumber: pick(c?.tenant_building_number),
  };
  for (const [k, v] of Object.entries(fallback)) if (client[k] == null && v !== undefined) client[k] = v;
  const officeSupply: OfficeSupplyMarker = { buyerType: (t?.type as string | undefined) ?? pick(c?.tenant_type) ?? null };
  return { ...doc, kind: "invoice", contractId: null, client, officeSupply };
}
