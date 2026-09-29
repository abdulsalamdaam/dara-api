-- The FULL legacy schema, schema only (no data), for the Finance v2 hook specs.
-- Generated from the Drizzle definitions in db/src/schema (the barrel, which
-- excludes financeV2.ts) with:
--   cd db && ../node_modules/.bin/drizzle-kit export --dialect postgresql --schema ./src/schema/index.ts
-- then with the "public". qualifier stripped so each spec builds it in its own
-- throwaway schema. Regenerate when a legacy schema file changes.
CREATE TYPE "property_status" AS ENUM('active', 'inactive', 'maintenance');
CREATE TYPE "unit_status" AS ENUM('available', 'rented', 'maintenance', 'reserved');
CREATE TYPE "contract_status" AS ENUM('active', 'expired', 'terminated', 'cancelled', 'pending');
CREATE TYPE "payment_frequency" AS ENUM('monthly', 'quarterly', 'semi_annual', 'annual', 'custom');
CREATE TYPE "payment_status" AS ENUM('paid', 'pending', 'overdue', 'cancelled', 'partially_paid', 'settled_external');
CREATE TYPE "payment_confirmation_status" AS ENUM('pending', 'approved', 'rejected');
CREATE TYPE "maintenance_priority" AS ENUM('low', 'medium', 'high');
CREATE TYPE "maintenance_status" AS ENUM('open', 'in_progress', 'pending_approval', 'completed');
CREATE TYPE "sender_role" AS ENUM('user', 'admin');
CREATE TYPE "ticket_status" AS ENUM('open', 'closed');
CREATE TYPE "owner_status" AS ENUM('active', 'inactive');
CREATE TYPE "owner_type" AS ENUM('individual', 'company');
CREATE TYPE "tenant_status" AS ENUM('active', 'inactive');
CREATE TYPE "tenant_type" AS ENUM('individual', 'company');
CREATE TYPE "contact_submission_status" AS ENUM('new', 'read', 'in_progress', 'resolved', 'spam');
CREATE TYPE "zatca_env" AS ENUM('sandbox', 'simulation', 'production');
CREATE TYPE "invoice_doc_type" AS ENUM('invoice', 'credit', 'debit');
CREATE TYPE "invoice_language" AS ENUM('ar', 'en');
CREATE TYPE "invoice_profile" AS ENUM('standard', 'simplified');
CREATE TYPE "invoice_status" AS ENUM('draft', 'submitted', 'cleared', 'reported', 'rejected', 'error');
CREATE TYPE "vat_category" AS ENUM('S', 'Z', 'E', 'O');
CREATE TYPE "simple_invoice_status" AS ENUM('draft', 'confirmed', 'cancelled');
CREATE TYPE "simple_invoice_type" AS ENUM('invoice', 'credit', 'debit');
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"phone" text,
	"login_count" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_verify_token_hash" text,
	"email_verify_expires_at" timestamp with time zone,
	"owner_user_id" integer,
	"company_id" integer,
	"role_id" integer,
	"package_plan" text DEFAULT 'broker' NOT NULL,
	"user_type" text DEFAULT 'individual' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"subscription_started_at" timestamp with time zone,
	"subscription_ends_at" timestamp with time zone,
	"subscription_status" text DEFAULT 'pending_payment' NOT NULL,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"subscription_is_trial" boolean DEFAULT false NOT NULL,
	"trial_consumed_at" timestamp with time zone,
	"desired_package_plan" text,
	"desired_billing_cycle" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"commercial_reg" text,
	"vat_number" text,
	"tax_number" text,
	"official_email" text,
	"company_phone" text,
	"website" text,
	"city" text,
	"region" text,
	"district" text,
	"street" text,
	"building_number" text,
	"postal_code" text,
	"additional_number" text,
	"address" text,
	"logo_key" text,
	"bio" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label_ar" text NOT NULL,
	"label_en" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"company_id" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_otp_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "phone_otp_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "login_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"ip" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "deeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"deed_number" text NOT NULL,
	"deed_type" text DEFAULT 'electronic' NOT NULL,
	"document_url" text,
	"document_name" text,
	"owner_id" integer,
	"owner_national_id" text,
	"deed_owners" jsonb,
	"issue_date" timestamp with time zone,
	"issue_date_hijri" text,
	"copy_date" timestamp with time zone,
	"registry_number" text,
	"issuing_authority" text,
	"notes" text,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"is_demo" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "properties" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" "property_status" DEFAULT 'active' NOT NULL,
	"district" text,
	"street" text,
	"deed_number" text,
	"deed_id" integer,
	"total_units" integer DEFAULT 0 NOT NULL,
	"floors" integer,
	"elevators" integer,
	"parkings" integer,
	"year_built" integer,
	"building_type" text,
	"postal_code" text,
	"building_number" text,
	"additional_number" text,
	"owner_id" integer,
	"amenities_data" text,
	"notes" text,
	"image_key" text,
	"images" jsonb,
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"map_url" text,
	"ejar_id" text,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"management_fee_percent" numeric(5, 2),
	"type_lookup_id" integer,
	"type_other" text,
	"usage_lookup_id" integer,
	"region_lookup_id" integer,
	"city_lookup_id" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "units" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"unit_number" text NOT NULL,
	"status" "unit_status" DEFAULT 'available' NOT NULL,
	"floor" integer,
	"area" numeric(10, 2),
	"bedrooms" integer,
	"bathrooms" integer,
	"living_rooms" integer,
	"halls" integer,
	"parking_spaces" integer,
	"rent_price" numeric(12, 2),
	"electricity_meter" text,
	"water_meter" text,
	"gas_meter" text,
	"ac_units" integer,
	"ac_type" text,
	"parking_type" text,
	"furnishing" text,
	"kitchen_type" text,
	"fiber" text,
	"amenities" text,
	"amenities_data" text,
	"year_built" text,
	"facade_length" numeric(10, 2),
	"unit_length" numeric(10, 2),
	"unit_width" numeric(10, 2),
	"unit_height" numeric(10, 2),
	"has_mezzanine" boolean,
	"image_key" text,
	"floor_plan_key" text,
	"documents" jsonb,
	"images" jsonb,
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"notes" text,
	"type_lookup_id" integer,
	"type_other" text,
	"direction_lookup_id" integer,
	"finishing_lookup_id" integer,
	"usage_lookup_id" integer,
	"ejar_id" text,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"contract_number" text NOT NULL,
	"tenant_id" integer,
	"tenant_type" text,
	"tenant_name" text NOT NULL,
	"tenant_id_number" text,
	"tenant_phone" text,
	"tenant_nationality" text,
	"tenant_email" text,
	"tenant_tax_number" text,
	"tenant_address" text,
	"tenant_postal_code" text,
	"tenant_additional_number" text,
	"tenant_building_number" text,
	"signing_date" date,
	"signing_place" text,
	"ejar_contract_number" text,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"monthly_rent" numeric(14, 6) NOT NULL,
	"payment_frequency" "payment_frequency" DEFAULT 'monthly' NOT NULL,
	"deposit_amount" numeric(12, 2),
	"deposit_status" text,
	"deposit_due_date" date,
	"deposit_method" text,
	"prepaid_method" text,
	"prepaid_rent" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_enabled" boolean DEFAULT false NOT NULL,
	"escalation_type" text DEFAULT 'percent' NOT NULL,
	"escalation_rate" numeric(12, 2) DEFAULT '0' NOT NULL,
	"rep_name" text,
	"rep_id_number" text,
	"company_unified" text,
	"company_org_type" text,
	"landlord_name" text,
	"landlord_rep_name" text,
	"landlord_rep_id_number" text,
	"landlord_nationality" text,
	"landlord_id_number" text,
	"landlord_phone" text,
	"landlord_email" text,
	"landlord_tax_number" text,
	"landlord_address" text,
	"landlord_postal_code" text,
	"landlord_additional_number" text,
	"landlord_building_number" text,
	"agency_fee" numeric(12, 2),
	"first_payment_amount" numeric(12, 2),
	"additional_fees" jsonb,
	"custom_schedule" jsonb,
	"status" "contract_status" DEFAULT 'active' NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"attachment_key" text,
	"settled_external_until" date,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "contract_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"contract_id" integer NOT NULL,
	"unit_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "contract_rent_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"contract_id" integer NOT NULL,
	"year" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"contract_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"due_date" date NOT NULL,
	"paid_date" date,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"receipt_number" text,
	"attachment_key" text,
	"description" text,
	"notes" text,
	"vat_enabled" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "payment_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" integer,
	"user_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"collected_date" date NOT NULL,
	"method" text,
	"receipt_number" text,
	"attachment_key" text,
	"invoice_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "payment_confirmations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"contract_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"method" text,
	"reference" text,
	"note" text,
	"proof_key" text,
	"proof_name" text,
	"status" "payment_confirmation_status" DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'custom' NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "owner_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'custom' NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "maintenance_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tenant_id" integer,
	"contract_id" integer,
	"unit_label" text NOT NULL,
	"description" text NOT NULL,
	"priority" "maintenance_priority" DEFAULT 'medium' NOT NULL,
	"status" "maintenance_status" DEFAULT 'open' NOT NULL,
	"supplier" text,
	"estimated_cost" numeric(12, 2),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "support_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"sender_role" "sender_role" NOT NULL,
	"message" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "owners" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"company_id" integer,
	"name" text NOT NULL,
	"short_name" text,
	"type" "owner_type" DEFAULT 'individual' NOT NULL,
	"id_number" text,
	"phone" text,
	"email" text,
	"iban" text,
	"management_fee_percent" numeric(5, 2),
	"tax_number" text,
	"is_representative" boolean DEFAULT false NOT NULL,
	"representative_doc_url" text,
	"original_owner_name" text,
	"original_owner_id_number" text,
	"original_owner_phone" text,
	"original_owner_email" text,
	"national_address_city" text,
	"national_address_district" text,
	"national_address_street" text,
	"address" text,
	"postal_code" text,
	"additional_number" text,
	"building_number" text,
	"status" "owner_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"is_demo" text DEFAULT 'false',
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_account_holder" boolean DEFAULT false NOT NULL,
	"nationality_lookup_id" integer,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"fcm_token" text,
	"fcm_platform" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"type" "tenant_type" DEFAULT 'individual' NOT NULL,
	"national_id" text,
	"phone" text,
	"email" text,
	"tax_number" text,
	"iban" text,
	"employer" text,
	"monthly_income" numeric(12, 2),
	"national_address_city" text,
	"national_address_district" text,
	"national_address_street" text,
	"address" text,
	"postal_code" text,
	"additional_number" text,
	"building_number" text,
	"nationality" text,
	"nationality_lookup_id" integer,
	"is_representative" boolean DEFAULT false NOT NULL,
	"representative_doc_url" text,
	"original_tenant_name" text,
	"original_tenant_id_number" text,
	"original_tenant_phone" text,
	"original_tenant_email" text,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"is_demo" text DEFAULT 'false',
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_account_holder" boolean DEFAULT false NOT NULL,
	"ejar_source" text,
	"ejar_raw" jsonb,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"fcm_token" text,
	"fcm_platform" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "facilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"property_name" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'خدمي' NOT NULL,
	"status" text DEFAULT 'يعمل' NOT NULL,
	"last_maintenance" text,
	"next_maintenance" text,
	"monthly_opex" numeric(12, 2) DEFAULT '0',
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"target_units" text,
	"channel" text DEFAULT '' NOT NULL,
	"budget" numeric(12, 2) DEFAULT '0',
	"leads" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'نشطة' NOT NULL,
	"start_date" text,
	"end_date" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "contact_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"description" text NOT NULL,
	"source" text DEFAULT 'landing-contact',
	"status" "contact_submission_status" DEFAULT 'new' NOT NULL,
	"response_notes" text,
	"resolved_by_id" integer,
	"resolved_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "zatca_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_id" integer,
	"active_environment" "zatca_env" DEFAULT 'sandbox' NOT NULL,
	"seller_name" text NOT NULL,
	"seller_name_ar" text,
	"seller_vat_number" text NOT NULL,
	"seller_crn" text,
	"seller_id_scheme" text DEFAULT 'CRN',
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
	"prod_slot_env" text,
	"link_invalid_at" timestamp with time zone,
	"link_invalid_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"uuid" text NOT NULL,
	"contract_id" integer,
	"payment_id" integer,
	"owner_id" integer,
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

