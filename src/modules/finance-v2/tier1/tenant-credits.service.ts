import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { LedgerEmitter } from "../ledger-emitter.service";
import { PostingWorker } from "../posting-worker.service";
import { ArAgingService } from "../reports/aging.service";
import { auditRow, isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { LOCK_KEYS } from "../lock-keys";
import { sqlOf } from "../hooks/sql";
import { contractCtx, loadSettings, reversalEvent, today } from "../hooks/facts-loader";
import { BankAccountsService } from "./bank-accounts.service";
import { creditActionEvents } from "./credit-events";
import { asciiDigits } from "./iban";
import { DEPOSIT_DESC } from "../hooks/classify";
import { nextPvNumber } from "../pv-number";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export interface CreditBucket {
  tenantId: number;
  contractId: number | null;
  contractNumber: string | null;
  ownerId: number | null;
  ownerName: string | null;
  propertyId: number | null;
  treatment: "principal" | "agent" | null;
  /** Ledger credit (−AR) less refunds/applications not yet posted; 2-decimal string. */
  credit: string;
}

export interface CreditActionOut {
  id: number;
  kind: "refund" | "apply";
  number: string | null;
  tenantId: number;
  contractId: number | null;
  ownerId: number | null;
  amount: string;
  actionOn: string;
  targetDocumentId: number | null;
  targetPaymentId: number | null;
  targetContractId: number | null;
  sourceDocumentId: number | null;
  bankAccountId: number | null;
  method: string | null;
  reference: string | null;
  status: "posted" | "void";
  posting: { status: string; entryId: number | null } | null;
  createdAt: string;
}

const ACTION_SQL = `select a.id, a.kind, a.number, a.tenant_id, a.contract_id, a.owner_id, a.amount::text as amount, to_char(a.action_on,'YYYY-MM-DD') as action_on,
    a.target_document_id, t.target_payment_id, t.target_contract_id, a.source_document_id, a.bank_account_id, a.method, a.reference, a.status, a.created_at,
    (select o.status from ledger_outbox o where o.user_id = a.user_id and o.source_type = 'tenant_credit_action' and o.source_id = a.id and o.event = a.kind) as o_status,
    (select o.entry_id from ledger_outbox o where o.user_id = a.user_id and o.source_type = 'tenant_credit_action' and o.source_id = a.id and o.event = a.kind) as o_entry
  from tenant_credit_actions a left join tenant_credit_targets t on t.action_id = a.id and t.user_id = a.user_id`;

const shapeAction = (r: any): CreditActionOut => ({
  id: Number(r.id), kind: r.kind, number: r.number ?? null, tenantId: Number(r.tenant_id), contractId: r.contract_id ?? null, ownerId: r.owner_id ?? null,
  amount: fromHalalas(toHalalas(r.amount)), actionOn: r.action_on, targetDocumentId: r.target_document_id ?? null, targetPaymentId: r.target_payment_id ?? null,
  targetContractId: r.target_contract_id ?? null, sourceDocumentId: r.source_document_id ?? null, bankAccountId: r.bank_account_id ?? null,
  method: r.method ?? null, reference: r.reference ?? null, status: r.status,
  posting: r.o_status ? { status: r.o_status, entryId: r.o_entry == null ? null : Number(r.o_entry) } : null,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});

const idOf = (v: unknown, field: string, required = true): number | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} is required` });
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be an id` });
  return n;
};

function amountOf(v: unknown): number {
  let h: number;
  try {
    h = toHalalas(asciiDigits(String(v ?? "")).trim());
  } catch {
    throw new BadRequestException({ error: "BAD_AMOUNT", message: "المبلغ غير صالح · amount must be a decimal with at most 2 places" });
  }
  if (h <= 0) throw new BadRequestException({ error: "BAD_AMOUNT", message: "المبلغ يجب أن يكون موجباً · amount must be positive" });
  return h;
}

