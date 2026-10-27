import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException,
  ConflictException, ServiceUnavailableException, UnprocessableEntityException,
} from "@nestjs/common";
import type { EjarPartyRole } from "../../common/plan-features";
import type { EjarPartyCheck } from "./ejar.party-check";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { EjarAccessError, EjarApiError, EjarClientService, EjarConfigError } from "./ejar.client.service";
import { ejarDenialFor } from "./ejar.access";
import { combineLimit } from "../../common/limit-core";
import { signalLimitRefused } from "../limits/limits-signals";
import {
  canLookup, computeBudget, hasHeadroom, lookupConfig, planQuotaWindow, toCustomerBudget, windowBounds,
  type CustomerEjarBudget, type EjarBudget, type LookupConfig, type PlanQuota,
} from "./ejar.budget";
import {
  allPartyIdentifiers, computePrefill, computeRequired, lookupUuid, mapLookup, normalizeContractNumber, partyContact, partyMatches,
  partyIdentifiers, pickContractsResource, principalIndexFor, principalsOf, withMain,
  type LookupPrefill, type MainChoice, type MainSide, type MappedLookup, type PartyContact, type RequiredContext, type RequiredEntry,
} from "./ejar.lookup.map";
import type { EjarLookupStore, ImportedContract, LinkedParty, LookupMatches, PartyKey, PartyMatch, SavedLookup, UnitMatch } from "./ejar.lookup.store";
import { rentBasis, rentFigures, type RentFigures } from "./ejar.rent";
import { vatFromContractType } from "./ejar-rent-vat";
import type { EjarBody, EjarEndpointKey } from "./ejar.types";
import type { LookupParty } from "./ejar.lookup.map";
import { EJAR_PROPERTY_TYPE, EJAR_UNIT_TYPE, EJAR_USAGE, mapEjarValue } from "./ejar.import";
import { ejarNumberTakenMessage } from "../../common/ejar-contract-number";

export const EJAR_LOOKUP_STORE = Symbol("EJAR_LOOKUP_STORE");

export const SCOPE_MISMATCH_MESSAGE =
  "هذا العقد غير مرتبط بالسجل التجاري لحسابك · This contract is not linked to your account's commercial registration.";
export const EJAR_BUDGET_EXHAUSTED_MESSAGE =
  "تم استهلاك رصيد عمليات إيجار المتاح لحسابك — تواصل مع دعم دارا · Your account's Ejar lookups are used up — contact Dara support.";
export const BAD_FORMAT_MESSAGE = "رقم عقد إيجار غير صالح — أرقام فقط · Invalid Ejar contract number (digits only).";
/** The account's own record has no identifier to pin the inquiry to. */
export const PARTY_ID_MISSING_MESSAGE: Record<EjarPartyRole, string> = {
  landlord:
    "أكمل بيانات المؤجر في حسابك أولاً (السجل التجاري أو رقم الهوية) — يُستخدم للتحقق من أن عقد إيجار يخصك · Complete your landlord record (CR or national ID) first — it is how we check the Ejar contract is yours.",
  tenant:
    "أكمل بيانات حسابك أولاً (السجل التجاري أو رقم الهوية) — يُستخدم للتحقق من أنك المستأجر في عقد إيجار · Add your CR or national ID to your account first — it is how we check you are the tenant on the Ejar contract.",
};
/** Ejar's answer does not name the account's own record on that side of the contract. */
export const PARTY_MISMATCH_MESSAGE: Record<EjarPartyRole, string> = {
  landlord:
    "هذا العقد لا يخص المؤجر المسجّل في حسابك — السجل التجاري / الهوية لا يطابق المؤجر في عقد إيجار · This Ejar contract's landlord is not your account's landlord.",
  tenant:
    "هذا العقد لا يخصك — رقم السجل التجاري / الهوية في حسابك لا يطابق المستأجر في عقد إيجار · You are not the tenant on this Ejar contract.",
};

/**
 * 409 `contract_exists`: the account already holds a contract with this Ejar
 * number (imported, or typed on a manual contract). Sent before any Ejar call.
 */
