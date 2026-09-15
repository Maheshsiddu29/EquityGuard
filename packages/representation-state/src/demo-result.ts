/**
 * Structured demo result shared by the mainnet replay, the devnet execution
 * demo and a later UI.
 *
 * The execution environment is part of the type: a MAINNET_OBSERVATION result
 * cannot carry a transaction signature or a fixture quote, and a
 * DEVNET_EXECUTION result cannot carry a mainnet market quote.
 * `assertDemoResult` enforces the same rules at runtime for data from outside
 * the type system.
 *
 * The state decision (`decision`, `reasonCode`, `reason`) and execution
 * eligibility (`executionEligibility`, `executionReason`) are separate
 * fields: a SAFE state choice is never presented as executable on its own.
 */

import { Decision, type DecisionReasonCode, type RepresentationSummary } from "./decision.ts";
import { ExecutionEligibility, type ExecutionDecision } from "./execution.ts";
import { formatRationalFloor } from "./normalize.ts";
import type { RepresentationState, ResolvedRepresentationState, StateSource } from "./types.ts";

export type ExecutionEnvironment = "MAINNET_OBSERVATION" | "DEVNET_EXECUTION";

/** Where quote data came from; never interchangeable. */
export type QuoteSource = "JUPITER_MAINNET_SNAPSHOT" | "DEVNET_DEMO_QUOTE_FIXTURE";

export type QuoteStatus = "AVAILABLE" | "UNAVAILABLE" | "NOT_APPLICABLE";

export interface QuoteAvailability {
  readonly source: QuoteSource;
  /** When the quotes were observed; null for fixtures. */
  readonly observedAt: string | null;
  readonly preferred: QuoteStatus;
  readonly alternative: QuoteStatus;
  readonly note: string;
}

export interface EvidenceReference {
  readonly kind: "LIVE_CHAIN_STATE" | "LIVE_API_STATE" | "JUPITER_ROUTE_DISCOVERY" | "DEVNET_CHAIN_STATE" | "DEVNET_DEMO_QUOTE_FIXTURE";
  readonly description: string;
  readonly sha256: string | null;
  readonly observedAt: string | null;
}

export interface RepresentationRef {
  readonly underlying: string;
  readonly issuer: string;
  readonly symbol: string;
  readonly mint: string;
}

export interface DevnetTransactionEvidence {
  readonly signature: string;
  readonly slot: bigint;
  readonly succeeded: boolean;
  readonly customErrorName: string | null;
  readonly downstreamBalanceBefore: bigint;
  readonly downstreamBalanceAfter: bigint;
  readonly explorerUrl: string | null;
}

interface DemoResultBase {
  readonly underlying: string;
  readonly preferredRepresentation: RepresentationRef;
  readonly preferredState: RepresentationState | null;
  readonly preferredStateSource: StateSource | null;
  readonly alternativeRepresentation: RepresentationRef | null;
  readonly alternativeState: RepresentationState | null;
  readonly evidenceSources: readonly EvidenceReference[];
  readonly quoteAvailability: QuoteAvailability;
  readonly preferredSharesEquivalent?: string;
  readonly alternativeSharesEquivalent?: string;
  readonly conservativeCostDeltaBps?: bigint;
  /** State-level choice. */
  readonly decision: Decision;
  readonly reasonCode: DecisionReasonCode;
  readonly reason: string;
  readonly consentRequired: boolean;
  /** Whether a transaction could be built for the selection. */
  readonly executionEligibility: ExecutionEligibility;
  readonly executionReason: string;
  readonly selectedRepresentation: RepresentationSummary | null;
  readonly selectedRouteAvailable: boolean | null;
  readonly quoteAvailable: boolean;
}

export type MainnetObservationResult = DemoResultBase & {
  readonly executionEnvironment: "MAINNET_OBSERVATION";
  readonly transactionSignature?: never;
  readonly execution?: never;
  readonly executionPlanDigest?: never;
};

export type DevnetExecutionResult = DemoResultBase & {
  readonly executionEnvironment: "DEVNET_EXECUTION";
  /** Signature of the executed (successful) transaction, if any. */
  readonly transactionSignature?: string;
  /** planDigest of the execution plan the executed transaction consumed. */
  readonly executionPlanDigest?: string;
  readonly execution?: {
    readonly executed: DevnetTransactionEvidence | null;
    readonly rejectedPreferredAttempt: DevnetTransactionEvidence | null;
  };
};

export type DemoResult = MainnetObservationResult | DevnetExecutionResult;

export class DemoResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoResultError";
  }
}

const SHARE_DECIMALS = 12;

function ref(state: ResolvedRepresentationState): RepresentationRef {
  return { underlying: state.underlying, issuer: state.issuer, symbol: state.symbol, mint: state.mint };
}

