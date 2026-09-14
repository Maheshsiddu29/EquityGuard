/**
 * Jupiter Swap V2 `/build` client (GET https://api.jup.ag/swap/v2/build).
 *
 * `/build` returns raw instructions rather than a serialized transaction, so
 * EquityGuard can be inserted into the same transaction. This module never
 * signs or submits anything, and never logs or returns the API key.
 */

import { isAddress } from "@solana/kit";

export const JUPITER_API_BASE_URL = "https://api.jup.ag";
const BUILD_PATH = "/swap/v2/build";
/** Jupiter's documented `maxAccounts` bounds. */
const MAX_ACCOUNTS_RANGE = { min: 1, max: 64 } as const;
const BLOCKHASH_LEN = 32;
const REQUEST_TIMEOUT_MS = 20_000;
/** Enough of an error body to diagnose a failure without echoing large payloads. */
const ERROR_BODY_PREVIEW_CHARS = 300;

export class JupiterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterConfigError";
  }
}

/** HTTP or contract failure from Jupiter. Messages never include the API key. */
export class JupiterApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "JupiterApiError";
    this.status = status;
  }
}

export interface BuildRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Smallest units of the input token. */
  readonly amount: bigint;
  readonly taker: string;
  readonly slippageBps: number;
  readonly maxAccounts?: number;
}

export interface ApiAccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface ApiInstruction {
  readonly programId: string;
  readonly accounts: readonly ApiAccountMeta[];
  /** Base64-encoded instruction data. */
  readonly data: string;
}

export interface RoutePlanStep {
  readonly percent: number;
  /** Share of the route in bps; null if Jupiter omits it. */
  readonly bps: number | null;
  readonly swapInfo: {
    readonly ammKey: string;
    readonly label: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inAmount: string;
    readonly outAmount: string;
  };
}

/** The `/build` fields EquityGuard composition relies on, validated. */
export interface BuildResponse {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly swapMode: string;
  readonly slippageBps: number;
  readonly routePlan: readonly RoutePlanStep[];
  readonly computeBudgetInstructions: readonly ApiInstruction[];
  readonly setupInstructions: readonly ApiInstruction[];
  readonly swapInstruction: ApiInstruction;
  readonly cleanupInstruction: ApiInstruction | null;
  readonly otherInstructions: readonly ApiInstruction[];
  readonly tipInstruction: ApiInstruction | null;
  readonly addressesByLookupTableAddress: Readonly<Record<string, readonly string[]>>;
  readonly blockhashWithMetadata: {
    readonly blockhash: readonly number[];
    readonly lastValidBlockHeight: number;
  };
}

export function readJupiterApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.JUPITER_API_KEY;
  if (!key) throw new JupiterConfigError("JUPITER_API_KEY is not set");
  return key;
}

/** Builds the request URL. The API key goes in a header, never the URL. */
export function buildRequestUrl(request: BuildRequest, baseUrl: string = JUPITER_API_BASE_URL): URL {
  for (const [name, value] of [
    ["inputMint", request.inputMint],
    ["outputMint", request.outputMint],
    ["taker", request.taker],
  ] as const) {
    if (!isAddress(value)) throw new JupiterConfigError(`${name} is not a valid address`);
  }
  if (request.amount <= 0n) throw new JupiterConfigError("amount must be positive");
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0) {
    throw new JupiterConfigError("slippageBps must be a non-negative integer");
  }
  const url = new URL(BUILD_PATH, baseUrl);
  url.searchParams.set("inputMint", request.inputMint);
  url.searchParams.set("outputMint", request.outputMint);
  url.searchParams.set("amount", request.amount.toString());
  url.searchParams.set("taker", request.taker);
  url.searchParams.set("slippageBps", String(request.slippageBps));
  if (request.maxAccounts !== undefined) {
    const { min, max } = MAX_ACCOUNTS_RANGE;
    if (!Number.isInteger(request.maxAccounts) || request.maxAccounts < min || request.maxAccounts > max) {
      throw new JupiterConfigError(`maxAccounts must be an integer in [${min}, ${max}]`);
    }
    url.searchParams.set("maxAccounts", String(request.maxAccounts));
  }
  return url;
}