CREATE TABLE "lookups" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"label_ar" text NOT NULL,
	"label_en" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"parent_key" text,
	"company_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"actor_user_id" integer NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "simple_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"number" text NOT NULL,
	"type" "simple_invoice_type" DEFAULT 'invoice' NOT NULL,
	"status" "simple_invoice_status" DEFAULT 'draft' NOT NULL,
	"kind" text,
	"contract_id" integer,
	"payment_id" integer,
	"payment_ids" jsonb,
	"tenant_id" integer,
	"tenant_name" text,
	"client" jsonb,
	"items" jsonb,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"confirmed_at" timestamp with time zone,
	"paid_date" date,
	"payment_method" text,
	"attachment_key" text,
	"pdf_key" text,
	"zatca_status" text,
	"zatca_error" text,
	"zatca_qr" text,
	"zatca_invoice_id" integer,
	"receipt_number" text,
	"billing_reference" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "subscription_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"plan" text NOT NULL,
	"billing_cycle" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"moyasar_invoice_id" text,
	"moyasar_payment_id" text,
	"payment_url" text,
	"paid_at" timestamp with time zone,
	"invoice_number" text,
	"invoice_issued_at" timestamp with time zone,
	"invoice_emailed_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"property_id" integer,
	"owner_id" integer,
	"category" text,
	"amount" numeric(12, 2) NOT NULL,
	"expense_date" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "landlord_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"transfer_date" text,
	"method" text,
	"reference" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "ejar_api_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"env" text DEFAULT 'uat' NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"params" jsonb,
	"request_headers" jsonb,
	"status" integer,
	"ejar_status" integer,
	"transaction_id" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"response_body" jsonb,
	"body_truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "app_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"event" text,
	"request_id" text,
	"method" text,
	"path" text,
	"status" integer,
	"duration_ms" integer,
	"user_id" integer,
	"owner_user_id" integer,
	"ip" text,
	"user_agent" text,
	"message" text,
	"context" text,
	"error" text,
	"stack" text,
	"meta" jsonb
);

CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"external_id" text NOT NULL,
	"url" text,
	"author_handle" text,
	"author_name" text,
	"author_avatar_url" text,
	"text" text NOT NULL,
	"lang" text,
	"posted_at" timestamp with time zone,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb,
	"ai_relevant" boolean,
	"ai_score" integer,
	"ai_category" text,
	"ai_title_ar" text,
	"ai_title_en" text,
	"ai_summary_ar" text,
	"ai_summary_en" text,
	"ai_tags" text[],
	"ai_reason" text,
	"ai_attempts" integer DEFAULT 0 NOT NULL,
	"filter_kind" text,
	"status" text DEFAULT 'hidden' NOT NULL,
	"moderated_by" integer,
	"moderated_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"judged_at" timestamp with time zone,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "news_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"accounts_total" integer DEFAULT 0 NOT NULL,
	"accounts_ok" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"published" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE "news_job_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"run_time" text DEFAULT '07:00' NOT NULL,
	"days_of_week" integer[] DEFAULT '{0,1,2,3,4,5,6}' NOT NULL,
	"lookback_hours" integer DEFAULT 36 NOT NULL,
	"max_per_account" integer DEFAULT 20 NOT NULL,
	"min_score" integer DEFAULT 60 NOT NULL,
	"extra_instructions" text,
	"next_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"rejected_retention_hours" integer DEFAULT 24 NOT NULL,
	"purge_duplicates" boolean DEFAULT true NOT NULL,
	"hidden_retention_days" integer DEFAULT 14 NOT NULL,
	"runs_retention_days" integer DEFAULT 90 NOT NULL,
	"seen_retention_days" integer DEFAULT 30 NOT NULL,
	"last_cleanup_at" timestamp with time zone,
	"last_cleanup_stats" jsonb
);

