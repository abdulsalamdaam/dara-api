/**
 * E8 and E9 (DESIGN §9): the two v2-only document kinds.
 *
 *  - `rent_receipt` "سند استلام إيجار — مستند غير ضريبي / Rent receipt — not a
 *    tax invoice": for a seller landlord WITHOUT a VAT number (a registrant
 *    must issue tax invoices; 400). RR-######, category O, no VAT, no QR, never
 *    sent to ZATCA. Approval posts E08 (charges its installments like E01)
 *    and triggers the v2 commission (E1).
 *  - `agency_fee` "أتعاب الوساطة (السعي) / Brokerage fee": the account's own
 *    supply billed to the tenant, AGF-######, 15% only when the account is
 *    VAT-registered (else O). A VAT-bearing AGF is refused at approval while
 *    the account is ZATCA-integrated (409 FINANCE_V2_TAX_DOC_NOT_REPORTABLE;
 *    a 15% document that never reaches Fatoora is not a valid tax invoice).
 *    Approval posts E17.
 *
 * Both are approved by `approveV2Kind` (the legacy approve forks to it at the
 * top), which never calls the ZATCA orchestration. No ZATCA file is touched.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { simpleInvoicesTable } from "@dara/database";
import { accountVatRegistered, accountZatcaIntegrated, createCommissionV2, nextDocNumber } from "../commission";
import { captureDims } from "../hooks/facts-loader";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { DEPOSIT_DESC } from "./reads";
import type { Sql } from "../hooks/sql";

export const RENT_RECEIPT_LABEL = { ar: "سند استلام إيجار — مستند غير ضريبي", en: "Rent receipt — not a tax invoice" } as const;
export const AGENCY_FEE_LINE = "أتعاب الوساطة (السعي) / Brokerage fee";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The row as the web reads documents (camelCase, dates as YYYY-MM-DD, money as strings). */
export async function docById(q: Sql, scope: number, id: number): Promise<any | null> {
  const [r] = await q.rows(
    `select id, user_id, number, type::text as type, status::text as status, kind, contract_id, payment_id, payment_ids, tenant_id, tenant_name,
            client, items, subtotal::text as subtotal, total::text as total, to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(due_date,'YYYY-MM-DD') as due_date, confirmed_at, to_char(paid_date,'YYYY-MM-DD') as paid_date, zatca_status,
            receipt_number, billing_reference, notes, created_at, updated_at
       from simple_invoices where id = $1 and user_id = $2 and deleted_at is null`,
    [id, scope],
  );
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, number: r.number, type: r.type, status: r.status, kind: r.kind, contractId: r.contract_id,
    paymentId: r.payment_id, paymentIds: r.payment_ids, tenantId: r.tenant_id, tenantName: r.tenant_name, client: r.client,
    items: r.items, subtotal: r.subtotal, total: r.total, issueDate: r.issue_date, dueDate: r.due_date, confirmedAt: r.confirmed_at,
    paidDate: r.paid_date, zatcaStatus: r.zatca_status, receiptNumber: r.receipt_number, billingReference: r.billing_reference,
    notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    label: r.kind === "rent_receipt" ? RENT_RECEIPT_LABEL : null,
  };
}

/** The seller landlord of a contract (frozen dims first) and whether it is VAT-registered. */
async function sellerOf(q: Sql, scope: number, contractId: number): Promise<{ ownerId: number | null; name: string | null; idNumber: string | null; vatRegistered: boolean }> {
  await captureDims(q, scope, contractId);
  const [r] = await q.rows(
    `select o.id, o.name, o.id_number, nullif(trim(coalesce(o.tax_number,'')),'') is not null as reg
       from finance_contract_dims d left join owners o on o.id = d.owner_id and o.user_id = d.user_id
      where d.contract_id = $1 and d.user_id = $2`,
    [contractId, scope],
  );
  return { ownerId: r?.id ?? null, name: r?.name ?? null, idNumber: r?.id_number ?? null, vatRegistered: r?.reg === true };
}

/**
 * POST /finance/v2/rent-receipts {paymentIds, issueDate?, notes?} → a DRAFT
 * rent receipt covering those installments (same contract; not deposits,
 * cancelled or externally settled; not already on a live charge document).
 */
