/**
 * Execution eligibility: whether a transaction can actually be built now.
 *
 * `decide` answers which representation is acceptable given representation
 * STATE; it knows nothing about liquidity. This layer combines that state
 * decision with route availability, quote availability, the state binding of
 * quotes and consent, and never reports a result as executable unless the
 * selected representation has an available route and a quote bound to its
 * exact current economic state. It is pure: it fetches, builds and signs
 * nothing.
 *
 * Consent is applied here, not in `decide`: a REQUIRES_CONSENT decision
 * becomes USE_ALTERNATIVE only with a `ConsentRecord` that authorizes that
 * exact disclosure, comparison and slot (it is consumed later, by
 * `createExecutionPlan`).
 */

import type { NormalizedQuote, QuoteComparison } from "./compare.ts";
import { consentIssues, type ConsentIssue, type ConsentRecord } from "./consent.ts";
import { Decision, decide, exceedsCostLimit, type DecisionInput, type DecisionResult, type RepresentationSummary } from "./decision.ts";
import { economicStateMismatches, economicStateOf } from "./economic-state.ts";
import { quoteIdentityOf, quoteMismatches, type QuoteIdentity, type QuoteMismatch } from "./quote-identity.ts";
import { canonicalKey } from "./quote-identity.ts";
import type { ResolvedRepresentationState, TransitionPolicy } from "./types.ts";

export const ExecutionEligibility = {
  /** A transaction for the selected representation can be built now. */
  EXECUTABLE: "EXECUTABLE",
  /** The representation that would be used has no available route. */
  ROUTE_UNAVAILABLE: "ROUTE_UNAVAILABLE",
  /** A route exists but no usable quote does. */
  QUOTE_UNAVAILABLE: "QUOTE_UNAVAILABLE",
  /** No SAFE eligible representation exists. */
  STATE_UNSAFE: "STATE_UNSAFE",
  /** A required state is UNKNOWN or conflicting. */
  STATE_UNKNOWN: "STATE_UNKNOWN",
  /** A reroute is available but the user has not consented. */
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  /** A consent record was presented but does not authorize this exact reroute; `consentIssues` says why. */
  CONSENT_INVALID: "CONSENT_INVALID",
  /** The transition policy that classified the selected state is missing or differs between representations. */
  POLICY_MISMATCH: "POLICY_MISMATCH",
  /** A SAFE, quoted alternative exists but costs more than the reroute policy's maximum additional cost. */
  ALTERNATIVE_OUTSIDE_TOLERANCE: "ALTERNATIVE_OUTSIDE_TOLERANCE",
  /** A quote or comparison was built against a different economic state. */
  STALE_COMPARISON: "STALE_COMPARISON",
  /**
   * A quote or comparison belongs to a different trade (mint, underlying or
   * notional), or the route's quote is not the exact quote the comparison
   * was built from; `quoteMismatches` carries the precise reasons.
   */
  QUOTE_MISMATCH: "QUOTE_MISMATCH",
} as const;
export type ExecutionEligibility = (typeof ExecutionEligibility)[keyof typeof ExecutionEligibility];

export type RouteStatus = "AVAILABLE" | "UNAVAILABLE";

/** Route availability for one representation at one point in time. */
export interface RouteObservation {
  readonly mint: string;
  readonly status: RouteStatus;
  /** Quote normalized against the state it was observed at; null when no usable quote exists. */
  readonly quote: NormalizedQuote | null;
  /** Where availability came from, e.g. a route discovery snapshot or a demo fixture. */
  readonly source: string;
  readonly detail: string | null;
}

export interface ExecutionInput extends DecisionInput {
  readonly routes: { readonly preferred: RouteObservation | null; readonly alternative: RouteObservation | null };
  /** Consent to one exact disclosure; null when the user has not accepted one. */
  readonly consent: ConsentRecord | null;
  /** Chain slot of this evaluation; consent expiry is checked against it. */
  readonly currentSlot: bigint;
}