export function contractExists(contractNumber: string, existing: ImportedContract) {
  return new ConflictException({
    code: "contract_exists",
    contractId: existing.deleted ? null : existing.contractId,
    contractNumber: existing.contractNumber ?? null,
    ejarNumber: contractNumber,
    message: ejarNumberTakenMessage(contractNumber, existing.contractNumber ?? null),
  });
}

/** 409 `party_id_missing` when the account is pinned (عقاري / tenant) but its record carries no ID. */
export function assertPartyIdOnFile(check: EjarPartyCheck): void {
  if (check.role && !check.idNumber) {
    throw new ConflictException({ code: "party_id_missing", role: check.role, message: PARTY_ID_MISSING_MESSAGE[check.role] });
  }
}

/** True when the inquiry is unpinned, or the pinned identity is on the right side of the contract. */
export function partyCheckPasses(check: EjarPartyCheck, m: Pick<MappedLookup, "parties" | "contract">): boolean {
  return !check.role || partyMatches(m, check.role, check.idNumber);
}

export function partyMismatch(check: EjarPartyCheck, extra: Record<string, unknown> = {}) {
  return new UnprocessableEntityException({
    code: "party_mismatch", role: check.role, message: PARTY_MISMATCH_MESSAGE[check.role!], ...extra,
  });
}

export interface LookupResponse extends Omit<MappedLookup, "contractsResource"> {
  source: "ejar" | "cache";
  lookedUpAt: string;
  /** Available / not only — the counts are never sent to a customer. */
  budget: CustomerEjarBudget;
  alreadyImported: { contractId: number } | null;
  matches: {
    /** Always null: parties are not linked to existing records (kept for the web's shape). */
    landlord: null;
    tenant: null;
    /** The account's property with this Ejar property UUID. */
    property: PartyMatch | null;
    /** The first matched unit (by Ejar unit UUID), and all of them. */
    unit: UnitMatch | null;
    units: UnitMatch[];
  };
  required: RequiredEntry[];
  /**
   * The existing landlord / tenant the import will link instead of creating
   * a record (same ID / CR, or the account's own landlord at the plan's cap).
   * Its stored contact is what the contract keeps — the review shows it read-only.
   */
  linkedParties: { landlord: LinkedParty | null; tenant: LinkedParty | null };
  /**
   * The rent as Dara will store it (ejar.rent.ts), under the contract type's
   * VAT verdict — the import applies the final one (usage) the same way.
   */
  rent: RentFigures;
  /** Every value the import takes from Ejar, as the review's inputs hold them (ids, the city label). */
  prefill: LookupPrefill;
  /** Whose stored identity the inquiry was pinned to, and that it matched (null role: unpinned). */
  partyCheck: { role: EjarPartyRole | null; idNumber: string | null; matched: boolean | null };
  /**
   * Ejar's PRINCIPAL lessors / tenants and which one is the main one. The
   * top-level `parties`, `required`, `prefill` and `linkedParties` describe
   * `defaultIndex`; each option carries what changes when the user picks it.
   * `lockedIndex` (عقاري: the landlord side; tenant plan: the tenant side) is
   * the account's own record — the main one, not to be changed.
   */
  principals: Record<MainSide, PrincipalSide>;
  logs: unknown[];
}

export interface PrincipalOption {
  index: number;
  party: LookupParty;
  /** That section's required[] entries when this one is the main one. */
  required: RequiredEntry[];
  prefill: PartyContact;
  linked: LinkedParty | null;
}
export interface PrincipalSide {
  defaultIndex: number;
  /** Set: the main one is fixed (a pinned account's own record). */
  lockedIndex: number | null;
  options: PrincipalOption[];
}

/**
 * The principal a pinned account must import as the main one: عقاري → the
 * lessor carrying the account landlord's ID; the tenant plan → the tenant
 * carrying the account's CR / ID. Offices / Companies: none (a free choice).
 */
