--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET search_path TO public;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: contact_submission_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contact_submission_status AS ENUM (
    'new',
    'read',
    'in_progress',
    'resolved',
    'spam'
);


--
-- Name: contract_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contract_status AS ENUM (
    'active',
    'expired',
    'terminated',
    'pending'
);


--
-- Name: maintenance_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_priority AS ENUM (
    'low',
    'medium',
    'high'
);


--
-- Name: maintenance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_status AS ENUM (
    'open',
    'in_progress',
    'pending_approval',
    'completed'
);


--
-- Name: owner_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.owner_status AS ENUM (
    'active',
    'inactive'
);


--
-- Name: owner_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.owner_type AS ENUM (
    'individual',
    'company'
);


--
-- Name: payment_frequency; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_frequency AS ENUM (
    'monthly',
    'quarterly',
    'semi_annual',
    'annual'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'paid',
    'pending',
    'overdue',
    'cancelled'
);


--
-- Name: property_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.property_status AS ENUM (
    'active',
    'inactive',
    'maintenance'
);


--
-- Name: property_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.property_type AS ENUM (
    'residential',
    'commercial',
    'mixed',
    'land',
    'villa',
    'apartment_building',
    'tower',
    'plaza',
    'mall',
    'chalet',
    'other'
);


--
-- Name: sender_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sender_role AS ENUM (
    'user',
    'admin'
);


--
-- Name: tenant_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tenant_status AS ENUM (
    'active',
    'inactive'
);


--
-- Name: tenant_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tenant_type AS ENUM (
    'individual',
    'company'
);


--
-- Name: ticket_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_status AS ENUM (
    'open',
    'closed'
);


--
-- Name: unit_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.unit_status AS ENUM (
    'available',
    'rented',
    'maintenance',
    'reserved'
);


--
-- Name: unit_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.unit_type AS ENUM (
    'apartment',
    'villa',
    'office',
    'shop',
    'warehouse',
    'studio'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'super_admin',
    'admin',
    'user',
    'demo'
);


SET default_table_access_method = heap;

--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    target_units text,
    channel text DEFAULT ''::text NOT NULL,
    budget numeric(12,2) DEFAULT '0'::numeric,
    leads integer DEFAULT 0 NOT NULL,
    conversions integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'نشطة'::text NOT NULL,
    start_date text,
    end_date text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.campaigns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.campaigns_id_seq OWNED BY public.campaigns.id;


