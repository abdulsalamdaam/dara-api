/**
 * Minimal Dhamen (Elm) "Pay-In" client — subscription payments through the
 * Dhamen embedded widget (Integration Guide v1.6 + the widget guide at
 * `${DHAMEN_BASE_URL}/widget/integration-guide.html`).
 *
 *   1. `createDhamenPayment` — POST /api/payments/customer-payment. Dhamen
 *      answers with a hashed `invoiceId` (and a hosted `paymentUrl`).
 *   2. The browser mounts `dhamen-pay.js` with that `invoiceId`; the card /
 *      mada / Apple Pay form runs inside Dhamen's iframe.
 *   3. `fetchDhamenPaymentStatus` — POST /api/payments/customer-payment-status.
 *      The ONLY thing we trust: the widget's onSuccess and Dhamen's
 *      notification are both just a cue to ask this.
 *
 * Auth is four static headers (App-key, App-id, ClientId, api-version). Env:
 *   DHAMEN_BASE_URL     https://dhamendemo.elm.sa (QA) — no default on purpose
 *   DHAMEN_APP_ID / DHAMEN_APP_KEY / DHAMEN_CLIENT_ID
 *   DHAMEN_API_VERSION  default 2
 */

import { randomBytes } from "node:crypto";

export function dhamenBaseUrl(): string | null {
  const b = (process.env.DHAMEN_BASE_URL || "").trim().replace(/\/$/, "");
  return b || null;
}

export function isDhamenConfigured(): boolean {
  return !!(dhamenBaseUrl() && process.env.DHAMEN_APP_ID && process.env.DHAMEN_APP_KEY && process.env.DHAMEN_CLIENT_ID);
}

/** The widget script the browser loads. Same host as the API. */
export function dhamenSdkUrl(): string | null {
  const b = dhamenBaseUrl();
  return b ? `${b}/widget/dhamen-pay.js` : null;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "App-key": process.env.DHAMEN_APP_KEY || "",
    "App-id": process.env.DHAMEN_APP_ID || "",
    ClientId: process.env.DHAMEN_CLIENT_ID || "",
    "api-version": process.env.DHAMEN_API_VERSION || "2",
  };
}