/** Calls `/build` and returns the validated response. */
export async function fetchBuild(
  request: BuildRequest,
  options: { readonly apiKey: string; readonly baseUrl?: string; readonly fetchImpl?: typeof fetch },
): Promise<BuildResponse> {
  const url = buildRequestUrl(request, options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "x-api-key": options.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new JupiterApiError(`request failed: ${error instanceof Error ? error.message : String(error)}`, null);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new JupiterApiError(`HTTP ${response.status}: ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`, response.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JupiterApiError("response is not JSON", response.status);
  }
  return parseBuildResponse(json);
}

/** Validates a `/build` response against the documented contract. */
export function parseBuildResponse(value: unknown): BuildResponse {
  const r = asRecord(value, "response");
  const blockhash = asRecord(r.blockhashWithMetadata, "blockhashWithMetadata");
  const blockhashBytes = asArray(blockhash.blockhash, "blockhashWithMetadata.blockhash");
  if (
    blockhashBytes.length !== BLOCKHASH_LEN ||
    !blockhashBytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)
  ) {
    throw contractError("blockhashWithMetadata.blockhash must be 32 bytes");
  }

  const alts = r.addressesByLookupTableAddress ?? {};
  const altRecord = asRecord(alts, "addressesByLookupTableAddress");
  const addressesByLookupTableAddress: Record<string, readonly string[]> = {};
  for (const [table, addresses] of Object.entries(altRecord)) {
    addressesByLookupTableAddress[asAddress(table, "lookup table")] = asArray(addresses, `ALT ${table}`).map((a) =>
      asAddress(a, `ALT ${table} entry`),
    );
  }

  return {
    inputMint: asAddress(r.inputMint, "inputMint"),
    outputMint: asAddress(r.outputMint, "outputMint"),
    inAmount: asIntegerString(r.inAmount, "inAmount"),
    outAmount: asIntegerString(r.outAmount, "outAmount"),
    otherAmountThreshold: asIntegerString(r.otherAmountThreshold, "otherAmountThreshold"),
    swapMode: asString(r.swapMode, "swapMode"),
    slippageBps: asNumber(r.slippageBps, "slippageBps"),
    routePlan: asArray(r.routePlan, "routePlan").map(parseRouteStep),
    computeBudgetInstructions: asArray(r.computeBudgetInstructions, "computeBudgetInstructions").map(parseInstruction),
    setupInstructions: asArray(r.setupInstructions, "setupInstructions").map(parseInstruction),
    swapInstruction: parseInstruction(r.swapInstruction),
    cleanupInstruction: r.cleanupInstruction == null ? null : parseInstruction(r.cleanupInstruction),
    otherInstructions: asArray(r.otherInstructions ?? [], "otherInstructions").map(parseInstruction),
    tipInstruction: r.tipInstruction == null ? null : parseInstruction(r.tipInstruction),
    addressesByLookupTableAddress,
    blockhashWithMetadata: {
      blockhash: blockhashBytes as number[],
      lastValidBlockHeight: asNumber(blockhash.lastValidBlockHeight, "lastValidBlockHeight"),
    },
  };
}

function parseInstruction(value: unknown): ApiInstruction {
  const i = asRecord(value, "instruction");
  return {
    programId: asAddress(i.programId, "programId"),
    accounts: asArray(i.accounts, "accounts").map((meta) => {
      const m = asRecord(meta, "account meta");
      if (typeof m.isSigner !== "boolean" || typeof m.isWritable !== "boolean") {
        throw contractError("account meta flags must be booleans");
      }
      return { pubkey: asAddress(m.pubkey, "account pubkey"), isSigner: m.isSigner, isWritable: m.isWritable };
    }),
    data: asString(i.data, "instruction data"),
  };
}

function parseRouteStep(value: unknown): RoutePlanStep {
  const step = asRecord(value, "routePlan step");
  const info = asRecord(step.swapInfo, "swapInfo");
  return {
    percent: asNumber(step.percent, "percent"),
    bps: step.bps == null ? null : asNumber(step.bps, "bps"),
    swapInfo: {
      ammKey: asAddress(info.ammKey, "ammKey"),
      label: asString(info.label, "label"),
      inputMint: asAddress(info.inputMint, "swapInfo.inputMint"),
      outputMint: asAddress(info.outputMint, "swapInfo.outputMint"),
      inAmount: asIntegerString(info.inAmount, "swapInfo.inAmount"),
      outAmount: asIntegerString(info.outAmount, "swapInfo.outAmount"),
    },
  };
}

function contractError(message: string): JupiterApiError {
  return new JupiterApiError(`unexpected /build response: ${message}`, null);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw contractError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${name} must be an array`);
  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw contractError(`${name} must be a string`);
  return value;
}

function asNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw contractError(`${name} must be a number`);
  return value;
}

function asIntegerString(value: unknown, name: string): string {
  const s = asString(value, name);
  if (!/^\d+$/.test(s)) throw contractError(`${name} must be an unsigned integer string`);
  return s;
}

function asAddress(value: unknown, name: string): string {
  const s = asString(value, name);
  if (!isAddress(s)) throw contractError(`${name} is not a valid address`);
  return s;
}
