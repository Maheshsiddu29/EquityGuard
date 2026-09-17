/**
 * The EquityGuard drop-in integration surface for applications that already
 * build Jupiter swaps: `@equityguard/jupiter/protect`.
 *
 * One call turns a Jupiter Swap V2 `/build` response into an unsigned,
 * guarded transaction, or says — in typed form — why it could not. It reuses
 * the reviewed decoders, ABI encoder, grammar checks and composer; it
 * reimplements none of them.
 *
 * What it does on the caller's behalf:
 *
 *   1. decides whether a protected Token-2022 mint is involved at all;
 *   2. reads that mint and the Clock at one slot (`fetchGuardSnapshot`);
 *   3. derives the expected economic state and activation phase from chain
 *      time (`expectationFromSnapshot`);
 *   4. refuses to build a guard the program would reject right now
 *      (`checkGuardOffline`);
 *   5. composes guard-first with the Jupiter suffix and commits to it
 *      (`composeGuardedJupiterTrade`);
 *   6. returns unsigned wire bytes and the composable instructions.
 *
 * Build-only, by construction: nothing here signs, submits, holds a key or
 * reads an environment variable. The caller keeps the wallet.
 *
 * PROTECTION IS NEVER SILENTLY DROPPED. When a protected mint is involved and
 * the route cannot be represented safely, the result is
 * `UNSUPPORTED_PROTECTED_ROUTE` or `ERROR` — never the original unguarded
 * transaction, and never `NOT_APPLICABLE`.
 */

import {
  address,
  getBase64Decoder,
  type Address,
  type Base64EncodedDataResponse,
  type Commitment,
  type GetMultipleAccountsApi,
  type Instruction,
  type Rpc,
} from "@solana/kit";
import {
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  GuardClientError,
  SET_COMPUTE_UNIT_LIMIT,
  USDC_MINT_ADDRESS,
  checkGuardOffline,
  checkGuardedJupiterTransaction,
  decodeProtectedState,
  expectationFromSnapshot,
  fetchGuardSnapshot,
  phaseAt,
  type AssertSafeExecutionRequest,
  type EquityGuardErrorName,
  type GuardSnapshot,
  type JupiterAdapterKind,
  type JupiterTradeBinding,
  type ProtectedState,
  type ProtectionWindow,
} from "@equityguard/guard-client";

import { parseBuildResponse, JupiterApiError, type BuildResponse } from "./build-client.ts";
import {
  CompositionError,
  UNSIMULATED_COMPUTE_UNIT_LIMIT,
  UnsupportedJupiterBuildError,
  composeGuardedJupiterTrade,
  resolveWireTransaction,
  type TransactionMetrics,
} from "./compose.ts";

/**
 * The routes adapter kinds 2 and 3 represent. Everything outside this table
 * fails closed; this milestone does not widen it.
 */
export const SUPPORTED_JUPITER_ROUTES = Object.freeze({
  jupiterProgram: "Jupiter v6",
  entrypoint: "route_v2",
  swapMode: "ExactIn",
  counterAsset: `canonical USDC (${USDC_MINT_ADDRESS})`,
  protectedAsset: "a Token-2022 mint carrying a decodable ScaledUiAmount extension",
  directions: ["BUY (USDC -> protected)", "SELL (protected -> USDC)"],
  grammar: "guard at index 0, then SetComputeUnitPrice, SetComputeUnitLimit, optional ATA CreateIdempotent, route_v2 last",
  tokenAccounts: "canonical associated token accounts of the swap authority, on both sides",
  unsupported: [
    "cleanup, tip or other instructions (wSOL-intermediate flows)",
    "ExactOut",
    "any counter asset other than canonical USDC",
    "more than one setup instruction, or a setup that is not this trade's CreateIdempotent",
    "platform-fee or positive-slippage-sharing routes",
    "a destination override, or non-canonical source/destination accounts",
    "any Jupiter entrypoint other than route_v2",
  ],
} as const);

/** The single EquityGuard deployment. The program is NOT deployed on mainnet. */
export const DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS = EQUITY_GUARD_DEVNET_PROGRAM_ID;

/** Raw, unparsed `/build` JSON, as `await response.json()` returns it. */
export type RawJupiterBuild = { readonly [field: string]: unknown };

