/**
 * Facts loaders (DESIGN §5.1 point 2, §5.2): read the SOURCE rows a legacy
 * handler just wrote and turn them into outbox events whose payload freezes
 * everything the rule needs (amounts as strings, dimensions, the
 * principal/agent treatment, VAT groups, the collection classification).
 * Ledger state (is it charged, how much advance VAT, unreleased 2131) is NOT
 * frozen here; the worker reads it at post time (§5.3).
 *
 * Every read goes through the caller's `Sql` handle, so inside a source
 * transaction the loader sees that transaction's uncommitted rows. Every id
 * is loaded with the account scope in the same `where`.
 */
import { resolveTreatment, SYS, classifyCollection, type AccountRef, type Dims, type OutboxPayload, type Treatment, type Usage, type AccountingMode } from "../rules";
import type { CollectionFacts, DepositMoneyFacts, DocumentFacts, ExpenseFacts, ForfeitFacts, InstallmentFacts, MoneyFacts } from "../rules";
import type { LedgerEvent } from "../ledger-emitter.service";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import type { Sql } from "./sql";
import { CONVERSION_NOTE, DEPOSIT_DESC, documentGroups, installmentNature, installmentVat, parseBusinessDate, usageOf } from "./classify";

export interface FinanceSettingsRow {
  mode: AccountingMode;
  deferRent: boolean;
  forfeitVat: "O" | "S" | "E";
  goLive: string | null;
  ledgerStarted: boolean;
}

export async function loadSettings(q: Sql, userId: number): Promise<FinanceSettingsRow | null> {
  const [r] = await q.rows(
    `select accounting_mode as mode, defer_rent_straight_line as defer, deposit_forfeit_vat as fv,
            to_char(ledger_go_live_date,'YYYY-MM-DD') as go_live, ledger_started_at is not null as started
       from finance_settings where account_user_id = $1 and finance_v2_enabled`,
    [userId],
  );
  if (!r) return null;
  return {
    mode: r.mode === "owner" ? "owner" : "manager",
    deferRent: r.defer !== false,
    forfeitVat: r.fv === "S" || r.fv === "E" ? r.fv : "O",
    goLive: r.go_live ?? null,
    ledgerStarted: r.started === true,
  };
}

// ─── Contract dimensions (§4.3) ─────────────────────────────────────────────

/**
 * Landlord fallbacks after the unit chain, id number and name (tier-3 round,
 * Phase-2 gap "terminated-contract landlord dimension"): a contract terminated
 * before Finance v2 was enabled has no contract_units left. In order:
 *  1. the landlord whose VAT number is the contract's landlord VAT number;
 *  2. the landlord on the ledger's own history of the contract (the most
 *     recent posted line carrying both, e.g. the opening entry);
 *  3. the account's only landlord, when it has exactly one.
 * `c` is the contracts row. A contract resolved without units is flagged
 * `dimension_inferred` by contractCtx.
 */
const LANDLORD_FALLBACK_SQL = `
  (select o.id from owners o where o.user_id = c.user_id and o.deleted_at is null
      and nullif(trim(coalesce(c.landlord_tax_number,'')),'') is not null
      and trim(coalesce(o.tax_number,'')) = trim(c.landlord_tax_number) order by o.id limit 1),
  (select l.owner_id from journal_lines l join owners o on o.id = l.owner_id and o.user_id = l.user_id
    where l.user_id = c.user_id and l.contract_id = c.id and l.owner_id is not null order by l.id desc limit 1),
  (select min(o.id) from owners o where o.user_id = c.user_id and o.deleted_at is null
    having count(*) = 1)`;

/** Property fallback: the ledger's history of the contract, then the landlord's only property. */
const PROPERTY_FALLBACK_SQL = `
  (select l.property_id from journal_lines l join properties p on p.id = l.property_id and p.user_id = l.user_id
    where l.user_id = c.user_id and l.contract_id = c.id and l.property_id is not null order by l.id desc limit 1)`;

