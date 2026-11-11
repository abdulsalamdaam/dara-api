/**
 * Whether a new registration waits for an admin before it can be used.
 *
 * Off by default (2026-11-11): sign-up is self-serve. The account is created
 * `pending`, and the moment the registrant proves the email (the verification
 * code, or a login code — both arrive in the same inbox) it is activated on
 * the plan they picked, with the platform trial (14 days by default, see
 * common/trial.ts). Platform admins still get an email for every new account,
 * but it asks for nothing.
 *
 * `REGISTRATION_REQUIRES_APPROVAL=true` restores the admin queue exactly as it
 * was: accounts stay `pending` until `PATCH /admin/registrations/:id/approve`.
 */
export function registrationRequiresApproval(): boolean {
  return String(process.env.REGISTRATION_REQUIRES_APPROVAL ?? "").trim().toLowerCase() === "true";
}
