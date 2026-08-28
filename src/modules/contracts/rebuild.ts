/**
 * Contract rebuild — the pure decision layer.
 *
 * A landlord who mistyped a rent, a date or a fee cannot "patch" the mistake:
 * the schedule, the unit links and the advance artefacts were all derived from
 * the values that were wrong. The product answer is to REBUILD the contract in
 * place — destroy everything the creation path produced and generate it again
 * from the corrected values, keeping the same row, the same id and the same
 * contract number.
 *
 * That is only ever safe while the contract has produced nothing a third party
 * is holding. Everything in this file answers one question — *may* this
 * contract be rebuilt — from facts the controller reads out of the database, so
 * the rule is one readable function instead of a chain of `if`s buried in a
 * transaction.
 *
 * Kept free of Drizzle and Nest on purpose: it is the part worth reasoning
 * about, and it reasons about plain data.
 */

/**
 * The exact note the creation path stamps on the advance-rent collection AND on
 * the receipt voucher it mints. It is already the codebase's discriminator for
 * "this money is the advance" (`collectedBuckets` buckets by this same string),
 * so the rebuild uses it too rather than inventing a second, divergent marker.
 */
export const ADVANCE_NOTE = "إيجار مدفوع مقدماً";

/** `simple_invoices.kind` of the receipt voucher minted for the advance. */
export const RECEIPT_KIND = "receipt";
/** `simple_invoices.kind` of the deposit (تأمين) receipt voucher. */
export const DEPOSIT_KIND = "deposit";

/**
 * `simple_invoices.zatca_status` values that mean the document REACHED ZATCA.
 *
 * `billing.module.ts` (`submitApprovedDocToZatca`) is the only writer of this
 * column and it writes exactly five values:
 *
 *   cleared  — standard (B2B) invoice accepted by ZATCA clearance → submitted
 *   reported — simplified (B2C) invoice reported to ZATCA          → submitted
 *   failed   — submission was ATTEMPTED and ZATCA rejected it      → submitted
 *   pending  — landlord not linked / not onboarded: nothing sent   → not sent
 *   skipped  — exempt or out-of-scope supply, no e-invoice needed  → not sent
 *
 * `failed` counts as submitted deliberately. A rejected submission still
 * travelled: it consumed an ICV in the landlord's ZATCA chain and ZATCA has a
 * record of the attempt. Treating it as "never happened" is exactly the kind of
 * optimism this gate exists to refuse.
 */
export const ZATCA_SUBMITTED_STATUSES = ["cleared", "reported", "failed"] as const;

/** The `simple_invoices` columns the gate needs. */
export type ContractDocRow = {
  id: number;
  kind: string | null;
  status: string | null;
  notes: string | null;
  zatcaStatus: string | null;
  zatcaQr: string | null;
  zatcaInvoiceId: number | null;
  total: string | null;
  /** Proof of payment uploaded with the voucher, carried across a rebuild. */
  attachmentKey?: string | null;
};

/** The `payment_collections` columns the gate needs. */
export type ContractCollectionRow = {
  id: number;
  notes: string | null;
  amount: string | null;
  /**
   * The billing document this collection was recorded against, if any.
   *
   * This is the discriminator that actually holds. The creation path never
   * sets it — its advance collection belongs to an installment, not to a
   * document — while `createReceiptVoucher` always does. The note text does
   * NOT hold: that endpoint copies the caller's note onto both the voucher and
   * every collection it writes, so a hand-made voucher carrying the same
   * Arabic string used to be mistaken for the create path's own artefact,
   * silently voided, and its collection deleted.
   */
  invoiceId: number | null;
};

/**
 * Has this billing document been submitted to ZATCA?
 *
 * Three independent signals, ORed, because each one on its own is proof and the
 * write of all three is best-effort (`submitApprovedDocToZatca` swallows its own
 * persistence errors — the status may be missing on a document that really did
 * go out):
 *   - `zatca_status` says so;
 *   - `zatca_qr` holds the signed QR ZATCA's submission produced;
 *   - `zatca_invoice_id` points at the `invoices` row it became.
 */
export function isSubmittedToZatca(doc: ContractDocRow): boolean {
  if (doc.zatcaStatus && (ZATCA_SUBMITTED_STATUSES as readonly string[]).includes(doc.zatcaStatus)) return true;
  if (typeof doc.zatcaQr === "string" && doc.zatcaQr.trim() !== "") return true;
  if (doc.zatcaInvoiceId != null) return true;
  return false;
}

/** Is this the advance-rent receipt voucher the creation path minted? */
export function isAdvanceVoucher(doc: ContractDocRow): boolean {
  return doc.kind === RECEIPT_KIND && doc.notes === ADVANCE_NOTE;
}

