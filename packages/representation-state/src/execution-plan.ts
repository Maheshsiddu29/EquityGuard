/**
 * Execution plan: the single artifact an executor consumes.
 *
 * A plan can only be created from an EXECUTABLE decision in a submit-capable
 * environment (DEVNET_EXECUTION). It pins the exact selected quote (route,
 * raw input/output, minimum output, quote context), the economic state and
 * the transition policy the guard must assert (the same policy that
 * classified the state), the decision, the consent and disclosure for a
 * reroute, and an explicit slot-based freshness window.
 *
 * Authenticity is runtime provenance, not content: only `createExecutionPlan`
 * registers a plan (module-private WeakSet), so hand-built, copied or
 * deserialized plans are rejected even when they are internally consistent.
 * Plans are deep-frozen and single-use: `consumeExecutionPlan` marks a plan
 * consumed before anything is signed, and a consumed plan is never accepted
 * again.
 *
 * `planDigest` is SHA-256 over the canonical content. It is a stable
 * commitment (logs, evidence, a future on-chain commitment), NOT
 * authentication: anyone can compute it.
 */

import type { QuoteComparison } from "./compare.ts";
import { ConsentError, consumeConsent } from "./consent.ts";
import { Decision, type DecisionReasonCode, type RepresentationSummary, type RerouteDisclosure } from "./decision.ts";
import type { ExecutionEnvironment } from "./demo-result.ts";
import type { EconomicState } from "./economic-state.ts";
import { ExecutionEligibilityError, assertExecutable, type ExecutionDecision } from "./execution.ts";
import type { TransitionPolicy } from "./types.ts";
import { canonicalKey, quoteIdentityOf, quoteKey, quoteMismatches, type QuoteIdentity, type QuoteMismatch, type RouteIdentity } from "./quote-identity.ts";
import { sha256Hex } from "./sha256.ts";

/** How long a plan stays executable, in slots after the slot it was created at. Explicit per executor. */
export interface PlanFreshnessPolicy {
  readonly validForSlots: bigint;
}

export interface ExecutionPlanContent {
  readonly environment: "DEVNET_EXECUTION";
  readonly selectedRepresentation: RepresentationSummary;
  readonly quote: QuoteIdentity;
  readonly quoteKey: string;
  /** What the guard asserts; always `quote.state`. */
  readonly economicState: EconomicState;
  /** The transition policy the state was classified under; the guard window is built from it. */
  readonly policy: TransitionPolicy;
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
  /** Present for a consented reroute: the consumed consent record. */
  readonly consentId: string | null;
  readonly createdAtSlot: bigint;
  /** Last slot at which the plan may be signed (inclusive). */
  readonly expiresAtSlot: bigint;
}

export interface ExecutionPlan extends ExecutionPlanContent {
  /** SHA-256 of the canonical content: a commitment, not authentication. */
  readonly planDigest: string;
}

export type ExecutionPlanErrorCode =
  | "NOT_EXECUTABLE"
  | "OBSERVATION_ONLY_ENVIRONMENT"
  | "PLAN_NOT_ISSUED"
  | "PLAN_CONSUMED"
  | "PLAN_EXPIRED"
  | "PLAN_TAMPERED"
  | "QUOTE_SUBSTITUTED"
  | "COMPARISON_NOT_FOR_PLAN"
  | "DISCLOSURE_NOT_FOR_COMPARISON"
  | "CONSENT_REJECTED"
  | "INVALID_FRESHNESS"
  | "POLICY_MISMATCH";

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

const issuedPlans = new WeakSet<object>();
const consumedPlans = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function contentOf(plan: ExecutionPlan): ExecutionPlanContent {
  const { planDigest: _digest, ...content } = plan;
  return content;
}

export function planDigestOf(content: ExecutionPlanContent): string {
  return sha256Hex(canonicalKey(content));
}

/**
 * Creates and registers the plan. Refuses any environment other than
 * DEVNET_EXECUTION — a MAINNET_OBSERVATION result can describe eligibility
 * but never becomes a plan — and anything but an EXECUTABLE decision. A
 * reroute's consent is re-verified and consumed here.
 */
