/**
 * Billing switches, read from env on every call so a Coolify env change and a
 * restart is all it takes.
 *
 *   BILLING_TOKENIZATION_ENABLED=true   in-app checkout that saves the card, for everyone
 *   BILLING_TOKENIZATION_USERS=12,34    …or only for these account ids (test on production
 *                                       without changing anyone else's checkout)
 *   BILLING_TEST_PRICE_USERS=12=5       these accounts are charged this many SAR (VAT
 *                                       included) instead of the plan price, on every
 *                                       subscription payment and renewal. Their payments
 *                                       do not email the platform admins.
 *
 * Account ids are the paying account (the owner), never an employee.
 */
import { isMoyasarConfigured, moyasarPublishableKey } from "./moyasar";

const flag = (k: string) => String(process.env[k] || "").toLowerCase() === "true";

function idList(raw: string | undefined): Set<number> {
  return new Set(String(raw || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));
}

function priceMap(raw: string | undefined): Map<number, number> {
  const m = new Map<number, number>();
  for (const part of String(raw || "").split(",")) {
    const [id, price] = part.split("=").map((s) => Number(String(s).trim()));
    if (Number.isInteger(id) && id! > 0 && Number.isFinite(price) && price! > 0) m.set(id!, Math.round(price! * 100) / 100);
  }
  return m;
}

/** In-app checkout for this account: on for everyone, or opted in by id. Needs both Moyasar keys. */
export function tokenizationEnabled(accountId?: number | null): boolean {
  if (!isMoyasarConfigured() || !moyasarPublishableKey()) return false;
  if (flag("BILLING_TOKENIZATION_ENABLED")) return true;
  return accountId != null && idList(process.env.BILLING_TOKENIZATION_USERS).has(accountId);
}

/** A fixed test charge (SAR, VAT included) for this account, or null for the real price. */
export function testPriceFor(accountId?: number | null): number | null {
  if (accountId == null) return null;
  return priceMap(process.env.BILLING_TEST_PRICE_USERS).get(accountId) ?? null;
}
