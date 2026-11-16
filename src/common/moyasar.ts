/**
 * Minimal Moyasar (https://moyasar.com) hosted-invoice client.
 *
 * We use Moyasar **invoices**: the backend creates an invoice for the
 * subscription amount and redirects the user to the returned hosted payment
 * page (`url`). Moyasar then calls our webhook + redirects to `success_url`.
 *
 * Credentials are read from the environment so the flow is test-ready before
 * real keys exist:
 *   MOYASAR_SECRET_KEY   — secret API key (basic-auth username, blank password)
 *   MOYASAR_BASE_URL     — defaults to https://api.moyasar.com/v1
 *
 * `isMoyasarConfigured()` is false until a secret key is set; callers should
 * surface a clear "payments not configured yet" message in that case.
 */

const BASE = process.env.MOYASAR_BASE_URL || "https://api.moyasar.com/v1";

export function isMoyasarConfigured(): boolean {
  return !!process.env.MOYASAR_SECRET_KEY;
}

function authHeader(): string {
  const key = process.env.MOYASAR_SECRET_KEY || "";
  // Basic auth: secret key as username, empty password.
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

export interface MoyasarInvoice {
  id: string;
  status: string; // initiated | paid | failed | ...
  amount: number; // halalas
  currency: string;
  url: string; // hosted payment page
  description?: string;
  metadata?: Record<string, any>;
  /** The payment attempts made against this invoice, as Moyasar returns them on GET. */
  payments?: MoyasarPayment[];
}

/** The fields of a Moyasar payment object that verification relies on. */
export interface MoyasarPayment {
  id: string;
  status: string; // initiated | paid | authorized | captured | failed | refunded | voided | ...
  amount: number; // halalas
  currency?: string;
  refunded?: number; // halalas refunded so far
  invoice_id?: string | null;
  metadata?: Record<string, any> | null;
  created_at?: string;
}

/** Create a hosted invoice. `amountSar` is in SAR; Moyasar charges in halalas. */
export async function createMoyasarInvoice(input: {
  amountSar: number;
  description: string;
  callbackUrl?: string;
  successUrl?: string;
  backUrl?: string;
  metadata?: Record<string, any>;
}): Promise<MoyasarInvoice> {
  if (!isMoyasarConfigured()) throw new Error("MOYASAR_NOT_CONFIGURED");
  const body: Record<string, any> = {
    amount: Math.round(input.amountSar * 100), // SAR → halalas
    currency: "SAR",
    description: input.description,
  };
  if (input.callbackUrl) body.callback_url = input.callbackUrl;
  if (input.successUrl) body.success_url = input.successUrl;
  if (input.backUrl) body.back_url = input.backUrl;
  if (input.metadata) body.metadata = input.metadata;

  const res = await fetch(`${BASE}/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MOYASAR_INVOICE_FAILED: ${res.status} ${text}`);
  }
  return (await res.json()) as MoyasarInvoice;
}

/** Fetch an invoice (used by the webhook to verify the real status). */
export async function fetchMoyasarInvoice(invoiceId: string): Promise<MoyasarInvoice> {
  if (!isMoyasarConfigured()) throw new Error("MOYASAR_NOT_CONFIGURED");
  const res = await fetch(`${BASE}/invoices/${invoiceId}`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`MOYASAR_FETCH_FAILED: ${res.status}`);
  return (await res.json()) as MoyasarInvoice;
}

/**
 * Cancel (void) an unpaid invoice. Used when a user changes plan/cycle so the
 * superseded hosted invoice can no longer be paid. A paid/non-cancellable
 * invoice makes Moyasar 4xx — callers treat that as non-fatal.
 */
