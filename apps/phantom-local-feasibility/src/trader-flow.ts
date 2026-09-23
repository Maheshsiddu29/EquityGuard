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
import { formatFailureHeadline, type LocalSimulationFailure } from "./rpc-failure.ts";

/** Buy always uses the sealed pre-activation authorization. It is not a scenario picker. */
export const TRADER_BUY_KIND = "STALE" as const;
/** Confirm always uses the sealed post-activation authorization, after a separate click. */
export const TRADER_CONFIRM_KIND = "REFRESHED" as const;

export const TRADER_INITIAL_STEP = "READY_STALE" as const;

const NO_TOKENS = "No tokens were exchanged.";

export function tokensUnchanged(outcome: Pick<ReplayOutcome, "before" | "after">): boolean {
  return outcome.before.usdc === outcome.after.usdc && outcome.before.kox === outcome.after.kox;
}

/** True only for a landed local failure, not a simulation-only result. */
export function staleReviewAllowed(outcome: ReplayOutcome): boolean {
  return outcome.kind === TRADER_BUY_KIND
    && outcome.authorizationSource === STALE_AUTHORIZATION_SOURCE
    && outcome.signature.length > 0
    && outcome.slot > 0n
    && outcome.error !== null
    && outcome.guardInvoked
    && outcome.failedInstruction === 0
    && outcome.customCode === 12
    && outcome.guardErrorName === "ActivationPhaseChanged"
    && !outcome.jupiterInvoked
    && !outcome.whirlpoolInvoked
    && tokensUnchanged(outcome);
}

export function staleReviewMessage(outcome: ReplayOutcome): string | null {
  if (!staleReviewAllowed(outcome) || !tokensUnchanged(outcome)) return null;
  return [
    "Order needs review",
    "",
    "The asset changed while your order was being processed.",
    "",
    NO_TOKENS,
  ].join("\n");
}

export function refreshedSuccessAllowed(outcome: ReplayOutcome): boolean {
  return outcome.kind === TRADER_CONFIRM_KIND
    && outcome.authorizationSource === REFRESHED_AUTHORIZATION_SOURCE
    && outcome.signature.length > 0
    && outcome.slot > 0n
    && outcome.error === null
    && !outcome.skipPreflight
    && outcome.guardInvoked
    && outcome.jupiterInvoked
    && outcome.whirlpoolInvoked
    && outcome.after.usdc === outcome.before.usdc - EXPECTED_IN_AMOUNT
    && outcome.after.kox === outcome.before.kox + EXPECTED_OUT_AMOUNT
    && formatKox(outcome.after.kox - outcome.before.kox) === "0.05504261";
}

export function refreshedSuccessMessage(outcome: ReplayOutcome): string | null {
  if (!refreshedSuccessAllowed(outcome)) return null;
  return [
    "Protected trade replay completed",
    "",
    "5.00 USDC",
    "→",
    "0.05504261 KOx",
    "",
    "Local execution replay",
  ].join("\n");
}

export function technicalEvidence(stale: ReplayOutcome, refreshed: ReplayOutcome): string | null {
  if (!staleReviewAllowed(stale) || !refreshedSuccessAllowed(refreshed)) return null;
  const usdcSpent = formatUsdc(refreshed.before.usdc - refreshed.after.usdc);
  const koxReceived = formatKox(refreshed.after.kox - refreshed.before.kox);
  return [
    "REAL MARKET EVIDENCE",
    "",
    "KOx authorization:",
    "Sep 15 · 00:29:46 UTC",
    "",
    "Activation:",
    "00:30:00 UTC",
    "",
    "Post-state:",
    "00:30:16 UTC",
    "",
    "Source:",
    "recorded Solana mainnet KOx state",
    "",
    "SIGNED STALE ATTEMPT",
    "",
    "Signer:",
    "Phantom",
    "",
    "Execution:",
    "local solana-test-validator",
    "",
    "EquityGuard:",
    "Rejected at ix0",
    "",
    "Reason:",
    "ActivationPhaseChanged",
    "",
    "Jupiter:",
    "Not invoked",
    "",
    "Whirlpool:",
    "Not invoked",
    "",
    "USDC:",
    "0 movement",
    "",
    "KOx:",
    "0 movement",
    "",
    "SIGNED UPDATED ATTEMPT",
    "",
    "Second Phantom approval:",
    "Yes",
    "",
    "EquityGuard:",
    "Passed",
    "",
    "Jupiter:",
    "Executed",
    "",
    "Whirlpool:",
    "Executed",
    "",
    "USDC:",
    `-${usdcSpent}`,
    "",
    "KOx:",
    `+${koxReceived}`,
    "",
    "PROVENANCE",
    "",
    "Economic-state source:",
    "recorded Sep 15 Solana mainnet",
    "",
    "Route source:",
    "independently captured Sep 17 mainnet-derived Jupiter route",
    "",
    "Execution:",
    "local solana-test-validator",
    "",
    "Hard boundary:",
    "not a mainnet EquityGuard transaction",
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

export function traderFacingError(action: "buy" | "confirm", error: unknown): { readonly headline: string; readonly technical: string } {
  const technical = error instanceof Error && "failure" in error
    ? `${formatFailureHeadline((error as { readonly failure: LocalSimulationFailure }).failure, action === "buy" ? "Buy" : "Updated order")}\n${((error as { readonly failure: LocalSimulationFailure }).failure.logs).join("\n")}`
    : errorMessage(error);
  if (isPhantomMissing(error)) return { headline: "Phantom not detected", technical };
  if (isSignatureCancelled(error)) return { headline: "Signature request cancelled", technical };
  if (isEnvironmentUnavailable(error)) return { headline: "Local replay environment unavailable", technical };
  return {
    headline: action === "buy" ? "Order could not be submitted" : "Updated order could not be confirmed",
    technical,
  };
}