export async function createRentReceipt(q: Sql, scope: number, body: any) {
  const ids: number[] = Array.isArray(body?.paymentIds) ? body.paymentIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "حدد الأقساط · paymentIds is required" });
  const uniq = [...new Set(ids)];
  const rows = await q.rows(
    `select p.id, p.contract_id, p.amount::text as amount, to_char(p.due_date,'YYYY-MM-DD') as due, p.status::text as status, p.description
       from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
      where p.user_id = $1 and p.id = any($2::int[]) and p.deleted_at is null and c.deleted_at is null order by p.due_date, p.id`,
    [scope, uniq],
  );
  if (rows.length !== uniq.length) throw new NotFoundException("Installment not found");
  const contractId = Number(rows[0].contract_id);
  if (rows.some((r: any) => Number(r.contract_id) !== contractId)) {
    throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "يجب أن تتبع الأقساط عقداً واحداً · All installments must belong to one contract" });
  }
  const bad = rows.filter((r: any) => r.description === DEPOSIT_DESC || ["cancelled", "settled_external"].includes(r.status));
  if (bad.length) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "قسط غير قابل للإيصال · An installment cannot be receipted", paymentIds: bad.map((r: any) => r.id) });
  const covered = await q.rows(
    `select id, number from simple_invoices si where si.user_id = $1 and si.deleted_at is null and si.status <> 'cancelled' and si.type = 'invoice'
        and coalesce(si.kind, 'invoice') in ('invoice','manual','rent_receipt')
        and (si.payment_id = any($2::int[]) or exists (select 1 from jsonb_array_elements_text(coalesce(si.payment_ids, '[]'::jsonb)) x
                                                         where x::int = any($2::int[])))`,
    [scope, uniq],
  );
  if (covered.length) {
    throw new ConflictException({ error: "FINANCE_V2_ALREADY_DOCUMENTED", message: "القسط مغطى بمستند قائم · An installment is already on a document", documents: covered.map((d: any) => d.number) });
  }
  const seller = await sellerOf(q, scope, contractId);
  if (seller.vatRegistered) {
    throw new BadRequestException({
      error: "FINANCE_V2_SELLER_VAT_REGISTERED",
      message: "المؤجر مسجّل في ضريبة القيمة المضافة؛ يلزم إصدار فاتورة ضريبية · The landlord is VAT-registered and must issue a tax invoice",
    });
  }
  const issueDate = typeof body?.issueDate === "string" && ISO.test(body.issueDate) ? body.issueDate : riyadhToday();
  const [c] = await q.rows(`select tenant_id, tenant_name from contracts where id = $1 and user_id = $2`, [contractId, scope]);
  const items = rows.map((r: any) => {
    const amt = Number(fromHalalas(toHalalas(r.amount)));
    return { description: `إيجار — قسط ${r.due} / Rent — installment due ${r.due}`, quantity: 1, unitPrice: amt, amount: amt, vat: false, vatCategory: "O" };
  });
  const total = fromHalalas(rows.reduce((s: number, r: any) => s + toHalalas(r.amount), 0));
  const number = await nextDocNumber(q, scope, "RR");
  const client = { sellerName: seller.name, sellerIdNumber: seller.idNumber, ownerId: seller.ownerId, nonTax: true };
  const [row] = await q.rows(
    `insert into simple_invoices (user_id, number, type, kind, status, contract_id, payment_id, payment_ids, tenant_id, tenant_name, client, items,
                                  subtotal, total, issue_date, due_date, notes)
     values ($1, $2, 'invoice', 'rent_receipt', 'draft', $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10, $10, $11, $12, $13) returning id`,
    [scope, number, contractId, uniq.length === 1 ? uniq[0] : null, JSON.stringify(rows.map((r: any) => Number(r.id))), c?.tenant_id ?? null,
      c?.tenant_name ?? null, JSON.stringify(client), JSON.stringify(items), total, issueDate, rows[0].due,
      typeof body?.notes === "string" ? body.notes.slice(0, 1000) : `${RENT_RECEIPT_LABEL.ar} · ${RENT_RECEIPT_LABEL.en}`],
  );
  return docById(q, scope, Number(row.id));
}

/**
 * E8: the draft brokerage-fee document of a contract (idempotent: at most one
 * live AGF per contract). Returns the row, or null when the contract has no fee.
 */
