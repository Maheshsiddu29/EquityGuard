/**
 * Immutable execution plan: the single artifact an executor consumes.
 *
 * A plan can only be created from an EXECUTABLE decision in a submit-capable
 * environment (DEVNET_EXECUTION). It pins the exact selected quote (route,
 * raw input/output, minimum output, quote context), the economic state the
 * guard must assert, the decision, and — for a consented reroute — the
 * comparison and disclosure the user consented to. `verifyExecutionPlan`
 * fails closed with precise codes when the plan was altered, or when the
 * quote or comparison presented at execution time is not the planned one.
 */

import type { QuoteComparison } from "./compare.ts";
import { Decision, type DecisionReasonCode, type RepresentationSummary, type RerouteDisclosure } from "./decision.ts";
import type { ExecutionEnvironment } from "./demo-result.ts";
import type { EconomicState } from "./economic-state.ts";
import { ExecutionEligibilityError, assertExecutable, type ExecutionDecision } from "./execution.ts";
import { canonicalKey, quoteIdentityOf, quoteKey, quoteMismatches, type QuoteIdentity, type QuoteMismatch, type RouteIdentity } from "./quote-identity.ts";

export interface ExecutionPlanContent {
  readonly environment: "DEVNET_EXECUTION";
  readonly selectedRepresentation: RepresentationSummary;
  readonly quote: QuoteIdentity;
  readonly quoteKey: string;
  /** What the guard asserts; always `quote.state`. */
  readonly economicState: EconomicState;
  readonly inputRaw: bigint;
  readonly expectedOutputRaw: bigint;
  readonly minOutputRaw: bigint | null;
  readonly route: RouteIdentity;
  readonly decision: Decision;
  readonly reasonCode: DecisionReasonCode;
  readonly executionEligibility: "EXECUTABLE";
  /** Present for a consented reroute: the comparison consent was given to. */
  readonly comparisonKey: string | null;
  readonly disclosure: RerouteDisclosure | null;
}

export interface ExecutionPlan extends ExecutionPlanContent {
  /** Canonical key of the content; any alteration changes it. */
  readonly planId: string;
}

export type ExecutionPlanErrorCode =
  | "NOT_EXECUTABLE"
  | "OBSERVATION_ONLY_ENVIRONMENT"
  | "PLAN_TAMPERED"
  | "QUOTE_SUBSTITUTED"
  | "COMPARISON_NOT_FOR_PLAN"
  | "DISCLOSURE_NOT_FOR_COMPARISON";

export class ExecutionPlanError extends Error {
  readonly code: ExecutionPlanErrorCode;
  readonly mismatches: readonly QuoteMismatch[];

  constructor(code: ExecutionPlanErrorCode, message: string, mismatches: readonly QuoteMismatch[] = []) {
    super(`${code}: ${message}`);
    this.name = "ExecutionPlanError";
    this.code = code;
    this.mismatches = mismatches;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function contentOf(plan: ExecutionPlan): ExecutionPlanContent {
  const { planId: _planId, ...content } = plan;
  return content;
}

/**
 * Creates the plan. Refuses any environment other than DEVNET_EXECUTION — a
 * MAINNET_OBSERVATION result can describe eligibility but never becomes a
 * submit-capable plan — and anything but an EXECUTABLE decision.
 */
export function createExecutionPlan(decision: ExecutionDecision, environment: ExecutionEnvironment): ExecutionPlan {
  if (environment !== "DEVNET_EXECUTION") {
    throw new ExecutionPlanError("OBSERVATION_ONLY_ENVIRONMENT", `${environment} results cannot produce a submit-capable execution plan`);
  }
  try {
    assertExecutable(decision);
  } catch (error) {
    if (error instanceof ExecutionEligibilityError) throw new ExecutionPlanError("NOT_EXECUTABLE", error.message);
    throw error;
  }
  const { stateDecision, comparison } = decision;
  const rerouted = stateDecision.decision === Decision.USE_ALTERNATIVE;
  if (rerouted && (!comparison || stateDecision.disclosure?.comparisonKey !== comparison.comparisonKey)) {
    throw new ExecutionPlanError("DISCLOSURE_NOT_FOR_COMPARISON", "a consented reroute needs the disclosure of the exact comparison");
  }
  const quote = quoteIdentityOf(decision.executableQuote);
  const content: ExecutionPlanContent = {
    environment,
    selectedRepresentation: decision.selectedRepresentation,
    quote,
    quoteKey: quoteKey(quote),
    economicState: quote.state,
    inputRaw: quote.inputRaw,
    expectedOutputRaw: quote.outputRaw,
    minOutputRaw: quote.minOutputRaw,
    route: quote.route,
    decision: stateDecision.decision,
    reasonCode: stateDecision.reasonCode,
    executionEligibility: "EXECUTABLE",
    comparisonKey: rerouted ? (comparison as QuoteComparison).comparisonKey : null,
    disclosure: rerouted ? stateDecision.disclosure : null,
  };
  // Structured clone detaches the plan from caller-owned objects before freezing.
  return deepFreeze(structuredClone({ ...content, planId: canonicalKey(content) }));
}

/**
 * Execution-time check; call before building anything. `quote` is the quote
 * the downstream builder is about to execute; `comparison` is required for a
 * consented reroute and must be the one the plan was made from.
 */
export function verifyExecutionPlan(
  plan: ExecutionPlan,
  presented: { readonly quote: QuoteIdentity; readonly comparison: QuoteComparison | null },
): void {
  const content = contentOf(plan);
  if (canonicalKey(content) !== plan.planId) throw new ExecutionPlanError("PLAN_TAMPERED", "plan content does not match its planId");
  if (
    plan.environment !== "DEVNET_EXECUTION" ||
    plan.executionEligibility !== "EXECUTABLE" ||
    plan.quoteKey !== quoteKey(plan.quote) ||
    canonicalKey(plan.economicState) !== canonicalKey(plan.quote.state) ||
    plan.inputRaw !== plan.quote.inputRaw ||
    plan.expectedOutputRaw !== plan.quote.outputRaw ||
    plan.minOutputRaw !== plan.quote.minOutputRaw ||
    canonicalKey(plan.route) !== canonicalKey(plan.quote.route) ||
    plan.selectedRepresentation.mint !== plan.quote.mint
  ) {
    throw new ExecutionPlanError("PLAN_TAMPERED", "plan fields are inconsistent with the planned quote");
  }
  const substituted = quoteMismatches(plan.quote, presented.quote);
  if (substituted.length > 0) {
    throw new ExecutionPlanError("QUOTE_SUBSTITUTED", `presented quote is not the planned quote: ${substituted.map((m) => m.code).join(", ")}`, substituted);
  }
  if (plan.comparisonKey !== null) {
    if (!presented.comparison || presented.comparison.comparisonKey !== plan.comparisonKey) {
      throw new ExecutionPlanError("COMPARISON_NOT_FOR_PLAN", "presented comparison is not the one consent was given to");
    }
    if (plan.disclosure?.comparisonKey !== plan.comparisonKey) {
      throw new ExecutionPlanError("DISCLOSURE_NOT_FOR_COMPARISON", "plan disclosure does not describe the planned comparison");
    }
    const alternative = quoteMismatches(presented.comparison.alternativeQuote, plan.quote);
    if (alternative.length > 0) {
      throw new ExecutionPlanError("COMPARISON_NOT_FOR_PLAN", "comparison's alternative quote is not the planned quote", alternative);
    }
  }
}