export function createExecutionPlan(
  decision: ExecutionDecision,
  environment: ExecutionEnvironment,
  options: { readonly currentSlot: bigint; readonly freshness: PlanFreshnessPolicy },
): ExecutionPlan {
  if (environment !== "DEVNET_EXECUTION") {
    throw new ExecutionPlanError("OBSERVATION_ONLY_ENVIRONMENT", `${environment} results cannot produce a submit-capable execution plan`);
  }
  if (typeof options.freshness?.validForSlots !== "bigint" || options.freshness.validForSlots <= 0n || typeof options.currentSlot !== "bigint") {
    throw new ExecutionPlanError("INVALID_FRESHNESS", "an explicit positive bigint validForSlots and currentSlot are required");
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
  if (!decision.transitionPolicy) {
    throw new ExecutionPlanError("POLICY_MISMATCH", "an executable decision must carry the transition policy its state was classified under");
  }
  if (rerouted) {
    // Re-verify against the REQUIRES_CONSENT form of this decision and consume: one consent, one plan.
    if (!decision.consent) throw new ExecutionPlanError("CONSENT_REJECTED", "a reroute plan requires a consent record");
    try {
      consumeConsent(decision.consent, {
        decision: { ...stateDecision, decision: Decision.REQUIRES_CONSENT, reasonCode: "CONSENT_REQUIRED" },
        comparison: comparison as QuoteComparison,
        reroutePolicy: decision.reroutePolicy,
        currentSlot: options.currentSlot,
      });
    } catch (error) {
      if (error instanceof ConsentError) throw new ExecutionPlanError("CONSENT_REJECTED", error.message);
      throw error;
    }
  }
  const content: ExecutionPlanContent = {
    environment,
    selectedRepresentation: decision.selectedRepresentation,
    quote,
    quoteKey: quoteKey(quote),
    economicState: quote.state,
    policy: decision.transitionPolicy,
    inputRaw: quote.inputRaw,
    expectedOutputRaw: quote.outputRaw,
    minOutputRaw: quote.minOutputRaw,
    route: quote.route,
    decision: stateDecision.decision,
    reasonCode: stateDecision.reasonCode,
    executionEligibility: "EXECUTABLE",
    comparisonKey: rerouted ? (comparison as QuoteComparison).comparisonKey : null,
    disclosure: rerouted ? stateDecision.disclosure : null,
    consentId: rerouted ? (decision.consent?.consentId ?? null) : null,
    createdAtSlot: options.currentSlot,
    expiresAtSlot: options.currentSlot + options.freshness.validForSlots,
  };
  // Structured clone detaches the plan from caller-owned objects before freezing.
  const detached = structuredClone(content);
  const plan: ExecutionPlan = deepFreeze({ ...detached, planDigest: planDigestOf(detached) });
  issuedPlans.add(plan);
  return plan;
}

/**
 * Execution-time check without side effects; call before building anything.
 * `quote` is the quote the downstream builder is about to execute;
 * `comparison` is required for a consented reroute and must be the one the
 * plan was made from.
 */
export function verifyExecutionPlan(
  plan: ExecutionPlan,
  presented: { readonly quote: QuoteIdentity; readonly comparison: QuoteComparison | null },
): void {
  if (typeof plan !== "object" || plan === null || !issuedPlans.has(plan)) {
    throw new ExecutionPlanError("PLAN_NOT_ISSUED", "execution plans can only come from createExecutionPlan");
  }
  if (consumedPlans.has(plan)) throw new ExecutionPlanError("PLAN_CONSUMED", `plan ${plan.planDigest.slice(0, 16)}… was already executed`);
  const content = contentOf(plan);
  if (planDigestOf(content) !== plan.planDigest) throw new ExecutionPlanError("PLAN_TAMPERED", "plan content does not match its digest");
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

/**
 * Verifies and marks the plan consumed, before any signing or submission, so
 * an ambiguous RPC outcome can never lead to a blind second execution.
 */
export function consumeExecutionPlan(
  plan: ExecutionPlan,
  presented: { readonly quote: QuoteIdentity; readonly comparison: QuoteComparison | null },
): void {
  verifyExecutionPlan(plan, presented);
  consumedPlans.add(plan);
}

/** Throws POLICY_MISMATCH unless the executor's configured policy is exactly the plan's. */
export function assertPlanPolicy(plan: ExecutionPlan, executorPolicy: TransitionPolicy): void {
  if (canonicalKey(plan.policy) !== canonicalKey(executorPolicy)) {
    throw new ExecutionPlanError("POLICY_MISMATCH", `plan was decided under \"${plan.policy.basis}\" (${plan.policy.beforeSecs}/${plan.policy.afterSecs}s); executor is configured for \"${executorPolicy.basis}\" (${executorPolicy.beforeSecs}/${executorPolicy.afterSecs}s)`);
  }
}

/** Throws PLAN_EXPIRED unless `currentSlot` is within the plan's freshness window. */
export function assertPlanFresh(plan: ExecutionPlan, currentSlot: bigint): void {
  if (typeof currentSlot !== "bigint" || currentSlot > plan.expiresAtSlot) {
    throw new ExecutionPlanError("PLAN_EXPIRED", `slot ${String(currentSlot)} > expiresAtSlot ${plan.expiresAtSlot}`);
  }
}
