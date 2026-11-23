-- 0100: rental offer send history (23 Nov 2026).
--
-- One row per offer email that the mail provider accepted: who it went to,
-- the client (company) it was for at that moment, who sent it, and the note.
-- The Offers tab shows the count per offer and the full log; nothing else
-- reads it. Offers emailed before this table existed have no rows.
--
-- Idempotent: safe to run on every boot (bootstrap.ts).

CREATE TABLE IF NOT EXISTS rental_offer_sends (
  id serial PRIMARY KEY,
  offer_id integer NOT NULL REFERENCES rental_offers(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_by integer,
  to_email text NOT NULL,
  client_name text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rental_offer_sends_offer_idx ON rental_offer_sends (offer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rental_offer_sends_user_idx ON rental_offer_sends (user_id, created_at DESC);