/**
 * Stable reasons a protected swap produced no transaction. Every one is a
 * refusal: none of them means "send the unguarded transaction instead".
 */
export const EquityGuardFailureCode = {
  /** The route is a shape adapter kinds 2/3 cannot represent. */
  UNSUPPORTED_ROUTE_SHAPE: "UNSUPPORTED_ROUTE_SHAPE",
  /** A protected mint is traded against something other than canonical USDC. */
  UNSUPPORTED_COUNTER_ASSET: "UNSUPPORTED_COUNTER_ASSET",
  /** The guarded transaction would exceed Solana's size limit. */
  TRANSACTION_TOO_LARGE: "TRANSACTION_TOO_LARGE",
  /** The `/build` payload is not a well-formed Jupiter Swap V2 response. */
  INVALID_JUPITER_BUILD: "INVALID_JUPITER_BUILD",
  /** A Token-2022 mint account could not be decoded; the guard would refuse it too. */
  MALFORMED_TOKEN_STATE: "MALFORMED_TOKEN_STATE",
  /** The mint's extension set is one Token-2022 forbids. */
  UNSUPPORTED_TOKEN_STATE: "UNSUPPORTED_TOKEN_STATE",
  /** The mint account or Clock could not be read. */
  MINT_STATE_UNAVAILABLE: "MINT_STATE_UNAVAILABLE",
  /** Chain state no longer matches the state the caller quoted against. */
  ECONOMIC_STATE_CHANGED: "ECONOMIC_STATE_CHANGED",
  /** Chain time is inside the protection window around a scheduled activation. */
  INSIDE_TRANSITION_WINDOW: "INSIDE_TRANSITION_WINDOW",
  /** The protection window or state expectation handed in is not encodable. */
  INVALID_GUARD_REQUEST: "INVALID_GUARD_REQUEST",
  /** The composed transaction does not resolve to what the guard committed to. */
  COMMITMENT_FAILURE: "COMMITMENT_FAILURE",
} as const;
export type EquityGuardFailureCode = (typeof EquityGuardFailureCode)[keyof typeof EquityGuardFailureCode];

/** Why no protected mint is involved. Only these two mean "carry on unguarded". */
export type NotApplicableReason =
  /** Neither side of the swap is a Token-2022 mint. */
  | "NO_TOKEN_2022_MINT"
  /** A Token-2022 mint is involved, but it carries no ScaledUiAmount state to protect. */
  | "NO_PROTECTED_STATE";

export type SwapDirection = "BUY" | "SELL";

export interface ProtectedSwap {
  readonly status: "PROTECTED";
  readonly protectedMint: Address;
  readonly direction: SwapDirection;
  readonly adapterKind: JupiterAdapterKind;
  readonly programAddress: Address;
  /** Unsigned v0 transaction: one zeroed signature slot per required signer. */
  readonly transaction: Uint8Array;
  /** The same bytes, base64-encoded, for wallet APIs that take a string. */
  readonly transactionBase64: string;
  /** `[guard, price, limit, (ATA setup), route_v2]`, for callers that compile themselves. */
  readonly instructions: readonly Instruction[];
  /** Jupiter's lookup tables, as the transaction was compiled against them. */
  readonly lookupTables: Readonly<Record<string, readonly string[]>>;
  /** Every field of the trade the guard's grammar leaves to the client. */
  readonly binding: JupiterTradeBinding;
  readonly metrics: TransactionMetrics;
  /** The chain state and time the guard was bound to. */
  readonly snapshot: GuardSnapshot;
}

export interface NotApplicableSwap {
  readonly status: "NOT_APPLICABLE";
  readonly reason: NotApplicableReason;
  readonly message: string;
}

/** A protected asset whose route EquityGuard cannot safely represent. Fail closed. */
export interface UnsupportedProtectedRoute {
  readonly status: "UNSUPPORTED_PROTECTED_ROUTE";
  readonly code: EquityGuardFailureCode;
  readonly message: string;
  readonly protectedMint: Address;
  /** The error the on-chain program would return, when the refusal mirrors one. */
  readonly guardError: EquityGuardErrorName | null;
  /** Every reason the build was refused, as the composer reported them. */
  readonly details: readonly string[];
}

