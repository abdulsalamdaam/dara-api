-- The minimum of the LEGACY schema the Finance v2 DB specs touch (users,
-- roles, owners, properties, units, contracts, contract_units, audit_logs),
-- with only the columns Finance v2 reads. Synthetic test scaffolding, NOT the
-- real schema: 0066 references no legacy table, so the ledger itself needs
-- none of this. A committed schema-only dump of the full legacy schema (DESIGN
-- §2.2 point 5) is for the backfill/hook specs that read the legacy tables.
create table if not exists roles (id serial primary key, key text not null);
create table if not exists users (
  id serial primary key, email text not null, name text not null default '',
  owner_user_id integer, role_id integer, user_type text not null default 'individual',
  deleted_at timestamptz
);
create table if not exists owners (
  id serial primary key, user_id integer not null, name text not null,
  id_number text, tax_number text, is_account_holder boolean not null default false,
  deleted_at timestamptz
);
create table if not exists properties (id serial primary key, user_id integer not null, owner_id integer, deleted_at timestamptz);
create table if not exists units (id serial primary key, property_id integer not null, deleted_at timestamptz);
create table if not exists contracts (id serial primary key, user_id integer not null, status text not null default 'active', deleted_at timestamptz);
create table if not exists contract_units (id serial primary key, contract_id integer not null, unit_id integer not null);
create table if not exists audit_logs (
  id serial primary key, owner_user_id integer not null, actor_user_id integer not null,
  action text not null, entity text not null, entity_id text, method text not null, path text not null,
  created_at timestamptz not null default now()
);