/**
 * Fill the landlord / property of an existing dims row that has none (never
 * overwrites a value). Used by contractCtx for rows captured before the
 * fallbacks above existed, or before the ledger knew the contract.
 */
async function fillMissingDims(q: Sql, userId: number, contractId: number): Promise<void> {
  await q.exec(
    `update finance_contract_dims d
        set owner_id = coalesce(d.owner_id, x.owner_id), property_id = coalesce(d.property_id, x.property_id)
       from (select c.id,
                    coalesce(
                      (select o.id from owners o where o.user_id = c.user_id and o.deleted_at is null
                          and nullif(trim(coalesce(c.landlord_id_number,'')),'') is not null
                          and trim(coalesce(o.id_number,'')) = trim(c.landlord_id_number) order by o.id limit 1),
                      (select o.id from owners o where o.user_id = c.user_id and o.deleted_at is null
                          and nullif(trim(coalesce(c.landlord_name,'')),'') is not null
                          and lower(trim(o.name)) = lower(trim(c.landlord_name)) order by o.id limit 1),
                      ${LANDLORD_FALLBACK_SQL}) as owner_id,
                    ${PROPERTY_FALLBACK_SQL} as property_id
               from contracts c where c.id = $1 and c.user_id = $2) x
      where d.contract_id = x.id and d.user_id = $2 and (d.owner_id is null or d.property_id is null)
        and (x.owner_id is not null or x.property_id is not null)`,
    [contractId, userId],
  );
}

/**
 * Fill `finance_contract_dims` for one contract (or all of an account's when
 * `contractId` is null) from contract → contract_units → unit → property →
 * owner, falling back to the contract's landlord snapshot matched by id number
 * and then name (reports.module.ts landlordOf). `refresh` overwrites the
 * landlord/property/units of an existing row (a rebuild may change the units)
 * but never its `ended_on`, and never with an empty unit list.
 */
export async function captureDims(q: Sql, userId: number, contractId: number | null, opts: { refresh?: boolean } = {}): Promise<number> {
  const conflict = opts.refresh
    ? `on conflict (contract_id) do update set owner_id = excluded.owner_id, property_id = excluded.property_id,
         unit_ids = excluded.unit_ids, captured_at = now()
       where finance_contract_dims.user_id = excluded.user_id and cardinality(excluded.unit_ids) > 0`
    : `on conflict (contract_id) do nothing`;
  return q.exec(
    `insert into finance_contract_dims (contract_id, user_id, owner_id, property_id, unit_ids, ended_on)
     select c.id, c.user_id,
            coalesce(fu.owner_id,
              (select o.id from owners o where o.user_id = c.user_id and o.deleted_at is null
                  and nullif(trim(coalesce(c.landlord_id_number,'')),'') is not null
                  and trim(coalesce(o.id_number,'')) = trim(c.landlord_id_number) order by o.id limit 1),
              (select o.id from owners o where o.user_id = c.user_id and o.deleted_at is null
                  and nullif(trim(coalesce(c.landlord_name,'')),'') is not null
                  and lower(trim(o.name)) = lower(trim(c.landlord_name)) order by o.id limit 1),
              ${LANDLORD_FALLBACK_SQL}),
            coalesce(fu.property_id, ${PROPERTY_FALLBACK_SQL}),
            coalesce(us.ids, '{}'::int[]),
            case when c.status::text in ('terminated','cancelled') then (c.updated_at at time zone 'Asia/Riyadh')::date end
       from contracts c
       left join lateral (select array_agg(cu.unit_id order by cu.id) as ids from contract_units cu where cu.contract_id = c.id) us on true
       left join lateral (select u.property_id, p.owner_id from contract_units cu
                            join units u on u.id = cu.unit_id join properties p on p.id = u.property_id
                           where cu.contract_id = c.id order by cu.id limit 1) fu on true
      where c.user_id = $1 and ($2::int is null or c.id = $2::int)
     ${conflict}`,
    [userId, contractId],
  );
}

