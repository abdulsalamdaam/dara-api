/**
 * E1 (DESIGN §9): the management fee. Legacy reads only the PROPERTY rate
 * (billing.module.ts maybeCreateCommissionInvoice, reports.module.ts revenue),
 * so a landlord-level fee is silently 0%. Under v2:
 *
 *   effective rate = the property rate if it is not null (an explicit 0 means
 *                    "no fee for this property"), otherwise the landlord rate,
 *                    otherwise none.
 *
 * and a v2 commission document is created on approval of a rent invoice or a
 * non-tax rent receipt: none for a principal landlord (a commission to
 * oneself), VAT only when the ACCOUNT is VAT-registered and linked to ZATCA
 * (legacy forces 15%; §9 E8 — a VAT-bearing commission is then refused at
 * approval until Q6b, since commission documents are never reported).
 * Money is computed in integer halalas.
 */
import { contractCtx, loadSettings } from "./hooks/facts-loader";
import { installmentNature } from "./hooks/classify";
import { fromHalalas, toHalalas, vatSplit } from "./money";
import type { Sql } from "./hooks/sql";
import { riyadhToday } from "./dates";
import { commissionCarriesVat } from "./account-seller";
import { propertyBasis } from "./commission-basis";

/** Is 0070 applied (the monthly run's counted lines)? */
async function hasRunItemsTable(q: Sql): Promise<boolean> {
  const [r] = await q.rows(`select to_regclass('finance_commission_run_items') is not null as ok`);
  return r?.ok === true;
}

export type FeeSource = "property" | "landlord" | null;
export interface EffectiveFee {
  /** The effective rate as a 2-decimal string ("5.00"), or null when none applies. */
  pct: string | null;
  source: FeeSource;
  propertyPct: string | null;
  landlordPct: string | null;
  ownerId: number | null;
  propertyId: number | null;
}

const norm = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : fromHalalas(toHalalas(String(v))));

/** The rule itself, pure: property if not null, else landlord, else none. */
export function effectiveRate(propertyPct: unknown, landlordPct: unknown): { pct: string | null; source: FeeSource } {
  const p = norm(propertyPct);
  if (p != null) return { pct: p, source: "property" };
  const l = norm(landlordPct);
  if (l != null) return { pct: l, source: "landlord" };
  return { pct: null, source: null };
}

/** The effective fee of a property (its own rate, else its landlord's). */
export async function effectiveFeeForProperty(q: Sql, scope: number, propertyId: number): Promise<EffectiveFee | null> {
  const [r] = await q.rows(
    `select p.id, p.owner_id, p.management_fee_percent::text as ppct, o.management_fee_percent::text as lpct
       from properties p left join owners o on o.id = p.owner_id and o.user_id = p.user_id
      where p.id = $1 and p.user_id = $2`,
    [propertyId, scope],
  );
  if (!r) return null;
  const e = effectiveRate(r.ppct, r.lpct);
  return { ...e, propertyPct: norm(r.ppct), landlordPct: norm(r.lpct), ownerId: r.owner_id ?? null, propertyId: Number(r.id) };
}

/**
 * The effective fee of a contract: its property (frozen dims first, then the
 * first unit, as the reports do) and that property's landlord; with no
 * property, the landlord the dims resolved.
 */
export async function effectiveManagementFee(q: Sql, scope: number, contractId: number): Promise<EffectiveFee> {
  const [r] = await q.rows(
    `select coalesce(d.property_id, (select u.property_id from contract_units cu join units u on u.id = cu.unit_id
                                        where cu.contract_id = c.id order by cu.unit_id limit 1)) as property_id,
            d.owner_id
       from contracts c left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where c.id = $1 and c.user_id = $2`,
    [contractId, scope],
  );
  const none: EffectiveFee = { pct: null, source: null, propertyPct: null, landlordPct: null, ownerId: r?.owner_id ?? null, propertyId: null };
  if (!r) return none;
  if (r.property_id) {
    const f = await effectiveFeeForProperty(q, scope, Number(r.property_id));
    if (f) return f;
  }
  if (r.owner_id) {
    const [o] = await q.rows(`select management_fee_percent::text as lpct from owners where id = $1 and user_id = $2`, [r.owner_id, scope]);
    const e = effectiveRate(null, o?.lpct);
    return { ...none, ...e, landlordPct: norm(o?.lpct) };
  }
  return none;
}

export { accountVatRegistered, accountZatcaIntegrated, commissionCarriesVat, ownFeeCarriesVat } from "./account-seller";

/** pct (a decimal string, ≤ 2 dp) of a halala amount, rounded half-up to the halala. */
export function pctOf(baseHalalas: number, pct: string): number {
  const bp = toHalalas(pct); // basis points × 1 (pct × 100)
  return Math.floor((baseHalalas * bp + 5000) / 10000);
}

