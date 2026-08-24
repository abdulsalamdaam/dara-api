/**
 * The QA login bypasses, and the single flag that arms them.
 *
 * These flows are a full login, so a bypass here IS an authentication bypass.
 * Two rules follow from that, and both are load-bearing:
 *
 * 1. **Env-driven, never hardcoded.** A code-level bypass ships to production
 *    the moment someone forgets to flip it back — which is exactly what
 *    happened: the email-OTP path accepted the fixed code for every registered
 *    address on the live API, under a `TODO: remove before production` that was
 *    never actioned. The flag is the only thing that turns any of this on.
 *
 * 2. **Fails closed.** An unset or malformed flag means disabled. There is no
 *    "assume development" branch, because the API cannot tell where it is
 *    running: `APP_ENV` is literally "staging" on the production app too, and
 *    `NODE_ENV` is "production" on both (see DARA-NOTES §1). Anything that
 *    tried to infer the environment would infer it wrong.
 *
 * Currently `TWILIO_DEV_BYPASS` is "true" on dara-api-staging and "false" on
 * dara-api, so staging keeps its fixed codes and production accepts none.
 */

/** Fixed code accepted for the email OTP (portal login) while armed. */
export const EMAIL_OTP_BYPASS_CODE = "111111";

/**
 * Are the QA login bypasses armed? `SMS_DEV_BYPASS` is the current name;
 * `TWILIO_DEV_BYPASS` is the legacy one still set on the deployed apps.
 */
export function qaBypassEnabled(): boolean {
  return process.env.SMS_DEV_BYPASS === "true" || process.env.TWILIO_DEV_BYPASS === "true";
}
