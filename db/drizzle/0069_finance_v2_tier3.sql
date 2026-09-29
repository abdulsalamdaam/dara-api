-- Finance v2 (beta), tier 3: suppliers and bills (accounts payable).
-- Design: docs/finance-v2/DESIGN.md §8.4. The journal CSV export needs no table.
--
-- Same rules as 0066/0067 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: new tables and indexes; it alters nothing, not even the
--    0066/0067 tables (CI rejects ALTER TABLE on a table this file did not create).
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot, after 0066, 0067 and 0068.
--  * No FK to any legacy table (foreign keys only between the tables below).
--    One simple-query message = one transaction.
--  * No immutability triggers: these are working documents; the ledger entry
--    is the immutable record. The account purge deletes them from code
--    (hooks.service purgeAccount); the purge switch stays confined to 0066.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (as in 0066/0067).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'suppliers', '["id","user_id","name_ar","name_en","vat_number","cr_number","iban","phone","email","address","payment_terms_days","default_gl_account_id","is_active","notes","created_by","created_at","updated_at"]'::jsonb,
    'supplier_bills', '["id","user_id","number","supplier_id","supplier_invoice_no","bill_date","due_date","status","owner_id","property_id","charge_to","attachment_key","notes","subtotal","vat_total","total","created_by","approved_by","approved_at","voided_by","voided_at","voided_on","void_reason","created_at","updated_at"]'::jsonb,
    'supplier_bill_lines', '["id","bill_id","user_id","line_no","description","gl_account_id","net_amount","vat_category","vat_rate","vat_amount","vat_recoverable"]'::jsonb,
    'supplier_payments', '["id","user_id","number","supplier_id","paid_on","amount","bank_account_id","method","reference","status","created_by","created_at","voided_by","voided_at","voided_on","void_reason"]'::jsonb,
    'supplier_payment_allocations', '["id","payment_id","bill_id","user_id","amount"]'::jsonb
  );
  t text;
  missing text[];
begin
  for t in select jsonb_object_keys(expected) loop
    if exists (select 1 from information_schema.tables
                where table_schema = current_schema() and table_name = t) then
      select array_agg(c) into missing
        from jsonb_array_elements_text(expected -> t) as c
       where c not in (select column_name from information_schema.columns
                        where table_schema = current_schema() and table_name = t);
      if missing is not null then
        raise exception 'fv2: table %.% already exists and is not the Finance v2 table (missing columns: %)',
          current_schema(), t, array_to_string(missing, ', ');
      end if;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Supplier master
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists suppliers (
  id serial primary key,
  user_id integer not null,
  name_ar text not null,
  name_en text,
  vat_number text,                                   -- 15 digits, 3…3 (validated in code)
  cr_number text,
  iban text,
  phone text,
  email text,
  address text,
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  default_gl_account_id integer,                     -- accounts.id (expense or non-system asset leaf)
  is_active boolean not null default true,
  notes text,
  created_by integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists suppliers_user_idx on suppliers (user_id, is_active, id);
create unique index if not exists suppliers_vat_uq on suppliers (user_id, vat_number) where vat_number is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Bills (a supplier's invoice to us) and their lines
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists supplier_bills (
  id serial primary key,
  user_id integer not null,
  number text not null,                              -- BILL-######, per account
  supplier_id integer not null,
  supplier_invoice_no text,
  bill_date date not null,
  due_date date not null,
  status text not null default 'draft' check (status in ('draft','approved','void')),
  owner_id integer,                                  -- landlord dimension (no FK: legacy table)
  property_id integer,
  charge_to text not null default 'company' check (charge_to in ('company','landlord')),
  attachment_key text,
  notes text,
  subtotal numeric(14,2) not null default 0,
  vat_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  created_by integer,
  approved_by integer,
  approved_at timestamptz,
  voided_by integer,
  voided_at timestamptz,
  voided_on date,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date >= bill_date),
  check (total = subtotal + vat_total),
  unique (user_id, number),
  unique (id, user_id),
  foreign key (supplier_id, user_id) references suppliers (id, user_id)
);
create index if not exists supplier_bills_user_idx on supplier_bills (user_id, status, due_date);
create index if not exists supplier_bills_supplier_idx on supplier_bills (user_id, supplier_id, bill_date);
-- The same supplier invoice cannot be entered twice (unless the first was voided).
create unique index if not exists supplier_bills_supplier_invoice_uq
  on supplier_bills (user_id, supplier_id, lower(supplier_invoice_no))
  where supplier_invoice_no is not null and status <> 'void';

create table if not exists supplier_bill_lines (
  id serial primary key,
  bill_id integer not null,
  user_id integer not null,
  line_no smallint not null,
  description text not null,
  gl_account_id integer,                             -- null: the supplier default, then 5190/5290
  net_amount numeric(14,2) not null check (net_amount > 0),
  vat_category char(1) not null default 'S' check (vat_category in ('S','Z','E','O')),
  vat_rate numeric(5,2) not null default 0,
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  vat_recoverable boolean not null default false,
  check (vat_category = 'S' or vat_amount = 0),
  unique (bill_id, line_no),
  foreign key (bill_id, user_id) references supplier_bills (id, user_id) on delete cascade
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Supplier payments (payment vouchers PV-######) and their allocation to bills
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists supplier_payments (
  id serial primary key,
  user_id integer not null,
  number text not null,                              -- PV-######, the account's payment-voucher series
  supplier_id integer not null,
  paid_on date not null,
  amount numeric(14,2) not null check (amount > 0),
  bank_account_id integer,
  method text,
  reference text,
  status text not null default 'posted' check (status in ('posted','void')),
  created_by integer,
  created_at timestamptz not null default now(),
  voided_by integer,
  voided_at timestamptz,
  voided_on date,
  void_reason text,
  unique (user_id, number),
  unique (id, user_id),
  foreign key (supplier_id, user_id) references suppliers (id, user_id)
);
create index if not exists supplier_payments_user_idx on supplier_payments (user_id, supplier_id, paid_on);

create table if not exists supplier_payment_allocations (
  id serial primary key,
  payment_id integer not null,
  bill_id integer not null,
  user_id integer not null,
  amount numeric(14,2) not null check (amount > 0),
  unique (payment_id, bill_id),
  foreign key (payment_id, user_id) references supplier_payments (id, user_id) on delete cascade,
  foreign key (bill_id, user_id) references supplier_bills (id, user_id)
);
create index if not exists supplier_payment_allocations_bill_idx on supplier_payment_allocations (user_id, bill_id);