export interface ContractCtx {
  contractId: number;
  tenantId: number | null;
  ownerId: number | null;
  propertyId: number | null;
  unitId: number | null;
  treatment: Treatment;
  warnings: string[];
  usage: Usage | null;
  sellerRegistered: boolean;
  status: string;
  endDate: string | null;
  endedOn: string | null;
}

/** The frozen dimensions and treatment of one contract (captures dims when missing). */
export async function contractCtx(q: Sql, userId: number, mode: AccountingMode, contractId: number): Promise<ContractCtx | null> {
  let [c] = await q.rows(
    `select c.id, c.tenant_id, c.status::text as status, to_char(c.end_date,'YYYY-MM-DD') as end_date,
            d.owner_id, d.property_id, d.unit_ids, to_char(d.ended_on,'YYYY-MM-DD') as ended_on, d.contract_id is not null as has_dims
       from contracts c left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
      where c.id = $1 and c.user_id = $2`,
    [contractId, userId],
  );
  if (!c) return null;
  if (!c.has_dims || c.owner_id == null || c.property_id == null) {
    if (!c.has_dims) await captureDims(q, userId, contractId);
    else await fillMissingDims(q, userId, contractId);
    [c] = await q.rows(
      `select c.id, c.tenant_id, c.status::text as status, to_char(c.end_date,'YYYY-MM-DD') as end_date,
              d.owner_id, d.property_id, d.unit_ids, to_char(d.ended_on,'YYYY-MM-DD') as ended_on
         from contracts c join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
        where c.id = $1 and c.user_id = $2`,
      [contractId, userId],
    );
    if (!c) return null;
  }
  const units: number[] = Array.isArray(c.unit_ids) ? c.unit_ids.map(Number) : [];
  const warnings: string[] = [];
  if (!units.length && (c.owner_id != null || c.property_id != null)) warnings.push("dimension_inferred");
  if (units.length > 1) {
    const [n] = await q.rows(`select count(distinct property_id)::int as n from units where id = any($1::int[])`, [units]);
    if ((n?.n ?? 0) > 1) warnings.push("dimension_ambiguous");
  }
  const owner = c.owner_id
    ? (await q.rows(
        `select id, is_account_holder, nullif(trim(coalesce(tax_number,'')),'') is not null as registered
           from owners where id = $1 and user_id = $2`,
        [c.owner_id, userId],
      ))[0]
    : null;
  const t = resolveTreatment(mode, owner ? { id: owner.id, isAccountHolder: owner.is_account_holder === true } : null);
  warnings.push(...t.warnings);
  let usage: Usage | null = null;
  if (units[0]) {
    const [u] = await q.rows(
      `select (select l.key from lookups l where l.id = p.usage_lookup_id) as pkey,
              (select l.key from lookups l where l.id = u.usage_lookup_id) as ukey
         from units u join properties p on p.id = u.property_id where u.id = $1`,
      [units[0]],
    );
    if (u) usage = usageOf(u.pkey, u.ukey);
  }
  return {
    contractId, tenantId: c.tenant_id ?? null, ownerId: t.ownerId, propertyId: c.property_id ?? null, unitId: units[0] ?? null,
    treatment: t.treatment, warnings, usage, sellerRegistered: owner?.registered === true,
    status: c.status, endDate: c.end_date ?? null, endedOn: c.ended_on ?? null,
  };
}

/** Treatment for a landlord id directly (expenses, payouts, documents without a contract). */
async function ownerTreatment(q: Sql, userId: number, mode: AccountingMode, ownerId: number | null) {
  const owner = ownerId
    ? (await q.rows(`select id, is_account_holder from owners where id = $1 and user_id = $2`, [ownerId, userId]))[0]
    : null;
  return resolveTreatment(mode, owner ? { id: owner.id, isAccountHolder: owner.is_account_holder === true } : null);
}

