/**
 * Pure representation decision. It decides; it never executes, switches
 * assets, fetches quotes or signs anything.
 *
 * Every outcome is an expected product state returned as a value, not thrown.
 * A switch to a different issuer's representation is never silent and never
 * decided here: the most this layer returns is REQUIRES_CONSENT with an exact
 * disclosure. Only a `ConsentRecord` for that exact disclosure (consent.ts,
 * applied by `decideExecution`) turns it into USE_ALTERNATIVE. There is no
 * user preference flag in this path.
 *
 * The reroute policy's `maxAdditionalCostBps` is a hard, ONE-SIDED economic
 * bound: an alternative that costs more than it is NO_ACCEPTABLE_ROUTE /
 * ALTERNATIVE_OUTSIDE_TOLERANCE and is never offered for consent. An
 * economically better alternative always passes the bound, and still
 * requires consent: benefit never implies an automatic issuer switch.
 */

import type { EconomicEffect, QuoteComparison } from "./compare.ts";
import { economicStateMismatches, economicStateOf, type EconomicState } from "./economic-state.ts";
import { formatRationalFloor } from "./normalize.ts";
import { canonicalKey } from "./quote-identity.ts";
import { sha256Hex } from "./sha256.ts";
import { RepresentationState, StateSource, type ResolvedRepresentationState } from "./types.ts";

