/**
 * The security deposit (التأمين) after a contract is created — the rules, kept
 * pure so they are tested without a database (TR-5, accountant test 5 Oct 2026).
 *
 * A contract's deposit has two halves:
 *  - the TERMS on the contract row (`deposit_amount`, due date, method): what the
 *    tenant owes as a deposit. They carry no ledger effect of their own.
 *  - the RECEIPTS: confirmed `simple_invoices` of kind `deposit` (سند قبض). Each
 *    is an issued document and, under Finance v2, posts E09 (Dr bank / Cr 2141
 *    deposits held) for itself.
 *
 * So the terms may change freely until money is receipted. After that a receipt
 * is never edited or re-minted: more deposit is recorded as ANOTHER receipt for
 * the difference (its own E09), and less deposit is a refund, which belongs to
 * the settlement at contract end (terminate → E10), never a silent edit.
 */

export const DEPOSIT_DESC = "تأمين (وديعة)";
export const DEPOSIT_KIND = "deposit";

export interface DepositFacts {
  isDraft: boolean;
  /** contracts.status */
  status: string | null;
  /** contracts.deposit_status */
  depositStatus: string | null;
  /** Σ live (confirmed, not deleted) deposit receipt vouchers, riyals. */
  received: number;
  /** The contract still carries a legacy deposit INSTALLMENT row (the pre-voucher model). */
  legacyDepositRow: boolean;
}

export interface Refusal {
  status: 400 | 409;
  error: string;
  message: string;
}

const ENDED = new Set(["terminated", "cancelled"]);
const SETTLED = new Set(["returned", "forfeited"]);

function common(f: DepositFacts): Refusal | null {
  if (f.isDraft) {
    return { status: 400, error: "DEPOSIT_CONTRACT_DRAFT",
      message: "العقد مسودة — عدّل التأمين من معالج العقد · The contract is a draft — set the deposit in the contract wizard" };
  }
  if (ENDED.has(String(f.status))) {
    return { status: 409, error: "DEPOSIT_CONTRACT_ENDED",
      message: "لا يمكن تعديل التأمين على عقد منتهٍ · The deposit of an ended contract cannot be changed" };
  }
  if (SETTLED.has(String(f.depositStatus))) {
    return { status: 409, error: "DEPOSIT_SETTLED",
      message: "سُوِّي التأمين (أُعيد أو صودر) ولا يمكن تعديله · The deposit was already returned or forfeited" };
  }
  if (f.legacyDepositRow) {
    return { status: 409, error: "DEPOSIT_LEGACY_ROW",
      message: "التأمين مسجّل كقسط في جدول الدفعات — عدّله من الجدول · This deposit is an installment row — manage it from the schedule" };
  }
  return null;
}

/** May the deposit TERMS be set to `amount`? Only while nothing has been receipted. */
export function termsChangeRefusal(f: DepositFacts, amount: number): Refusal | null {
  const r = common(f);
  if (r) return r;
  if (!(amount >= 0)) return { status: 400, error: "DEPOSIT_BAD_AMOUNT", message: "مبلغ التأمين غير صالح · Invalid deposit amount" };
  if (f.received > 0.005) {
    return {
      status: 409, error: "DEPOSIT_RECEIPTED",
      message:
        `صدر سند قبض بالتأمين (${f.received.toFixed(2)} ر.س) ولا يُعدَّل. لزيادة التأمين سجّل تأميناً إضافياً بسند قبض جديد، ` +
        "وأي تخفيض يُردّ للمستأجر ضمن تسوية التأمين عند إنهاء العقد · " +
        "A receipt was already issued for this deposit and is not edited. Record an additional deposit (a new receipt) to increase it; " +
        "a reduction is refunded to the tenant in the deposit settlement when the contract ends",
    };
  }
  return null;
}

/** May an ADDITIONAL deposit receipt of `amount` be issued? Only on top of an existing receipt. */
export function topUpRefusal(f: DepositFacts, amount: number): Refusal | null {
  const r = common(f);
  if (r) return r;
  if (!(amount > 0)) return { status: 400, error: "DEPOSIT_BAD_AMOUNT", message: "مبلغ التأمين الإضافي يجب أن يكون أكبر من صفر · The additional deposit must be greater than zero" };
  if (!(f.received > 0.005)) {
    return { status: 409, error: "DEPOSIT_NOT_RECEIPTED",
      message: "لم يُحصَّل التأمين بعد — استخدم «تحصيل الوديعة» · The deposit has not been collected yet — use “Collect deposit”" };
  }
  return null;
}

/** The deposit status the contract row should carry after the terms change (no receipt exists). */
export function statusForTerms(amount: number): "pending" | null {
  return amount > 0.005 ? "pending" : null;
}

/** The contract's deposit amount after a top-up: the receipts never exceed it. */
export function amountAfterTopUp(currentAmount: number, receivedBefore: number, topUp: number): number {
  const received = round2(receivedBefore + topUp);
  return round2(Math.max(currentAmount, received));
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