export function dimsOf(ctx: ContractCtx | null, extra: Dims = {}): Dims {
  return {
    ownerId: ctx?.ownerId ?? null, propertyId: ctx?.propertyId ?? null, unitId: ctx?.unitId ?? null,
    tenantId: ctx?.tenantId ?? null, contractId: ctx?.contractId ?? null, ...extra,
  };
}

const ev = (sourceType: string, sourceId: number, event: string, payload: OutboxPayload): LedgerEvent =>
  ({ sourceType, sourceId, event, occurredOn: payload.facts.date, payload });

// ─── Collections (E03/E04/E09C/E12/E12B/E16 + E34), §4.4.1 ─────────────────

export async function collectionEvents(q: Sql, userId: number, s: FinanceSettingsRow, ids: number[]): Promise<LedgerEvent[]> {
  if (!ids.length) return [];
  const rows = await q.rows(
    `select pc.id, pc.payment_id, pc.amount::text as amount, to_char(pc.collected_date,'YYYY-MM-DD') as date, pc.method, pc.notes, pc.invoice_id,
            p.contract_id as p_contract, p.description as p_desc, p.vat_enabled as p_vat,
            si.kind as doc_kind, si.contract_id as doc_contract, to_char(si.issue_date,'YYYY-MM-DD') as doc_issue,
            m.classification, m.bank_account_id
       from payment_collections pc
       left join payments p on p.id = pc.payment_id and p.user_id = pc.user_id
       left join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
       left join finance_collection_meta m on m.collection_id = pc.id and m.user_id = pc.user_id
      where pc.user_id = $1 and pc.id = any($2::int[])
      order by pc.id`,
    [userId, ids],
  );
  const out: LedgerEvent[] = [];
  const ctxCache = new Map<number, ContractCtx | null>();
  for (const r of rows) {
    const amount = toHalalas(r.amount);
    const nature = r.payment_id ? installmentNature(r.p_desc) : null;
    const cls = classifyCollection({
      amount,
      metaClassification: r.classification ?? null,
      documentKind: r.doc_kind ?? null,
      paymentId: r.payment_id ?? null,
      paymentIsDeposit: nature === "deposit",
      looksLikeTerminateConversion: r.doc_kind === "deposit" && !r.payment_id && r.notes === CONVERSION_NOTE && !!r.doc_issue && r.date > r.doc_issue,
    });
    if (!cls.rule || !cls.cls) continue;
    const contractId: number | null = r.p_contract ?? r.doc_contract ?? null;
    let ctx: ContractCtx | null = null;
    if (contractId) {
      if (!ctxCache.has(contractId)) ctxCache.set(contractId, await contractCtx(q, userId, s.mode, contractId));
      ctx = ctxCache.get(contractId) ?? null;
    }
    const t = ctx ? { treatment: ctx.treatment, warnings: ctx.warnings } : resolveTreatment(s.mode, null);
    const vat = r.payment_id && nature !== "deposit"
      ? installmentVat({ vatEnabled: r.p_vat === true, usage: ctx?.usage ?? null, sellerRegistered: ctx?.sellerRegistered ?? false })
      : null;
    const facts: CollectionFacts = {
      date: r.date, treatment: t.treatment, dims: dimsOf(ctx, { paymentId: r.payment_id ?? null }),
      warnings: [...t.warnings, ...cls.warnings],
      collectionId: r.id, amount: r.amount, cls: cls.cls,
      bank: { bankAccountId: r.bank_account_id ?? null, method: r.method ?? null },
      paymentId: r.payment_id ?? null,
      category: vat?.category ?? null, rate: vat?.rate ?? null,
      forfeitVat: s.forfeitVat,
    };
    const paymentIds = r.payment_id ? [Number(r.payment_id)] : undefined;
    const event = cls.rule === "E12" ? "deposit_converted" : "collected";
    out.push(ev("payment_collection", r.id, event, { rule: cls.rule, facts, paymentIds }));
    // E34: VAT at the earliest tax point on an S installment (§4.1). The rule
    // reads the charge state at post time and skips `already_charged`; a
    // negative collection reverses what was booked.
    if (r.payment_id && vat?.category === "S" && (cls.rule === "E03" || cls.rule === "E04")) {
      out.push(ev("payment_collection", r.id, "advance_vat", { rule: "E34", facts, paymentIds }));
    }
  }
  return out;
}