export const Decision = {
  USE_PREFERRED: "USE_PREFERRED",
  REQUIRES_CONSENT: "REQUIRES_CONSENT",
  USE_ALTERNATIVE: "USE_ALTERNATIVE",
  NO_SAFE_ROUTE: "NO_SAFE_ROUTE",
  /** A SAFE, quoted alternative exists but its economics are above the maximum additional cost of the reroute policy. */
  NO_ACCEPTABLE_ROUTE: "NO_ACCEPTABLE_ROUTE",
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
  | "QUOTE_COMPARISON_STALE_STATE"
  | "ALTERNATIVE_OUTSIDE_TOLERANCE"
  | "CONSENT_REQUIRED"
  | "CONSENT_GIVEN";

/**
 * Integrator reroute policy. `maxAdditionalCostBps` is the HARD maximum
 * additional economic cost of switching: `additionalCostBps` must be at most
 * this (a better alternative, with negative cost, always passes). User consent
 * cannot lift it.
 */
export interface ReroutePolicy {
  readonly maxAdditionalCostBps: bigint;
}

/** Share-equivalent display precision; values are rounded down for display only. */
const DISCLOSURE_SHARE_DECIMALS = 12;

export interface RerouteDisclosure {
  readonly underlying: string;
  readonly original: RepresentationSummary;
  readonly alternative: RepresentationSummary;
  readonly reason: string;
  /** Conservative: switching costs at least this many bps when positive. */
  readonly additionalCostBps: bigint;
  readonly preferredSharesEquivalent: string;
  readonly alternativeSharesEquivalent: string;
  /** Whether the alternative costs more, is equal, or is better, and by how many bps. */
  readonly economicEffect: EconomicEffect;
  readonly notice: string;
  /** The exact comparison this disclosure (and any consent to it) describes. */
  readonly comparisonKey: string;
  readonly inputRaw: bigint;
  /** Hard policy bound the disclosed cost was checked against. */
  readonly policyMaxAdditionalCostBps: bigint;
  /** SHA-256 of the canonical disclosure content above; what a consent record binds. */
  readonly disclosureDigest: string;
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
  /** Present for REQUIRES_CONSENT and (consent layer) USE_ALTERNATIVE only. */
  readonly disclosure: RerouteDisclosure | null;
}

export interface DecisionInput {
  readonly preferred: ResolvedRepresentationState;
  readonly alternative: ResolvedRepresentationState | null;
  readonly reroutePolicy: ReroutePolicy;
  /** Input notional (smallest units) of the trade being decided. */
  readonly inputRaw: bigint;
  /**
   * Normalized comparison of preferred vs alternative. It must be bound to
   * this decision's underlying, both mints and `inputRaw`, and to the exact
   * economic state of both resolved representations, or no reroute is
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

/**
 * Describes why a comparison was built against a different economic state
 * than the resolved representations carry, or null if both states match.
 * A representation without a decoded chain state cannot match.
 */
export function comparisonStateMismatch(
  comparison: QuoteComparison,
  preferred: ResolvedRepresentationState,
  alternative: ResolvedRepresentationState,
): string | null {
  const mismatches: string[] = [];
  const check = (role: string, bound: EconomicState, state: ResolvedRepresentationState) => {
    const current = economicStateOf(state.chainObservation);
    if (!current) mismatches.push(`${role} ${state.symbol}: no decoded chain state to bind`);
    else mismatches.push(...economicStateMismatches(bound, current).map((m) => `${role} ${state.symbol}: ${m}`));
  };
  check("preferred", comparison.preferredQuote.state, preferred);
  check("alternative", comparison.alternativeQuote.state, alternative);
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
  const { preferred, alternative, reroutePolicy, comparison } = input;
  if (typeof reroutePolicy.maxAdditionalCostBps !== "bigint" || reroutePolicy.maxAdditionalCostBps < 0n) {
    throw new RangeError("reroute policy maxAdditionalCostBps must be a non-negative bigint");
  }
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
  // Economics normalized against another state are stale: recompute, never reuse.
  const stale = comparisonStateMismatch(comparison, preferred, alternative);
  if (stale) {
    return result(Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_STALE_STATE", `${unsafeReason}; quote comparison was built against a different economic state and must be recomputed: ${stale}`);
  }

  // Hard one-sided economic bound: never offer an alternative outside it, whatever consent might say later.
  const outside = exceedsCostLimit(comparison, reroutePolicy);
  if (outside) {
    return result(Decision.NO_ACCEPTABLE_ROUTE, "ALTERNATIVE_OUTSIDE_TOLERANCE", `${unsafeReason}; ${alternative.symbol} is SAFE but ${outside}`);
  }

  return result(Decision.REQUIRES_CONSENT, "CONSENT_REQUIRED", `${unsafeReason}; ${alternative.symbol} (${alternative.issuer}) is SAFE`, disclosureFor(preferred, alternative, unsafeReason, comparison, input.inputRaw, reroutePolicy));
}

/**
 * Why a comparison is economically unacceptable under the hard one-sided
 * policy, or null. Only additional cost counts: `additionalCostBps <=
 * maxAdditionalCostBps`, never an absolute difference.
 */
export function exceedsCostLimit(comparison: QuoteComparison, policy: ReroutePolicy): string | null {
  if (comparison.alternativeQuote.outputRaw <= 0n) return "the alternative quote delivers nothing";
  if (comparison.additionalCostBps > policy.maxAdditionalCostBps) {
    return `switching costs ${comparison.additionalCostBps} bps more, above the ${policy.maxAdditionalCostBps} bps maximum additional cost`;
  }
  return null;
}

function disclosureFor(
  preferred: ResolvedRepresentationState,
  alternative: ResolvedRepresentationState,
  reason: string,
  comparison: QuoteComparison,
  inputRaw: bigint,
  policy: ReroutePolicy,
): RerouteDisclosure {
  const content = {
    underlying: preferred.underlying,
    original: summary(preferred),
    alternative: summary(alternative),
    reason,
    additionalCostBps: comparison.additionalCostBps,
    preferredSharesEquivalent: formatRationalFloor(comparison.preferredSharesEquivalent, DISCLOSURE_SHARE_DECIMALS),
    alternativeSharesEquivalent: formatRationalFloor(comparison.alternativeSharesEquivalent, DISCLOSURE_SHARE_DECIMALS),
    economicEffect: comparison.economicEffect,
    notice: NOT_IDENTICAL_NOTICE,
    comparisonKey: comparison.comparisonKey,
    inputRaw,
    policyMaxAdditionalCostBps: policy.maxAdditionalCostBps,
  };
  return { ...content, disclosureDigest: disclosureDigestOf(content) };
}

/** SHA-256 of a disclosure's canonical content (everything but the digest itself). */
export function disclosureDigestOf(disclosure: Omit<RerouteDisclosure, "disclosureDigest">): string {
  const { disclosureDigest: _ignored, ...content } = disclosure as RerouteDisclosure;
  return sha256Hex(canonicalKey(content));
}
