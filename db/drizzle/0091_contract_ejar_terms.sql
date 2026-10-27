-- 0091: the Ejar contract terms Get Contracts returns and the contract had no
-- column for (Ejar Import v3, Oct 2026):
--
--   auto_renewal      auto_renewal_enabled — the contract renews itself
--   sublease_allowed  sublease_allowed — the tenant may sublet
--   ejar_fee          contract_creation_ejar_fee — Ejar's registration fee (SAR)
--   broker_name       broker_name — the broker on the Ejar contract
--   broker_id_number  broker_national_id
--
-- All nullable: a manual contract and every existing row leave them null
-- (= not known). Location needs no column: the property's map_url already
-- holds Ejar's latitude/longitude as ?q=LAT,LNG (LocationPicker, Map view).
-- Idempotent (applied at boot by bootstrap.ts on every start).

alter table contracts add column if not exists auto_renewal boolean;
alter table contracts add column if not exists sublease_allowed boolean;
alter table contracts add column if not exists ejar_fee numeric(12, 2);
alter table contracts add column if not exists broker_name text;
alter table contracts add column if not exists broker_id_number text;