/** Malformed input, unreadable state, or state that moved. Fail closed. */
export interface EquityGuardErrorResult {
  readonly status: "ERROR";
  readonly code: EquityGuardFailureCode;
  readonly message: string;
  /** Null when the failure happened before a protected mint was identified. */
  readonly protectedMint: Address | null;
  readonly guardError: EquityGuardErrorName | null;
  readonly details: readonly string[];
}

export type ProtectJupiterSwapResult = ProtectedSwap | NotApplicableSwap | UnsupportedProtectedRoute | EquityGuardErrorResult;

/** What `supportsJupiterSwap` answers, without building anything. */
export type JupiterSwapSupport =
  | { readonly supported: true; readonly protectedMint: Address; readonly direction: SwapDirection; readonly adapterKind: JupiterAdapterKind }
  | { readonly supported: false; readonly protectedMint: Address | null; readonly status: "NOT_APPLICABLE" | "UNSUPPORTED_PROTECTED_ROUTE" | "ERROR"; readonly code: EquityGuardFailureCode | NotApplicableReason; readonly message: string };

export interface ProtectJupiterSwapInput {
  /** A Jupiter Swap V2 `/build` response, parsed or raw. */
  readonly build: BuildResponse | RawJupiterBuild;
  /** The wallet taking the swap: the swap authority and the fee payer. */
  readonly userPublicKey: Address;
  /** Any Solana RPC. It is read from, never written to. */
  readonly rpc: Rpc<GetMultipleAccountsApi>;
  /**
   * The inclusive refusal interval around a scheduled activation T,
   * `[T - beforeSecs, T + afterSecs]`. Required: it is a policy decision about
   * how much corporate-action risk the integrator refuses to execute through,
   * and there is no safe default.
   */
  readonly protectionWindow: ProtectionWindow;
  /** Defaults to the single EquityGuard deployment (devnet). */
  readonly programAddress?: Address;
  /** Defaults to Jupiter's own limit when the build carries one. */
  readonly computeUnitLimit?: number;
  /**
   * The protected state the caller quoted against, if it has one. When chain
   * state has moved away from it the swap is refused with
   * ECONOMIC_STATE_CHANGED instead of being rebound to the newer state.
   */
  readonly expectedState?: ProtectedState;
  /** Commitment for the state read. Defaults to `confirmed`. */
  readonly commitment?: Commitment;
}

export type SupportsJupiterSwapInput = Pick<ProtectJupiterSwapInput, "build" | "rpc" | "commitment">;

// ------------------------------------------------------------ classification

type Classification =
  | { readonly kind: "PROTECTED"; readonly protectedMint: Address; readonly direction: SwapDirection; readonly adapterKind: JupiterAdapterKind }
  | { readonly kind: "NOT_APPLICABLE"; readonly reason: NotApplicableReason; readonly message: string }
  | { readonly kind: "UNSUPPORTED"; readonly code: EquityGuardFailureCode; readonly message: string; readonly protectedMint: Address }
  | { readonly kind: "ERROR"; readonly code: EquityGuardFailureCode; readonly message: string; readonly protectedMint: Address | null };

/**
 * Whether a candidate mint carries protected state, using the reviewed
 * decoder. `InvalidMintOwner` and `MissingScaledUiAmount` mean "not an
 * EquityGuard asset"; every other decode failure is a protected-looking
 * Token-2022 mint that cannot be read, and fails closed.
 */
function inspectMint(mint: Address, owner: string, data: Uint8Array): { readonly protectedMint: true } | { readonly protectedMint: false; readonly reason: NotApplicableReason } | { readonly failure: EquityGuardErrorResult } {
  try {
    decodeProtectedState(owner, data);
    return { protectedMint: true };
  } catch (error) {
    if (!(error instanceof GuardClientError)) throw error;
    if (error.code === "InvalidMintOwner") return { protectedMint: false, reason: "NO_TOKEN_2022_MINT" };
    if (error.code === "MissingScaledUiAmount") return { protectedMint: false, reason: "NO_PROTECTED_STATE" };
    return {
      failure: {
        status: "ERROR",
        code: error.code === "InvalidExtensionCombination" ? EquityGuardFailureCode.UNSUPPORTED_TOKEN_STATE : EquityGuardFailureCode.MALFORMED_TOKEN_STATE,
        message: `${mint} is a Token-2022 mint whose state cannot be read (${error.message}); EquityGuard refuses rather than trading it unprotected`,
        protectedMint: mint,
        guardError: null,
        details: [error.message],
      },
    };
  }
}