const insufficient = (available: number) => new ConflictException({
  error: "FINANCE_V2_INSUFFICIENT_CREDIT", available: fromHalalas(available),
  message: `رصيد المستأجر الدائن أقل من المبلغ (المتاح ${fromHalalas(available)}) · The tenant's credit is less than the amount (available ${fromHalalas(available)})`,
});

/**
 * Tenant credit balances: refund or carry forward (DESIGN §8.2 c, §4.4
 * E20/E21). Balances come from the LEDGER (AR 1121 + 1122 per tenant and
 * contract below −0.005). Every write takes the account's TENANT_CREDIT lock,
 * re-reads the balance, and refuses (409) an amount above what is available
 * (the E20 sufficiency check), so two concurrent refunds cannot overdraw it.
 */
@Injectable()
export class TenantCreditsService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly emitter: LedgerEmitter,
    private readonly banks: BankAccountsService,
    private readonly aging: ArAgingService,
    @Optional() private readonly worker?: PostingWorker,
  ) {}

  /** Post what is queued for the account first, so the ledger balance is current (best effort). */
  async settle(scope: number): Promise<void> {
    try {
      for (let i = 0; i < 5; i++) {
        const r = await this.worker?.runAccount(scope);
        if (!r || (r as any).posted + (r as any).skipped + (r as any).failed + (r as any).retry === 0) break;
      }
    } catch {
      /* the check below is conservative without it */
    }
  }

  /** Every credit bucket (tenant × contract) below −0.005, as of `asOf`. */
  async buckets(q: Q, scope: number, asOf: string, tenantId?: number | null): Promise<CreditBucket[]> {
    const p: unknown[] = [scope, asOf];
    let t = "";
    if (tenantId != null) {
      p.push(tenantId);
      t = ` and l.tenant_id = $3`;
    }
    const r = await q.query(
      `with bal as (
         select l.tenant_id, l.contract_id, max(l.owner_id) as owner_id, max(l.property_id) as property_id,
                bool_or(a.system_key = 'tenant_receivable_agency') as agency, sum(l.debit - l.credit) as bal
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
          where l.user_id = $1 and l.entry_date <= $2::date and l.tenant_id is not null
            and a.system_key in ('tenant_receivable','tenant_receivable_agency')${t}
          group by l.tenant_id, l.contract_id),
       pend as (
         select x.tenant_id, x.contract_id, sum(x.amount) as amt from tenant_credit_actions x
          where x.user_id = $1 and x.status = 'posted'
            and (x.kind = 'refund' or exists (select 1 from ledger_outbox o where o.user_id = x.user_id and o.source_type = 'tenant_credit_action'
                                              and o.source_id = x.id and o.event = 'apply' and o.status in ('pending','failed')))
            and not exists (select 1 from ledger_outbox o where o.user_id = x.user_id and o.source_type = 'tenant_credit_action'
                             and o.source_id = x.id and o.event = x.kind and o.status in ('posted','skipped','dismissed'))
          group by 1, 2)
       select b.tenant_id, b.contract_id, b.owner_id, b.property_id, b.agency, (-b.bal - coalesce(p.amt, 0))::text as credit,
              c.contract_number, o.name as owner_name
         from bal b
         left join pend p on p.tenant_id = b.tenant_id and p.contract_id is not distinct from b.contract_id
         left join contracts c on c.id = b.contract_id and c.user_id = $1
         left join owners o on o.id = b.owner_id and o.user_id = $1
        where -b.bal - coalesce(p.amt, 0) > 0.005
        order by b.tenant_id, b.contract_id nulls last`,
      p,
    );
    return r.rows.map((x: any) => ({
      tenantId: Number(x.tenant_id), contractId: x.contract_id ?? null, contractNumber: x.contract_number ?? null,
      ownerId: x.owner_id ?? null, ownerName: x.owner_name ?? null, propertyId: x.property_id ?? null,
      treatment: x.agency ? "agent" : "principal", credit: fromHalalas(toHalalas(x.credit)),
    }));
  }

  /** GET /tenant-credits: tenants with a credit balance, with their buckets. */
  async list(scope: number, asOfRaw?: string) {
    const asOf = asOfRaw ? isoDate(asOfRaw, "asOf") : riyadhToday();
    const bs = await this.buckets(this.pool, scope, asOf);
    const names = await this.tenantNames(scope, bs.map((b) => b.tenantId));
    const byTenant = new Map<number, CreditBucket[]>();
    for (const b of bs) byTenant.set(b.tenantId, [...(byTenant.get(b.tenantId) ?? []), b]);
    const rows = [...byTenant.entries()].map(([tenantId, buckets]) => ({
      tenantId, tenantName: names.get(tenantId) ?? null, total: fromHalalas(buckets.reduce((s, b) => s + toHalalas(b.credit), 0)), buckets,
    }));
    return { asOf, rows, total: fromHalalas(bs.reduce((s, b) => s + toHalalas(b.credit), 0)) };
  }

  /** GET /tenant-credits/:tenantId: the buckets, the tenant's open items (apply targets) and the action history. */
  async tenant(scope: number, tenantId: number) {
    const [t] = (await this.pool.query(`select id, name from tenants where id = $1 and user_id = $2`, [tenantId, scope])).rows;
    if (!t) throw new NotFoundException({ error: "TENANT_NOT_FOUND", message: "Tenant not found" });
    const asOf = riyadhToday();
    const [buckets, aging, actions, future] = await Promise.all([
      this.buckets(this.pool, scope, asOf, tenantId),
      this.aging.openItems(scope, asOf, "contract"),
      this.pool.query(`${ACTION_SQL} where a.user_id = $1 and a.tenant_id = $2 order by a.id desc`, [scope, tenantId]),
      this.pool.query(
        `select p.id, p.contract_id, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount,
                (select coalesce(sum(pc.amount), 0)::text from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id) as collected,
                (select coalesce(sum(a.amount), 0)::text from tenant_credit_targets tt join tenant_credit_actions a on a.id = tt.action_id and a.user_id = tt.user_id
                  where tt.user_id = p.user_id and tt.target_payment_id = p.id and a.status = 'posted') as applied
           from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
          where p.user_id = $1 and c.tenant_id = $2 and p.deleted_at is null and c.deleted_at is null and p.due_date > $3::date
            and p.status::text in ('pending','partially_paid') and coalesce(p.description, '') <> $4
          order by p.due_date, p.id limit 24`,
        [scope, tenantId, asOf, DEPOSIT_DESC],
      ),
    ]);
    const openItems = aging.items.filter((i) => i.tenantId === tenantId && i.remaining > 0).map((i) => ({
      type: i.type, id: i.id, number: i.number, contractId: i.contractId, dueDate: i.dueDate, remaining: fromHalalas(i.remaining),
    }));
    const upcoming = future.rows
      .map((p: any) => ({ type: "installment" as const, id: Number(p.id), number: null, contractId: p.contract_id, dueDate: p.due,
        remaining: fromHalalas(toHalalas(p.amount) - toHalalas(p.collected) - toHalalas(p.applied)) }))
      .filter((p: any) => toHalalas(p.remaining) > 0);
    return {
      tenant: { id: Number(t.id), name: t.name }, asOf, buckets,
      total: fromHalalas(buckets.reduce((s, b) => s + toHalalas(b.credit), 0)),
      openItems, upcoming, actions: actions.rows.map(shapeAction),
    };
  }

  async actions(scope: number, q: any) {
    const p: unknown[] = [scope];
    let w = "a.user_id = $1";
    if (q?.tenantId) {
      p.push(idOf(q.tenantId, "tenantId"));
      w += ` and a.tenant_id = $${p.length}`;
    }
    if (q?.contractId) {
      p.push(idOf(q.contractId, "contractId"));
      w += ` and a.contract_id = $${p.length}`;
    }
    const r = await this.pool.query(`${ACTION_SQL} where ${w} order by a.id desc limit 500`, p);
    return { rows: r.rows.map(shapeAction) };
  }

  /**
   * POST /tenant-credits/refund {tenantId, contractId?, amount, date?, bankAccountId?, method?, reference?}:
   * a payment voucher PV-######, `tenant_credit_actions` kind refund, E20.
   */
  async refund(scope: number, user: { id: number }, body: any): Promise<{ action: CreditActionOut; remainingCredit: string }> {
    const tenantId = idOf(body?.tenantId, "tenantId")!;
    const contractIn = idOf(body?.contractId, "contractId", false);
    const amount = amountOf(body?.amount);
    const date = body?.date ? isoDate(body.date, "date") : riyadhToday();
    if (date > riyadhToday()) throw new BadRequestException({ error: "BAD_DATE", message: "A refund cannot be dated in the future" });
    const method = optText(body?.method, "method", 40);
    const reference = optText(body?.reference, "reference", 100);
    await this.settle(scope);
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.TENANT_CREDIT]);
      await this.assertTenant(c, scope, tenantId, contractIn);
      await this.assertPeriodOpen(c, scope, date);
      const bankAccountId = await this.banks.assertUsable(c, scope, body?.bankAccountId);
      const bucket = this.pickBucket(await this.buckets(c, scope, riyadhToday(), tenantId), contractIn);
      const available = toHalalas(bucket.credit);
      if (amount > available) throw insufficient(available);
      const number = await this.nextPv(c, scope);
      const ins = await c.query(
        `insert into tenant_credit_actions (user_id, tenant_id, contract_id, owner_id, kind, amount, action_on, bank_account_id, method, reference, number, created_by)
         values ($1, $2, $3, $4, 'refund', $5, $6, $7, $8, $9, $10, $11) returning id`,
        [scope, tenantId, bucket.contractId, bucket.ownerId, fromHalalas(amount), date, bankAccountId, method, reference, number, user.id],
      );
      const id = Number(ins.rows[0].id);
      await this.emitAction(c, scope, id);
      await auditRow(c, scope, user.id, "tenant_credit_action", id, "/finance/v2/tenant-credits/refund");
      const [row] = (await c.query(`${ACTION_SQL} where a.id = $1 and a.user_id = $2`, [id, scope])).rows;
      return { action: shapeAction(row), remainingCredit: fromHalalas(available - amount) };
    });
    this.emitter.kick(scope);
    return out;
  }

  /**
   * POST /tenant-credits/apply {tenantId, contractId?, targetDocumentId | targetPaymentId, amount, date?}:
   * the allocation (drives document matching and aging) and E21 — a reclass
   * only when the contract or landlord differs; across landlords under agency
   * it is refused (400) before anything is written.
   */
  async apply(scope: number, user: { id: number }, body: any): Promise<{ action: CreditActionOut; remainingCredit: string }> {
    const tenantId = idOf(body?.tenantId, "tenantId")!;
    const contractIn = idOf(body?.contractId, "contractId", false);
    const docId = idOf(body?.targetDocumentId, "targetDocumentId", false);
    const payId = idOf(body?.targetPaymentId, "targetPaymentId", false);
    if ((docId == null) === (payId == null)) throw new BadRequestException({ error: "BAD_INPUT", message: "Give exactly one of targetDocumentId or targetPaymentId" });
    const amount = amountOf(body?.amount);
    const date = body?.date ? isoDate(body.date, "date") : riyadhToday();
    if (date > riyadhToday()) throw new BadRequestException({ error: "BAD_DATE", message: "An application cannot be dated in the future" });
    await this.settle(scope);
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.TENANT_CREDIT]);
      await this.assertTenant(c, scope, tenantId, contractIn);
      await this.assertPeriodOpen(c, scope, date);
      const s = await loadSettings(sqlOf(c as any), scope);
      if (!s) throw new NotFoundException();
      const asOf = riyadhToday();
      // The target, its contract, and what is still open on it.
      let targetContract: number | null;
      let targetRemaining: number;
      const aging = await this.aging.openItems(scope, asOf, "contract");
      if (docId != null) {
        const [d] = (await c.query(
          `select si.id, si.contract_id, si.tenant_id, si.type::text as type, coalesce(si.kind, 'invoice') as kind, si.status::text as status,
                  (select ct.tenant_id from contracts ct where ct.id = si.contract_id and ct.user_id = si.user_id) as c_tenant
             from simple_invoices si where si.id = $1 and si.user_id = $2 and si.deleted_at is null`, [docId, scope])).rows;
        if (!d) throw new NotFoundException({ error: "DOCUMENT_NOT_FOUND", message: "Document not found" });
        if ((d.tenant_id ?? d.c_tenant) !== tenantId) throw new BadRequestException({ error: "TARGET_OTHER_TENANT", message: "The document belongs to another tenant" });
        const item = aging.items.find((i) => i.type === "document" && i.id === docId);
        if (!item || item.remaining <= 0) throw new ConflictException({ error: "FINANCE_V2_TARGET_NOT_OPEN", message: "المستند ليس عليه رصيد مفتوح · The document has nothing open" });
        targetContract = d.contract_id ?? null;
        targetRemaining = item.remaining;
      } else {
        const [p] = (await c.query(
          `select p.id, p.contract_id, p.amount::text as amount, p.status::text as status, to_char(p.due_date,'YYYY-MM-DD') as due, ct.tenant_id,
                  (select coalesce(sum(pc.amount), 0)::text from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id) as collected,
                  (select coalesce(sum(a.amount), 0)::text from tenant_credit_targets tt join tenant_credit_actions a on a.id = tt.action_id and a.user_id = tt.user_id
                    where tt.user_id = p.user_id and tt.target_payment_id = p.id and a.status = 'posted') as applied
             from payments p join contracts ct on ct.id = p.contract_id and ct.user_id = p.user_id
            where p.id = $1 and p.user_id = $2 and p.deleted_at is null and ct.deleted_at is null`, [payId, scope])).rows;
        if (!p) throw new NotFoundException({ error: "INSTALLMENT_NOT_FOUND", message: "Installment not found" });
        if (p.tenant_id !== tenantId) throw new BadRequestException({ error: "TARGET_OTHER_TENANT", message: "The installment belongs to another tenant" });
        if (!["pending", "partially_paid"].includes(p.status)) throw new ConflictException({ error: "FINANCE_V2_TARGET_NOT_OPEN", message: "القسط ليس مفتوحاً · The installment is not open" });
        const item = aging.items.find((i) => i.type === "installment" && i.id === payId);
        targetContract = p.contract_id;
        targetRemaining = item ? item.remaining : toHalalas(p.amount) - toHalalas(p.collected) - toHalalas(p.applied);
        if (targetRemaining <= 0) throw new ConflictException({ error: "FINANCE_V2_TARGET_NOT_OPEN", message: "القسط ليس مفتوحاً · The installment has nothing open" });
      }
      if (amount > targetRemaining) {
        throw new ConflictException({ error: "FINANCE_V2_EXCEEDS_TARGET", open: fromHalalas(targetRemaining),
          message: `المبلغ أكبر من المفتوح على المستند (${fromHalalas(targetRemaining)}) · The amount exceeds what is open on the target (${fromHalalas(targetRemaining)})` });
      }
      // The source: the unapplied credit (sub-ledger) per contract; across contracts the ledger credit must cover it too.
      const unapplied = [...aging.credit.values()].filter((x) => x.tenantId === tenantId && x.amount < 0);
      const ledger = await this.buckets(c, scope, asOf, tenantId);
      let source: number | null = contractIn;
      if (source == null) {
        const own = unapplied.find((x) => x.contractId === targetContract);
        source = own ? targetContract : unapplied.length === 1 ? unapplied[0].contractId : null;
        if (source == null && unapplied.length > 1) {
          throw new BadRequestException({ error: "FINANCE_V2_CONTRACT_REQUIRED", message: "للمستأجر أرصدة على أكثر من عقد؛ حدد العقد · The tenant has credit on several contracts; choose one",
            contracts: unapplied.map((x) => ({ contractId: x.contractId, credit: fromHalalas(-x.amount) })) });
        }
      }
      const sub = -(unapplied.find((x) => x.contractId === source)?.amount ?? 0);
      const led = toHalalas(ledger.find((b) => b.contractId === source)?.credit ?? "0");
      const available = source === targetContract ? sub : Math.min(sub, led);
      if (amount > available) throw insufficient(Math.max(0, available));
      const src = source ? await contractCtx(sqlOf(c as any), scope, s.mode, source) : null;
      const tgt = targetContract ? await contractCtx(sqlOf(c as any), scope, s.mode, targetContract) : null;
      const sameLandlord = (src?.ownerId ?? null) === (tgt?.ownerId ?? null);
      if (!sameLandlord && (src?.treatment === "agent" || tgt?.treatment === "agent")) {
        throw new BadRequestException({ error: "FINANCE_V2_CROSS_LANDLORD",
          message: "لا يمكن نقل رصيد المستأجر بين مؤجرين مختلفين في الوكالة · A tenant credit cannot move between landlords under agency" });
      }
      const ins = await c.query(
        `insert into tenant_credit_actions (user_id, tenant_id, contract_id, owner_id, kind, amount, action_on, target_document_id, source_document_id, created_by)
         values ($1, $2, $3, $4, 'apply', $5, $6, $7, $8, $9) returning id`,
        [scope, tenantId, source, src?.ownerId ?? null, fromHalalas(amount), date, docId, idOf(body?.sourceDocumentId, "sourceDocumentId", false), user.id],
      );
      const id = Number(ins.rows[0].id);
      await c.query(`insert into tenant_credit_targets (action_id, user_id, target_payment_id, target_contract_id) values ($1, $2, $3, $4)`, [id, scope, payId, targetContract]);
      await this.emitAction(c, scope, id);
      await auditRow(c, scope, user.id, "tenant_credit_action", id, "/finance/v2/tenant-credits/apply");
      const [row] = (await c.query(`${ACTION_SQL} where a.id = $1 and a.user_id = $2`, [id, scope])).rows;
      return { action: shapeAction(row), remainingCredit: fromHalalas(available - amount) };
    });
    this.emitter.kick(scope);
    return out;
  }

  /** POST /tenant-credits/:id/void: the action becomes void and its entry is reversed (approve capability). */
  async void(scope: number, user: { id: number }, id: number): Promise<CreditActionOut> {
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.TENANT_CREDIT]);
      const [a] = (await c.query(`select id, kind, status, to_char(action_on,'YYYY-MM-DD') as on from tenant_credit_actions where id = $1 and user_id = $2 for update`, [id, scope])).rows;
      if (!a) throw new NotFoundException({ error: "CREDIT_ACTION_NOT_FOUND", message: "Not found" });
      if (a.status === "void") throw new ConflictException({ error: "FINANCE_V2_ALREADY_VOID", message: "Already void" });
      const [p] = (await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [scope, a.on])).rows;
      if (p?.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "The action's period is locked" });
      await c.query(`update tenant_credit_actions set status = 'void' where id = $1 and user_id = $2`, [id, scope]);
      await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, reversalEvent("tenant_credit_action", id, a.kind, today(), { reason: "voided" }));
      await auditRow(c, scope, user.id, "tenant_credit_action", id, `/finance/v2/tenant-credits/${id}/void`);
      const [row] = (await c.query(`${ACTION_SQL} where a.id = $1 and a.user_id = $2`, [id, scope])).rows;
      return shapeAction(row);
    });
    this.emitter.kick(scope);
    return out;
  }

  /**
   * GET /documents/:id/tenant-credit: after a credit note is approved, the
   * credit it left the tenant (min of the note total and the tenant's credit on
   * its contract), so the web can offer refund / apply / keep.
   */
  async documentCredit(scope: number, docId: number) {
    const [d] = (await this.pool.query(
      `select si.id, si.number, si.type::text as type, si.status::text as status, si.total::text as total, si.contract_id, si.tenant_id,
              coalesce(si.contract_id, (select r.contract_id from simple_invoices r where r.user_id = si.user_id and r.type = 'invoice'
                 and r.number = si.billing_reference and r.deleted_at is null order by r.id limit 1)) as eff_contract
         from simple_invoices si where si.id = $1 and si.user_id = $2 and si.deleted_at is null`, [docId, scope])).rows;
    if (!d) throw new NotFoundException({ error: "DOCUMENT_NOT_FOUND", message: "Document not found" });
    let tenantId: number | null = d.tenant_id ?? null;
    if (tenantId == null && d.eff_contract) tenantId = (await this.pool.query(`select tenant_id from contracts where id = $1 and user_id = $2`, [d.eff_contract, scope])).rows[0]?.tenant_id ?? null;
    const empty = { documentId: d.id, number: d.number, type: d.type, tenantId, contractId: d.eff_contract ?? null, noteTotal: fromHalalas(toHalalas(d.total)), available: "0.00", amount: "0.00" };
    if (d.type !== "credit" || d.status !== "confirmed" || tenantId == null) return empty;
    await this.settle(scope);
    const b = (await this.buckets(this.pool, scope, riyadhToday(), tenantId)).find((x) => x.contractId === (d.eff_contract ?? null));
    const available = toHalalas(b?.credit ?? "0");
    return { ...empty, available: fromHalalas(available), amount: fromHalalas(Math.min(available, toHalalas(d.total))) };
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async emitAction(c: Fv2Client, scope: number, id: number): Promise<void> {
    const s = await loadSettings(sqlOf(c as any), scope);
    if (!s) return;
    const r = await creditActionEvents(sqlOf(c as any), scope, s, id);
    for (const e of r?.events ?? []) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
  }

  private pickBucket(bs: CreditBucket[], contractId: number | null): CreditBucket {
    if (contractId != null) {
      const b = bs.find((x) => x.contractId === contractId);
      if (!b) throw insufficient(0);
      return b;
    }
    if (!bs.length) throw insufficient(0);
    if (bs.length > 1) {
      throw new BadRequestException({ error: "FINANCE_V2_CONTRACT_REQUIRED", message: "للمستأجر أرصدة على أكثر من عقد؛ حدد العقد · The tenant has credit on several contracts; choose one",
        contracts: bs.map((b) => ({ contractId: b.contractId, credit: b.credit })) });
    }
    return bs[0];
  }

  private async assertTenant(c: Q, scope: number, tenantId: number, contractId: number | null) {
    const t = await c.query(`select 1 from tenants where id = $1 and user_id = $2`, [tenantId, scope]);
    if (!t.rowCount) throw new NotFoundException({ error: "TENANT_NOT_FOUND", message: "Tenant not found" });
    if (contractId != null) {
      const k = await c.query(`select tenant_id from contracts where id = $1 and user_id = $2`, [contractId, scope]);
      if (!k.rows[0]) throw new NotFoundException({ error: "CONTRACT_NOT_FOUND", message: "Contract not found" });
      if (k.rows[0].tenant_id !== tenantId) throw new BadRequestException({ error: "CONTRACT_OTHER_TENANT", message: "The contract belongs to another tenant" });
    }
  }

  private async assertPeriodOpen(c: Q, scope: number, date: string) {
    const r = await c.query(`select status from fiscal_periods where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [scope, date]);
    if (r.rows[0]?.status === "locked") throw new ConflictException({ error: "PERIOD_LOCKED", message: "The period is locked; choose another date" });
  }

  /** PV-###### per account, across tenant refunds and deposit refunds (§2.3.7), under the PV lock. */
  private async nextPv(c: Fv2Client, scope: number): Promise<string> {
    return nextPvNumber(c, scope);
  }

  private async tenantNames(scope: number, ids: number[]) {
    const list = [...new Set(ids)];
    if (!list.length) return new Map<number, string>();
    const r = await this.pool.query(`select id, name from tenants where user_id = $1 and id = any($2::int[])`, [scope, list]);
    return new Map<number, string>(r.rows.map((x: any) => [Number(x.id), x.name]));
  }
}

function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new BadRequestException({ error: "BAD_INPUT", message: `${field} must be a string` });
  const s = v.trim();
  if (s.length > max) throw new BadRequestException({ error: "BAD_INPUT", message: `${field} is too long` });
  return s || null;
}
