-- Which environment the `prod_*` credential columns actually hold.
--
-- Simulation and production share one set of columns (same lifecycle, only the
-- gateway prefix and the CSR template differ). Nothing recorded WHICH of the
-- two a row's certificate came from, so a seller who had only rehearsed
-- against simulation showed up everywhere as "Live (production)":
-- `productionOnboarded` is just `prod_cert_pem IS NOT NULL`, and
-- switchEnvironment('production') accepted that same certificate as proof the
-- seller was ready for real invoices.
--
-- 'simulation' | 'production'. NULL = filled before this column existed.
ALTER TABLE "zatca_credentials" ADD COLUMN IF NOT EXISTS "prod_slot_env" text;

-- Backfill what can be known: a row whose active environment is production and
-- that carries a production certificate is production. Everything else keeps
-- NULL rather than being guessed at — an unknown is safer than a wrong "live".
UPDATE "zatca_credentials"
SET "prod_slot_env" = 'production'
WHERE "prod_cert_pem" IS NOT NULL
  AND "prod_slot_env" IS NULL
  AND "active_environment" = 'production';