const base64 = ([encoded]: Base64EncodedDataResponse): Uint8Array => Uint8Array.from(Buffer.from(encoded, "base64"));

/** Identifies the protected side of a build and the adapter kind that covers it. */
async function classify(build: BuildResponse, rpc: Rpc<GetMultipleAccountsApi>, commitment: Commitment): Promise<Classification> {
  const inputMint = address(build.inputMint);
  const outputMint = address(build.outputMint);
  if (inputMint === outputMint) {
    return { kind: "UNSUPPORTED", code: EquityGuardFailureCode.UNSUPPORTED_ROUTE_SHAPE, message: "the build trades a mint for itself", protectedMint: inputMint };
  }
  // USDC is the pinned counter asset and is a legacy SPL token, never protected.
  const candidates = [inputMint, outputMint].filter((mint) => mint !== USDC_MINT_ADDRESS);
  if (candidates.length === 0) {
    return { kind: "NOT_APPLICABLE", reason: "NO_TOKEN_2022_MINT", message: "neither side of the swap is a Token-2022 mint" };
  }

  const { value } = await rpc.getMultipleAccounts(candidates, { encoding: "base64", commitment }).send();
  const protectedMints: Address[] = [];
  let notApplicable: NotApplicableReason = "NO_TOKEN_2022_MINT";
  for (const [index, mint] of candidates.entries()) {
    const account = value[index];
    if (!account) {
      return { kind: "ERROR", code: EquityGuardFailureCode.MINT_STATE_UNAVAILABLE, message: `mint ${mint} was not returned by the RPC; EquityGuard cannot tell whether it is protected`, protectedMint: null };
    }
    const inspected = inspectMint(mint, account.owner, base64(account.data));
    if ("failure" in inspected) return { kind: "ERROR", code: inspected.failure.code, message: inspected.failure.message, protectedMint: mint };
    if (inspected.protectedMint) protectedMints.push(mint);
    else if (inspected.reason === "NO_PROTECTED_STATE") notApplicable = "NO_PROTECTED_STATE";
  }

  const [protectedMint, second] = protectedMints;
  if (!protectedMint) {
    return {
      kind: "NOT_APPLICABLE",
      reason: notApplicable,
      message: notApplicable === "NO_PROTECTED_STATE" ? "the Token-2022 mint in this swap carries no ScaledUiAmount state to protect" : "neither side of the swap is a protected Token-2022 mint",
    };
  }
  if (second) {
    return { kind: "UNSUPPORTED", code: EquityGuardFailureCode.UNSUPPORTED_COUNTER_ASSET, message: `both ${protectedMint} and ${second} are protected; adapter kinds 2 and 3 trade one protected mint against canonical USDC`, protectedMint };
  }
  const counterMint = protectedMint === outputMint ? inputMint : outputMint;
  if (counterMint !== USDC_MINT_ADDRESS) {
    return { kind: "UNSUPPORTED", code: EquityGuardFailureCode.UNSUPPORTED_COUNTER_ASSET, message: `${protectedMint} is protected but is traded against ${counterMint}; only canonical USDC is supported`, protectedMint };
  }
  return protectedMint === outputMint
    ? { kind: "PROTECTED", protectedMint, direction: "BUY", adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC }
    : { kind: "PROTECTED", protectedMint, direction: "SELL", adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_SELL_USDC };
}

// -------------------------------------------------------------- entry points

/**
 * Whether this swap can be protected, without reading the trade's economic
 * state or building anything. Wallets use it to decide what to show before a
 * user commits; it is not a substitute for `protectJupiterSwap`, which
 * re-derives everything it needs.
 */