export function lockedMain(
  parties: MappedLookup["parties"], check: { role: EjarPartyRole | null; idNumber: string | null },
): Record<MainSide, number | null> {
  return {
    landlord: check.role === "landlord" ? principalIndexFor(parties, "landlord", check.idNumber) : null,
    tenant: check.role === "tenant" ? principalIndexFor(parties, "tenant", check.idNumber) : null,
  };
}

/** The saved lookup, mapped. */
export function mapSaved(saved: SavedLookup): MappedLookup {
  return mapLookup(
    saved.invoicesBody as EjarBody | null, saved.detailsBody as EjarBody | null,
    (saved.contractsBody ?? null) as EjarBody | null, saved.contractNumber,
  );
}

/**
 * What the account already holds for this contract (matches by CR / ID
 * number / Ejar UUID) and which of Ejar's values resolve to lookup options —
 * the context `required[]` is decided in, for the lookup and the import alike.
 */
export async function lookupContext(
  store: EjarLookupStore, accountId: number, mapped: MappedLookup,
): Promise<{ matches: LookupMatches; resolved: NonNullable<RequiredContext["resolved"]> }> {
  const res = async (category: string, ...values: Array<string | null | undefined>) => {
    for (const v of values) if (v) { const id = await store.resolveLookup(category, v); if (id != null) return id; }
    return null;
  };
  const p = mapped.property;
  const [matches, propertyTypeId, usageId, cityId, unitTypeIds, unitUsageIds] = await Promise.all([
    // No landlord/tenant matching is offered: parties always come from Ejar
    // as new records (the writer dedupes by ID/CR on its own). Only the
    // property and units are matched, by Ejar UUID.
    store.findMatches(accountId, {
      landlord: [],
      tenant: [],
      propertyEjarId: p?.ejarId ?? null,
      unitEjarIds: mapped.units.map((u) => u.ejarId).filter((v): v is string => !!v),
    }),
    res("property_type", mapEjarValue(EJAR_PROPERTY_TYPE, p?.type)),
    // Usage from the contract type (residential / commercial), Ejar's own word.
    res("property_usage", mapEjarValue(EJAR_USAGE, mapped.contract.contractType)),
    // City from the region, when one of our city options carries that key/name.
    res("city", p?.region?.key, p?.region?.nameAr),
    Promise.all(mapped.units.map((u) => res("unit_type", mapEjarValue(EJAR_UNIT_TYPE, u.unitType)))),
    Promise.all(mapped.units.map((u) => res("property_usage", mapEjarValue(EJAR_USAGE, u.usage)))),
  ]);
  return { matches, resolved: { propertyTypeId, usageId, cityId, unitTypeIds, unitUsageIds } };
}

/** The ids of the call-log rows a lookup wrote. */
export function logIds(logs: unknown[]): number[] {
  return logs.map((l) => Number((l as { id?: unknown } | null)?.id)).filter((n) => Number.isInteger(n) && n > 0);
}

/** Call-log rows without their response bodies — what a refusal may echo back. */
export function withoutBodies(logs: unknown[]): unknown[] {
  return logs.map((l) => {
    if (!l || typeof l !== "object") return l;
    const { responseBody: _body, ...rest } = l as Record<string, unknown>;
    return rest;
  });
}

/** Ejar client errors → HTTP, surfacing the real upstream status. */
export function toEjarHttp(err: unknown, opts: { withBody?: boolean } = {}): unknown {
  const withBody = opts.withBody !== false;
  if (err instanceof HttpException) return err;
  if (err instanceof EjarConfigError) return new ServiceUnavailableException(err.message);
  const log = err instanceof EjarApiError && err.log ? (withBody ? err.log : withoutBodies([err.log])[0]) : null;
  if (err instanceof EjarAccessError) return new ForbiddenException({ code: "access_denied", message: err.message, log });
  if (err instanceof EjarApiError) {
    // Whatever the gateway answered is OUR upstream failing, never the
    // caller's: a passed-through 401 reads as "your session expired" to the
    // web client, and a 429 as an exhausted lookup budget. The upstream
    // status travels in the body instead.
    const upstream = err.status;
    const code = 502;
    return new HttpException(
      { message: err.message, status: upstream, transactionId: err.transactionId, log },
      code,
    );
  }
  return err instanceof Error ? new BadRequestException(err.message) : new BadRequestException("Ejar call failed");
}

