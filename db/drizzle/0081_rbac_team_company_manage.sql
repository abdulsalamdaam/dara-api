-- RBAC: `team.manage` and `company.manage` (Oct 2026).
--
-- Team management and the company profile used to be gated by "is this a
-- top-level login" rather than by a permission. Both are permissions now, held
-- by the account-holder presets (`user`, and `general` through it).
--
-- The SYSTEM roles (company_id IS NULL: user, general, admin, super_admin...)
-- are rewritten from code on every boot (bootstrap.ts, "Phase 1.6"), so they
-- need nothing here. This statement covers the one case the boot refresh does
-- not: a company-scoped role that an ACCOUNT HOLDER (a top-level, non-staff
-- user) is linked to. Without the grant such a holder would lose the team and
-- company screens. Employee roles (`emp_custom_*`, held by users with
-- owner_user_id set) are deliberately NOT touched: employees could never
-- manage the team before, and granting it is the holder's decision.
--
-- Idempotent: re-running only re-adds keys an account holder's own role must
-- carry anyway. Applied at boot by bootstrap.ts; safe to run by hand.
UPDATE roles r
SET permissions = (
      SELECT jsonb_agg(DISTINCT p ORDER BY p)
      FROM jsonb_array_elements_text(r.permissions || '["team.manage","company.manage"]'::jsonb) AS t(p)
    ),
    updated_at = now()
WHERE r.company_id IS NOT NULL
  AND r.deleted_at IS NULL
  AND NOT (r.permissions @> '["team.manage","company.manage"]'::jsonb)
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.role_id = r.id
      AND u.owner_user_id IS NULL
      AND u.deleted_at IS NULL
  )
  AND r.key NOT IN ('super_admin', 'admin');