async function dhamenPost<T>(path: string, body: unknown): Promise<{ status: number; data: T | null; text: string }> {
  const base = dhamenBaseUrl();
  if (!base || !isDhamenConfigured()) throw new Error("DHAMEN_NOT_CONFIGURED");
  const res = await fetch(`${base}${path}`, {
    method: path.endsWith("/cancel") ? "PUT" : "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  let data: T | null = null;
  try { data = text ? (JSON.parse(text) as T) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

/**
 * Dhamen's `customerIdentifier` (≤ 12 chars): who pays. A value Dhamen does not
 * know as a `create-customer` identity routes the money into the authority's
 * collection account — what we want; no per-customer virtual IBAN. Prefixed by
 * environment so staging (a copy of production's ids) never shares one.
 */
export function dhamenCustomerIdentifier(accountId: number): string {
  const env = (process.env.DHAMEN_ENV_TAG || "S").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase() || "S";
  return `${env}${String(accountId).padStart(9, "0")}`.slice(0, 12);
}

export interface DhamenCreatedPayment {
  customerIdentifier: string;
  paymentUrl: string;
  invoiceId: string;
}

/** POST /api/payments/customer-payment — one customer, one amount (SAR, VAT included). */
export async function createDhamenPayment(input: {
  paymentReferenceId: string;
  name: string;
  customerIdentifier: string;
  amountSar: number;
  returnUrl: string;
  expiresInMinutes?: number;
  recurring?: boolean;
  email?: string | null;
  mobile?: string | null;
}): Promise<DhamenCreatedPayment> {
  const customer: Record<string, unknown> = {
    name: input.name.slice(0, 100) || "Dara customer",
    customerIdentifier: input.customerIdentifier,
    amount: Math.round(input.amountSar * 100) / 100,
    returnUrl: input.returnUrl,
  };
  if (input.email) customer.email = input.email;
  if (input.mobile) customer.mobile = input.mobile;
  const r = await dhamenPost<{ customerPayments?: DhamenCreatedPayment[] }>("/api/payments/customer-payment", {
    paymentReferenceId: input.paymentReferenceId,
    enableRecurring: input.recurring ?? false,
    paymentExpiredOnMinutes: input.expiresInMinutes ?? 60,
    customerPayments: [customer],
  });
  const p = r.data?.customerPayments?.[0];
  if (r.status !== 200 || !p?.invoiceId) throw new Error(`DHAMEN_PAYMENT_FAILED: ${r.status} ${r.text.slice(0, 300)}`);
  return p;
}

/** One entry of POST /api/payments/customer-payment-status. */
export interface DhamenPaymentStatus {
  paymentReferenceId: string;
  customerIdentifier?: string;
  amount: number;
  /** 0 unpaid, 1 paid. */
  paymentStatus: number;
  /** 1 Unpaid, 2 Pending, 3 Paid, 4 Rejected, 6 Expired, 7 PreAuthorized, 8 Reversed, 9 Refunded, 10 PartiallyRefunded. */
  paymentStatusDetail: number;
  /** 1 Settled, 3 Pending. */
  reconciliationStatus?: number;
  paymentBrand?: string | null;
  paymentUrl?: string;
  rrn?: string | null;
  cardLast4Digits?: string | null;
  refundPayments?: Array<{ requestId: string; rrn?: string; amount: number }> | null;
}

/** 11 = cancelled (cancel endpoint) — seen on the QA host, not in the guide. */
export const DHAMEN_DETAIL = { UNPAID: 1, PENDING: 2, PAID: 3, REJECTED: 4, EXPIRED: 6, PREAUTHORIZED: 7, REVERSED: 8, REFUNDED: 9, PARTIALLY_REFUNDED: 10, CANCELLED: 11 } as const;

/** The status of our payment reference, or null when Dhamen has no such payment (C013). */
export async function fetchDhamenPaymentStatus(paymentReferenceId: string): Promise<DhamenPaymentStatus | null> {
  const r = await dhamenPost<DhamenPaymentStatus[] | { messageCode?: string }>("/api/payments/customer-payment-status", { paymentReferenceId });
  if (r.status === 200 && Array.isArray(r.data)) {
    return r.data.find((p) => p?.paymentReferenceId === paymentReferenceId) ?? null;
  }
  // "Invoice not found": C013 per the guide; the QA host answers 412 InvPay010.
  if (/C013|InvPay010/.test(r.text)) return null;
  throw new Error(`DHAMEN_STATUS_FAILED: ${r.status} ${r.text.slice(0, 300)}`);
}

/** PUT /api/payments/cancel — void an unpaid payment link. A paid or unknown one is not an error to us. */
export async function cancelDhamenPayment(paymentReferenceId: string): Promise<boolean> {
  const r = await dhamenPost<{ messageCode?: number | string }>("/api/payments/cancel", { paymentReferenceId });
  return r.status === 200 && String(r.data?.messageCode ?? "") === "200";
}

/**
 * POST /api/payments/customer-payment-subsequent — charge the card of an
 * earlier, paid, recurring-enabled payment again, with no cardholder present.
 *
 * Idempotent by our reference: a repeat of `paymentReferenceId` is refused
 * with C033 ("already exist"), which we report as `duplicate` so the caller
 * looks the payment up instead of charging again. C037 means the original
 * cannot be charged again (never paid, or not recurring) — the saved method
 * is unusable.
 */
export async function chargeDhamenSubsequent(input: {
  paymentReferenceId: string;
  originalPaymentReferenceId: string;
  customerIdentifier: string;
  amountSar: number;
}): Promise<{ kind: "created"; invoiceId: string | null } | { kind: "duplicate" } | { kind: "unusable"; code: string } | { kind: "refused"; code: string; message: string }> {
  const r = await dhamenPost<{ invoiceId?: string; messageCode?: string; messageDescription?: string }>("/api/payments/customer-payment-subsequent", {
    paymentReferenceId: input.paymentReferenceId,
    originalPaymentReferenceId: input.originalPaymentReferenceId,
    customerIdentifier: input.customerIdentifier,
    amount: Math.round(input.amountSar * 100) / 100,
  });
  if (r.status === 200 && r.data && !r.data.messageCode) return { kind: "created", invoiceId: r.data.invoiceId ?? null };
  const code = String(r.data?.messageCode ?? "");
  if (code === "C033") return { kind: "duplicate" };
  if (code === "C037" || code === "C104") return { kind: "unusable", code };
  // 4xx with a business code: Dhamen answered and did not charge.
  if (r.status >= 400 && r.status < 500 && code) return { kind: "refused", code, message: String(r.data?.messageDescription ?? "").slice(0, 200) };
  throw new Error(`DHAMEN_SUBSEQUENT_FAILED: ${r.status} ${r.text.slice(0, 300)}`);
}

/* ── References and verification (shared by checkout, renewals and notifications) ── */

function envTag(): string {
  return (process.env.DHAMEN_ENV_TAG || "S").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase() || "S";
}

/** Our paymentReferenceId at Dhamen: unique, ≤ 50, names the environment and the row. */
export function dhamenRef(rowId: number): string {
  return `DARA-${envTag()}-${rowId}-${randomBytes(4).toString("hex")}`;
}

/** The row id a reference of ours names, or null for one that is not ours / not this environment's. */
export function rowIdFromRef(ref: string): number | null {
  const m = /^DARA-([A-Z]{1,2})-(\d{1,10})-[0-9a-f]{8}$/.exec(String(ref || ""));
  if (!m || m[1] !== envTag()) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 && id < 2 ** 31 ? id : null;
}

/** Is this status a full, settled-or-settling payment of exactly this row? */
export function verifyDhamenPaid(row: { amount: string | number; gatewayRef: string | null }, s: DhamenPaymentStatus | null): { ok: boolean; reason?: string } {
  if (!s) return { ok: false, reason: "not_found" };
  if (s.paymentReferenceId !== row.gatewayRef) return { ok: false, reason: "reference_mismatch" };
  if (Number(s.paymentStatus) !== 1 || Number(s.paymentStatusDetail) !== DHAMEN_DETAIL.PAID) {
    return { ok: false, reason: `not_paid:${s.paymentStatus}/${s.paymentStatusDetail}` };
  }
  if (Math.round(Number(s.amount) * 100) !== Math.round(Number(row.amount) * 100)) return { ok: false, reason: "amount_mismatch" };
  if ((s.refundPayments ?? []).length > 0) return { ok: false, reason: "refunded" };
  return { ok: true };
}