// ─── Documents (E01/E06/E07/E15/E36, E09 voucher) ──────────────────────────

const CHARGE_KINDS = new Set(["invoice", "manual"]);

export async function documentEvents(q: Sql, userId: number, s: FinanceSettingsRow, docId: number,
  opts: { includeReturnedDeposit?: boolean } = {}): Promise<LedgerEvent[]> {
  const [d] = await q.rows(
    `select id, type::text as type, kind, status::text as status, items, subtotal::text as subtotal, total::text as total,
            to_char(coalesce(issue_date, (confirmed_at at time zone 'Asia/Riyadh')::date),'YYYY-MM-DD') as date,
            to_char(coalesce(paid_date, issue_date, (confirmed_at at time zone 'Asia/Riyadh')::date),'YYYY-MM-DD') as paid_on,
            contract_id, payment_id, payment_ids, tenant_id, number, billing_reference, client, payment_method,
            (select m.bank_account_id from finance_document_meta m where m.document_id = simple_invoices.id and m.user_id = simple_invoices.user_id) as bank_account_id
       from simple_invoices where id = $1 and user_id = $2 and deleted_at is null`,
    [docId, userId],
  );
  // The backfill (§6.3) also posts the E09 of a deposit voucher that was later cancelled by a refund.
  const returnedDeposit = opts.includeReturnedDeposit === true && d?.kind === "deposit" && d?.status === "cancelled";
  if (!d || (d.status !== "confirmed" && !returnedDeposit)) return [];
  const kind: string = d.kind ?? "invoice";
  const ctx = d.contract_id ? await contractCtx(q, userId, s.mode, Number(d.contract_id)) : null;
  const clientOwner = Number(d.client?.ownerId);
  const t = ctx
    ? { treatment: ctx.treatment, warnings: ctx.warnings }
    : await ownerTreatment(q, userId, s.mode, Number.isInteger(clientOwner) && clientOwner > 0 ? clientOwner : null);
  const dims = dimsOf(ctx, { tenantId: d.tenant_id ?? ctx?.tenantId ?? null });

  if (d.type === "invoice" && kind === "receipt") return []; // E30: its collections post
  if (d.type === "invoice" && kind === "deposit") {
    const [linked] = await q.rows(
      `select coalesce(sum(amount), 0)::text as s from payment_collections where user_id = $1 and invoice_id = $2 and payment_id is not null`,
      [userId, d.id],
    );
    const unlinked = toHalalas(d.total) - toHalalas(linked.s);
    const facts: DepositMoneyFacts = {
      date: d.paid_on, treatment: t.treatment, dims, warnings: t.warnings,
      documentId: d.id, amount: fromHalalas(Math.max(0, unlinked)),
      bank: d.bank_account_id != null ? { bankAccountId: Number(d.bank_account_id), method: d.payment_method ?? null } : { method: d.payment_method ?? null },
    };
    return [ev("simple_invoice", d.id, "deposit_received", { rule: "E09", facts })];
  }

  // Coverage: the document's own installments; a note falls back to its original invoice's.
  let ref: any = null;
  if ((d.type === "credit" || d.type === "debit") && d.billing_reference) {
    [ref] = await q.rows(
      `select id, kind, payment_id, payment_ids from simple_invoices
        where user_id = $1 and type = 'invoice' and number = $2 and deleted_at is null order by id limit 1`,
      [userId, d.billing_reference],
    );
  }
  const idsOf = (x: any): number[] => {
    const list = Array.isArray(x?.payment_ids) && x.payment_ids.length ? x.payment_ids : x?.payment_id ? [x.payment_id] : [];
    return [...new Set<number>(list.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))];
  };
  let covIds = idsOf(d);
  if (!covIds.length && ref) covIds = idsOf(ref);
  const cov = covIds.length
    ? await q.rows(
        `select id, amount::text as amount, description from payments where user_id = $1 and id = any($2::int[]) and deleted_at is null order by id`,
        [userId, covIds],
      )
    : [];
  const coverage = cov.filter((p: any) => installmentNature(p.description) !== "deposit").map((p: any) => ({ paymentId: Number(p.id), amount: p.amount }));
  const feeNames = new Set<string>(cov.filter((p: any) => installmentNature(p.description) === "fee").map((p: any) => String(p.description).trim()));

  const commission = kind === "commission" || (d.type === "credit" && ref?.kind === "commission");
  const { groups, warnings: gw } = documentGroups(d, { feeNames, usage: ctx?.usage ?? null, nature: commission || kind === "agency_fee" ? "other" : undefined });
  const facts: DocumentFacts = {
    date: d.date, treatment: t.treatment, dims, warnings: [...t.warnings, ...gw], memo: d.number ?? null,
    documentId: d.id, groups, coverage, deferRent: s.deferRent,
  };
  const paymentIds = coverage.map((c) => c.paymentId);
  let rule: OutboxPayload["rule"];
  if (d.type === "credit") rule = commission ? "E36" : "E06";
  else if (d.type === "debit") rule = "E07";
  else if (kind === "commission") rule = "E15";
  else if (kind === "rent_receipt") rule = "E08";
  else if (kind === "agency_fee") rule = "E17";
  else if (CHARGE_KINDS.has(kind)) rule = "E01";
  else return [];
  return [ev("simple_invoice", d.id, "confirmed", { rule, facts, paymentIds: paymentIds.length ? paymentIds : undefined })];
}

