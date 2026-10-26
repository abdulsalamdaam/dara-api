/**
 * Wire shapes of the account-limits API (the contract the web builds on —
 * prod-promotion/features/account-limits-plan.md "Interfaces").
 */
import type { EffectiveLimit, LimitKey } from "../../common/limits";
import type { CatalogItem } from "../../common/addon-catalog";
import type { EjarAccountMode } from "../ejar/ejar.access";

export type { EffectiveLimit, LimitKey, CatalogItem, EjarAccountMode };

export interface AddonView {
  id: number;
  limitKey: LimitKey;
  quantity: number;
  status: string;
  activation: string;
  source: string;
  period: string;
  startsAt: string | null;
  endsAt: string | null;
  /** Before VAT. */
  priceSar: number | null;
  /** The payment's amount when there is one, else priceSar with VAT. */
  amountInclVat: number | null;
  paymentId: number | null;
  /** The Moyasar hosted-invoice URL while the payment is pending. */
  payUrl: string | null;
  offerExpiresAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface LimitEvent {
  id: number;
  actorKind: string;
  actorName: string | null;
  source: string;
  limitKey: string;
  oldValue: number | null;
  newValue: number | null;
  note: string | null;
  createdAt: string;
}

export interface OverrideView {
  limitKey: string;
  /** null = unlimited (for `ejar.enabled`: 1 enabled / 0 disabled). */
  value: number | null;
  note: string;
  setBy: number | null;
  updatedAt: string;
}

export interface AdminLimitsView {
  limits: EffectiveLimit[];
  overrides: OverrideView[];
  addons: AddonView[];
  ejar: { mode: EjarAccountMode; envMode: string; effective: boolean };
  /** Latest 50. */
  events: LimitEvent[];
}

/** Who made a change. */
export interface LimitsActor {
  userId: number | null;
  kind: "admin" | "customer" | "system";
}

export type AddonMode = "free" | "invoice" | "offer";

/** `POST /admin/customers/:userId/addons` body, validated. */
export interface CreateAddonInput {
  limitKey: LimitKey;
  quantity: number;
  mode: AddonMode;
  catalogKey: string | null;
  priceSar: number | null;
  period: "subscription_period" | "one_off";
  endsAt: Date | null;
  activation: "on_payment" | "immediate";
  note: string | null;
  notify: boolean;
}
