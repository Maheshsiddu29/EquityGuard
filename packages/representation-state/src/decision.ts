/**
 * Pure representation decision. It decides; it never executes, switches
 * assets, fetches quotes or signs anything.
 *
 * Every outcome is an expected product state returned as a value, not thrown.
 * A switch to a different issuer's representation is never silent: it needs
 * the user's explicit cross-issuer policy and always carries a disclosure
 * (issuers, reason, conservative cost delta).
 */

import type { QuoteComparison } from "./compare.ts";
import { formatRationalFloor } from "./normalize.ts";
import { RepresentationState, StateSource, type ResolvedRepresentationState } from "./types.ts";

export const Decision = {
  USE_PREFERRED: "USE_PREFERRED",
  REQUIRES_CONSENT: "REQUIRES_CONSENT",
  USE_ALTERNATIVE: "USE_ALTERNATIVE",
  NO_SAFE_ROUTE: "NO_SAFE_ROUTE",
  UNKNOWN_STATE: "UNKNOWN_STATE",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export type DecisionReasonCode =
  | "PREFERRED_SAFE"
  | "PREFERRED_STATE_UNKNOWN"
  | "PREFERRED_STATE_CONFLICT"
  | "NO_ALTERNATIVE"
  | "ALTERNATIVE_STATE_UNKNOWN"
  | "ALTERNATIVE_STATE_CONFLICT"
  | "ALTERNATIVE_NOT_SAFE"
  | "ALTERNATIVE_NOT_SAME_UNDERLYING"
  | "ALTERNATIVE_QUOTE_UNAVAILABLE"
  | "QUOTE_COMPARISON_MISMATCH"
  | "CONSENT_REQUIRED"
  | "CONSENT_GIVEN";

export interface ReroutePolicy {
  /** Explicit user choice: "Allow rerouting across verified issuers". */
  readonly allowCrossIssuerReroute: boolean;
}

/** Share-equivalent display precision; values are rounded down for display only. */
const DISCLOSURE_SHARE_DECIMALS = 12;

export interface RerouteDisclosure {
  readonly underlying: string;
  readonly original: RepresentationSummary;
  readonly alternative: RepresentationSummary;
  readonly reason: string;
  /** Conservative: switching costs at least this many bps when positive. */
  readonly conservativeCostDeltaBps: bigint;
  readonly preferredSharesEquivalent: string;
  readonly alternativeSharesEquivalent: string;
  readonly toleranceBps: bigint;
  readonly withinTolerance: boolean;
  readonly notice: string;
}

export interface RepresentationSummary {
  readonly issuer: string;
  readonly symbol: string;
  readonly mint: string;
  readonly state: RepresentationState | null;
  readonly stateSource: StateSource | null;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly reasonCode: DecisionReasonCode;
  readonly reason: string;
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState | null;
  /** Present for REQUIRES_CONSENT and USE_ALTERNATIVE only. */
  readonly disclosure: RerouteDisclosure | null;
}

export interface DecisionInput {
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState | null;
  readonly policy: ReroutePolicy;
  /** Input notional (smallest units) of the trade being decided. */
  readonly inputRaw: bigint;
  /**
   * Normalized comparison of preferred vs alternative. It must be bound to
   * this decision's underlying, both mints and `inputRaw`, or no reroute is
   * authorized.
   */
  readonly comparison: QuoteComparison | null;
}

/** Describes why a comparison does not belong to this decision, or null if it does. */
export function comparisonBindingMismatch(
  comparison: QuoteComparison,
  preferred: ResolvedRepresentationState,
  alternative: ResolvedRepresentationState,
  inputRaw: bigint,
): string | null {
  const mismatches: string[] = [];
  if (comparison.underlying !== preferred.underlying) {
    mismatches.push(`underlying ${comparison.underlying} != ${preferred.underlying}`);
  }
  if (comparison.preferredMint !== preferred.mint) {
    mismatches.push(`preferredMint ${comparison.preferredMint} != ${preferred.mint}`);
  }
  if (comparison.alternativeMint !== alternative.mint) {
    mismatches.push(`alternativeMint ${comparison.alternativeMint} != ${alternative.mint}`);
  }
  if (comparison.inputRaw !== inputRaw) mismatches.push(`inputRaw ${comparison.inputRaw} != ${inputRaw}`);
  return mismatches.length > 0 ? mismatches.join("; ") : null;
}

const NOT_IDENTICAL_NOTICE =
  "Representations from different issuers are associated with the same underlying equity but are not legally or economically identical.";

function summary(state: ResolvedRepresentationState): RepresentationSummary {
  return { issuer: state.issuer, symbol: state.symbol, mint: state.mint, state: state.state, stateSource: state.stateSource };
}

function unusable(state: ResolvedRepresentationState): "conflict" | "unknown" | null {
  if (state.stateSource === StateSource.CONFLICT) return "conflict";
  if (state.state === null || state.state === RepresentationState.UNKNOWN) return "unknown";
  return null;
}

export function decide(input: DecisionInput): DecisionResult {
  const { preferred, alternative, policy, comparison } = input;
  const result = (
    decision: Decision,
    reasonCode: DecisionReasonCode,
    reason: string,
    disclosure: RerouteDisclosure | null = null,
  ): DecisionResult => ({ decision, reasonCode, reason, preferred, alternative, disclosure });

  const preferredIssue = unusable(preferred);
  if (preferredIssue === "conflict") {
    return result(Decision.UNKNOWN_STATE, "PREFERRED_STATE_CONFLICT", `${preferred.symbol}: ${preferred.reason}`);
  }
  if (preferredIssue === "unknown") {
    return result(Decision.UNKNOWN_STATE, "PREFERRED_STATE_UNKNOWN", `${preferred.symbol}: ${preferred.reason}`);
  }
  if (preferred.state === RepresentationState.SAFE) {
    return result(Decision.USE_PREFERRED, "PREFERRED_SAFE", `${preferred.symbol} is SAFE`);
  }

  const unsafeReason = `${preferred.symbol} is ${preferred.state}: ${preferred.reason}`;
  if (!alternative) return result(Decision.NO_SAFE_ROUTE, "NO_ALTERNATIVE", `${unsafeReason}; no alternative representation`);
  if (alternative.underlying !== preferred.underlying || alternative.mint === preferred.mint) {
    return result(Decision.NO_SAFE_ROUTE, "ALTERNATIVE_NOT_SAME_UNDERLYING", `${alternative.symbol} is not an alternative representation of ${preferred.underlying}`);
  }
  const alternativeIssue = unusable(alternative);
  if (alternativeIssue === "conflict") {
    return result(Decision.UNKNOWN_STATE, "ALTERNATIVE_STATE_CONFLICT", `${unsafeReason}; ${alternative.symbol}: ${alternative.reason}`);
  }
  if (alternativeIssue === "unknown") {
    return result(Decision.UNKNOWN_STATE, "ALTERNATIVE_STATE_UNKNOWN", `${unsafeReason}; ${alternative.symbol}: ${alternative.reason}`);
  }
  if (alternative.state !== RepresentationState.SAFE) {
    return result(Decision.NO_SAFE_ROUTE, "ALTERNATIVE_NOT_SAFE", `${unsafeReason}; ${alternative.symbol} is ${alternative.state}`);
  }
  // A SAFE alternative exists, but without a normalized quote the cost of
  // switching is unknown and cannot be disclosed: not offered, even with consent.
  if (!comparison) {
    return result(Decision.UNKNOWN_STATE, "ALTERNATIVE_QUOTE_UNAVAILABLE", `${unsafeReason}; ${alternative.symbol} is SAFE but no normalized quote comparison is available`);
  }
  // A comparison computed for another trade must never authorize a reroute.
  const mismatch = comparisonBindingMismatch(comparison, preferred, alternative, input.inputRaw);
  if (mismatch) {
    return result(Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_MISMATCH", `${unsafeReason}; quote comparison does not match this decision: ${mismatch}`);
  }

  const disclosure: RerouteDisclosure = {
    underlying: preferred.underlying,
    original: summary(preferred),
    alternative: summary(alternative),
    reason: unsafeReason,
    conservativeCostDeltaBps: comparison.conservativeCostDeltaBps,
    preferredSharesEquivalent: formatRationalFloor(comparison.preferredSharesEquivalent, DISCLOSURE_SHARE_DECIMALS),
    alternativeSharesEquivalent: formatRationalFloor(comparison.alternativeSharesEquivalent, DISCLOSURE_SHARE_DECIMALS),
    toleranceBps: comparison.toleranceBps,
    withinTolerance: comparison.withinTolerance,
    notice: NOT_IDENTICAL_NOTICE,
  };
  if (!policy.allowCrossIssuerReroute) {
    return result(Decision.REQUIRES_CONSENT, "CONSENT_REQUIRED", `${unsafeReason}; ${alternative.symbol} (${alternative.issuer}) is SAFE`, disclosure);
  }
  return result(Decision.USE_ALTERNATIVE, "CONSENT_GIVEN", `${unsafeReason}; user allows cross-issuer reroute to ${alternative.symbol} (${alternative.issuer})`, disclosure);
}