// ─── Installments (E02 / E05 / E33 facts) ──────────────────────────────────

export interface InstallmentRow {
  id: number;
  contract_id: number;
  amount: string;
  due: string;
  status: string;
  description: string | null;
  vat_enabled: boolean;
}

export const INSTALLMENT_COLS = `p.id, p.contract_id, p.amount::text as amount, to_char(p.due_date,'YYYY-MM-DD') as due, p.status::text as status,
  p.description, p.vat_enabled`;

export async function installmentRows(q: Sql, userId: number, ids: number[]): Promise<InstallmentRow[]> {
  if (!ids.length) return [];
  return q.rows(`select ${INSTALLMENT_COLS} from payments p where p.user_id = $1 and p.id = any($2::int[]) order by p.id`, [userId, ids]);
}

export function installmentFacts(p: InstallmentRow, ctx: ContractCtx | null, s: FinanceSettingsRow, date: string, extra: Partial<InstallmentFacts> = {}): InstallmentFacts | null {
  const nature = installmentNature(p.description);
  if (nature === "deposit") return null;
  const vat = installmentVat({ vatEnabled: p.vat_enabled === true, usage: ctx?.usage ?? null, sellerRegistered: ctx?.sellerRegistered ?? false });
  const t = ctx ? { treatment: ctx.treatment, warnings: ctx.warnings } : resolveTreatment(s.mode, null);
  return {
    date, treatment: t.treatment, dims: dimsOf(ctx, { paymentId: p.id }), warnings: [...t.warnings, ...vat.warnings],
    paymentId: p.id, gross: p.amount, category: vat.category, rate: vat.rate, nature, usage: ctx?.usage ?? null,
    deferRent: s.deferRent, ...extra,
  };
}

// ─── Expenses (E18) and landlord payouts (E19) ─────────────────────────────

