/**
 * Structured demo result shared by the mainnet replay, the devnet execution
 * demo and a later UI.
 *
 * The execution environment is part of the type: a MAINNET_OBSERVATION result
 * cannot carry a transaction signature or a fixture quote, and a
 * DEVNET_EXECUTION result cannot carry a mainnet market quote.
 * `assertDemoResult` enforces the same rules at runtime for data from outside
 * the type system.
 */

import type { QuoteComparison } from "./compare.ts";
import { Decision, type DecisionReasonCode, type DecisionResult } from "./decision.ts";
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
  readonly decision: Decision;
  readonly reasonCode: DecisionReasonCode;
  readonly consentRequired: boolean;
  readonly reason: string;
}

export type MainnetObservationResult = DemoResultBase & {
  readonly executionEnvironment: "MAINNET_OBSERVATION";
  readonly transactionSignature?: never;
  readonly execution?: never;
};

export type DevnetExecutionResult = DemoResultBase & {
  readonly executionEnvironment: "DEVNET_EXECUTION";
  /** Signature of the executed (successful) transaction, if any. */
  readonly transactionSignature?: string;
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
  decision: DecisionResult,
  comparison: QuoteComparison | null,
  evidenceSources: readonly EvidenceReference[],
  quoteAvailability: QuoteAvailability,
): DemoResultBase {
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
    consentRequired: decision.decision === Decision.REQUIRES_CONSENT,
    reason: decision.reason,
  };
}

/** A decision over observed mainnet state. It has no transaction fields at all. */
export function mainnetObservationResult(input: {
  readonly decision: DecisionResult;
  readonly comparison: QuoteComparison | null;
  readonly evidenceSources: readonly EvidenceReference[];
  readonly quoteAvailability: QuoteAvailability;
}): MainnetObservationResult {
  const result: MainnetObservationResult = {
    ...base(input.decision, input.comparison, input.evidenceSources, input.quoteAvailability),
    executionEnvironment: "MAINNET_OBSERVATION",
  };
  assertDemoResult(result);
  return result;
}

export function devnetExecutionResult(input: {
  readonly decision: DecisionResult;
  readonly comparison: QuoteComparison | null;
  readonly evidenceSources: readonly EvidenceReference[];
  readonly quoteAvailability: QuoteAvailability;
  readonly execution?: DevnetExecutionResult["execution"];
}): DevnetExecutionResult {
  const executed = input.execution?.executed ?? null;
  const result: DevnetExecutionResult = {
    ...base(input.decision, input.comparison, input.evidenceSources, input.quoteAvailability),
    executionEnvironment: "DEVNET_EXECUTION",
    ...(executed?.succeeded ? { transactionSignature: executed.signature } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
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
    if (r.transactionSignature !== undefined || r.execution !== undefined) {
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
    if (executed && r.decision !== Decision.USE_ALTERNATIVE && r.decision !== Decision.USE_PREFERRED) {
      throw new DemoResultError(`nothing may execute for decision ${r.decision}`);
    }
  }
  if (r.consentRequired !== (r.decision === Decision.REQUIRES_CONSENT)) {
    throw new DemoResultError("consentRequired must match the decision");
  }
}