export interface ExecutionDecision {
  /** The state-level choice, unchanged from `decide`. */
  readonly stateDecision: DecisionResult;
  readonly comparison: QuoteComparison | null;
  readonly executionEligibility: ExecutionEligibility;
  readonly executionReason: string;
  /** Representation a transaction would use; null when the state decision selects none. */
  readonly selectedRepresentation: RepresentationSummary | null;
  /** Null when nothing is selected. */
  readonly selectedRouteAvailable: boolean | null;
  /** Whether a quote usable for the selected (or proposed) representation exists. */
  readonly quoteAvailable: boolean;
  readonly consentRequired: boolean;
  /**
   * The exact quote (route, raw amounts, economic state) execution must use;
   * non-null only when EXECUTABLE. Its `state` is what the guard asserts.
   */
  readonly executableQuote: QuoteIdentity | null;
  /** Precise reasons when a presented quote differs from the bound one. */
  readonly quoteMismatches: readonly QuoteMismatch[];
  /** The consent that turned REQUIRES_CONSENT into USE_ALTERNATIVE; null otherwise. */
  readonly consent: ConsentRecord | null;
  /** Why a presented consent was not accepted. */
  readonly consentIssues: readonly ConsentIssue[];
  readonly reroutePolicy: DecisionInput["reroutePolicy"];
  readonly currentSlot: bigint;
  /**
   * The transition policy the selected state was classified under; non-null
   * whenever EXECUTABLE. The plan and the guard's window are built from it.
   */
  readonly transitionPolicy: TransitionPolicy | null;
}

export type ExecutableDecision = ExecutionDecision & {
  readonly executionEligibility: "EXECUTABLE";
  readonly selectedRepresentation: RepresentationSummary;
  readonly executableQuote: QuoteIdentity;
};

export class ExecutionEligibilityError extends Error {
  readonly eligibility: ExecutionEligibility | null;

  constructor(eligibility: ExecutionEligibility | null, message: string) {
    super(message);
    this.name = "ExecutionEligibilityError";
    this.eligibility = eligibility;
  }
}

function summary(state: ResolvedRepresentationState): RepresentationSummary {
  return { issuer: state.issuer, symbol: state.symbol, mint: state.mint, state: state.state, stateSource: state.stateSource };
}

function routeFor(route: RouteObservation | null, representation: ResolvedRepresentationState | null): RouteObservation | null {
  return route && representation && route.mint === representation.mint ? route : null;
}

/** Applies a presented consent to a REQUIRES_CONSENT decision; the state layer itself never sees consent. */
function applyConsent(base: DecisionResult, input: ExecutionInput): { stateDecision: DecisionResult; consent: ConsentRecord | null; issues: readonly ConsentIssue[] } {
  if (base.decision !== Decision.REQUIRES_CONSENT || !input.consent || !input.comparison) return { stateDecision: base, consent: null, issues: [] };
  const issues = consentIssues(input.consent, { decision: base, comparison: input.comparison, reroutePolicy: input.reroutePolicy, currentSlot: input.currentSlot });
  if (issues.length > 0) return { stateDecision: base, consent: null, issues };
  const consent = input.consent;
  return {
    stateDecision: {
      ...base,
      decision: Decision.USE_ALTERNATIVE,
      reasonCode: "CONSENT_GIVEN",
      reason: `${base.reason}; consent ${consent.consentId.slice(0, 12)}… accepts this exact disclosure (${consent.additionalCostBps} bps, max ${consent.maxAdditionalCostBps} bps, until slot ${consent.expiresAtSlot})`,
    },
    consent,
    issues: [],
  };
}

