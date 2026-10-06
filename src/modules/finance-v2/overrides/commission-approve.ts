/**
 * Approving a commission document validates the OFFICE — the seller — and
 * nothing else (accountant's test, 5 Oct 2026, finding 1; DESIGN §9 E1-E).
 *
 * A commission invoice (فاتورة عمولة) is billed BY the office TO the landlord.
 * Neither the contract's tenant nor the landlord's own VAT registration or
 * ZATCA link has anything to do with issuing it, so:
 *
 *  - office NOT VAT-registered (or not linked to ZATCA): the document is a
 *    non-tax commission document (category O, no VAT, "ليس فاتورة ضريبية").
 *    Nothing is demanded; it approves.
 *  - office VAT-registered AND linked: the document is a tax invoice in the
 *    office's name (15%), reported to ZATCA under the office's own seller with
 *    the landlord as the buyer (standard/cleared when the landlord has a VAT
 *    number, simplified/reported otherwise). It approves when the office's
 *    seller identity is complete and the landlord buyer can be named.
 *  - a document that carries VAT although the office cannot issue a tax
 *    invoice (not registered, or not linked: DARA-NOTES §2b-iii) is refused,
 *    naming the office's missing registration / link and "remove the VAT".
 *
 * The landlord's VAT number is never demanded (it only decides standard vs
 * simplified), nor the landlord's ZATCA link, nor any tenant confirmation.
 * `commissionSellerCheck` is the one verdict: the approve guard refuses on it
 * and `GET /finance/v2/commission-documents/:id/seller-check` shows it to the
 * approve dialog, so the two cannot drift.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Sql } from "../hooks/sql";
import { accountVatRegistered, accountZatcaIntegrated } from "../account-seller";
import { effectiveManagementFee } from "../commission";
import { toHalalas } from "../money";

export interface CommissionSellerIssue {
  code: string;
  message: string;
}

export interface CommissionSellerCheck {
  documentId: number;
  number: string;
  /** What the document is: a tax invoice in the office's name, or a non-tax commission document. */
  document: "tax" | "non_tax";
  office: { name: string | null; vatRegistered: boolean; vatNumber: string | null; zatcaLinked: boolean };
  /** The landlord billed (the buyer); his VAT number only decides the ZATCA profile. */
  buyer: { ownerId: number | null; name: string | null; vatNumber: string | null; profile: "standard" | "simplified" | null; addressComplete: boolean | null };
  ok: boolean;
  blockers: CommissionSellerIssue[];
  /** Informative, never block approval. */
  notices: CommissionSellerIssue[];
}

const carriesVat = (doc: { subtotal?: unknown; total?: unknown }) => toHalalas(String(doc.total ?? "0")) > toHalalas(String(doc.subtotal ?? "0"));

/** The landlord a commission document bills: `client.ownerId`, else the contract's landlord (frozen dims, else its property's). */
export async function commissionBuyerOwnerId(q: Sql, scope: number, doc: any): Promise<number | null> {
  const o = Number(doc?.client?.ownerId);
  if (Number.isInteger(o) && o > 0) return o;
  if (!doc?.contractId) return null;
  const fee = await effectiveManagementFee(q, scope, Number(doc.contractId));
  return fee.ownerId ? Number(fee.ownerId) : null;
}

/** The office (the account) as the seller of its own commission. */
async function officeOf(q: Sql, scope: number) {
  const [r] = await q.rows(
    `select coalesce(nullif(trim(c.name),''), nullif(trim(u.name),'')) as name,
            coalesce(nullif(trim(c.vat_number),''),
                     (select nullif(trim(o.tax_number),'') from owners o where o.user_id = u.id and o.deleted_at is null
                         and (o.is_account_holder or o.is_default) and nullif(trim(coalesce(o.tax_number,'')),'') is not null
                       order by o.is_account_holder desc, o.id limit 1)) as vat
       from users u left join companies c on c.id = u.company_id where u.id = $1`,
    [scope],
  );
  // The seller identity ZATCA files under: the account-level credentials, else the account holder's (resolveStandaloneSellerId).
  const [z] = await q.rows(
    `select nullif(trim(coalesce(z.seller_name,'')),'') as seller_name, nullif(trim(coalesce(z.seller_vat_number,'')),'') as seller_vat
       from zatca_credentials z where z.user_id = $1 and z.deleted_at is null
        and (z.owner_id is null or z.owner_id in (select id from owners where user_id = $1 and is_account_holder))
      order by (z.owner_id is null) desc, z.id limit 1`,
    [scope],
  );
  return {
    name: (r?.name as string | null) ?? null,
    vatNumber: (r?.vat as string | null) ?? null,
    vatRegistered: await accountVatRegistered(q, scope),
    zatcaLinked: await accountZatcaIntegrated(q, scope),
    seller: z ? { name: z.seller_name as string | null, vat: z.seller_vat as string | null } : null,
  };
}