export async function supportsJupiterSwap(input: SupportsJupiterSwapInput): Promise<JupiterSwapSupport> {
  let build: BuildResponse;
  try {
    build = parseBuildResponse(input.build);
  } catch (error) {
    if (!(error instanceof JupiterApiError)) throw error;
    return { supported: false, protectedMint: null, status: "ERROR", code: EquityGuardFailureCode.INVALID_JUPITER_BUILD, message: error.message };
  }
  const classified = await classify(build, input.rpc, input.commitment ?? "confirmed");
  switch (classified.kind) {
    case "PROTECTED":
      return { supported: true, protectedMint: classified.protectedMint, direction: classified.direction, adapterKind: classified.adapterKind };
    case "NOT_APPLICABLE":
      return { supported: false, protectedMint: null, status: "NOT_APPLICABLE", code: classified.reason, message: classified.message };
    case "UNSUPPORTED":
      return { supported: false, protectedMint: classified.protectedMint, status: "UNSUPPORTED_PROTECTED_ROUTE", code: classified.code, message: classified.message };
    default:
      return { supported: false, protectedMint: classified.protectedMint, status: "ERROR", code: classified.code, message: classified.message };
  }
}

/**
 * Turns a Jupiter `/build` response into an unsigned guarded transaction, or
 * says why it could not.
 *
 * RPC and network failures are thrown, not returned: a caller must decide
 * explicitly what to do when it cannot tell whether an asset is protected.
 * Treating a thrown error as NOT_APPLICABLE would defeat the guard.
 */
export async function protectJupiterSwap(input: ProtectJupiterSwapInput): Promise<ProtectJupiterSwapResult> {
  let build: BuildResponse;
  try {
    build = parseBuildResponse(input.build);
  } catch (error) {
    if (!(error instanceof JupiterApiError)) throw error;
    return { status: "ERROR", code: EquityGuardFailureCode.INVALID_JUPITER_BUILD, message: error.message, protectedMint: null, guardError: null, details: [] };
  }

  const commitment = input.commitment ?? "confirmed";
  const classified = await classify(build, input.rpc, commitment);
  if (classified.kind === "NOT_APPLICABLE") return { status: "NOT_APPLICABLE", reason: classified.reason, message: classified.message };
  if (classified.kind === "UNSUPPORTED") {
    return { status: "UNSUPPORTED_PROTECTED_ROUTE", code: classified.code, message: classified.message, protectedMint: classified.protectedMint, guardError: null, details: [] };
  }
  if (classified.kind === "ERROR") {
    return { status: "ERROR", code: classified.code, message: classified.message, protectedMint: classified.protectedMint, guardError: null, details: [] };
  }
  const { protectedMint, direction, adapterKind } = classified;

  let snapshot: GuardSnapshot;
  try {
    snapshot = await fetchGuardSnapshot(input.rpc, protectedMint, commitment);
  } catch (error) {
    if (!(error instanceof GuardClientError)) throw error;
    return {
      status: "ERROR",
      code: stateFailureCode(error),
      message: `the protected state of ${protectedMint} could not be read: ${error.message}`,
      protectedMint,
      guardError: null,
      details: [error.message],
    };
  }

  const expectation = expectationFromSnapshot(snapshot, input.protectionWindow);
  // What the caller quoted against, if anything, must still be what is on chain.
  if (input.expectedState) {
    const quoted = { expected: input.expectedState, expectedPhase: phaseAt(input.expectedState, snapshot.clock.unixTimestamp), window: input.protectionWindow };
    const moved = guardVerdict(quoted, snapshot);
    if (moved) return economicFailure(moved, protectedMint);
  }
  // Refuse now what the program would refuse at execution time.
  const wouldFail = guardVerdict(expectation, snapshot);
  if (wouldFail) return economicFailure(wouldFail, protectedMint);

  try {
    const composed = await composeGuardedJupiterTrade({
      build,
      programAddress: input.programAddress ?? DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS,
      feePayer: input.userPublicKey,
      taker: input.userPublicKey,
      protectedMint,
      adapterKind,
      expectation,
      computeUnitLimit: input.computeUnitLimit ?? defaultComputeUnitLimit(build),
    });
    return {
      status: "PROTECTED",
      protectedMint,
      direction,
      adapterKind,
      programAddress: input.programAddress ?? DEFAULT_EQUITY_GUARD_PROGRAM_ADDRESS,
      transaction: composed.wireBytes,
      transactionBase64: getBase64Decoder().decode(composed.wireBytes),
      instructions: composed.trade.instructions,
      lookupTables: build.addressesByLookupTableAddress,
      binding: composed.binding,
      metrics: composed.metrics,
      snapshot,
    };
  } catch (error) {
    return compositionFailure(error, protectedMint);
  }
}