type Outcome =
  | { kind: "ok"; saved: SavedLookup; logs: unknown[] }
  | { kind: "exhausted"; budget: EjarBudget }
  | { kind: "not_found"; logs: unknown[] }
  | { kind: "details_unavailable"; logs: unknown[] }
  | { kind: "wrong_number_cap" }
  | { kind: "scope_mismatch"; logs: unknown[] }
  | { kind: "party_mismatch"; logs: unknown[] }
  | { kind: "error"; err: unknown; logs: unknown[] };

/** The upstream answered "no such contract" (staging: 400 "رقم العقد غير صحيح"). */
function isUnknownContract(err: unknown): boolean {
  if (!(err instanceof EjarApiError) || err instanceof EjarAccessError) return false;
  const sent = (err.log as { status?: number | null } | undefined)?.status;
  return (err.status === 400 || err.status === 404) && (sent === 400 || sent === 404);
}

/**
 * Ejar Import v2 — the two-call lookup.
 *
 *   validate number → access gate → saved lookup (cache) → [advisory lock:
 *   budget check → Invoices → Details → save] → map + match + required[]
 *
 * Nothing reaches Ejar except through `lookup()`, and `lookup()` only sends
 * while holding the budget lock with headroom on both endpoints.
 */
@Injectable()
export class EjarLookupService {
  constructor(
    private readonly client: EjarClientService,
    @Inject(EJAR_LOOKUP_STORE) private readonly store: EjarLookupStore,
  ) {}

  /** Read per call so a changed env (and the tests) take effect immediately. */
  protected config(): LookupConfig {
    return lookupConfig(process.env);
  }

  /**
   * The budget, plus `enabled`: false when the account's Ejar switch (or the
   * server's EJAR_ACCESS) shuts it out, so the import screen can say so
   * before the user types a number. `userId` is the caller (EJAR_ACCESS
   * allowlists users); omitted, only the account switch and the kill switch count.
   */
  async budget(accountId: number, cfg = this.config(), userId?: number | null): Promise<EjarBudget & { enabled: boolean }> {
    const { start } = windowBounds(cfg.window);
    const [usage, plan, mode] = await Promise.all([
      this.store.usage(start, accountId), this.planQuota(accountId), this.store.ejarAccountMode(accountId),
    ]);
    return { ...computeBudget(cfg, usage, new Date(), plan), enabled: ejarDenialFor(mode, userId) == null };
  }

  /** The stored identity this account's inquiries are pinned to (ejar.party-check.ts). */
  partyCheck(accountId: number): Promise<EjarPartyCheck> {
    return this.store.partyCheck(accountId);
  }

  /** The budget as a customer may see it (`GET /ejar/budget`, lookup responses and refusals): attempts available only, no allowance or usage. */
  async customerBudget(accountId: number, cfg = this.config(), userId?: number | null): Promise<CustomerEjarBudget> {
    const b = await this.budget(accountId, cfg, userId);
    return toCustomerBudget(b, b.enabled);
  }

  /**
   * The account's Ejar quota for this paid period and what it has used of it;
   * null = uncapped. The quota is the EFFECTIVE one (common/limits.ts): the
   * plan's, replaced by an admin override, plus active Ejar packs.
   */
  private async planQuota(accountId: number): Promise<PlanQuota | null> {
    const [period, adj] = await Promise.all([this.store.planPeriod(accountId), this.store.ejarQuotaAdjustment(accountId)]);
    const base = planQuotaWindow(period)?.limit ?? null;
    const win = planQuotaWindow(period, new Date(), combineLimit(base, adj.override, adj.addons));
    if (!win) return null;
    const { account } = await this.store.usage(win.since, accountId);
    return { ...win, used: account };
  }