CREATE TABLE "news_seen" (
	"external_id" text PRIMARY KEY NOT NULL,
	"source_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict" text,
	"purged_at" timestamp with time zone
);

CREATE TABLE "news_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'x' NOT NULL,
	"handle" text,
	"feed_url" text,
	"site_url" text,
	"http_etag" text,
	"http_last_modified" text,
	"display_name" text,
	"avatar_url" text,
	"x_user_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"last_fetched_at" timestamp with time zone,
	"last_seen_tweet_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "deeds" ADD CONSTRAINT "deeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "deeds" ADD CONSTRAINT "deeds_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_deed_id_deeds_id_fk" FOREIGN KEY ("deed_id") REFERENCES "deeds"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_type_lookup_id_lookups_id_fk" FOREIGN KEY ("type_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_usage_lookup_id_lookups_id_fk" FOREIGN KEY ("usage_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_region_lookup_id_lookups_id_fk" FOREIGN KEY ("region_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "properties" ADD CONSTRAINT "properties_city_lookup_id_lookups_id_fk" FOREIGN KEY ("city_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "units" ADD CONSTRAINT "units_type_lookup_id_lookups_id_fk" FOREIGN KEY ("type_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "units" ADD CONSTRAINT "units_direction_lookup_id_lookups_id_fk" FOREIGN KEY ("direction_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "units" ADD CONSTRAINT "units_finishing_lookup_id_lookups_id_fk" FOREIGN KEY ("finishing_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "units" ADD CONSTRAINT "units_usage_lookup_id_lookups_id_fk" FOREIGN KEY ("usage_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "contract_units" ADD CONSTRAINT "contract_units_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "contract_units" ADD CONSTRAINT "contract_units_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "contract_rent_terms" ADD CONSTRAINT "contract_rent_terms_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payments" ADD CONSTRAINT "payments_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_collections" ADD CONSTRAINT "payment_collections_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_collections" ADD CONSTRAINT "payment_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "owner_notifications" ADD CONSTRAINT "owner_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "owner_notifications" ADD CONSTRAINT "owner_notifications_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "owners" ADD CONSTRAINT "owners_nationality_lookup_id_lookups_id_fk" FOREIGN KEY ("nationality_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_nationality_lookup_id_lookups_id_fk" FOREIGN KEY ("nationality_lookup_id") REFERENCES "lookups"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "zatca_credentials" ADD CONSTRAINT "zatca_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "zatca_credentials" ADD CONSTRAINT "zatca_credentials_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "news_sources"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_run_id_news_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "news_job_runs"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "companies_vat_idx" ON "companies" USING btree ("vat_number");
CREATE UNIQUE INDEX "roles_key_company_uniq" ON "roles" USING btree ("key","company_id");
CREATE INDEX "email_otp_tokens_email_idx" ON "email_otp_tokens" USING btree ("email","expires_at");
CREATE INDEX "phone_otp_tokens_phone_idx" ON "phone_otp_tokens" USING btree ("phone","expires_at");
CREATE UNIQUE INDEX "deeds_user_deednumber_uniq" ON "deeds" USING btree ("user_id","deed_number");
CREATE UNIQUE INDEX "properties_deed_id_uniq" ON "properties" USING btree ("deed_id");
CREATE UNIQUE INDEX "contract_units_contract_unit_uniq" ON "contract_units" USING btree ("contract_id","unit_id");
CREATE INDEX "contract_units_contract_idx" ON "contract_units" USING btree ("contract_id");
CREATE INDEX "contract_units_unit_idx" ON "contract_units" USING btree ("unit_id");
CREATE INDEX "contract_rent_terms_contract_idx" ON "contract_rent_terms" USING btree ("contract_id");
CREATE INDEX "payment_collections_payment_idx" ON "payment_collections" USING btree ("payment_id");
CREATE UNIQUE INDEX "zatca_credentials_user_owner_uniq" ON "zatca_credentials" USING btree ("user_id","owner_id");
CREATE UNIQUE INDEX "invoices_user_invoice_number_uniq" ON "invoices" USING btree ("user_id","invoice_number") WHERE deleted_at is null;
CREATE UNIQUE INDEX "invoices_user_owner_env_icv_uniq" ON "invoices" USING btree ("user_id",coalesce("owner_id", 0),"environment","icv") WHERE deleted_at is null and status in ('cleared', 'reported', 'submitted');
CREATE INDEX "invoices_user_idx" ON "invoices" USING btree ("user_id","created_at");
CREATE INDEX "invoices_contract_idx" ON "invoices" USING btree ("contract_id");
CREATE INDEX "invoices_payment_idx" ON "invoices" USING btree ("payment_id");
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id","line_number");
CREATE UNIQUE INDEX "lookups_category_key_company_uniq" ON "lookups" USING btree ("category","key","company_id");
CREATE INDEX "audit_logs_owner_idx" ON "audit_logs" USING btree ("owner_user_id");
CREATE UNIQUE INDEX "app_settings_key_uniq" ON "app_settings" USING btree ("key");
CREATE UNIQUE INDEX "news_items_external_id_uniq" ON "news_items" USING btree ("external_id");
CREATE INDEX "news_items_feed_idx" ON "news_items" USING btree ("status","pinned","posted_at");
CREATE INDEX "news_items_category_idx" ON "news_items" USING btree ("ai_category");
CREATE INDEX "news_items_source_idx" ON "news_items" USING btree ("source_id");
CREATE INDEX "news_items_created_idx" ON "news_items" USING btree ("created_at","id");
CREATE INDEX "news_items_retention_age_idx" ON "news_items" USING btree ((coalesce("judged_at", "created_at")),"id") WHERE "news_items"."status" in ('rejected', 'hidden') and "news_items"."moderated_at" is null and "news_items"."pinned" = false;
CREATE INDEX "news_job_runs_started_idx" ON "news_job_runs" USING btree ("started_at");
CREATE INDEX "news_job_runs_status_idx" ON "news_job_runs" USING btree ("status");
CREATE UNIQUE INDEX "news_sources_handle_uniq" ON "news_sources" USING btree ("handle");
CREATE UNIQUE INDEX "news_sources_feed_url_uniq" ON "news_sources" USING btree ("feed_url") WHERE "news_sources"."kind" = 'rss';