--
-- Name: contact_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_submissions (
    id integer NOT NULL,
    name text,
    email text,
    phone text,
    description text NOT NULL,
    source text DEFAULT 'landing-contact'::text,
    status public.contact_submission_status DEFAULT 'new'::public.contact_submission_status NOT NULL,
    response_notes text,
    resolved_by_id integer,
    resolved_at timestamp with time zone,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: contact_submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_submissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_submissions_id_seq OWNED BY public.contact_submissions.id;


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    unit_id integer NOT NULL,
    contract_number text NOT NULL,
    tenant_type text,
    tenant_name text NOT NULL,
    tenant_id_number text,
    tenant_phone text,
    tenant_nationality text,
    tenant_email text,
    tenant_tax_number text,
    tenant_address text,
    tenant_postal_code text,
    tenant_additional_number text,
    tenant_building_number text,
    signing_date date,
    signing_place text,
    start_date date NOT NULL,
    end_date date NOT NULL,
    monthly_rent numeric(12,2) NOT NULL,
    payment_frequency public.payment_frequency DEFAULT 'monthly'::public.payment_frequency NOT NULL,
    deposit_amount numeric(12,2),
    rep_name text,
    rep_id_number text,
    company_unified text,
    company_org_type text,
    landlord_name text,
    landlord_nationality text,
    landlord_id_number text,
    landlord_phone text,
    landlord_email text,
    landlord_tax_number text,
    landlord_address text,
    landlord_postal_code text,
    landlord_additional_number text,
    landlord_building_number text,
    agency_fee numeric(12,2),
    first_payment_amount numeric(12,2),
    additional_fees jsonb,
    status public.contract_status DEFAULT 'active'::public.contract_status NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: contracts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contracts_id_seq OWNED BY public.contracts.id;


--
-- Name: facilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facilities (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    property_name text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'خدمي'::text NOT NULL,
    status text DEFAULT 'يعمل'::text NOT NULL,
    last_maintenance text,
    next_maintenance text,
    monthly_opex numeric(12,2) DEFAULT '0'::numeric,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: facilities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.facilities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facilities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.facilities_id_seq OWNED BY public.facilities.id;


--
-- Name: login_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_logs (
    id integer NOT NULL,
    user_id integer,
    email text NOT NULL,
    status text NOT NULL,
    ip text,
    device text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: login_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.login_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: login_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.login_logs_id_seq OWNED BY public.login_logs.id;


--
-- Name: maintenance_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_requests (
    id integer NOT NULL,
    user_id integer NOT NULL,
    unit_label text NOT NULL,
    description text NOT NULL,
    priority public.maintenance_priority DEFAULT 'medium'::public.maintenance_priority NOT NULL,
    status public.maintenance_status DEFAULT 'open'::public.maintenance_status NOT NULL,
    supplier text,
    estimated_cost numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id integer,
    contract_id integer,
    deleted_at timestamp with time zone
);


--
-- Name: maintenance_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maintenance_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maintenance_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maintenance_requests_id_seq OWNED BY public.maintenance_requests.id;


--
-- Name: owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owners (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    type public.owner_type DEFAULT 'individual'::public.owner_type NOT NULL,
    id_number text,
    phone text,
    email text,
    iban text,
    management_fee_percent numeric(5,2),
    tax_number text,
    address text,
    postal_code text,
    additional_number text,
    building_number text,
    status public.owner_status DEFAULT 'active'::public.owner_status NOT NULL,
    notes text,
    is_demo text DEFAULT 'false'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: owners_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.owners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: owners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.owners_id_seq OWNED BY public.owners.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id integer NOT NULL,
    user_id integer NOT NULL,
    contract_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    due_date date NOT NULL,
    paid_date date,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    receipt_number text,
    description text,
    notes text,
    is_demo boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.properties (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    type public.property_type DEFAULT 'residential'::public.property_type NOT NULL,
    status public.property_status DEFAULT 'active'::public.property_status NOT NULL,
    city text NOT NULL,
    district text,
    street text,
    deed_number text,
    total_units integer DEFAULT 0 NOT NULL,
    floors integer,
    elevators integer,
    parkings integer,
    year_built integer,
    building_type text,
    usage_type text,
    region text,
    postal_code text,
    building_number text,
    additional_number text,
    owner_id integer,
    amenities_data text,
    notes text,
    is_demo boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: properties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.properties_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: properties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.properties_id_seq OWNED BY public.properties.id;


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id integer NOT NULL,
    ticket_id integer NOT NULL,
    sender_id integer NOT NULL,
    sender_role public.sender_role NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: support_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_messages_id_seq OWNED BY public.support_messages.id;


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    status public.ticket_status DEFAULT 'open'::public.ticket_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: support_tickets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_tickets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_tickets_id_seq OWNED BY public.support_tickets.id;


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    type public.tenant_type DEFAULT 'individual'::public.tenant_type NOT NULL,
    national_id text,
    phone text,
    email text,
    tax_number text,
    address text,
    postal_code text,
    additional_number text,
    building_number text,
    nationality text,
    status public.tenant_status DEFAULT 'active'::public.tenant_status NOT NULL,
    notes text,
    is_demo text DEFAULT 'false'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    last_login_at timestamp with time zone,
    fcm_token text,
    fcm_platform text,
    deleted_at timestamp with time zone
);


--
-- Name: tenants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenants_id_seq OWNED BY public.tenants.id;


--
-- Name: units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.units (
    id integer NOT NULL,
    property_id integer NOT NULL,
    unit_number text NOT NULL,
    type public.unit_type DEFAULT 'apartment'::public.unit_type NOT NULL,
    status public.unit_status DEFAULT 'available'::public.unit_status NOT NULL,
    floor integer,
    area numeric(10,2),
    bedrooms integer,
    bathrooms integer,
    living_rooms integer,
    halls integer,
    parking_spaces integer,
    rent_price numeric(12,2),
    electricity_meter text,
    water_meter text,
    gas_meter text,
    ac_units integer,
    ac_type text,
    parking_type text,
    furnishing text,
    kitchen_type text,
    fiber text,
    amenities text,
    unit_direction text,
    year_built text,
    finishing text,
    facade_length numeric(10,2),
    unit_length numeric(10,2),
    unit_width numeric(10,2),
    unit_height numeric(10,2),
    has_mezzanine boolean,
    is_demo boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.units_id_seq OWNED BY public.units.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    role public.user_role DEFAULT 'user'::public.user_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    account_status text DEFAULT 'active'::text NOT NULL,
    phone text,
    company text,
    login_count integer DEFAULT 0 NOT NULL,
    last_login_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    permissions jsonb,
    role_label text,
    deleted_at timestamp with time zone,
    owner_user_id integer,
    commercial_reg text,
    vat_number text,
    official_email text,
    company_phone text,
    website text,
    city text,
    address text,
    logo_url text
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: campaigns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns ALTER COLUMN id SET DEFAULT nextval('public.campaigns_id_seq'::regclass);


--
-- Name: contact_submissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_submissions ALTER COLUMN id SET DEFAULT nextval('public.contact_submissions_id_seq'::regclass);


--
-- Name: contracts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts ALTER COLUMN id SET DEFAULT nextval('public.contracts_id_seq'::regclass);


--
-- Name: facilities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities ALTER COLUMN id SET DEFAULT nextval('public.facilities_id_seq'::regclass);


--
-- Name: login_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_logs ALTER COLUMN id SET DEFAULT nextval('public.login_logs_id_seq'::regclass);


--
-- Name: maintenance_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests ALTER COLUMN id SET DEFAULT nextval('public.maintenance_requests_id_seq'::regclass);


--
-- Name: owners id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners ALTER COLUMN id SET DEFAULT nextval('public.owners_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: properties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties ALTER COLUMN id SET DEFAULT nextval('public.properties_id_seq'::regclass);


--
-- Name: support_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages ALTER COLUMN id SET DEFAULT nextval('public.support_messages_id_seq'::regclass);


--
-- Name: support_tickets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets ALTER COLUMN id SET DEFAULT nextval('public.support_tickets_id_seq'::regclass);


--
-- Name: tenants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants ALTER COLUMN id SET DEFAULT nextval('public.tenants_id_seq'::regclass);


--
-- Name: units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units ALTER COLUMN id SET DEFAULT nextval('public.units_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: contact_submissions contact_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_submissions
    ADD CONSTRAINT contact_submissions_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_contract_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_contract_number_unique UNIQUE (contract_number);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: facilities facilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_pkey PRIMARY KEY (id);


--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: maintenance_requests maintenance_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_requests
    ADD CONSTRAINT maintenance_requests_pkey PRIMARY KEY (id);


--
-- Name: owners owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners
    ADD CONSTRAINT owners_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: units units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users_owner_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_owner_user_id_idx ON public.users USING btree (owner_user_id) WHERE (owner_user_id IS NOT NULL);


--
-- Name: contracts contracts_unit_id_units_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE CASCADE;


--
-- Name: contracts contracts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: login_logs login_logs_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_logs
    ADD CONSTRAINT login_logs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_contract_id_contracts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_contract_id_contracts_id_fk FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: payments payments_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: properties properties_owner_id_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_owner_id_owners_id_fk FOREIGN KEY (owner_id) REFERENCES public.owners(id) ON DELETE SET NULL;


--
-- Name: properties properties_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: units units_property_id_properties_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_property_id_properties_id_fk FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: users users_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- ─── ZATCA / e-invoice schema ────────────────────────────
CREATE TYPE "public"."zatca_env" AS ENUM('sandbox', 'simulation', 'production');--> statement-breakpoint
CREATE TYPE "public"."invoice_profile" AS ENUM('standard', 'simplified');--> statement-breakpoint
CREATE TYPE "public"."invoice_doc_type" AS ENUM('invoice', 'credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."invoice_language" AS ENUM('ar', 'en');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'submitted', 'cleared', 'reported', 'rejected', 'error');--> statement-breakpoint
CREATE TYPE "public"."vat_category" AS ENUM('S', 'Z', 'E', 'O');--> statement-breakpoint

CREATE TABLE "zatca_credentials" (
    "id" serial PRIMARY KEY NOT NULL,
    "user_id" integer NOT NULL,
    "active_environment" "zatca_env" DEFAULT 'sandbox' NOT NULL,
    "seller_name" text NOT NULL,
    "seller_name_ar" text,
    "seller_vat_number" text NOT NULL,
    "seller_crn" text,
    "seller_street" text NOT NULL,
    "seller_building_no" text NOT NULL,
    "seller_district" text NOT NULL,
    "seller_city" text NOT NULL,
    "seller_postal_zone" text NOT NULL,
    "seller_additional_no" text,
    "serial_number" text NOT NULL,
    "organization_identifier" text NOT NULL,
    "organization_unit_name" text NOT NULL,
    "invoice_type" text DEFAULT '1100' NOT NULL,
    "location_address" text NOT NULL,
    "industry_category" text NOT NULL,
    "country_name" text DEFAULT 'SA' NOT NULL,
    "common_name" text NOT NULL,
    "sandbox_private_key_enc" text,
    "sandbox_public_key_pem" text,
    "sandbox_csr_pem" text,
    "sandbox_binary_security_token" text,
    "sandbox_secret_enc" text,
    "sandbox_cert_pem" text,
    "sandbox_compliance_request_id" text,
    "sandbox_icv" integer DEFAULT 0 NOT NULL,
    "sandbox_pih" text DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==' NOT NULL,
    "sandbox_onboarded_at" timestamp with time zone,
    "prod_private_key_enc" text,
    "prod_public_key_pem" text,
    "prod_csr_pem" text,
    "prod_binary_security_token" text,
    "prod_secret_enc" text,
    "prod_cert_pem" text,
    "prod_compliance_request_id" text,
    "prod_icv" integer DEFAULT 0 NOT NULL,
    "prod_pih" text DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==' NOT NULL,
    "prod_onboarded_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "invoices" (
    "id" serial PRIMARY KEY NOT NULL,
    "user_id" integer NOT NULL,
    "invoice_number" text NOT NULL,
    "uuid" text NOT NULL,
    "contract_id" integer,
    "payment_id" integer,
    "profile" "invoice_profile" NOT NULL,
    "doc_type" "invoice_doc_type" DEFAULT 'invoice' NOT NULL,
    "language" "invoice_language" DEFAULT 'ar' NOT NULL,
    "currency" text DEFAULT 'SAR' NOT NULL,
    "issue_date" date NOT NULL,
    "issue_time" text NOT NULL,
    "icv" integer NOT NULL,
    "pih" text NOT NULL,
    "environment" "zatca_env" NOT NULL,
    "billing_reference_id" text,
    "instruction_note" text,
    "payment_means_code" text DEFAULT '10' NOT NULL,
    "seller_snapshot" jsonb NOT NULL,
    "buyer_snapshot" jsonb,
    "totals" jsonb NOT NULL,
    "unsigned_xml" text NOT NULL,
    "signed_xml" text,
    "invoice_hash" text,
    "qr_base64" text,
    "signature_value" text,
    "status" "invoice_status" DEFAULT 'draft' NOT NULL,
    "submitted_to" text,
    "http_status" integer,
    "zatca_response" jsonb,
    "submitted_at" timestamp with time zone,
    "cleared_xml" text,
    "notes" text,
    "is_demo" boolean DEFAULT false NOT NULL,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "invoice_lines" (
    "id" serial PRIMARY KEY NOT NULL,
    "invoice_id" integer NOT NULL,
    "line_number" integer NOT NULL,
    "external_id" text,
    "name" text NOT NULL,
    "name_ar" text,
    "unit_code" text DEFAULT 'PCE' NOT NULL,
    "quantity" numeric(14, 6) NOT NULL,
    "unit_price" numeric(14, 2) NOT NULL,
    "vat_category" "vat_category" DEFAULT 'S' NOT NULL,
    "vat_percent" numeric(5, 2) NOT NULL,
    "line_net" numeric(14, 2) NOT NULL,
    "line_vat" numeric(14, 2) NOT NULL,
    "line_total_inc_vat" numeric(14, 2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "zatca_credentials" ADD CONSTRAINT "zatca_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "zatca_credentials_user_id_uniq" ON "zatca_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_user_invoice_number_uniq" ON "invoices" USING btree ("user_id","invoice_number") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_user_env_icv_uniq" ON "invoices" USING btree ("user_id","environment","icv");--> statement-breakpoint
CREATE INDEX "invoices_user_idx" ON "invoices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "invoices_contract_idx" ON "invoices" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "invoices_payment_idx" ON "invoices" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id","line_number");
