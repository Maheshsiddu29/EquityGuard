/**
 * Representation state domain types. UNKNOWN is a state, not an exception,
 * and a chain/API conflict is recorded as such, never reconciled away.
 */

import type { ActivationPhase, ProtectedState } from "@equityguard/guard-client";

import type { Issuer } from "./registry.ts";

export const RepresentationState = {
  SAFE: "SAFE",
  TRANSITION: "TRANSITION",
  PAUSED: "PAUSED",
  UNKNOWN: "UNKNOWN",
} as const;
export type RepresentationState = (typeof RepresentationState)[keyof typeof RepresentationState];

export const StateSource = {
  /** Only on-chain evidence was available. */
  CHAIN: "chain",
  /** Only issuer/API evidence was available. */
  API: "api",
  /** Both were available and resolved to the same state. */
  BOTH_AGREE: "both-agree",
  /** Both were available and resolved to different states. */
  CONFLICT: "conflict",
} as const;
export type StateSource = (typeof StateSource)[keyof typeof StateSource];

/** Whether a policy value comes from empirical observation or is a placeholder. */
export type Calibration = "UNCALIBRATED" | "CALIBRATED";

/**
 * Protection interval around a scheduled multiplier activation T, inclusive:
 * `[T - beforeSecs, T + afterSecs]`, matching the on-chain guard. There is no
 * default: callers must state the policy and its calibration basis.
 */
export interface TransitionPolicy {
  readonly beforeSecs: bigint;
  readonly afterSecs: bigint;
  readonly calibration: Calibration;
  /** Where the numbers come from, e.g. issuer documentation or observed events. */
  readonly basis: string;
}

/** Successfully decoded mint account at a point in chain history. */
export interface ChainObservation {
  readonly kind: "decoded";
  readonly mint: string;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  /** Wallclock at capture/fetch time; informational only. */
  readonly observedAt: string | null;
  /** Chain time used for phase decisions (Clock or block time); null if unavailable. */
  readonly chainUnixTimestamp: bigint | null;
  readonly decimals: number;
  /** Token-2022 Pausable flag; null when the mint has no Pausable extension. */
  readonly paused: boolean | null;
  readonly protectedState: ProtectedState;
  readonly hasScheduledChange: boolean;
  /** Null when chain time is unavailable. */
  readonly phase: ActivationPhase | null;
}

/** A mint account that could not be decoded; kept as evidence, not thrown. */
export interface ChainDecodeFailure {
  readonly kind: "decode-error";
  readonly mint: string;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly observedAt: string | null;
  readonly code: string;
  readonly message: string;
}

export type ChainEvidence = ChainObservation | ChainDecodeFailure;

/**
 * Normalized issuer/API status. The mapping from any real issuer API to these
 * values is UNCALIBRATED until verified against captured behaviour.
 */
export type ApiStatus = "active" | "paused" | "transition" | "unknown";

export interface ApiObservation {
  readonly issuer: Issuer;
  readonly symbol: string;
  readonly observedAt: string;
  readonly status: ApiStatus;
  readonly detail: string | null;
  readonly calibration: Calibration;
}

export interface ResolvedRepresentationState {
  readonly underlying: string;
  readonly issuer: Issuer;
  readonly symbol: string;
  readonly mint: string;
  /** Null only when `stateSource` is `conflict`: conflicting evidence is not collapsed. */
  readonly state: RepresentationState | null;
  /** Null only when no evidence at all was available (state is then UNKNOWN). */
  readonly stateSource: StateSource | null;
  readonly chainState: RepresentationState | null;
  readonly apiState: RepresentationState | null;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly observedAt: string | null;
  readonly reason: string;
  readonly chainObservation: ChainEvidence | null;
  readonly apiObservation: ApiObservation | null;
}