/**
 * Re-checks a protected transaction against the commitment its guard carries,
 * returning the error the program would raise, or `null`. Any downstream edit
 * — a different route, amount, slippage, destination or account flag — changes
 * the suffix and is detected here exactly as it is on chain.
 */
export type VerificationVerdict = EquityGuardErrorName | "UNRESOLVABLE_TRANSACTION" | null;

export async function verifyProtectedSwap(result: ProtectedSwap, wireBytes: Uint8Array = result.transaction): Promise<VerificationVerdict> {
  let instructions;
  try {
    instructions = resolveWireTransaction(wireBytes, result.lookupTables);
  } catch (error) {
    if (error instanceof CompositionError) return "UNRESOLVABLE_TRANSACTION";
    throw error;
  }
  return checkGuardedJupiterTransaction({
    instructions,
    guardIndex: 0,
    adapterKind: result.adapterKind,
    protectedMint: result.protectedMint,
    commitment: Uint8Array.from(Buffer.from(result.binding.suffixCommitmentHex, "hex")),
  });
}

/**
 * A deterministic, human-readable explanation of a non-protected result, for
 * wallet and agent surfaces. No model, no network, no formatting of amounts:
 * the same result always produces the same sentence.
 */
export function explainEquityGuardError(result: ProtectJupiterSwapResult): string {
  switch (result.status) {
    case "PROTECTED":
      return `EquityGuard is protecting this ${result.direction.toLowerCase()} of ${result.protectedMint}: the transaction fails atomically if the token's economic state changes before it lands.`;
    case "NOT_APPLICABLE":
      return `EquityGuard does not apply to this swap: ${result.message}. Continue with your existing Jupiter flow.`;
    default:
      return `${EXPLANATIONS[result.code]} EquityGuard did not produce a protected transaction, and the unguarded Jupiter transaction must not be sent in its place.${detailSuffix(result.details, result.guardError)}`;
  }
}

const EXPLANATIONS: Readonly<Record<EquityGuardFailureCode, string>> = {
  UNSUPPORTED_ROUTE_SHAPE: "This Jupiter route is a shape EquityGuard cannot protect yet. Rebuilding the quote — often with a lower maxAccounts, or after liquidity moves — usually returns a supported route.",
  UNSUPPORTED_COUNTER_ASSET: "EquityGuard protects tokenized-equity trades against canonical USDC only, and this swap uses another counter asset.",
  TRANSACTION_TOO_LARGE: "The guarded transaction would exceed Solana's 1232-byte limit. Rebuild the quote with a lower maxAccounts and try again.",
  INVALID_JUPITER_BUILD: "The Jupiter /build response could not be read as a Swap V2 build.",
  MALFORMED_TOKEN_STATE: "The token's on-chain state could not be decoded, so its economic state cannot be asserted. The on-chain guard would refuse it too.",
  UNSUPPORTED_TOKEN_STATE: "The token carries a Token-2022 extension combination EquityGuard does not support.",
  MINT_STATE_UNAVAILABLE: "The token's mint account or the Clock could not be read from the RPC, so no current economic state could be bound.",
  ECONOMIC_STATE_CHANGED: "The token's economic state changed after the quote was taken — this is exactly the event EquityGuard exists to catch. Refresh the quote and rebuild.",
  INSIDE_TRANSITION_WINDOW: "A corporate action is activating right now, inside the configured protection window. Wait for the window to pass and rebuild.",
  INVALID_GUARD_REQUEST: "The protection window or state expectation supplied to EquityGuard could not be encoded.",
  COMMITMENT_FAILURE: "The composed transaction did not match the commitment the guard was built over, so it was discarded.",
};

// ----------------------------------------------------------------- internals

/** Jupiter's own limit when it set one; otherwise its unsimulated maximum. */
function defaultComputeUnitLimit(build: BuildResponse): number {
  for (const instruction of build.computeBudgetInstructions) {
    const data = Uint8Array.from(Buffer.from(instruction.data, "base64"));
    if (data.length === SET_COMPUTE_UNIT_LIMIT.length && data[0] === SET_COMPUTE_UNIT_LIMIT.tag) {
      return new DataView(data.buffer, data.byteOffset).getUint32(1, true);
    }
  }
  return UNSIMULATED_COMPUTE_UNIT_LIMIT;
}