export async function ensureAgencyFeeDraft(q: Sql, scope: number, contractId: number): Promise<any | null> {
  const [c] = await q.rows(
    `select id, tenant_id, tenant_name, agency_fee::text as fee, to_char(start_date,'YYYY-MM-DD') as start
       from contracts where id = $1 and user_id = $2 and deleted_at is null`,
    [contractId, scope],
  );
  if (!c) throw new NotFoundException("Contract not found");
  const fee = c.fee == null ? 0 : toHalalas(c.fee);
  if (!(fee > 0)) return null;
  const [existing] = await q.rows(
    `select id from simple_invoices where user_id = $1 and contract_id = $2 and kind = 'agency_fee' and deleted_at is null and status <> 'cancelled' limit 1`,
    [scope, contractId],
  );
  if (existing) return { existing: true, ...(await docById(q, scope, Number(existing.id))) };
  const reg = await accountVatRegistered(q, scope);
  const vat = reg ? Math.floor((fee * 15 + 50) / 100) : 0;
  const net = Number(fromHalalas(fee));
  const items = [{ description: AGENCY_FEE_LINE, quantity: 1, unitPrice: net, amount: net, vat: reg, vatCategory: reg ? "S" : "O" }];
  const number = await nextDocNumber(q, scope, "AGF");
  const [row] = await q.rows(
    `insert into simple_invoices (user_id, number, type, kind, status, contract_id, tenant_id, tenant_name, client, items, subtotal, total,
                                  issue_date, due_date, notes)
     values ($1, $2, 'invoice', 'agency_fee', 'draft', $3, $4, $5, '{}'::jsonb, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
    [scope, number, contractId, c.tenant_id ?? null, c.tenant_name ?? null, JSON.stringify(items), fromHalalas(fee), fromHalalas(fee + vat),
      riyadhToday(), c.start, reg ? AGENCY_FEE_LINE : `${AGENCY_FEE_LINE} — ليس فاتورة ضريبية / not a tax invoice`],
  );
  return docById(q, scope, Number(row.id));
}

/** GET /finance/v2/agency-fees/unbilled: contracts with a fee and no live AGF document. */
export async function unbilledAgencyFees(q: Sql, scope: number) {
  const rows = await q.rows(
    `select c.id, c.contract_number, c.tenant_name, c.agency_fee::text as fee, to_char(c.start_date,'YYYY-MM-DD') as start, c.status::text as status
       from contracts c where c.user_id = $1 and c.deleted_at is null and coalesce(c.agency_fee, 0) > 0
        and not exists (select 1 from simple_invoices si where si.user_id = c.user_id and si.contract_id = c.id and si.kind = 'agency_fee'
                         and si.deleted_at is null and si.status <> 'cancelled')
      order by c.id`,
    [scope],
  );
  return {
    rows: rows.map((r: any) => ({ contractId: r.id, contractNumber: r.contract_number, tenantName: r.tenant_name, agencyFee: fromHalalas(toHalalas(r.fee)), startDate: r.start, status: r.status })),
    total: fromHalalas(rows.reduce((s: number, r: any) => s + toHalalas(r.fee), 0)),
  };
}

/**
 * The v2 approve of a `rent_receipt` / `agency_fee` (the legacy approve forks
 * here at the top). Confirms the draft, emits the ledger event (E08/E17) via
 * `emitConfirmed`, and for a rent receipt creates the v2 commission. Never
 * calls ZATCA: `zatca` is null, `zatcaStatus` stays null. Returns the legacy
 * approve's shape `{ ...document, commission, zatca }`.
 */
export async function approveV2Kind(
  q: Sql, db: any, scope: number, doc: any, emitConfirmed: (documentId: number) => Promise<void>,
): Promise<any> {
  const subtotal = toHalalas(String(doc.subtotal ?? "0"));
  const total = toHalalas(String(doc.total ?? "0"));
  const items: any[] = Array.isArray(doc.items) ? doc.items : [];
  const itemsSum = items.reduce((s, it) => s + toHalalas(String(it?.amount ?? 0)), 0);
  if (!(total > 0) || total < subtotal || itemsSum !== subtotal) {
    throw new BadRequestException({ error: "FINANCE_V2_BAD_DOCUMENT", message: "مبالغ المستند غير متسقة · The document's amounts do not add up" });
  }
  if (doc.kind === "rent_receipt") {
    if (total !== subtotal) throw new BadRequestException({ error: "FINANCE_V2_BAD_DOCUMENT", message: "سند الإيجار غير الضريبي لا يحمل ضريبة · A non-tax rent receipt carries no VAT" });
    if (doc.contractId) {
      const seller = await sellerOf(q, scope, Number(doc.contractId));
      if (seller.vatRegistered) {
        throw new BadRequestException({ error: "FINANCE_V2_SELLER_VAT_REGISTERED", message: "المؤجر مسجّل في ضريبة القيمة المضافة؛ يلزم إصدار فاتورة ضريبية · The landlord is VAT-registered and must issue a tax invoice" });
      }
    }
  }
  if (doc.kind === "agency_fee" && total > subtotal && (await accountZatcaIntegrated(q, scope))) {
    throw new ConflictException({
      error: "FINANCE_V2_TAX_DOC_NOT_REPORTABLE",
      message: "لا يمكن اعتماد مستند خاضع للضريبة لا يُرسل إلى هيئة الزكاة أثناء المرحلة التجريبية · "
        + "A VAT-bearing document that is not reported to ZATCA cannot be approved during the beta",
    });
  }
  const [updated] = await db.update(simpleInvoicesTable).set({ status: "confirmed", confirmedAt: new Date() } as any)
    .where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, scope))).returning();
  await emitConfirmed(updated.id);
  let commission: any = null;
  if (doc.kind === "rent_receipt") {
    const comId = await createCommissionV2(q, scope, {
      id: doc.id, number: doc.number, contractId: doc.contractId ?? null, paymentId: doc.paymentId ?? null,
      paymentIds: Array.isArray(doc.paymentIds) ? doc.paymentIds : null, dueDate: doc.dueDate ?? null,
    }).catch(() => null);
    if (comId) [commission] = await db.select().from(simpleInvoicesTable).where(and(eq(simpleInvoicesTable.id, comId), eq(simpleInvoicesTable.userId, scope)));
  }
  return { ...updated, commission: commission ?? null, zatca: null };
}
