import recorded from "../../reference/data/kox-trade-replay.json" with { type: "json" };
import { type BuyStage, formatTechnicalDetails } from "./buy-error.ts";
import { FeasibilityError } from "./feasibility.ts";
import {
  EXPECTED_IN_AMOUNT,
  EXPECTED_OUT_AMOUNT,
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
  formatKox,
  formatUsdc,
} from "./local-funding.ts";
import type { ReplayOutcome } from "./replay-execution.ts";

/** Buy uses the sealed post-activation authorization and normal preflight. */
export const TRADER_BUY_KIND = "SAFE" as const;

export const TRADER_INITIAL_STEP = "READY_SAFE" as const;

/**
 * Recorded local executions from apps/reference/data/kox-trade-replay.json.
 * These are not the Phantom signature from the current Buy click.
 */
const stale = recorded.staleExecution;
const refreshed = recorded.refreshedExecution;
const wasInvoked = (programs: readonly string[], prefix: string) => programs.some((program) => program.startsWith(prefix));
export const RECORDED_STALE_PROOF = {
  authorizationSource: stale.authorizationSource,
  signature: stale.outcome.signature,
  failedInstruction: stale.outcome.failedInstruction,
  customCode: stale.outcome.customCode,
  guardErrorName: stale.outcome.guardErrorName,
  jupiterInvoked: wasInvoked(stale.invoked, "JUP6"),
  whirlpoolInvoked: wasInvoked(stale.invoked, "whirLb"),
  usdcDelta: stale.deltas.usdc,
  koxDelta: stale.deltas.kox,
};
export const RECORDED_REFRESHED_PROOF = {
  authorizationSource: refreshed.authorizationSource,
  signature: refreshed.outcome.signature,
  guardPassed: refreshed.outcome.succeeded && refreshed.outcome.err === null,
  jupiterInvoked: wasInvoked(refreshed.invoked, "JUP6"),
  whirlpoolInvoked: wasInvoked(refreshed.invoked, "whirLb"),
  usdcDelta: refreshed.deltas.usdc,
  koxDelta: refreshed.deltas.kox,
};

export function protectionTechnicalDetails(): string {
  return JSON.stringify({
    source: "apps/reference/data/kox-trade-replay.json",
    recordedAt: recorded.recordedAt,
    recordedTrader: recorded.localExecution.taker,
    stale: recorded.staleExecution,
    refreshed: recorded.refreshedExecution,
    marketEvidence: recorded.marketEvidence,
    routeEvidence: recorded.routeEvidence,
  }, null, 2);
}

export function liveSafeAllowed(outcome: ReplayOutcome): boolean {
  return outcome.kind === TRADER_BUY_KIND
    && outcome.authorizationSource === REFRESHED_AUTHORIZATION_SOURCE
    && outcome.signature.length > 0
    && outcome.slot > 0n
    && outcome.before.usdc === EXPECTED_IN_AMOUNT
    && outcome.before.kox === 0n
    && outcome.signer === outcome.feePayer
    && outcome.error === null
    && !outcome.skipPreflight
    && outcome.guardInvoked
    && outcome.jupiterInvoked
    && outcome.whirlpoolInvoked
    && outcome.after.usdc === outcome.before.usdc - EXPECTED_IN_AMOUNT
    && outcome.after.kox === outcome.before.kox + EXPECTED_OUT_AMOUNT
    && formatUsdc(EXPECTED_IN_AMOUNT) === "5.00"
    && formatKox(outcome.after.kox - outcome.before.kox) === "0.05504261";
}

export function liveSafeMessage(outcome: ReplayOutcome): string | null {
  if (!liveSafeAllowed(outcome)) return null;
  return [
    "Protected trade executed locally",
    "",
    "5.00 USDC → 0.05504261 KOx",
    "",
    "Local execution replay",
  ].join("\n");
}