export function decideExecution(input: ExecutionInput): ExecutionDecision {
  const applied = applyConsent(decide(input), input);
  const { stateDecision } = applied;
  const { preferred, alternative } = stateDecision;
  const preferredRoute = routeFor(input.routes.preferred, preferred);
  const alternativeRoute = routeFor(input.routes.alternative, alternative);
  const result = (
    executionEligibility: ExecutionEligibility,
    executionReason: string,
    fields: Partial<Pick<ExecutionDecision, "selectedRepresentation" | "selectedRouteAvailable" | "quoteAvailable" | "executableQuote" | "quoteMismatches" | "transitionPolicy">> = {},
  ): ExecutionDecision => ({
    stateDecision,
    comparison: input.comparison,
    executionEligibility,
    executionReason,
    selectedRepresentation: fields.selectedRepresentation ?? null,
    selectedRouteAvailable: fields.selectedRouteAvailable ?? null,
    quoteAvailable: fields.quoteAvailable ?? false,
    consentRequired: stateDecision.decision === Decision.REQUIRES_CONSENT,
    executableQuote: fields.executableQuote ?? null,
    quoteMismatches: fields.quoteMismatches ?? [],
    consent: applied.consent,
    consentIssues: applied.issues,
    reroutePolicy: input.reroutePolicy,
    currentSlot: input.currentSlot,
    transitionPolicy: fields.transitionPolicy ?? null,
  });

  switch (stateDecision.decision) {
    case Decision.USE_PREFERRED: {
      const selectedRepresentation = summary(preferred);
      // API or historical evidence is never executable economic state: live chain state is required.
      if (!economicStateOf(preferred.chainObservation)) {
        return result(ExecutionEligibility.STATE_UNKNOWN, `${preferred.symbol} has no authoritative live chain state (state source ${preferred.stateSource})`, { selectedRepresentation });
      }
      if (!preferredRoute || preferredRoute.status !== "AVAILABLE") {
        return result(ExecutionEligibility.ROUTE_UNAVAILABLE, `${preferred.symbol} is SAFE but has no available route${preferredRoute?.detail ? `: ${preferredRoute.detail}` : ""}`, { selectedRepresentation, selectedRouteAvailable: false });
      }
      const quote = preferredRoute.quote;
      if (!quote) {
        return result(ExecutionEligibility.QUOTE_UNAVAILABLE, `${preferred.symbol} is SAFE and routable but no usable quote exists`, { selectedRepresentation, selectedRouteAvailable: true });
      }
      const fields = { selectedRepresentation, selectedRouteAvailable: true, quoteAvailable: true };
      if (quote.mint !== preferred.mint || quote.underlying !== preferred.underlying || quote.inputRaw !== input.inputRaw) {
        return result(ExecutionEligibility.QUOTE_MISMATCH, `${preferred.symbol} quote does not belong to this trade`, fields);
      }
      const current = economicStateOf(preferred.chainObservation);
      const stale = current ? economicStateMismatches(quote.state, current) : ["no decoded chain state to bind"];
      if (stale.length > 0) {
        return result(ExecutionEligibility.STALE_COMPARISON, `${preferred.symbol} quote was built against a different economic state: ${stale.join("; ")}`, fields);
      }
      if (!preferred.transitionPolicy) {
        return result(ExecutionEligibility.POLICY_MISMATCH, `${preferred.symbol} has no transition policy bound to its classification`, fields);
      }
      return result(ExecutionEligibility.EXECUTABLE, `${preferred.symbol} is SAFE, routable, and quoted against its current state`, { ...fields, executableQuote: quoteIdentityOf(quote), transitionPolicy: preferred.transitionPolicy });
    }
    case Decision.USE_ALTERNATIVE: {
      // `decide` already verified the comparison's identity and state binding.
      const chosen = alternative as ResolvedRepresentationState;
      const selectedRepresentation = summary(chosen);
      if (!economicStateOf(chosen.chainObservation) || !economicStateOf(preferred.chainObservation)) {
        return result(ExecutionEligibility.STATE_UNKNOWN, "a reroute needs authoritative live chain state for both representations", { selectedRepresentation });
      }
      const comparison = input.comparison as QuoteComparison;
      if (!alternativeRoute || alternativeRoute.status !== "AVAILABLE") {
        return result(ExecutionEligibility.ROUTE_UNAVAILABLE, `${chosen.symbol} has no available route`, { selectedRepresentation, selectedRouteAvailable: false, quoteAvailable: true });
      }
      if (!alternativeRoute.quote) {
        return result(ExecutionEligibility.QUOTE_UNAVAILABLE, `${chosen.symbol} is routable but the route carries no quote to execute`, { selectedRepresentation, selectedRouteAvailable: true });
      }
      // Defense in depth: the one-sided policy limit and the accepted maximum still hold.
      const consent = applied.consent as ConsentRecord;
      const outside = exceedsCostLimit(comparison, input.reroutePolicy) ?? (comparison.additionalCostBps > consent.maxAdditionalCostBps ? "cost above the accepted maximum" : null);
      if (outside) {
        return result(ExecutionEligibility.ALTERNATIVE_OUTSIDE_TOLERANCE, `${chosen.symbol}: ${outside}`, { selectedRepresentation, quoteAvailable: true });
      }
      // The route's quote must be exactly the quote that was normalized, compared and disclosed.
      const substituted = quoteMismatches(comparison.alternativeQuote, alternativeRoute.quote);
      const fields = { selectedRepresentation, selectedRouteAvailable: true, quoteAvailable: true };
      if (substituted.length > 0) {
        return result(ExecutionEligibility.QUOTE_MISMATCH, `${chosen.symbol} route quote is not the compared quote: ${substituted.map((m) => m.code).join(", ")}`, { ...fields, quoteMismatches: substituted });
      }
      // Both states must have been classified under one and the same transition policy.
      if (!chosen.transitionPolicy || !preferred.transitionPolicy || canonicalKey(chosen.transitionPolicy) !== canonicalKey(preferred.transitionPolicy)) {
        return result(ExecutionEligibility.POLICY_MISMATCH, `${preferred.symbol} and ${chosen.symbol} were not classified under the same transition policy`, fields);
      }
      return result(ExecutionEligibility.EXECUTABLE, `consented reroute to ${chosen.symbol}: SAFE, routable, and the route quote is the compared quote`, {
        ...fields,
        executableQuote: comparison.alternativeQuote,
        transitionPolicy: chosen.transitionPolicy,
      });
    }
    case Decision.REQUIRES_CONSENT:
      return applied.issues.length > 0
        ? result(ExecutionEligibility.CONSENT_INVALID, `presented consent does not authorize this reroute: ${applied.issues.map((i) => i.code).join(", ")}`, { quoteAvailable: true })
        : result(ExecutionEligibility.CONSENT_REQUIRED, "a disclosed cross-issuer reroute needs consent to this exact disclosure before anything can be built", { quoteAvailable: true });
    case Decision.NO_ACCEPTABLE_ROUTE:
      return result(ExecutionEligibility.ALTERNATIVE_OUTSIDE_TOLERANCE, stateDecision.reason, { quoteAvailable: true });
    case Decision.NO_SAFE_ROUTE:
      return result(ExecutionEligibility.STATE_UNSAFE, stateDecision.reason);
    case Decision.UNKNOWN_STATE:
      switch (stateDecision.reasonCode) {
        case "ALTERNATIVE_QUOTE_UNAVAILABLE":
          return !alternativeRoute || alternativeRoute.status !== "AVAILABLE"
            ? result(ExecutionEligibility.ROUTE_UNAVAILABLE, `${alternative?.symbol} has no available route; no normalized comparison exists`)
            : result(ExecutionEligibility.QUOTE_UNAVAILABLE, `${alternative?.symbol} is routable but no normalized comparison exists`);
        case "QUOTE_COMPARISON_MISMATCH":
          return result(ExecutionEligibility.QUOTE_MISMATCH, stateDecision.reason, { quoteAvailable: true });
        case "QUOTE_COMPARISON_STALE_STATE":
          return result(ExecutionEligibility.STALE_COMPARISON, stateDecision.reason, { quoteAvailable: true });
        default:
          return result(ExecutionEligibility.STATE_UNKNOWN, stateDecision.reason);
      }
  }
}

/**
 * Runtime execution gate. Anything that builds or submits a transaction must
 * call this first; it throws unless the decision is EXECUTABLE.
 */
export function assertExecutable(decision: ExecutionDecision): asserts decision is ExecutableDecision {
  if (decision.executionEligibility !== ExecutionEligibility.EXECUTABLE || !decision.selectedRepresentation || !decision.executableQuote) {
    throw new ExecutionEligibilityError(decision.executionEligibility, `refusing to execute: ${decision.executionEligibility} (${decision.executionReason})`);
  }
  if (decision.executableQuote.mint !== decision.selectedRepresentation.mint || decision.executableQuote.state.mint !== decision.selectedRepresentation.mint) {
    throw new ExecutionEligibilityError(decision.executionEligibility, "refusing to execute: executable quote is for a different mint");
  }
}