export async function cancelMoyasarInvoice(invoiceId: string): Promise<void> {
  if (!isMoyasarConfigured()) throw new Error("MOYASAR_NOT_CONFIGURED");
  const res = await fetch(`${BASE}/invoices/${invoiceId}/cancel`, {
    method: "POST",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`MOYASAR_CANCEL_FAILED: ${res.status}`);
}

/* ── Tokenization: saved cards + recurring charges (migration 0097) ─────────
 * https://docs.moyasar.com/guides/tokenization/overview
 *
 *  - The first payment is made in the browser (Moyasar.js, publishable key)
 *    with `save_card: true`; the token id comes back in `source.token`.
 *  - Renewals: POST /v1/payments with source {type: "token", token} — from
 *    the server only, with the secret key. No 3DS for an `active` token.
 *  - `given_id` (UUID) makes a payment idempotent: repeating it returns the
 *    existing payment instead of charging again.
 */

/**
 * This environment's name on a payment (`metadata.app`): the app host. Staging
 * and production share one Moyasar account, so a payment is matched to a row
 * only when it was made by this environment.
 */
export function moyasarAppTag(): string {
  const url = process.env.APP_PUBLIC_URL || "https://app.dara-sa.com";
  try { return new URL(url).host; } catch { return url; }
}

/** The publishable key for the browser form. Null until configured. */
export function moyasarPublishableKey(): string | null {
  return process.env.MOYASAR_PUBLISHABLE_KEY || null;
}

/** Whether the configured secret key is a test key (sk_test_…). */
export function isMoyasarTestMode(): boolean {
  return (process.env.MOYASAR_SECRET_KEY || "").startsWith("sk_test_");
}

/** The fields of a payment source we rely on. */
export interface MoyasarPaymentSource {
  type?: string; // creditcard | applepay | samsungpay | token | stcpay
  company?: string; // visa | master | mada | amex
  name?: string;
  number?: string; // masked, e.g. "4111-11XX-XXXX-1111"
  token?: string | null;
  message?: string | null;
  transaction_url?: string | null;
  gateway_id?: string;
}

export interface MoyasarPaymentFull extends MoyasarPayment {
  description?: string | null;
  source?: MoyasarPaymentSource | null;
  live?: boolean;
}

export interface MoyasarToken {
  id: string;
  status: string; // initiated | active | inactive | expired
  brand?: string | null;
  funding?: string | null;
  country?: string | null;
  month?: string | number | null;
  year?: string | number | null;
  name?: string | null;
  last_four?: string | null;
  metadata?: Record<string, any> | null;
}

async function moyasarJson<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null; text: string }> {
  if (!isMoyasarConfigured()) throw new Error("MOYASAR_NOT_CONFIGURED");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: authHeader(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  let data: T | null = null;
  try { data = text ? (JSON.parse(text) as T) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

/** GET /v1/payments/:id — the server-side truth for a payment. */
export async function fetchMoyasarPayment(paymentId: string): Promise<MoyasarPaymentFull> {
  const r = await moyasarJson<MoyasarPaymentFull>("GET", `/payments/${encodeURIComponent(paymentId)}`);
  if (r.status !== 200 || !r.data) throw new Error(`MOYASAR_PAYMENT_FETCH_FAILED: ${r.status}`);
  return r.data;
}

/** Like `fetchMoyasarPayment`, but null on a 404 (the payment was never created). */
export async function findMoyasarPayment(paymentId: string): Promise<MoyasarPaymentFull | null> {
  const r = await moyasarJson<MoyasarPaymentFull>("GET", `/payments/${encodeURIComponent(paymentId)}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.data) throw new Error(`MOYASAR_PAYMENT_FETCH_FAILED: ${r.status}`);
  return r.data;
}

/**
 * Charge a saved token. `givenId` is the idempotency key: Moyasar returns the
 * existing payment for a repeated id, so a retry after a timeout never
 * charges twice. Returns the payment whatever its status (paid / failed /
 * initiated when the issuer demands 3DS); throws only when Moyasar gave no
 * payment at all (network error, 5xx, a 4xx validation error).
 */
export async function chargeMoyasarToken(input: {
  givenId: string;
  token: string;
  amountSar: number;
  description: string;
  callbackUrl: string;
  metadata: Record<string, string>;
}): Promise<MoyasarPaymentFull> {
  const body = {
    given_id: input.givenId,
    amount: Math.round(input.amountSar * 100),
    currency: "SAR",
    description: input.description,
    callback_url: input.callbackUrl,
    metadata: input.metadata,
    // Merchant-initiated renewal: no cardholder to do 3DS. Moyasar defaults
    // `3ds` from the token status (active → false) but its guide and API
    // reference disagree on that default, so say it outright.
    source: { type: "token", token: input.token, "3ds": false },
  };
  const r = await moyasarJson<MoyasarPaymentFull & { message?: string; type?: string }>("POST", "/payments", body);
  if ((r.status === 200 || r.status === 201) && r.data?.id) return r.data;
  // "Payment is already created" for this given_id — fetch it instead.
  if (r.status === 400 && /already/i.test(r.text)) return fetchMoyasarPayment(input.givenId);
  throw new Error(`MOYASAR_TOKEN_CHARGE_FAILED: ${r.status} ${r.text.slice(0, 300)}`);
}

/** GET /v1/tokens/:id — status, brand and last four. */
export async function fetchMoyasarToken(tokenId: string): Promise<MoyasarToken> {
  const r = await moyasarJson<MoyasarToken>("GET", `/tokens/${encodeURIComponent(tokenId)}`);
  if (r.status !== 200 || !r.data) throw new Error(`MOYASAR_TOKEN_FETCH_FAILED: ${r.status}`);
  return r.data;
}

/** DELETE /v1/tokens/:id. A token Moyasar no longer has (404) counts as deleted. */
export async function deleteMoyasarToken(tokenId: string): Promise<void> {
  const r = await moyasarJson<unknown>("DELETE", `/tokens/${encodeURIComponent(tokenId)}`);
  if (r.status === 204 || r.status === 200 || r.status === 404) return;
  throw new Error(`MOYASAR_TOKEN_DELETE_FAILED: ${r.status}`);
}