  async lookup(user: AuthUser, body: { contract_number?: unknown; refresh?: unknown }): Promise<LookupResponse> {
    const contractNumber = normalizeContractNumber(body?.contract_number);
    if (!contractNumber) throw new BadRequestException({ code: "bad_format", message: BAD_FORMAT_MESSAGE });

    const accountId = scopeId(user);
    // EJAR_ACCESS plus the account's own switch (ejar.access.ts): a disabled
    // account is refused with `ejar_disabled_for_account`.
    const accountMode = await this.store.ejarAccountMode(accountId);
    const denial = ejarDenialFor(accountMode, user.id);
    if (denial) throw new ForbiddenException({ code: denial.code, message: denial.message });

    // Already in the account — imported before, or a manual contract whose
    // optional Ejar number is this one: refused here, before the cache, the
    // budget lock and any Ejar call, so it costs nothing against the quota.
    const existing = await this.store.findImported(accountId, contractNumber);
    if (existing) throw contractExists(contractNumber, existing);

    // عقاري / tenant plan: pinned to the account's own stored landlord /
    // tenant ID (never a typed value). No ID on file → refused before any call.
    const check = await this.store.partyCheck(accountId);
    assertPartyIdOnFile(check);
    const crInfo = { role: check.role, idNumber: check.idNumber, matched: check.role ? true : null };

    const scope = await this.store.scope(accountId);
    const cfg = this.config();
    const refresh = body?.refresh === true || body?.refresh === "true";

    if (!refresh) {
      const saved = await this.store.getLookup(accountId, contractNumber);
      if (saved && Date.now() - new Date(saved.createdAt).getTime() < cfg.cacheHours * 3_600_000) {
        if (!partyCheckPasses(check, mapSaved(saved))) throw partyMismatch(check);
        if (scope.locked && !allPartyIdentifiers(mapSaved(saved).parties).includes(scope.idNumber!)) {
          throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
        }
        return this.respond(accountId, saved, "cache", [], cfg, crInfo);
      }
    }

    const { start } = windowBounds(cfg.window);
    const outcome = await this.store.withBudgetLock<Outcome>(async () => {
      const [usage, plan] = await Promise.all([this.store.usage(start, accountId), this.planQuota(accountId)]);
      if (!canLookup(cfg, usage, plan)) return { kind: "exhausted", budget: computeBudget(cfg, usage, new Date(), plan) };
      if (cfg.wrongNumbersPerDay != null) {
        const { start: today } = windowBounds("day");
        if ((await this.store.wrongNumbers(today!, accountId)) >= cfg.wrongNumbersPerDay) return { kind: "wrong_number_cap" };
      }

      const logs: unknown[] = [];
      const call = async (endpoint: EjarEndpointKey, params: Record<string, string>) => {
        try {
          const r = await this.client.request(endpoint, params, { userId: user.id, accountId, accountMode });
          logs.push(r.log);
          return { body: r.body as EjarBody | null };
        } catch (err) {
          if (err instanceof EjarApiError && err.log) logs.push(err.log);
          return { err };
        }
      };

      const inv = await call("rentalContractInvoices", { contractNumber });
      if ("err" in inv) return isUnknownContract(inv.err) ? { kind: "not_found", logs } : { kind: "error", err: inv.err, logs };
      const uuid = lookupUuid(inv.body, contractNumber);
      // A 200 with no contract in it is Ejar not knowing the number too.
      if (!uuid) return { kind: "not_found", logs };

      let contractsBody: EjarBody | null = null;
      let detailsBody: EjarBody | null = null;
      let needDetails = cfg.secondCall === "details";
      if (cfg.secondCall === "contracts") {
        // Get Contracts by the Invoices UUID. id_number=1 is a placeholder
        // the gateway requires; skip_filter_id_number lets contract_ids alone
        // decide (the client refuses this call without a UUID).
        const gc = await call("getRentalContracts", {
          id_number: "1", contract_ids: uuid, skip_filter_id_number: "true", "page[number]": "1", "page[size]": "10",
        });
        if ("err" in gc) return { kind: "error", err: gc.err, logs };
        contractsBody = gc.body;
        if (!pickContractsResource(contractsBody, contractNumber, uuid)) {
          // Not in the list (a renewed contract's entry carries the older
          // version's id). Fall back to Details — a third call, so it needs
          // its own headroom; without it, stop rather than overspend.
          const [now, nowPlan] = await Promise.all([this.store.usage(start, accountId), this.planQuota(accountId)]);
          if (!hasHeadroom(cfg, now, "details", nowPlan)) return { kind: "details_unavailable", logs };
          needDetails = true;
        }
      }
      if (needDetails) {
        const det = await call("contractDetails", { uuid });
        if ("err" in det) return { kind: "error", err: det.err, logs };
        detailsBody = det.body;
      }

      // A locked (tenant-package) account may only see a contract it is a
      // party to. Checked before anything is saved or returned.
      const fresh = mapLookup(inv.body, detailsBody, contractsBody, contractNumber);
      // The account's own landlord / tenant ID must be on that side of the
      // contract. The calls are spent (and counted) either way; a mismatch
      // saves nothing. (First, so a tenant account gets the tenant-side
      // answer; the broader scope rule below still stands behind it.)
      if (!partyCheckPasses(check, fresh)) return { kind: "party_mismatch", logs };
      if (scope.locked && !allPartyIdentifiers(fresh.parties).includes(scope.idNumber!)) {
        return { kind: "scope_mismatch", logs };
      }

      const saved = await this.store.saveLookup({
        accountId, contractNumber, ejarUuid: uuid,
        invoicesBody: (inv.body ?? null) as Record<string, unknown> | null,
        detailsBody: detailsBody as Record<string, unknown> | null,
        contractsBody: contractsBody as Record<string, unknown> | null,
        lookedUpBy: user.id,
      });
      return { kind: "ok", saved, logs };
    });

    // A pinned (عقاري / tenant plan) or locked account received a contract it
    // was not verified for — refused, or never checked because a call failed.
    // Its raw Ejar answers (names, IDs, representatives' phones and emails)
    // must not stay readable through the account's call log (GET
    // /ejar/logs/:id), and the refusal carries none of them.
    const unverified = outcome.kind === "party_mismatch" || outcome.kind === "scope_mismatch"
      || ((check.role != null || scope.locked) && outcome.kind !== "ok" && "logs" in outcome);
    if (unverified && "logs" in outcome) {
      await this.store.withholdLogBodies(logIds(outcome.logs), outcome.kind);
    }
    const publicLogs = (logs: unknown[]) => (unverified ? [] : withoutBodies(logs));

    switch (outcome.kind) {
      case "exhausted":
        // The account's own quota ran out (not the shared gateway budget): a
        // `limit_reached` audit event for the admin (once per period).
        if (outcome.budget.plan && outcome.budget.plan.remaining <= 0) signalLimitRefused(accountId, "ejar_lookups");
        throw new HttpException(
          {
            code: "budget_exhausted",
            message: EJAR_BUDGET_EXHAUSTED_MESSAGE,
            // Only what is left (0 here): a customer is never told the allowance or its use.
            budget: toCustomerBudget(outcome.budget),
            // Ejar packs are granted by the admin only — the web says "contact us".
            addonAvailable: false,
            contactAdmin: true,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "not_found":
        throw new NotFoundException({
          code: "not_found",
          message: "لم يُعثر على العقد في إيجار — تحقق من الرقم · Ejar has no contract with this number.",
          logs: publicLogs(outcome.logs),
          budget: await this.customerBudget(accountId, cfg, user.id),
        });
      case "wrong_number_cap":
        throw new HttpException(
          {
            code: "too_many_wrong_numbers",
            message:
              "تجاوزت عدد محاولات الأرقام غير الصحيحة اليوم — حاول غداً · Too many wrong contract numbers today; try again tomorrow.",
            limit: cfg.wrongNumbersPerDay,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "details_unavailable":
        throw new HttpException(
          {
            code: "details_unavailable",
            message:
              "لم يُرجع إيجار تفاصيل العقد ولا يسمح الرصيد بطلبها · Ejar returned no contract details, and the Details budget has no room to fetch them.",
            logs: publicLogs(outcome.logs),
            budget: await this.customerBudget(accountId, cfg, user.id),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "scope_mismatch":
        throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
      case "party_mismatch":
        // The code and the message only — never the contract that did not match.
        throw partyMismatch(check, { budget: await this.customerBudget(accountId, cfg, user.id) });
      case "error":
        throw toEjarHttp(outcome.err, { withBody: !unverified });
      case "ok":
        return this.respond(accountId, outcome.saved, "ejar", outcome.logs, cfg, crInfo);
    }
  }

  private async respond(
    accountId: number, saved: SavedLookup, source: "ejar" | "cache", logs: unknown[], cfg: LookupConfig,
    partyCheck: LookupResponse["partyCheck"],
  ): Promise<LookupResponse> {
    const full = mapSaved(saved);
    // The main lessor / tenant: a pinned account's own record, else Ejar's first.
    const lock = lockedMain(full.parties, partyCheck);
    const main: MainChoice = { landlord: lock.landlord ?? 0, tenant: lock.tenant ?? 0 };
    const chosen = withMain(full, main);
    const { contractsResource: _internal, ...mapped } = chosen;
    const [ctx, alreadyImported, budget] = await Promise.all([
      lookupContext(this.store, accountId, chosen),
      this.store.findImported(accountId, saved.contractNumber),
      this.customerBudget(accountId, cfg),
    ]);
    const { matches, resolved } = ctx;
    const reqCtx: RequiredContext = { resolved, matches: { ...matches, unitEjarIds: matchedUnitEjarIds(mapped, matches.units) } };
    const side = async (s: MainSide): Promise<PrincipalSide> => ({
      defaultIndex: main[s],
      lockedIndex: lock[s],
      options: await Promise.all(principalsOf(full.parties, s).map(async (party, index) => {
        const m = withMain(full, { ...main, [s]: index });
        return {
          index, party,
          required: computeRequired(m, reqCtx).filter((r) => r.section === s),
          prefill: partyContact(m.parties, s),
          linked: await this.store.existingParty(accountId, s, partyKey(party)),
        };
      })),
    });
    const [cityLabel, linkedLandlord, linkedTenant, pLandlord, pTenant] = await Promise.all([
      resolved.cityId != null ? this.store.lookupRow(resolved.cityId).then((r) => r?.labelAr ?? null) : Promise.resolve(null),
      this.store.existingParty(accountId, "landlord", partyKey(mapped.parties.lessor)),
      this.store.existingParty(accountId, "tenant", partyKey(mapped.parties.tenant)),
      side("landlord"),
      side("tenant"),
    ]);
    return {
      source,
      lookedUpAt: new Date(saved.createdAt).toISOString(),
      budget,
      alreadyImported,
      ...mapped,
      matches: { ...matches, landlord: null, tenant: null, unit: matches.units[0] ?? null },
      required: computeRequired(chosen, reqCtx),
      prefill: computePrefill(mapped, resolved, cityLabel),
      linkedParties: { landlord: linkedLandlord, tenant: linkedTenant },
      rent: rentFigures(rentBasis(mapped), vatFromContractType(mapped.contract.contractType)),
      partyCheck,
      principals: { landlord: pLandlord, tenant: pTenant },
      logs,
    };
  }
}

/** How the import's writer will look this party up: its ID (an organization: its CR), else its name. */
export function partyKey(p: LookupParty | null): PartyKey {
  if (!p) return { idNumber: null, name: null, ids: [] };
  const isOrg = p.kind === "organization";
  const idNumber = (isOrg ? p.crNumber : p.idNumber) ?? null;
  const ids = [...new Set([idNumber, p.idNumber, p.crNumber, p.unifiedNumber, p.vatNumber].filter((v): v is string => !!v && !!v.trim()))];
  return { idNumber, name: p.name ?? null, ids };
}

/** The contract's Ejar unit UUIDs that the account already holds. */
export function matchedUnitEjarIds(mapped: Pick<MappedLookup, "units">, units: UnitMatch[]): string[] {
  const held = new Set(units.map((u) => u.ejarId).filter((v): v is string => !!v));
  return mapped.units.map((u) => u.ejarId).filter((v): v is string => !!v && held.has(v));
}
