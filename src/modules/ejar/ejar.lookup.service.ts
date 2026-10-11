import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { EjarAccessError, EjarApiError, EjarClientService, EjarConfigError, ejarAccessDenial } from "./ejar.client.service";
import { canLookup, computeBudget, lookupConfig, windowBounds, type EjarBudget, type LookupConfig } from "./ejar.budget";
import {
  allPartyIdentifiers, computeRequired, lookupUuid, mapLookup, normalizeContractNumber, partyIdentifiers,
  type MappedLookup, type RequiredEntry,
} from "./ejar.lookup.map";
import type { EjarLookupStore, PartyMatch, SavedLookup } from "./ejar.lookup.store";
import type { EjarBody } from "./ejar.types";

export const EJAR_LOOKUP_STORE = Symbol("EJAR_LOOKUP_STORE");

export const SCOPE_MISMATCH_MESSAGE =
  "هذا العقد غير مرتبط بالسجل التجاري لحسابك · This contract is not linked to your account's commercial registration.";
export const BAD_FORMAT_MESSAGE = "رقم عقد إيجار غير صالح — أرقام فقط · Invalid Ejar contract number (digits only).";

export interface LookupResponse extends MappedLookup {
  source: "ejar" | "cache";
  lookedUpAt: string;
  budget: EjarBudget;
  alreadyImported: { contractId: number } | null;
  matches: { landlord: PartyMatch | null; tenant: PartyMatch | null };
  required: RequiredEntry[];
  logs: unknown[];
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
    return computeBudget(cfg, await this.store.usage(start, accountId));
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
        if (scope.locked && !allPartyIdentifiers(mapLookup(saved.invoicesBody, saved.detailsBody).parties).includes(scope.idNumber!)) {
          throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
        }
        return this.respond(accountId, saved, "cache", [], cfg);
      }
    }

    const outcome = await this.store.withBudgetLock<Outcome>(async () => {
      const budget = await this.budget(accountId, cfg);
      if (!canLookup(budget)) return { kind: "exhausted", budget };

      const logs: unknown[] = [];
      const call = async (endpoint: "rentalContractInvoices" | "contractDetails", params: Record<string, string>) => {
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

      const det = await call("contractDetails", { uuid });
      if ("err" in det) return { kind: "error", err: det.err, logs };

      // A locked (tenant-package) account may only see a contract it is a
      // party to. Checked before anything is saved or returned.
      if (scope.locked && !allPartyIdentifiers(mapLookup(inv.body, det.body).parties).includes(scope.idNumber!)) {
        return { kind: "scope_mismatch", logs };
      }

      const saved = await this.store.saveLookup({
        accountId, contractNumber, ejarUuid: uuid,
        invoicesBody: (inv.body ?? null) as Record<string, unknown> | null,
        detailsBody: (det.body ?? null) as Record<string, unknown> | null,
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
    const mapped = mapLookup(saved.invoicesBody, saved.detailsBody);
    const [matches, alreadyImported, budget] = await Promise.all([
      this.store.findMatches(accountId, partyIdentifiers(mapped.parties.lessor), partyIdentifiers(mapped.parties.tenant)),
      this.store.findImported(accountId, saved.contractNumber),
      this.budget(accountId, cfg),
    ]);
    return {
      source,
      lookedUpAt: new Date(saved.createdAt).toISOString(),
      budget,
      alreadyImported,
      ...mapped,
      matches,
      required: computeRequired(mapped.parties),
      logs,
    };
  }
}
