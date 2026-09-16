/**
 * Execution plan: the single artifact an executor consumes.
 *
 * A plan can only be created from an EXECUTABLE decision in a submit-capable
 * environment (DEVNET_EXECUTION). It pins the exact selected quote (route,
 * raw input/output, minimum output, quote context), the economic state and
 * the transition policy the guard must assert (the same policy that
 * classified the state), the decision, the consent and disclosure for a
 * reroute, an explicit slot-based freshness window, and the ABI v2
 * downstream binding: the adapter kind and the SHA-256 commitment to the exact
 * action the guard will protect. For a Jupiter adapter (kinds 2/3) the binding
 * also pins every field of the trade the guard's grammar leaves to the client
 * — amounts, slippage, minimum output, accounts — and must describe exactly
 * the planned quote.
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

import { isAddress } from "@solana/kit";
import {
  JUPITER_V6_PROGRAM_ADDRESS,
  ROUTE_V2_DISCRIMINATOR_HEX,
  USDC_MINT_ADDRESS,
  minimumOutFromQuote,
  type JupiterTradeBinding,
} from "@equityguard/guard-client";

import type { QuoteComparison } from "./compare.ts";
import { ConsentError, consumeConsent } from "./consent.ts";
import { Decision, type DecisionReasonCode, type RepresentationSummary, type RerouteDisclosure } from "./decision.ts";
import type { ExecutionEnvironment } from "./demo-result.ts";
import type { EconomicState } from "./economic-state.ts";
import { ExecutionEligibilityError, assertExecutable, type ExecutionDecision } from "./execution.ts";
import type { TransitionPolicy } from "./types.ts";
import { canonicalKey, quoteIdentityOf, quoteKey, quoteMismatches, type QuoteIdentity, type QuoteMismatch, type RouteIdentity } from "./quote-identity.ts";
import { sha256Hex } from "./sha256.ts";

/** Adapter kind 1: the commitment to the single protected instruction. */
export interface TransferCheckedDownstreamBinding {
  readonly adapterKind: "TOKEN_2022_TRANSFER_CHECKED";
  /** Lowercase hex SHA-256 downstream commitment (64 digits). */
  readonly commitmentHex: string;
}

/**
 * Adapter kinds 2/3: a USDC ↔ protected-equity Jupiter `route_v2`, built by
 * `jupiterTradeBindingOf`. The on-chain guard cannot know the intended
 * amounts, slippage or route; this binding is where they are pinned.
 */
export type JupiterDownstreamBinding = JupiterTradeBinding;

/**
 * The exact downstream action the plan executes, committed as ABI v2 does
 * on-chain. The executor must rebuild the action and prove it equals this
 * before anything is signed.
 */
export type DownstreamBinding = TransferCheckedDownstreamBinding | JupiterDownstreamBinding;

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
  readonly downstream: DownstreamBinding;
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
  | "POLICY_MISMATCH"
  | "INVALID_DOWNSTREAM"
  | "DOWNSTREAM_NOT_FOR_QUOTE"
  | "DOWNSTREAM_COMMITMENT_MISMATCH";

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

const isCommitmentHex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isAddressString = (v: unknown): v is string => typeof v === "string" && isAddress(v);
const isPositive = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n && v < 2n ** 64n;

const JUPITER_KINDS = {
  JUPITER_ROUTE_V2_BUY_USDC: "DESTINATION",
  JUPITER_ROUTE_V2_SELL_USDC: "SOURCE",
} as const;

/** Why `value` is not a well-formed binding; empty when it is. */
function downstreamProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["a downstream binding is required"];
  const b = value as Record<string, unknown>;
  if (b.adapterKind === "TOKEN_2022_TRANSFER_CHECKED") {
    return isCommitmentHex(b.commitmentHex) ? [] : ["commitmentHex must be 64 lowercase hex digits"];
  }
  const role = JUPITER_KINDS[b.adapterKind as keyof typeof JUPITER_KINDS];
  if (!role) return [`unknown adapter kind ${String(b.adapterKind)}`];
  const problems: string[] = [];
  if (b.jupiterProgramId !== JUPITER_V6_PROGRAM_ADDRESS) problems.push("jupiterProgramId is not the pinned Jupiter program");
  if (b.routeDiscriminatorHex !== ROUTE_V2_DISCRIMINATOR_HEX) problems.push("routeDiscriminatorHex is not route_v2");
  if (b.protectedMintRole !== role) problems.push(`${String(b.adapterKind)} protects the ${role} mint`);
  for (const k of ["protectedMint", "counterMint", "authority", "sourceMint", "destinationMint", "sourceTokenAccount", "destinationTokenAccount"]) {
    if (!isAddressString(b[k])) problems.push(`${k} must be an address`);
  }
  if (b.counterMint !== USDC_MINT_ADDRESS) problems.push("the counter mint must be canonical USDC");
  const [protectedSide, counterSide] = role === "DESTINATION" ? [b.destinationMint, b.sourceMint] : [b.sourceMint, b.destinationMint];
  if (protectedSide !== b.protectedMint || counterSide !== b.counterMint) problems.push("source and destination mints do not match the role");
  if (!isPositive(b.inAmountRaw) || !isPositive(b.quotedOutRaw)) problems.push("inAmountRaw and quotedOutRaw must be positive u64 bigints");
  const slippage = b.slippageBps;
  if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 0 || slippage > 10_000) problems.push("slippageBps must be an integer in [0, 10000]");
  else if (isPositive(b.quotedOutRaw) && b.minOutRaw !== minimumOutFromQuote(b.quotedOutRaw, slippage)) problems.push("minOutRaw is not the minimum Jupiter derives from quotedOutRaw and slippageBps");
  if (!isCommitmentHex(b.suffixCommitmentHex)) problems.push("suffixCommitmentHex must be 64 lowercase hex digits");
  if (b.suffixInstructionCount !== 3 && b.suffixInstructionCount !== 4) problems.push("suffixInstructionCount must be 3 or 4");
  return problems;
}

