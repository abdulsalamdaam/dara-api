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