export async function expenseEvent(q: Sql, userId: number, s: FinanceSettingsRow, expenseId: number): Promise<LedgerEvent | null> {
  const [e] = await q.rows(
    `select e.id, e.amount::text as amount, e.expense_date, to_char((e.created_at at time zone 'Asia/Riyadh')::date,'YYYY-MM-DD') as created,
            e.category, e.owner_id, e.property_id, e.deleted_at is not null as deleted, e.notes,
            d.revision, d.gross_amount::text as gross, d.net_amount::text as net, d.vat_amount::text as vat, d.vat_category,
            d.vat_rate::text as vat_rate, d.vat_recoverable, d.charge_to, d.gl_account_id, d.bank_account_id,
            to_char(d.expense_on,'YYYY-MM-DD') as expense_on,
            (select p.owner_id from properties p where p.id = e.property_id and p.user_id = e.user_id) as prop_owner,
            (select m.account_id from finance_expense_category_map m where m.user_id = e.user_id and m.category = e.category) as mapped
       from expenses e left join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id
      where e.id = $1 and e.user_id = $2`,
    [expenseId, userId],
  );
  if (!e || e.deleted) return null;
  const ownerId: number | null = e.owner_id ?? e.prop_owner ?? null;
  const t = await ownerTreatment(q, userId, s.mode, ownerId);
  const warnings = [...t.warnings];
  let date: string | null = e.expense_on ?? parseBusinessDate(e.expense_date);
  if (!date) {
    date = e.created;
    warnings.push("inferred_date");
  }
  const detailed = e.revision != null;
  const chargeTo: "company" | "landlord" = detailed ? (e.charge_to === "landlord" ? "landlord" : "company") : (t.treatment === "agent" && ownerId ? "landlord" : "company");
  const expenseAccount: AccountRef = e.gl_account_id
    ? { id: Number(e.gl_account_id) }
    : e.mapped ? { id: Number(e.mapped) } : { sys: e.property_id ? SYS.expensePropertyOther : SYS.expenseGeneralOther };
  const revision = detailed ? Number(e.revision) : 1;
  const facts: ExpenseFacts = {
    date: date!, treatment: t.treatment, dims: { ownerId: t.ownerId ?? ownerId, propertyId: e.property_id ?? null }, warnings,
    memo: e.category ?? null,
    expenseId: e.id, revision,
    gross: detailed ? e.gross : e.amount, net: detailed ? e.net : e.amount, vat: detailed ? e.vat : "0.00",
    category: detailed ? e.vat_category : "O", rate: detailed ? Math.round(Number(e.vat_rate)) : 0,
    recoverable: detailed ? e.vat_recoverable === true : false,
    chargeTo, expenseAccount, bank: { bankAccountId: e.bank_account_id ?? null },
  };
  return ev("expense", e.id, `rev:${revision}`, { rule: "E18", facts });
}

export async function expenseRevision(q: Sql, userId: number, expenseId: number): Promise<{ revision: number; deleted: boolean } | null> {
  const [e] = await q.rows(
    `select e.deleted_at is not null as deleted, d.revision from expenses e
       left join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id
      where e.id = $1 and e.user_id = $2`,
    [expenseId, userId],
  );
  return e ? { revision: e.revision != null ? Number(e.revision) : 1, deleted: e.deleted === true } : null;
}

export async function payoutEvent(q: Sql, userId: number, s: FinanceSettingsRow, payoutId: number): Promise<LedgerEvent | null> {
  const [p] = await q.rows(
    `select lp.id, lp.owner_id, lp.amount::text as amount, lp.transfer_date, lp.method, lp.reference, lp.deleted_at is not null as deleted,
            to_char((lp.created_at at time zone 'Asia/Riyadh')::date,'YYYY-MM-DD') as created,
            to_char(m.paid_on,'YYYY-MM-DD') as paid_on, m.bank_account_id
       from landlord_payouts lp left join finance_payout_meta m on m.payout_id = lp.id and m.user_id = lp.user_id
      where lp.id = $1 and lp.user_id = $2`,
    [payoutId, userId],
  );
  if (!p || p.deleted) return null;
  const t = await ownerTreatment(q, userId, s.mode, p.owner_id ?? null);
  const warnings = [...t.warnings];
  let date: string | null = p.paid_on ?? parseBusinessDate(p.transfer_date);
  if (!date) {
    date = p.created;
    warnings.push("inferred_date");
  }
  const facts: MoneyFacts = {
    date: date!, treatment: t.treatment, dims: { ownerId: t.ownerId ?? p.owner_id ?? null }, warnings, memo: p.reference ?? null,
    amount: p.amount, bank: { bankAccountId: p.bank_account_id ?? null, method: p.method ?? null },
  };
  return ev("landlord_payout", p.id, "created", { rule: "E19", facts });
}