/** Is this the deposit (تأمين) receipt voucher? */
export function isDepositVoucher(doc: ContractDocRow): boolean {
  return doc.kind === DEPOSIT_KIND;
}

export type ContractDocs = {
  /** Documents that reached ZATCA — an absolute bar to rebuilding. */
  zatcaSubmitted: ContractDocRow[];
  /** The advance-rent voucher(s) the creation path minted — destroyed and re-minted. */
  advanceVouchers: ContractDocRow[];
  /** The deposit voucher(s) — kept, never re-minted (see `depositVoucherTotal`). */
  depositVouchers: ContractDocRow[];
  /** Anything else still live on the contract — invoices, manual receipt
   *  vouchers, notes. They reference installments the rebuild would destroy. */
  other: ContractDocRow[];
};

/**
 * Sort a contract's live `simple_invoices` into the four groups the rebuild
 * cares about. Cancelled documents are ignored: they have already been voided
 * and hold nothing.
 *
 * Note on the advance voucher: it is identified by `kind = "receipt"` AND
 * `notes = ADVANCE_NOTE`, which is what the creation path writes. Billing's
 * manual receipt-voucher endpoint can in principle produce the same pair (its
 * notes come from the request body), but such a voucher always records a real
 * collection, and a collection that is not the create-path advance is itself a
 * bar to rebuilding — so a hand-made look-alike is caught by the collection
 * check rather than being silently destroyed here.
 */
export function classifyContractDocs(
  docs: ContractDocRow[],
  /** Ids of documents that a collection was recorded against — never the
   *  creation path's advance voucher, which no collection references. */
  referencedByCollection: ReadonlySet<number> = new Set(),
): ContractDocs {
  const out: ContractDocs = { zatcaSubmitted: [], advanceVouchers: [], depositVouchers: [], other: [] };
  for (const d of docs) {
    if (isSubmittedToZatca(d)) { out.zatcaSubmitted.push(d); continue; }
    if (d.status === "cancelled") continue;
    if (isAdvanceVoucher(d) && !referencedByCollection.has(d.id)) {
      out.advanceVouchers.push(d); continue;
    }
    if (isDepositVoucher(d)) { out.depositVouchers.push(d); continue; }
    out.other.push(d);
  }
  return out;
}

/**
 * Collections on the contract that are NOT the advance the creation path made,
 * and which therefore bar a rebuild — the rebuild deletes the installments
 * they hang off.
 *
 * Both halves are required: the note marks it as an advance, and the absent
 * `invoiceId` proves the creation path wrote it rather than a hand-made
 * receipt voucher that happens to carry the same note.
 */