/** The program's execution-time verdict for this expectation against chain state now. */
function guardVerdict(expectation: AssertSafeExecutionRequest, snapshot: GuardSnapshot): EquityGuardErrorName | null {
  return checkGuardOffline(expectation, snapshot.state, snapshot.clock.unixTimestamp);
}

function economicFailure(verdict: EquityGuardErrorName, protectedMint: Address): EquityGuardErrorResult {
  const inside = verdict === "InsideTransitionWindow";
  return {
    status: "ERROR",
    code: inside ? EquityGuardFailureCode.INSIDE_TRANSITION_WINDOW : EquityGuardFailureCode.ECONOMIC_STATE_CHANGED,
    message: inside
      ? `${protectedMint} is inside its protection window around the scheduled activation; the guard would reject this transaction`
      : `the protected state of ${protectedMint} is no longer the state this swap was quoted against (${verdict})`,
    protectedMint,
    guardError: verdict,
    details: [],
  };
}

function stateFailureCode(error: GuardClientError): EquityGuardFailureCode {
  switch (error.code) {
    case "InvalidExtensionCombination":
      return EquityGuardFailureCode.UNSUPPORTED_TOKEN_STATE;
    case "AccountNotFound":
    case "InvalidClockData":
      return EquityGuardFailureCode.MINT_STATE_UNAVAILABLE;
    case "InvalidExpectedState":
    case "InvalidProtectionWindow":
      return EquityGuardFailureCode.INVALID_GUARD_REQUEST;
    default:
      return EquityGuardFailureCode.MALFORMED_TOKEN_STATE;
  }
}

/** Maps a composer refusal onto the public result, never onto a silent downgrade. */
function compositionFailure(error: unknown, protectedMint: Address): UnsupportedProtectedRoute | EquityGuardErrorResult {
  const unsupported = (code: EquityGuardFailureCode, message: string, guardError: EquityGuardErrorName | null, details: readonly string[]): UnsupportedProtectedRoute => ({
    status: "UNSUPPORTED_PROTECTED_ROUTE",
    code,
    message,
    protectedMint,
    guardError,
    details,
  });

  if (error instanceof UnsupportedJupiterBuildError) {
    return unsupported(EquityGuardFailureCode.UNSUPPORTED_ROUTE_SHAPE, error.message, null, error.reasons);
  }
  if (error instanceof GuardClientError) {
    if (error.code === "UnsupportedJupiterTrade" || error.code === "InvalidDownstream") {
      return unsupported(EquityGuardFailureCode.UNSUPPORTED_ROUTE_SHAPE, error.message, error.guardError, [error.message]);
    }
    return { status: "ERROR", code: stateFailureCode(error), message: error.message, protectedMint, guardError: error.guardError, details: [error.message] };
  }
  if (error instanceof CompositionError) {
    if (error.code === "TRANSACTION_TOO_LARGE") return unsupported(EquityGuardFailureCode.TRANSACTION_TOO_LARGE, error.message, null, [error.message]);
    if (error.code === "MISSING_COMPUTE_UNIT_PRICE") return unsupported(EquityGuardFailureCode.UNSUPPORTED_ROUTE_SHAPE, error.message, null, [error.message]);
    if (error.code === "INVALID_COMPUTE_UNIT_LIMIT") {
      return { status: "ERROR", code: EquityGuardFailureCode.INVALID_GUARD_REQUEST, message: error.message, protectedMint, guardError: null, details: [error.message] };
    }
    return { status: "ERROR", code: EquityGuardFailureCode.COMMITMENT_FAILURE, message: error.message, protectedMint, guardError: null, details: [error.message] };
  }
  throw error;
}

function detailSuffix(details: readonly string[], guardError: EquityGuardErrorName | null): string {
  const parts = [...details];
  if (guardError) parts.push(`on-chain error: ${guardError}`);
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

/** Canonical USDC: the only counter asset adapter kinds 2 and 3 support. */
export { USDC_MINT_ADDRESS };
export type { BuildResponse, EquityGuardErrorName, GuardSnapshot, JupiterAdapterKind, JupiterTradeBinding, ProtectedState, ProtectionWindow, TransactionMetrics };
