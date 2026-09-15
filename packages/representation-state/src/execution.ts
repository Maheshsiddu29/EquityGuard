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
 */

import type { NormalizedQuote, QuoteComparison } from "./compare.ts";
import { Decision, decide, type DecisionInput, type DecisionResult, type RepresentationSummary } from "./decision.ts";
import { economicStateMismatches, economicStateOf } from "./economic-state.ts";
import { quoteIdentityOf, quoteMismatches, type QuoteIdentity, type QuoteMismatch } from "./quote-identity.ts";
import type { ResolvedRepresentationState } from "./types.ts";

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

export function decideExecution(input: ExecutionInput): ExecutionDecision {
  const stateDecision = decide(input);
  const { preferred, alternative } = stateDecision;
  const preferredRoute = routeFor(input.routes.preferred, preferred);
  const alternativeRoute = routeFor(input.routes.alternative, alternative);
  const result = (
    executionEligibility: ExecutionEligibility,
    executionReason: string,
    fields: Partial<Pick<ExecutionDecision, "selectedRepresentation" | "selectedRouteAvailable" | "quoteAvailable" | "executableQuote" | "quoteMismatches">> = {},
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
  });

  switch (stateDecision.decision) {
    case Decision.USE_PREFERRED: {
      const selectedRepresentation = summary(preferred);
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
      return result(ExecutionEligibility.EXECUTABLE, `${preferred.symbol} is SAFE, routable, and quoted against its current state`, { ...fields, executableQuote: quoteIdentityOf(quote) });
    }
    case Decision.USE_ALTERNATIVE: {
      // `decide` already verified the comparison's identity and state binding.
      const chosen = alternative as ResolvedRepresentationState;
      const selectedRepresentation = summary(chosen);
      const comparison = input.comparison as QuoteComparison;
      if (!alternativeRoute || alternativeRoute.status !== "AVAILABLE") {
        return result(ExecutionEligibility.ROUTE_UNAVAILABLE, `${chosen.symbol} has no available route`, { selectedRepresentation, selectedRouteAvailable: false, quoteAvailable: true });
      }
      if (!alternativeRoute.quote) {
        return result(ExecutionEligibility.QUOTE_UNAVAILABLE, `${chosen.symbol} is routable but the route carries no quote to execute`, { selectedRepresentation, selectedRouteAvailable: true });
      }
      // The route's quote must be exactly the quote that was normalized, compared and disclosed.
      const substituted = quoteMismatches(comparison.alternativeQuote, alternativeRoute.quote);
      const fields = { selectedRepresentation, selectedRouteAvailable: true, quoteAvailable: true };
      if (substituted.length > 0) {
        return result(ExecutionEligibility.QUOTE_MISMATCH, `${chosen.symbol} route quote is not the compared quote: ${substituted.map((m) => m.code).join(", ")}`, { ...fields, quoteMismatches: substituted });
      }
      return result(ExecutionEligibility.EXECUTABLE, `consented reroute to ${chosen.symbol}: SAFE, routable, and the route quote is the compared quote`, {
        ...fields,
        executableQuote: comparison.alternativeQuote,
      });
    }
    case Decision.REQUIRES_CONSENT:
      return result(ExecutionEligibility.CONSENT_REQUIRED, "a disclosed cross-issuer reroute needs explicit consent before anything can be built", { quoteAvailable: true });
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
