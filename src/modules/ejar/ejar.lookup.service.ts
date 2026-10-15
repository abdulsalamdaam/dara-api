import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { EjarAccessError, EjarApiError, EjarClientService, EjarConfigError, ejarAccessDenial } from "./ejar.client.service";
import {
  canLookup, computeBudget, hasHeadroom, lookupConfig, planQuotaWindow, windowBounds,
  type EjarBudget, type LookupConfig, type PlanQuota,
} from "./ejar.budget";
import {
  allPartyIdentifiers, computeRequired, lookupUuid, mapLookup, normalizeContractNumber, partyIdentifiers, pickContractsResource,
  type MappedLookup, type RequiredContext, type RequiredEntry,
} from "./ejar.lookup.map";
import type { EjarLookupStore, LookupMatches, PartyMatch, SavedLookup, UnitMatch } from "./ejar.lookup.store";
import type { EjarBody, EjarEndpointKey } from "./ejar.types";
import { EJAR_PROPERTY_TYPE, EJAR_UNIT_TYPE, EJAR_USAGE, mapEjarValue } from "./ejar.import";

export const EJAR_LOOKUP_STORE = Symbol("EJAR_LOOKUP_STORE");

export const SCOPE_MISMATCH_MESSAGE =
  "هذا العقد غير مرتبط بالسجل التجاري لحسابك · This contract is not linked to your account's commercial registration.";
export const BAD_FORMAT_MESSAGE = "رقم عقد إيجار غير صالح — أرقام فقط · Invalid Ejar contract number (digits only).";

export interface LookupResponse extends Omit<MappedLookup, "contractsResource"> {
  source: "ejar" | "cache";
  lookedUpAt: string;
  budget: EjarBudget;
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
  logs: unknown[];
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
  const [matches, propertyTypeId, usageId, cityId, unitTypeIds] = await Promise.all([
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
  ]);
  return { matches, resolved: { propertyTypeId, usageId, cityId, unitTypeIds } };
}

/** Ejar client errors → HTTP, surfacing the real upstream status. */
export function toEjarHttp(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  if (err instanceof EjarConfigError) return new ServiceUnavailableException(err.message);
  if (err instanceof EjarAccessError) return new ForbiddenException({ code: "access_denied", message: err.message, log: err.log ?? null });
  if (err instanceof EjarApiError) {
    // Whatever the gateway answered is OUR upstream failing, never the
    // caller's: a passed-through 401 reads as "your session expired" to the
    // web client, and a 429 as an exhausted lookup budget. The upstream
    // status travels in the body instead.
    const upstream = err.status;
    const code = 502;
    return new HttpException(
      { message: err.message, status: upstream, transactionId: err.transactionId, log: err.log ?? null },
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

  async budget(accountId: number, cfg = this.config()): Promise<EjarBudget> {
    const { start } = windowBounds(cfg.window);
    const [usage, plan] = await Promise.all([this.store.usage(start, accountId), this.planQuota(accountId)]);
    return computeBudget(cfg, usage, new Date(), plan);
  }

  /** The account's plan quota and what it has used of it this period; null = uncapped. */
  private async planQuota(accountId: number): Promise<PlanQuota | null> {
    const win = planQuotaWindow(await this.store.planPeriod(accountId));
    if (!win) return null;
    const { account } = await this.store.usage(win.since, accountId);
    return { ...win, used: account };
  }

  async lookup(user: AuthUser, body: { contract_number?: unknown; refresh?: unknown }): Promise<LookupResponse> {
    const contractNumber = normalizeContractNumber(body?.contract_number);
    if (!contractNumber) throw new BadRequestException({ code: "bad_format", message: BAD_FORMAT_MESSAGE });

    const denial = ejarAccessDenial(user.id);
    if (denial) throw new ForbiddenException({ code: "access_denied", message: denial });

    const accountId = scopeId(user);
    const scope = await this.store.scope(accountId);
    const cfg = this.config();
    const refresh = body?.refresh === true || body?.refresh === "true";

    if (!refresh) {
      const saved = await this.store.getLookup(accountId, contractNumber);
      if (saved && Date.now() - new Date(saved.createdAt).getTime() < cfg.cacheHours * 3_600_000) {
        if (scope.locked && !allPartyIdentifiers(mapSaved(saved).parties).includes(scope.idNumber!)) {
          throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
        }
        return this.respond(accountId, saved, "cache", [], cfg);
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
          const r = await this.client.request(endpoint, params, { userId: user.id });
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
      if (scope.locked && !allPartyIdentifiers(mapLookup(inv.body, detailsBody, contractsBody, contractNumber).parties).includes(scope.idNumber!)) {
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

    switch (outcome.kind) {
      case "exhausted":
        throw new HttpException(
          {
            code: "budget_exhausted",
            message: "تم استهلاك رصيد الاستعلام من إيجار لهذه الفترة · The Ejar lookup budget for this period is used up.",
            budget: outcome.budget,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "not_found":
        throw new NotFoundException({
          code: "not_found",
          message: "لم يُعثر على العقد في إيجار — تحقق من الرقم · Ejar has no contract with this number.",
          logs: outcome.logs,
          budget: await this.budget(accountId, cfg),
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
            logs: outcome.logs,
            budget: await this.budget(accountId, cfg),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "scope_mismatch":
        throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
      case "error":
        throw toEjarHttp(outcome.err);
      case "ok":
        return this.respond(accountId, outcome.saved, "ejar", outcome.logs, cfg);
    }
  }

  private async respond(
    accountId: number, saved: SavedLookup, source: "ejar" | "cache", logs: unknown[], cfg: LookupConfig,
  ): Promise<LookupResponse> {
    const { contractsResource: _internal, ...mapped } = mapSaved(saved);
    const [ctx, alreadyImported, budget] = await Promise.all([
      lookupContext(this.store, accountId, { ...mapped, contractsResource: _internal }),
      this.store.findImported(accountId, saved.contractNumber),
      this.budget(accountId, cfg),
    ]);
    const { matches, resolved } = ctx;
    return {
      source,
      lookedUpAt: new Date(saved.createdAt).toISOString(),
      budget,
      alreadyImported,
      ...mapped,
      matches: { ...matches, landlord: null, tenant: null, unit: matches.units[0] ?? null },
      required: computeRequired({ ...mapped, contractsResource: _internal }, {
        resolved,
        matches: { ...matches, unitEjarIds: matchedUnitEjarIds(mapped, matches.units) },
      }),
      logs,
    };
  }
}

/** The contract's Ejar unit UUIDs that the account already holds. */
export function matchedUnitEjarIds(mapped: Pick<MappedLookup, "units">, units: UnitMatch[]): string[] {
  const held = new Set(units.map((u) => u.ejarId).filter((v): v is string => !!v));
  return mapped.units.map((u) => u.ejarId).filter((v): v is string => !!v && held.has(v));
}