export interface CommissionPlan {
  pct: string;
  source: FeeSource;
  base: string;
  net: string;
  vat: string;
  total: string;
  vatRegistered: boolean;
}

/**
 * What the v2 commission on a rent document would be, or null (principal
 * landlord, no effective rate, no rent base). Base = the pre-VAT RENT of the
 * covered installments (fee rows excluded), exactly as legacy defines it.
 */
export async function planCommission(q: Sql, scope: number, doc: { contractId: number | null; paymentIds: number[] }): Promise<CommissionPlan | null> {
  if (!doc.contractId || !doc.paymentIds.length) return null;
  const s = await loadSettings(q, scope);
  if (!s) return null;
  const ctx = await contractCtx(q, scope, s.mode, doc.contractId);
  if (!ctx || ctx.treatment === "principal") return null;
  const fee = await effectiveManagementFee(q, scope, doc.contractId);
  // On the COLLECTED basis commission is issued by the monthly run (commission-run.ts), never per rent document.
  // The basis is the PROPERTY's own when it has one, else the account's (commission-basis.ts, finding 9).
  if ((await propertyBasis(q, scope, fee.propertyId)).basis === "collected") return null;
  if (!fee.pct || !(toHalalas(fee.pct) > 0)) return null;
  // An installment a live monthly run already counted (the property was on "collected" then) is never charged again.
  const runItems = await hasRunItemsTable(q);
  const rows = await q.rows(
    `select amount::text as amount, description, vat_enabled from payments p where p.user_id = $1 and p.id = any($2::int[]) and p.deleted_at is null
        ${runItems ? `and not exists (select 1 from finance_commission_run_items i where i.user_id = p.user_id and i.payment_id = p.id and i.live)` : ""}`,
    [scope, doc.paymentIds],
  );
  let base = 0;
  for (const p of rows) {
    if (installmentNature(p.description) !== "rent") continue;
    const g = toHalalas(p.amount);
    base += p.vat_enabled === true ? vatSplit(g).net : g;
  }
  if (base <= 0) return null;
  const net = pctOf(base, fee.pct);
  if (net <= 0) return null;
  // VAT whenever the office is VAT-registered (account-seller.ts `commissionCarriesVat`);
  // an unlinked office's commission stays a draft tax invoice until it is linked.
  const vatRegistered = await commissionCarriesVat(q, scope);
  const vat = vatRegistered ? Math.floor((net * 15 + 50) / 100) : 0;
  return { pct: fee.pct, source: fee.source, base: fromHalalas(base), net: fromHalalas(net), vat: fromHalalas(vat), total: fromHalalas(net + vat), vatRegistered };
}

/** Next number in a per-account prefix series (MAX+1 over `<prefix>-######`, like legacy). */
export async function nextDocNumber(q: Sql, scope: number, prefix: string): Promise<string> {
  const [r] = await q.rows(
    `select coalesce(max(cast(substring(number from '[0-9]+$') as integer)), 0) as m from simple_invoices
      where user_id = $1 and number like $2`,
    [scope, `${prefix}-%`],
  );
  return `${prefix}-${String(Number(r?.m ?? 0) + 1).padStart(6, "0")}`;
}

/**
 * Create the draft v2 commission document for an approved rent document
 * (idempotent: one COM per rent document number). Returns the new row's id,
 * or null when no commission applies.
 */