/** The one verdict on approving a commission document (invoice or credit note). */
export async function commissionSellerCheck(q: Sql, scope: number, doc: any): Promise<CommissionSellerCheck> {
  const office = await officeOf(q, scope);
  const tax = carriesVat(doc);
  const ownerId = await commissionBuyerOwnerId(q, scope, doc);
  const [b] = ownerId
    ? await q.rows(
      `select name, nullif(trim(coalesce(tax_number,'')),'') as tax,
              (nullif(trim(coalesce(national_address_street,'')),'') is not null and nullif(trim(coalesce(building_number,'')),'') is not null
               and nullif(trim(coalesce(national_address_city,'')),'') is not null and nullif(trim(coalesce(national_address_district,'')),'') is not null
               and nullif(trim(coalesce(postal_code,'')),'') is not null) as addr
         from owners where id = $1 and user_id = $2`,
      [ownerId, scope])
    : [];
  const blockers: CommissionSellerIssue[] = [];
  const notices: CommissionSellerIssue[] = [];
  if (tax) {
    if (!office.vatRegistered) {
      blockers.push({
        code: "OFFICE_NOT_VAT_REGISTERED",
        message: "المكتب غير مسجّل في ضريبة القيمة المضافة، فلا يصدر فاتورة ضريبية؛ احذف الضريبة من مستند العمولة · "
          + "The office is not VAT-registered, so it issues no tax invoice: remove the VAT from this commission document",
      });
    } else if (!office.zatcaLinked) {
      blockers.push({
        code: "OFFICE_NOT_LINKED",
        message: "المكتب غير مرتبط بهيئة الزكاة، فلا يصدر فاتورة ضريبية؛ اربط المكتب بفاتورة أو احذف الضريبة من المستند · "
          + "The office is not linked to ZATCA, so it issues no tax invoice: link the office to Fatoora, or remove the VAT from this document",
      });
    } else if (!office.seller?.name || !office.seller?.vat) {
      blockers.push({
        code: "OFFICE_SELLER_INCOMPLETE",
        message: "بيانات المكتب كبائع في إعدادات هيئة الزكاة ناقصة (الاسم أو الرقم الضريبي) · "
          + "The office's seller details in the ZATCA settings are incomplete (name or VAT number)",
      });
    }
    if (!ownerId || !b) {
      blockers.push({
        code: "COMMISSION_BUYER_UNRESOLVED",
        message: "تعذّر تحديد المؤجر المفوتر في فاتورة العمولة · The landlord billed by this commission invoice could not be determined",
      });
    } else if (b.tax && b.addr !== true) {
      notices.push({
        code: "BUYER_ADDRESS_INCOMPLETE",
        message: "المؤجر مسجّل ضريبياً فتصدر له فاتورة ضريبية قياسية، وعنوانه الوطني ناقص؛ ستُعتمد الفاتورة لكن إرسالها للهيئة يحتاج العنوان · "
          + "The landlord is VAT-registered (a standard invoice) and his national address is incomplete: the invoice approves, but its ZATCA clearance needs the address",
      });
    }
  } else if (office.vatRegistered && !office.zatcaLinked) {
    notices.push({
      code: "OFFICE_REGISTERED_NOT_LINKED",
      message: "المكتب مسجّل ضريبياً وغير مرتبط بهيئة الزكاة، لذا تصدر العمولة مستنداً غير ضريبي حتى يرتبط · "
        + "The office is VAT-registered but not linked to ZATCA, so the commission is issued as a non-tax document until it is linked",
    });
  }
  return {
    documentId: Number(doc.id), number: String(doc.number ?? ""),
    document: tax ? "tax" : "non_tax",
    office: { name: office.name, vatRegistered: office.vatRegistered, vatNumber: office.vatNumber, zatcaLinked: office.zatcaLinked },
    buyer: {
      ownerId, name: b?.name ?? null, vatNumber: b?.tax ?? null,
      profile: tax && b ? (b.tax ? "standard" : "simplified") : null, addressComplete: b ? b.addr === true : null,
    },
    ok: blockers.length === 0,
    blockers,
    notices,
  };
}

/**
 * The approve guard for a commission INVOICE under v2 (a commission credit
 * note is never refused: it reverses VAT already booked, E36). 409
 * `FINANCE_V2_TAX_DOC_NOT_REPORTABLE` (the code the client already knows),
 * carrying the full verdict.
 */
export async function guardCommissionSeller(q: Sql, scope: number, doc: any): Promise<void> {
  if (doc?.kind !== "commission" || doc?.type !== "invoice") return;
  if (!carriesVat(doc)) return;
  const check = await commissionSellerCheck(q, scope, doc);
  if (check.ok) return;
  throw new ConflictException({
    error: "FINANCE_V2_TAX_DOC_NOT_REPORTABLE",
    message: check.blockers.map((x) => x.message).join(" — "),
    linked: check.office.zatcaLinked,
    sellerCheck: check,
  });
}

/** GET /finance/v2/commission-documents/:id/seller-check. */
export async function commissionSellerCheckById(q: Sql, scope: number, id: number): Promise<CommissionSellerCheck> {
  const [d] = await q.rows(
    `select id, number, type::text as type, kind, contract_id as "contractId", client, subtotal::text as subtotal, total::text as total
       from simple_invoices where id = $1 and user_id = $2 and deleted_at is null`,
    [id, scope],
  );
  if (!d || d.kind !== "commission") throw new NotFoundException("Commission document not found");
  return commissionSellerCheck(q, scope, d);
}

/**
 * The document the ZATCA submission should see for a commission document,
 * or null (any other document, which keeps its own path): the free invoice
 * billed TO the landlord, which files under the office's standalone seller
 * with the landlord as the buyer. The monthly landlord document (no contract)
 * always takes it, as before; a contract-bound (billed-basis) one only when
 * it carries VAT — a non-tax document is still never sent.
 */
export async function commissionZatcaDocV2(q: Sql, scope: number, doc: any): Promise<any | null> {
  if (doc?.kind !== "commission") return null;
  if (doc.contractId != null && !carriesVat(doc)) return null;
  const ownerId = await commissionBuyerOwnerId(q, scope, doc);
  if (!ownerId) return null;
  return { ...doc, kind: "invoice", contractId: null, client: { ...(doc.client ?? {}), kind: "landlord", ownerId } };
}
