import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Users are pure identity rows — no role/permissions/company data lives
 * here. Authorization is resolved by joining `roles` (via `role_id`) and
 * billing/branding data by joining `companies` (via `company_id`).
 *
 * Migration history:
 *   - Originally carried `role` enum + `permissions` jsonb + `role_label`
 *     and a bag of company fields (`company`, `commercial_reg`, `vat_number`,
 *     `official_email`, `company_phone`, `website`, `city`, `address`,
 *     `logo_url`). All dropped in migration 2026_05_drop_legacy_user_columns.sql
 *     once the data was backfilled into `companies` + `roles`.
 */
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  accountStatus: text("account_status").notNull().default("active"),
  phone: text("phone"),
  loginCount: integer("login_count").notNull().default(0),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  tokenVersion: integer("token_version").notNull().default(0),
  /**
   * Email verification. The user/employee clicks a link sent to their inbox
   * to set this true. Employees can't log in until verified; for new account
   * registrations the admin sees the verification status before approving.
   * The token is stored as a sha256 hash (searchable) with an expiry.
   */
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  emailVerifyTokenHash: text("email_verify_token_hash"),
  emailVerifyExpiresAt: timestamp("email_verify_expires_at", { withTimezone: true }),
  /**
   * If set, this user is an employee belonging to another user (the owner).
   * The employee inherits the owner's data scope (sees the owner's properties,
   * tenants, contracts, etc.). Null for top-level users (landlords/admins).
   * Self-referencing FK using AsType to avoid TS circular issue.
   */
  ownerUserId: integer("owner_user_id"),
  /** FK → companies.id. Source of legal/billing/branding fields. */
  companyId: integer("company_id"),
  /** FK → roles.id. Source of role key + permissions + label. */
  roleId: integer("role_id"),
  /**
   * Subscription package — "individual_owner" | "broker". Drives the
   * landlord/property/unit quota limits (see src/common/packages.ts).
   * Only meaningful on a top-level account; employees inherit the owner's.
   */
  packagePlan: text("package_plan").notNull().default("broker"),
  /** Account holder type — "individual" | "company" (set at registration). */
  userType: text("user_type").notNull().default("individual"),
  /** Set when the first-login setup wizard is completed (null = not yet). */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  // When the first-run "getting started" checklist (deed → property → units →
  // landlord → tenant → contract) was completed. Drives hiding that card.
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  /** Subscription window — set when a subscription payment is collected. */
  subscriptionStartedAt: timestamp("subscription_started_at", { withTimezone: true }),
  subscriptionEndsAt: timestamp("subscription_ends_at", { withTimezone: true }),
  /**
   * Subscription lifecycle:
   *   pending_payment → approved but not paid yet (must pay to activate)
   *   active          → paid, within the subscription window
   *   grace           → past due, within the 15-day grace period
   *   locked          → grace expired; account restricted to settings/usage/pay
   * `active` here is the *stored* status; the API also derives grace/locked
   * from the dates so it stays correct without a cron job.
   */
  subscriptionStatus: text("subscription_status").notNull().default("pending_payment"),
  /** Billing cycle the user is subscribed on — "monthly" | "yearly". */
  billingCycle: text("billing_cycle").notNull().default("monthly"),
  /**
   * The current window is a free trial granted by an admin, not a paid one.
   * Purely descriptive — trials use the same `active` status and the same
   * window columns, so nothing has to special-case them — but without it a
   * 30-day trial and a paid year look identical everywhere they are shown.
   * Cleared when a real payment activates the account.
   */
  subscriptionIsTrial: boolean("subscription_is_trial").notNull().default(false),
  /**
   * When this account used up its one free trial — the only durable record
   * that it ever had one.
   *
   * `subscription_is_trial` describes the CURRENT window and is cleared the
   * moment a payment lands, so after any payment, package change or refund
   * nothing on the row remembers a trial was granted. Without this column an
   * account could be handed a fresh free window on every approval or plan
   * change, forever. It is history, not state: never cleared, and deliberately
   * untouched by the payment path.
   */
  trialConsumedAt: timestamp("trial_consumed_at", { withTimezone: true }),
  /** The plan the user picked on the landing page, shown to the admin before approval. */
  desiredPackagePlan: text("desired_package_plan"),
  /** The billing cycle the user picked on the landing page. */
  desiredBillingCycle: text("desired_billing_cycle"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
