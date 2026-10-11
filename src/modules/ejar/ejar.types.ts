// Types + endpoint registry for the NHC / Takamolat "Ejar" integration.
//
// Two gateways front the same Ejar backend: NHC's IBM gateway (client id +
// secret headers) and MOMRAH's Balady gateway (OAuth client-credentials).
// Balady only carries the endpoints with a `balady` route below; the rest stay
// on NHC until MOMRAH subscribes us to them.
//
// Every NHC response shares one envelope: a `Header` (status + tracing) and a
// `Body` in JSON:API shape (`data` / `included` / `meta` / `links`). The client
// unwraps the envelope and returns the `Body`.

export interface EjarStatus {
  Code: number;
  Description?: string;
}

export interface EjarHeader {
  ResTime?: string;
  ChId?: string;
  RefId?: string;
  ReqID?: string;
  Status?: EjarStatus;
}

export interface JsonApiRef {
  type: string;
  id: string;
}

export interface JsonApiResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, { data?: JsonApiRef | JsonApiRef[] | null }>;
  links?: Record<string, unknown>;
}

export interface EjarBody<T = Record<string, unknown>> {
  data?: JsonApiResource<T> | JsonApiResource<T>[] | null;
  included?: JsonApiResource[];
  meta?: { count?: number; [k: string]: unknown };
  links?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface EjarEnvelope<T = Record<string, unknown>> {
  Header?: EjarHeader;
  Body?: EjarBody<T>;
}

/** Balady's envelope. `statusDetails.code` can be a string like "401-01". */
export interface BaladyEnvelope<T = Record<string, unknown>> {
  statusDetails?: { code?: number | string; message?: string };
  data?: { responseCode?: string; responseMessage?: string; responseId?: string; result?: EjarBody<T> };
}

/* ── Endpoint registry — the six NHC endpoints plus Balady's contract details ── */

export type EjarEndpointKey =
  | "getRentalContracts"
  | "getProperties"
  | "getUnits"
  | "nationalAddress"
  | "rentalContractInvoices"
  | "rentalFinancialData"
  | "contractDetails";

/**
 * The calls a contract lookup can make, all budgeted: Invoices, then Get
 * Contracts (or Details), with Details as the fallback when Get Contracts
 * does not hold the contract.
 */
export const LOOKUP_ENDPOINTS = ["rentalContractInvoices", "getRentalContracts", "contractDetails"] as const;

/** An Ejar contract UUID (the id the invoices call returns). */
export const EJAR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EjarEndpointDef {
  method: "GET";
  path: string;
  /** "A" = /v1/ejar/* (by contractNumber); "B" = /v1/ejarext/* (by id_number). */
  group: "A" | "B";
  required: string[];
  label: string;
  /**
   * Route on MOMRAH's Balady gateway, when it carries this endpoint. Balady
   * serves the same Ejar backend — its `data.result` is byte-identical to the
   * NHC `Body` — so only the path differs. Returns the path and the params
   * left over for the query string.
   */
  balady?: (params: Record<string, string>) => { path: string; query: Record<string, string> };
  /** Only Balady carries it: no NHC fallback, unconfigured Balady is a config error. */
  baladyOnly?: boolean;
  /**
   * Never retried automatically. These calls are counted against the lookup
   * budget, so a 5xx/429 retry would silently spend quota. The single
   * token-refresh retry on a Balady 401 still happens and is counted.
   */
  noRetry?: boolean;
  /** Validate params before anything is sent; return an error message to refuse. */
  validate?: (params: Record<string, string>) => string | null;
}

export const EJAR_ENDPOINTS: Record<EjarEndpointKey, EjarEndpointDef> = {
  // Since Import v2 only the lookup uses it, by UUID, on Balady. It must name
  // a contract: with skip_filter_id_number=true and no contract_ids the
  // gateway returns the entire dataset, so a missing/non-UUID contract_ids is
  // refused before sending.
  getRentalContracts: {
    method: "GET", path: "/v1/ejarext/GetRentalContracts", group: "B", required: ["id_number", "contract_ids"], label: "Get Rental Contracts",
    balady: (query) => ({ path: "/v1/ejar-services/contracts", query }),
    baladyOnly: true,
    noRetry: true,
    validate: ({ contract_ids }) =>
      (contract_ids ?? "").split(",").every((id) => EJAR_UUID_RE.test(id.trim())) ? null : "contract_ids must be Ejar contract UUIDs",
  },
  getProperties: { method: "GET", path: "/v1/ejarext/GetProperties", group: "B", required: ["id_number"], label: "Get Properties" },
  getUnits: { method: "GET", path: "/v1/ejarext/GetUnits", group: "B", required: ["id_number"], label: "Get Units" },
  nationalAddress: { method: "GET", path: "/v1/ejar/NationalAddress", group: "A", required: ["contractNumber"], label: "National Address" },
  rentalContractInvoices: {
    method: "GET", path: "/v1/ejar/RentalContractInvoices", group: "A", required: ["contractNumber"], label: "Rental Contract Invoices",
    balady: ({ contractNumber, ...query }) => ({ path: `/v1/ejar-services/contracts/${encodeURIComponent(contractNumber)}/invoices`, query }),
    noRetry: true,
    // Balady only: an NHC fallback would be logged under an NHC env and slip
    // past the lookup budget, which counts Balady calls.
    baladyOnly: true,
    validate: ({ contractNumber }) => (/^\d{5,20}$/.test(contractNumber ?? "") ? null : "contractNumber must be digits only"),
  },
  // Balady only. A non-UUID id makes the gateway answer 500, so it is refused
  // here before anything is sent.
  contractDetails: {
    method: "GET", path: "/v1/ejar-services/contracts/{uuid}", group: "A", required: ["uuid"], label: "Contract Details",
    balady: ({ uuid, ...query }) => ({ path: `/v1/ejar-services/contracts/${encodeURIComponent(uuid)}`, query }),
    baladyOnly: true,
    noRetry: true,
    validate: ({ uuid }) => (EJAR_UUID_RE.test(uuid ?? "") ? null : "uuid must be an Ejar contract UUID"),
  },
  rentalFinancialData: { method: "GET", path: "/v1/ejar/RentalFinancialData", group: "A", required: ["contractNumber"], label: "Rental Financial Data" },
};

export function isEjarEndpointKey(k: unknown): k is EjarEndpointKey {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(EJAR_ENDPOINTS, k);
}

/** In-memory shape of a log row before it is persisted (mirrors the DB row). */
export interface EjarLogRecordInput {
  userId: number | null;
  env: string;
  endpoint: EjarEndpointKey | string;
  method: string;
  url: string;
  params: Record<string, string>;
  requestHeaders: Record<string, string>;
  status: number | null;
  ejarStatus: number | null;
  transactionId: string | null;
  durationMs: number;
  attempts: number;
  responseBody: unknown;
  bodyTruncated: boolean;
  error: string | null;
}