// ─── Deposits at termination (E10, E11) ────────────────────────────────────

/** Σ what a deposit voucher put on DEP: its total less the collections linked to installments (E09). */
export async function voucherUnlinked(q: Sql, userId: number, voucherIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!voucherIds.length) return out;
  const rows = await q.rows(
    `select si.id, si.total::text as total,
            (select coalesce(sum(pc.amount), 0)::text from payment_collections pc
              where pc.user_id = si.user_id and pc.invoice_id = si.id and pc.payment_id is not null) as linked
       from simple_invoices si where si.user_id = $1 and si.id = any($2::int[]) and si.kind = 'deposit'`,
    [userId, voucherIds],
  );
  for (const r of rows) out.set(Number(r.id), Math.max(0, toHalalas(r.total) - toHalalas(r.linked)));
  return out;
}

export function depositRefundedEvent(voucherId: number, amount: number, ctx: ContractCtx | null, date: string, method: string | null, s: FinanceSettingsRow,
  bankAccountId: number | null = null): LedgerEvent {
  const t = ctx ? { treatment: ctx.treatment, warnings: ctx.warnings } : resolveTreatment(s.mode, null);
  const facts: DepositMoneyFacts = {
    date, treatment: t.treatment, dims: dimsOf(ctx), warnings: t.warnings,
    documentId: voucherId, amount: fromHalalas(amount), bank: bankAccountId != null ? { bankAccountId, method } : { method },
  };
  return ev("simple_invoice", voucherId, "deposit_refunded", { rule: "E10", facts });
}

/** E11: the deposit held for a contract (unlinked voucher amounts + legacy deposit-installment collections). */
export async function depositForfeitEvent(q: Sql, userId: number, s: FinanceSettingsRow, ctx: ContractCtx, date: string): Promise<LedgerEvent | null> {
  const vouchers = await q.rows(
    `select id from simple_invoices where user_id = $1 and contract_id = $2 and kind = 'deposit' and status = 'confirmed' and deleted_at is null`,
    [userId, ctx.contractId],
  );
  const unlinked = await voucherUnlinked(q, userId, vouchers.map((v: any) => Number(v.id)));
  const [legacy] = await q.rows(
    `select coalesce(sum(pc.amount), 0)::text as s from payment_collections pc join payments p on p.id = pc.payment_id
      where pc.user_id = $1 and p.contract_id = $2 and p.description = $3`,
    [userId, ctx.contractId, DEPOSIT_DESC],
  );
  const amount = [...unlinked.values()].reduce((a, b) => a + b, 0) + toHalalas(legacy.s);
  if (amount <= 0) return null;
  const facts: ForfeitFacts = {
    date, treatment: ctx.treatment, dims: dimsOf(ctx), warnings: ctx.warnings, amount: fromHalalas(amount), forfeitVat: s.forfeitVat,
  };
  return ev("contract", ctx.contractId, "deposit_forfeited", { rule: "E11", facts });
}

/** A `reversal:<event>` for an original key (§5.4); the engine blocks it behind a pending original. */
export function reversalEvent(sourceType: string, sourceId: number, origEvent: string, date: string, extra: Record<string, unknown> = {}): LedgerEvent {
  return { sourceType, sourceId, event: `reversal:${origEvent}`, occurredOn: date, payload: { facts: { date, ...extra } } };
}

export const today = (): string => riyadhToday();