export function foreignCollections(cols: ContractCollectionRow[]): ContractCollectionRow[] {
  return cols.filter((c) => !(c.notes === ADVANCE_NOTE && c.invoiceId == null));
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Sum of a set of collections, in riyals. */
export function collectionsTotal(cols: ContractCollectionRow[]): number {
  return round2(cols.reduce((s, c) => s + (Number(c.amount) || 0), 0));
}

/** Statuses that mean the contract is over — mirrors ENDED_CONTRACT_STATUSES. */
const ENDED = ["terminated", "cancelled"] as const;

export type RebuildFacts = {
  /** The stored contract as it is now. */
  isDraft: boolean;
  status: string | null;
  /** Rows in `invoices` (the ZATCA tax-invoice table) pointing at this contract. */
  zatcaInvoiceCount: number;
  docs: ContractDocs;
  /** Collections on this contract's installments that are not the advance. */
  foreignCollections: ContractCollectionRow[];
  /** Sum of the live deposit vouchers, in riyals. 0 when none was issued. */
  depositVoucherTotal: number;
  /** The deposit amount the rebuild would store. */
  nextDepositAmount: number;
  /** The deposit status the rebuild would store, e.g. "collected"/"pending". */
  nextDepositStatus: string | null;
  /** Whether the incoming payload asks for a draft. */
  wantsDraft: boolean;
};

export type RebuildRefusal = { code: string; message: string };

/**
 * May this contract be rebuilt? Returns `null` when it may, or the reason it
 * may not. Conservative by construction — every branch below is a refusal, and
 * a fact the caller could not establish should be passed in as "present".
 */
export function rebuildBlockReason(f: RebuildFacts): RebuildRefusal | null {
  // ── 1. A draft is not rebuilt, it is simply saved ──────────────────────
  // A draft holds no units, has no schedule and mints no artefacts, so there
  // is nothing to destroy: the ordinary PATCH already does the whole job.
  if (f.isDraft) {
    return {
      code: "draft",
      message:
        "هذا العقد مسودة — تُحفظ التعديلات بالطريقة المعتادة دون إعادة بناء، " +
        "لأن المسودة لا تُنشئ جدول دفعات ولا تحجز الوحدات · " +
        "Drafts are saved through the normal update path",
    };
  }
  // Turning a live contract back into a draft is not a rebuild: it would have
  // to release the units and erase a schedule without replacing it.
  if (f.wantsDraft) {
    return {
      code: "to_draft",
      message:
        "لا يمكن إعادة عقد ساري إلى حالة المسودة · A live contract cannot be turned back into a draft",
    };
  }

  // ── 2. An ended contract is history, not a work in progress ────────────
  // Terminating or cancelling a contract already freed its units, unlinked
  // them, and may have issued refund/disbursement vouchers against its
  // collections. Rebuilding it would resurrect a schedule under a closed
  // contract and re-occupy units another contract may now hold. Conservative:
  // refuse — reactivate it deliberately first, or write a new contract.
  if (f.status && (ENDED as readonly string[]).includes(f.status)) {
    return {
      code: "ended",
      message:
        "لا يمكن إعادة بناء عقد منتهٍ أو ملغى. أعِد تفعيل العقد أولاً أو أنشئ عقداً جديداً · " +
        "A terminated or cancelled contract cannot be rebuilt",
    };
  }

  // ── 3. The ZATCA bar ───────────────────────────────────────────────────
  // A tax invoice is an immutable fiscal document: once it exists, the values
  // it was built from are frozen and the only lawful correction is a credit
  // note. Two places record one:
  //
  //   (a) `invoices` — the ZATCA e-invoice table itself, joined by contract.
  //       ANY non-deleted row bars the rebuild, whatever its `status`. Even a
  //       `draft` row has already been allocated an ICV and a PIH in the
  //       landlord's hash chain (`invoices_user_owner_env_icv_uniq`), so the
  //       document exists as far as the chain is concerned.
  //
  //   (b) `simple_invoices` — the portal's own documents, which are what the
  //       landlord actually issues. `billing.module.ts` stamps the outcome of
  //       the ZATCA mirror onto the row (see ZATCA_SUBMITTED_STATUSES above);
  //       a document that reached ZATCA bars the rebuild exactly like (a).
  if (f.zatcaInvoiceCount > 0 || f.docs.zatcaSubmitted.length > 0) {
    return {
      code: "zatca_invoice",
      message:
        "لا يمكن تعديل عقد صدرت له فاتورة ضريبية مُرسلة إلى هيئة الزكاة والضريبة والجمارك. " +
        "الفاتورة الضريبية مستند نهائي لا يُعدَّل ولا يُلغى، والطريق الصحيح للتصحيح هو إصدار " +
        "إشعار دائن (Credit Note) بالفرق، ثم إنشاء عقد جديد إن لزم الأمر · " +
        "A contract with an issued ZATCA tax invoice cannot be modified — issue a credit note instead",
    };
  }

  // ── 4. Any other live billing document ─────────────────────────────────
  // Invoices, notes and manual receipt vouchers all point at installments the
  // rebuild is about to delete. Even without ZATCA, the tenant is holding a
  // document that would stop matching anything.
  if (f.docs.other.length > 0) {
    const numbers = f.docs.other.length;
    return {
      code: "linked_documents",
      message:
        `لا يمكن إعادة بناء العقد: يرتبط به ${numbers} مستند فوترة قائم (فواتير أو سندات) ` +
        "تشير إلى دفعات سيتم حذفها. ألغِ هذه المستندات أولاً أو أصدر إشعاراً دائناً · " +
        "Contract has linked billing documents",
    };
  }

  // ── 5. Money already collected ─────────────────────────────────────────
  // The advance the creation path recorded is fair game — the rebuild re-mints
  // it from the new values. Anything else is real money received against a
  // specific installment, and destroying that installment would erase the
  // record of a payment the landlord actually took. Same rule
  // `generate-installments` already applies, stated once here.
  if (f.foreignCollections.length > 0) {
    const total = collectionsTotal(f.foreignCollections).toFixed(2);
    return {
      code: "collected_payments",
      message:
        `لا يمكن إعادة بناء العقد بعد تحصيل دفعات عليه (${total} ر.س). ` +
        "استرد المبالغ أو أنهِ العقد وأنشئ عقداً جديداً · " +
        "Contract already has collected payments",
    };
  }

  // ── 6. A collected deposit is cash in hand ─────────────────────────────
  // The deposit voucher (سند قبض) is proof that trust money was received; the
  // rebuild deliberately does NOT void and re-mint it, because that would
  // destroy the receipt the tenant holds and burn an RV number. So the deposit
  // figure it attests to must not move underneath it.
  // A receipted deposit cannot be un-receipted either. Saying the deposit is no
  // longer collected while its confirmed voucher stands leaves the contract and
  // the tenant's receipt telling different stories, and the audit diff did not
  // even record it because the status was not one of the money facts.
  if (f.depositVoucherTotal > 0.01 && f.nextDepositStatus != null && f.nextDepositStatus !== "collected") {
    return {
      code: "deposit_uncollected",
      message:
        `لا يمكن وضع التأمين كغير محصَّل بعد إصدار سند قبض التأمين (${f.depositVoucherTotal.toFixed(2)} ر.س). ` +
        "استرد التأمين من شاشة إنهاء العقد ثم أعد التعديل · " +
        "The deposit cannot be marked uncollected once its receipt voucher has been issued",
    };
  }

  if (f.depositVoucherTotal > 0.01 && Math.abs(f.depositVoucherTotal - f.nextDepositAmount) > 0.01) {
    return {
      code: "deposit_voucher",
      message:
        `لا يمكن تغيير مبلغ التأمين (${f.depositVoucherTotal.toFixed(2)} ر.س) بعد إصدار سند قبض التأمين. ` +
        "استرد التأمين من شاشة إنهاء العقد ثم أعد التعديل · " +
        "The deposit amount cannot change once its receipt voucher has been issued",
    };
  }

  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * Audit
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The money-driving shape of a contract — the fields whose change is the whole
 * reason a rebuild exists. Anything outside this set (a corrected spelling of
 * the tenant's name, a note) does not alter a single installment, so it is left
 * out of the audit diff to keep it readable.
 */
export type ContractMoneyFacts = {
  rent: string;
  start: string;
  end: string;
  frequency: string;
  vat: boolean;
  escalationType: string;
  escalationRate: string;
  deposit: string;
  depositStatus: string;
  prepaid: string;
  agencyFee: string;
  fees: { name: string; amount: string; recurrence: string }[];
  units: number[];
  rentTerms: { year: number; amount: number }[];
};

const str = (v: unknown, fallback = "0") => (v == null ? fallback : String(v));

export function contractMoneyFacts(
  row: Record<string, any>,
  unitIds: number[],
  rentTerms: { year: number; amount: number }[],
): ContractMoneyFacts {
  const fees = Array.isArray(row.additionalFees) ? row.additionalFees : [];
  return {
    rent: str(row.monthlyRent),
    start: str(row.startDate, ""),
    end: str(row.endDate, ""),
    frequency: str(row.paymentFrequency, "monthly"),
    vat: Boolean(row.vatEnabled),
    escalationType: str(row.escalationType, "percent"),
    escalationRate: str(row.escalationRate),
    deposit: str(row.depositAmount),
    depositStatus: str(row.depositStatus, ""),
    prepaid: str(row.prepaidRent),
    agencyFee: str(row.agencyFee),
    fees: fees.map((f: any) => ({
      name: String(f?.name ?? "رسوم"),
      amount: str(f?.amount),
      recurrence: String(f?.recurrence ?? "monthly"),
    })),
    units: [...unitIds].sort((a, b) => a - b),
    rentTerms: [...rentTerms].sort((a, b) => a.year - b.year),
  };
}

/** Only the fields that actually moved, as `{ from, to }`. */
export function factsDiff(
  before: ContractMoneyFacts,
  after: ContractMoneyFacts,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(before) as (keyof ContractMoneyFacts)[]) {
    const a = before[key], b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[key] = { from: a, to: b };
  }
  return diff;
}

/**
 * The audit record's payload, rendered into `audit_logs.path`.
 *
 * ── Why the payload lives in `path` ──
 * `audit_logs` was built for the global interceptor and has exactly one shape:
 * (ownerUserId, actorUserId, action, entity, entityId, method, path). There is
 * no column for a before/after payload, and adding one is a migration this
 * change is not making. So the rebuild follows the existing shape — the same
 * columns the interceptor writes, so the row renders in the audit list like any
 * other — and carries its detail as a JSON suffix on `path`, after the route
 * and a single space. `path` is already a free-form description of the request;
 * everything before the space is still a real route, so existing consumers show
 * something sensible, and everything after it is machine-readable.
 *
 * `action` stays a clean `"rebuild"` so the row is greppable and filterable.
 *
 * The proper fix, when a migration is possible, is a `details jsonb` column;
 * this function is then the only thing that has to change.
 */
export function rebuildAuditPath(
  contractId: number,
  contractNumber: string | null,
  diff: Record<string, { from: unknown; to: unknown }>,
  counts: { installmentsRemoved: number; installmentsCreated: number },
): string {
  const payload = {
    contractNumber: contractNumber ?? null,
    changed: diff,
    installments: counts,
  };
  return `/contracts/${contractId} ${JSON.stringify(payload)}`;
}
