/**
 * Economic-state binding.
 *
 * An `EconomicState` is the exact state a normalized quote, a decision or a
 * guarded transaction was built against: the protected ScaledUiAmount bytes,
 * decimals, the Pausable flag and the activation phase evaluated at chain
 * time. The phase is part of the identity because the effective multiplier
 * changes when the clock crosses the effective timestamp while the account
 * bytes stay the same.
 *
 * Multipliers are kept as the hex of their stored bytes, never as formatted
 * floats. No wall-clock or slot value is included: re-observing an unchanged
 * state yields an identical binding. `economicStateMismatches` is the single
 * canonical comparison.
 */

import { ActivationPhase, type ProtectedState } from "@equityguard/guard-client";

import type { ChainEvidence } from "./types.ts";

export interface EconomicState {
  readonly mint: string;
  readonly decimals: number;
  /** Hex of the 8 stored little-endian bytes. */
  readonly multiplierHex: string;
  /** Hex of the 8 stored little-endian bytes. */
  readonly newMultiplierHex: string;
  readonly effectiveTimestamp: bigint;
  /** Phase at the chain time of the observation. */
  readonly phase: ActivationPhase;
  /** Token-2022 Pausable flag; null when the mint has no Pausable extension. */
  readonly paused: boolean | null;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/** The binding for decoded chain evidence; null when the state or chain time is unknown. */
export function economicStateOf(evidence: ChainEvidence | null): EconomicState | null {
  if (!evidence || evidence.kind !== "decoded" || evidence.phase === null) return null;
  return {
    mint: evidence.mint,
    decimals: evidence.decimals,
    multiplierHex: toHex(evidence.protectedState.multiplier),
    newMultiplierHex: toHex(evidence.protectedState.newMultiplier),
    effectiveTimestamp: evidence.protectedState.newMultiplierEffectiveTimestamp,
    phase: evidence.phase,
    paused: evidence.paused,
  };
}

/** Field-by-field differences between two bindings; empty means identical. */
export function economicStateMismatches(expected: EconomicState, actual: EconomicState): readonly string[] {
  const fields = ["mint", "decimals", "multiplierHex", "newMultiplierHex", "effectiveTimestamp", "phase", "paused"] as const;
  return fields.filter((field) => expected[field] !== actual[field]).map((field) => `${field} ${String(expected[field])} != ${String(actual[field])}`);
}

export function protectedStateOf(state: EconomicState): ProtectedState {
  return {
    multiplier: fromHex(state.multiplierHex),
    newMultiplier: fromHex(state.newMultiplierHex),
    newMultiplierEffectiveTimestamp: state.effectiveTimestamp,
  };
}

/** Stored bytes of the multiplier Token-2022 treats as effective in this state. */
export function effectiveMultiplierBytes(state: EconomicState): Uint8Array {
  return fromHex(state.phase === ActivationPhase.Activated ? state.newMultiplierHex : state.multiplierHex);
}