const isDownstreamBinding = (value: unknown): value is DownstreamBinding => downstreamProblems(value).length === 0;

/** A detached copy holding exactly the binding's own fields. */
function canonicalDownstream(value: DownstreamBinding): DownstreamBinding {
  if (value.adapterKind === "TOKEN_2022_TRANSFER_CHECKED") return { adapterKind: value.adapterKind, commitmentHex: value.commitmentHex };
  return {
    adapterKind: value.adapterKind,
    jupiterProgramId: value.jupiterProgramId,
    routeDiscriminatorHex: value.routeDiscriminatorHex,
    protectedMintRole: value.protectedMintRole,
    protectedMint: value.protectedMint,
    counterMint: value.counterMint,
    authority: value.authority,
    sourceMint: value.sourceMint,
    destinationMint: value.destinationMint,
    sourceTokenAccount: value.sourceTokenAccount,
    destinationTokenAccount: value.destinationTokenAccount,
    inAmountRaw: value.inAmountRaw,
    quotedOutRaw: value.quotedOutRaw,
    slippageBps: value.slippageBps,
    minOutRaw: value.minOutRaw,
    suffixCommitmentHex: value.suffixCommitmentHex,
    suffixInstructionCount: value.suffixInstructionCount,
  };
}

/**
 * How a Jupiter binding fails to be the trade of `quote`. Plans model
 * acquisitions (the quote's `mint` is the representation acquired with
 * `inputMint`), so only a BUY of the selected representation can match.
 */
function jupiterQuoteMismatches(binding: DownstreamBinding, quote: QuoteIdentity, representationMint: string): string[] {
  if (binding.adapterKind === "TOKEN_2022_TRANSFER_CHECKED") return [];
  const out: string[] = [];
  if (binding.adapterKind !== "JUPITER_ROUTE_V2_BUY_USDC") out.push("plans acquire the selected representation; only a BUY can execute one");
  if (binding.protectedMint !== representationMint || binding.destinationMint !== quote.mint) out.push("the trade does not acquire the planned representation");
  if (binding.sourceMint !== quote.inputMint) out.push("the trade does not spend the planned input mint");
  if (binding.inAmountRaw !== quote.inputRaw) out.push("inAmountRaw differs from the planned input");
  if (binding.quotedOutRaw !== quote.outputRaw) out.push("quotedOutRaw differs from the planned output");
  if (binding.minOutRaw !== quote.minOutputRaw) out.push("minOutRaw differs from the planned minimum output");
  return out;
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
  options: { readonly currentSlot: bigint; readonly freshness: PlanFreshnessPolicy; readonly downstream: DownstreamBinding },
): ExecutionPlan {
  if (environment !== "DEVNET_EXECUTION") {
    throw new ExecutionPlanError("OBSERVATION_ONLY_ENVIRONMENT", `${environment} results cannot produce a submit-capable execution plan`);
  }
  if (typeof options.freshness?.validForSlots !== "bigint" || options.freshness.validForSlots <= 0n || typeof options.currentSlot !== "bigint") {
    throw new ExecutionPlanError("INVALID_FRESHNESS", "an explicit positive bigint validForSlots and currentSlot are required");
  }
  const downstreamIssues = downstreamProblems(options.downstream);
  if (downstreamIssues.length > 0) {
    throw new ExecutionPlanError("INVALID_DOWNSTREAM", `a well-formed downstream binding is required: ${downstreamIssues.join("; ")}`);
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
  const notForQuote = jupiterQuoteMismatches(options.downstream, quote, decision.selectedRepresentation.mint);
  if (notForQuote.length > 0) {
    throw new ExecutionPlanError("DOWNSTREAM_NOT_FOR_QUOTE", `the Jupiter trade is not the planned quote: ${notForQuote.join("; ")}`);
  }
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
    downstream: canonicalDownstream(options.downstream),
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
    plan.selectedRepresentation.mint !== plan.quote.mint ||
    !isDownstreamBinding(plan.downstream) ||
    jupiterQuoteMismatches(plan.downstream, plan.quote, plan.selectedRepresentation.mint).length > 0
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

/**
 * Throws DOWNSTREAM_COMMITMENT_MISMATCH unless `actual` — the binding of the
 * action about to be submitted, rebuilt from the final transaction — is
 * exactly the planned one, field for field. Call before signing.
 */
export function assertPlanDownstream(plan: ExecutionPlan, actual: DownstreamBinding): void {
  if (!isDownstreamBinding(actual) || canonicalKey(canonicalDownstream(actual)) !== canonicalKey(plan.downstream)) {
    throw new ExecutionPlanError("DOWNSTREAM_COMMITMENT_MISMATCH", "the action being submitted is not the planned action");
  }
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
