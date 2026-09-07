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