/** Previously verified local executions. This text is not the Buy signature. */
export function protectionStory(): string {
  const refreshedUsdc = formatUsdc(BigInt(RECORDED_REFRESHED_PROOF.usdcDelta));
  const refreshedKox = formatKox(BigInt(RECORDED_REFRESHED_PROOF.koxDelta));
  const time = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19) + " UTC";
  return [
    "Stale authorization blocked",
    "Previously verified local execution evidence. Separate from the live Buy above.",
    "The asset state changed after authorization.",
    "EquityGuard rejected the transaction before the protected swap executed.",
    "",
    "EquityGuard: Rejected before protected execution",
    "Jupiter: " + (RECORDED_STALE_PROOF.jupiterInvoked ? "Invoked" : "Not invoked"),
    "Whirlpool: " + (RECORDED_STALE_PROOF.whirlpoolInvoked ? "Invoked" : "Not invoked"),
    "USDC movement: " + RECORDED_STALE_PROOF.usdcDelta,
    "KOx movement: " + RECORDED_STALE_PROOF.koxDelta,
    "",
    "Updated authorization executed",
    "Previously recorded recovery execution. Separate from the live Buy above.",
    "EquityGuard: " + (RECORDED_REFRESHED_PROOF.guardPassed ? "Passed" : "Failed"),
    "Jupiter: " + (RECORDED_REFRESHED_PROOF.jupiterInvoked ? "Executed" : "Not invoked"),
    "Whirlpool: " + (RECORDED_REFRESHED_PROOF.whirlpoolInvoked ? "Executed" : "Not invoked"),
    "USDC: " + refreshedUsdc,
    "KOx: +" + refreshedKox,
    "",
    "Recorded KOx Solana mainnet economic-state transition",
    "Authorization observation: Sep 15 " + time(recorded.marketEvidence.preparedObservation.blockTime),
    "Scheduled activation: " + time(Number(recorded.marketEvidence.scheduledActivation)),
    "Post-state observation: " + time(recorded.marketEvidence.postActivationObservation.blockTime),
    "The live Buy above is a separate local execution.",
    "It did not cross the Sep 15 event.",
    "It is not a Solana mainnet EquityGuard transaction.",
    "The Jupiter route is independently captured mainnet-derived evidence.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { readonly code?: unknown }).code;
}

export function isSignatureCancelled(error: unknown): boolean {
  if (error instanceof FeasibilityError && error.kind === "USER_REJECTED") return true;
  return errorCode(error) === 4001
    || /\b(?:user|request|signature request) (?:rejected|cancelled|canceled)\b/i.test(errorMessage(error));
}

function isPhantomMissing(error: unknown): boolean {
  if (error instanceof FeasibilityError && (error.kind === "PHANTOM_NOT_DETECTED" || error.kind === "SIGN_TRANSACTION_UNAVAILABLE")) {
    return true;
  }
  return /phantom (?:wallet )?not (?:found|detected)/i.test(errorMessage(error));
}

function isEnvironmentUnavailable(error: unknown): boolean {
  if (error instanceof FeasibilityError && error.kind === "LOCAL_RPC_REFUSED") return true;
  return /local (?:replay |validator|rpc)|reseed|baseline|genesis hash/i.test(errorMessage(error));
}

const STAGE_HEADLINE: Record<BuyStage, string> = {
  ENVIRONMENT_CHECK: "Local replay environment is not ready.",
  PHANTOM_CONNECT: "Connect Phantom to continue.",
  TRANSACTION_BUILD: "The protected order could not be prepared.",
  SIGN_REQUEST: "The signature request could not be completed.",
  SIGNED_BYTES_RETURNED: "The signed transaction could not be read.",
  PRE_SIGN_SIMULATION: "The order was not valid before signing. Reset the local reproduction.",
  WAITING_FOR_ACTIVATION: "The local state change could not be verified.",
  BLOCKHASH_VALIDATION: "The signed transaction expired. It was not rebuilt or resubmitted.",
  SIMULATION: "The protected order could not be validated.",
  SUBMISSION: "The order could not be submitted.",
  CONFIRMATION: "The transaction could not be confirmed.",
  BALANCE_VERIFICATION: "The transaction finished, but the result could not be verified.",
};

export function traderFacingError(
  action: "buy" | "confirm",
  error: unknown,
  stage: BuyStage,
  development = false,
): { readonly headline: string; readonly technical: string } {
  const technical = formatTechnicalDetails(error, stage, development);
  if (isSignatureCancelled(error)) return { headline: "Signature request cancelled.", technical };
  if (isPhantomMissing(error) || stage === "PHANTOM_CONNECT") return { headline: "Connect Phantom to continue.", technical };
  if (/reseed|baseline|Phantom (?:USDC|KOx) is/i.test(errorMessage(error))) {
    return { headline: "Demo environment needs reset\nReset the local replay environment before starting another trade.", technical };
  }
  if (isEnvironmentUnavailable(error) || stage === "ENVIRONMENT_CHECK") {
    return { headline: "Local replay environment is not ready.", technical };
  }
  return { headline: STAGE_HEADLINE[stage], technical };
}