export async function createCommissionV2(q: Sql, scope: number, rentDoc: {
  id: number; number: string; contractId: number | null; paymentId: number | null; paymentIds: number[] | null; dueDate: string | null;
}): Promise<number | null> {
  const paymentIds = rentDoc.paymentIds?.length ? rentDoc.paymentIds.map(Number) : rentDoc.paymentId ? [Number(rentDoc.paymentId)] : [];
  const plan = await planCommission(q, scope, { contractId: rentDoc.contractId, paymentIds });
  if (!plan) return null;
  const fee = await effectiveManagementFee(q, scope, Number(rentDoc.contractId));
  const [dup] = await q.rows(
    `select id from simple_invoices where user_id = $1 and kind = 'commission' and type = 'invoice' and billing_reference = $2 and deleted_at is null limit 1`,
    [scope, rentDoc.number],
  );
  if (dup) return null;
  const [c] = await q.rows(
    `select landlord_name, landlord_phone, landlord_email, landlord_address, landlord_tax_number from contracts where id = $1 and user_id = $2`,
    [rentDoc.contractId, scope],
  );
  if (!c) return null;
  const number = await nextDocNumber(q, scope, "COM");
  // The buyer is the landlord (the office bills him): named on the document so the ZATCA path can file it
  // under the office's seller with this landlord as the buyer (documents-v2.ts commissionZatcaDoc).
  const client = {
    ...(fee.ownerId ? { kind: "landlord", ownerId: Number(fee.ownerId) } : {}),
    ...(c.landlord_phone ? { phone: c.landlord_phone } : {}), ...(c.landlord_email ? { email: c.landlord_email } : {}),
    ...(c.landlord_address ? { address: c.landlord_address } : {}), ...(c.landlord_tax_number ? { vatNumber: c.landlord_tax_number } : {}),
  };
  const netNum = Number(plan.net);
  const items = [{ description: "عمولة إدارة الأملاك", quantity: 1, unitPrice: netNum, amount: netNum, vat: plan.vatRegistered, vatCategory: plan.vatRegistered ? "S" : "O" }];
  const src = plan.source === "landlord" ? "من المؤجر / from landlord" : "من العقار / from property";
  const [row] = await q.rows(
    `insert into simple_invoices (user_id, number, type, kind, status, contract_id, tenant_id, tenant_name, client, items,
                                  subtotal, total, issue_date, due_date, billing_reference, notes)
     values ($1, $2, 'invoice', 'commission', 'draft', $3, null, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
     returning id`,
    [scope, number, rentDoc.contractId, c.landlord_name ?? null, JSON.stringify(client), JSON.stringify(items), plan.net, plan.total,
      riyadhToday(), rentDoc.dueDate ?? null, rentDoc.number,
      `عمولة إدارة بنسبة ${plan.pct}% (${src}) على المستند ${rentDoc.number}`],
  );
  return Number(row.id);
}

/**
 * E36: a credit note approved on a rent invoice that has a CONFIRMED
 * commission document → a draft commission credit note for the
 * rent-proportional share (credit note subtotal / rent invoice subtotal of
 * the COM subtotal, same VAT rate as the COM). Idempotent per credit note.
 */
export async function createCommissionCreditV2(q: Sql, scope: number, creditNote: {
  id: number; number: string; type: string; billingReference: string | null; subtotal: string;
}): Promise<number | null> {
  if (creditNote.type !== "credit" || !creditNote.billingReference) return null;
  const [rent] = await q.rows(
    `select id, subtotal::text as subtotal, kind from simple_invoices where user_id = $1 and number = $2 and type = 'invoice'
        and status = 'confirmed' and deleted_at is null limit 1`,
    [scope, creditNote.billingReference],
  );
  if (!rent || rent.kind === "commission" || !(toHalalas(rent.subtotal) > 0)) return null;
  const [com] = await q.rows(
    `select id, number, contract_id, tenant_name, client, subtotal::text as subtotal, total::text as total from simple_invoices
      where user_id = $1 and kind = 'commission' and type = 'invoice' and status = 'confirmed' and deleted_at is null and billing_reference = $2
      order by id limit 1`,
    [scope, creditNote.billingReference],
  );
  if (!com) return null;
  const [dup] = await q.rows(
    `select id from simple_invoices where user_id = $1 and type = 'credit' and kind = 'commission' and billing_reference = $2
        and deleted_at is null and notes like $3 limit 1`,
    [scope, com.number, `%${creditNote.number}%`],
  );
  if (dup) return null;
  const comNet = toHalalas(com.subtotal);
  const ratioNum = Math.min(toHalalas(creditNote.subtotal), toHalalas(rent.subtotal));
  const net = Math.floor((comNet * ratioNum * 2 + toHalalas(rent.subtotal)) / (2 * toHalalas(rent.subtotal)));
  if (net <= 0) return null;
  const hasVat = toHalalas(com.total) > comNet;
  const vat = hasVat ? Math.floor((net * 15 + 50) / 100) : 0;
  const number = await nextDocNumber(q, scope, "CRN");
  const netNum = Number(fromHalalas(net));
  const items = [{ description: "تعديل عمولة إدارة الأملاك", quantity: 1, unitPrice: netNum, amount: netNum, vat: hasVat }];
  const [row] = await q.rows(
    `insert into simple_invoices (user_id, number, type, kind, status, contract_id, tenant_id, tenant_name, client, items,
                                  subtotal, total, issue_date, billing_reference, notes)
     values ($1, $2, 'credit', 'commission', 'draft', $3, null, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
    [scope, number, com.contract_id, com.tenant_name, JSON.stringify(com.client ?? {}), JSON.stringify(items),
      fromHalalas(net), fromHalalas(net + vat), riyadhToday(), com.number,
      `إشعار دائن للعمولة مقابل ${creditNote.number} · Commission credit for ${creditNote.number}`],
  );
  return Number(row.id);
}