function base(
  execution: ExecutionDecision,
  evidenceSources: readonly EvidenceReference[],
  quoteAvailability: QuoteAvailability,
): DemoResultBase {
  const decision = execution.stateDecision;
  const comparison = execution.comparison;
  const shares =
    comparison && comparison.preferredMint === decision.preferred.mint && comparison.alternativeMint === decision.alternative?.mint
      ? {
          preferredSharesEquivalent: formatRationalFloor(comparison.preferredSharesEquivalent, SHARE_DECIMALS),
          alternativeSharesEquivalent: formatRationalFloor(comparison.alternativeSharesEquivalent, SHARE_DECIMALS),
          conservativeCostDeltaBps: comparison.conservativeCostDeltaBps,
        }
      : {};
  return {
    underlying: decision.preferred.underlying,
    preferredRepresentation: ref(decision.preferred),
    preferredState: decision.preferred.state,
    preferredStateSource: decision.preferred.stateSource,
    alternativeRepresentation: decision.alternative ? ref(decision.alternative) : null,
    alternativeState: decision.alternative?.state ?? null,
    evidenceSources,
    quoteAvailability,
    ...shares,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    consentRequired: decision.decision === Decision.REQUIRES_CONSENT,
    executionEligibility: execution.executionEligibility,
    executionReason: execution.executionReason,
    selectedRepresentation: execution.selectedRepresentation,
    selectedRouteAvailable: execution.selectedRouteAvailable,
    quoteAvailable: execution.quoteAvailable,
  };
}

/**
 * A decision over observed mainnet state. It has no transaction fields at all:
 * eligibility is evaluated against recorded observations and is never
 * submitted.
 */
export function mainnetObservationResult(input: {
  readonly decision: ExecutionDecision;
  readonly evidenceSources: readonly EvidenceReference[];
  readonly quoteAvailability: QuoteAvailability;
}): MainnetObservationResult {
  const result: MainnetObservationResult = {
    ...base(input.decision, input.evidenceSources, input.quoteAvailability),
    executionEnvironment: "MAINNET_OBSERVATION",
  };
  assertDemoResult(result);
  return result;
}

export function devnetExecutionResult(input: {
  readonly decision: ExecutionDecision;
  readonly evidenceSources: readonly EvidenceReference[];
  readonly quoteAvailability: QuoteAvailability;
  readonly execution?: DevnetExecutionResult["execution"];
  readonly executionPlanDigest?: string;
}): DevnetExecutionResult {
  const executed = input.execution?.executed ?? null;
  const result: DevnetExecutionResult = {
    ...base(input.decision, input.evidenceSources, input.quoteAvailability),
    executionEnvironment: "DEVNET_EXECUTION",
    ...(executed?.succeeded ? { transactionSignature: executed.signature } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.executionPlanDigest ? { executionPlanDigest: input.executionPlanDigest } : {}),
  };
  assertDemoResult(result);
  return result;
}

/** Runtime enforcement of environment separation and internal consistency. */
export function assertDemoResult(result: DemoResult): void {
  const r = result as DemoResult & Record<string, unknown>;
  const environment: unknown = r.executionEnvironment;
  if (environment !== "MAINNET_OBSERVATION" && environment !== "DEVNET_EXECUTION") {
    throw new DemoResultError(`unknown execution environment ${String(environment)}`);
  }
  if (r.executionEnvironment === "MAINNET_OBSERVATION") {
    if (r.transactionSignature !== undefined || r.execution !== undefined || r.executionPlanDigest !== undefined) {
      throw new DemoResultError("a MAINNET_OBSERVATION result cannot carry transactions");
    }
    if (r.quoteAvailability.source !== "JUPITER_MAINNET_SNAPSHOT") {
      throw new DemoResultError("a MAINNET_OBSERVATION result cannot use fixture quotes");
    }
    if (r.evidenceSources.some((e) => e.kind === "DEVNET_CHAIN_STATE" || e.kind === "DEVNET_DEMO_QUOTE_FIXTURE")) {
      throw new DemoResultError("a MAINNET_OBSERVATION result cannot cite devnet evidence");
    }
  } else {
    if (r.quoteAvailability.source !== "DEVNET_DEMO_QUOTE_FIXTURE") {
      throw new DemoResultError("a DEVNET_EXECUTION result must use the devnet demo quote fixture");
    }
    if (r.evidenceSources.some((e) => e.kind === "LIVE_CHAIN_STATE" || e.kind === "LIVE_API_STATE" || e.kind === "JUPITER_ROUTE_DISCOVERY")) {
      throw new DemoResultError("a DEVNET_EXECUTION result cannot cite mainnet evidence");
    }
    const executed = r.execution?.executed ?? null;
    if (executed && r.executionEligibility !== ExecutionEligibility.EXECUTABLE) {
      throw new DemoResultError(`nothing may execute when eligibility is ${r.executionEligibility}`);
    }
    if (executed && !r.executionPlanDigest) {
      throw new DemoResultError("an executed transaction must record the execution plan it consumed");
    }
  }
  if (r.consentRequired !== (r.decision === Decision.REQUIRES_CONSENT)) {
    throw new DemoResultError("consentRequired must match the decision");
  }
  if (r.consentRequired && r.executionEligibility !== ExecutionEligibility.CONSENT_REQUIRED && r.executionEligibility !== ExecutionEligibility.CONSENT_INVALID) {
    throw new DemoResultError("a decision requiring consent cannot have any other eligibility");
  }
  if (r.executionEligibility === ExecutionEligibility.EXECUTABLE && (r.decision !== Decision.USE_PREFERRED && r.decision !== Decision.USE_ALTERNATIVE)) {
    throw new DemoResultError(`decision ${r.decision} can never be EXECUTABLE`);
  }
}
