-- 0092: co-landlords / co-tenants an Ejar contract names beside the main ones
-- (Ejar multi-party import, Oct 2026).
--
-- Ejar can list two or more PRINCIPAL lessors (co-owners of the property) or
-- tenants on one contract; Dara links one landlord and one tenant. The user
-- picks the main one of each at import; the others are kept here, on the
-- contract, FOR REFERENCE ONLY: a JSON array of
--   { role: "co_landlord" | "co_tenant", kind, name, idType, idNumber,
--     crNumber, unifiedNumber, vatNumber, nationality, phone, email, share,
--     source: "ejar", referenceOnly: true }
-- They are never an owners / tenants row, never linked as landlord / tenant,
-- never counted in the landlord cap, and nothing invoices, reports, settles
-- or messages them. Null on every manual contract and every existing row.
-- Idempotent (applied at boot by bootstrap.ts on every start).

alter table contracts add column if not exists co_parties jsonb;
