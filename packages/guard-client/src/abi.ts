/**
 * `assert_safe_execution` ABI v1 encoder. Mirrors
 * `programs/equity_guard/src/instruction.rs`, which documents the layout.
 */

import { GuardClientError } from "./errors.ts";

export const ABI_VERSION_V1 = 1;
export const ASSERT_SAFE_EXECUTION_V1_LEN = 34;

/** Which stored multiplier Token-2022 treats as effective. */
export const ActivationPhase = {
  /** `now < newMultiplierEffectiveTimestamp`: `multiplier` is effective. */
  Pending: 0,
  /** `now >= newMultiplierEffectiveTimestamp`: `newMultiplier` is effective. */
  Activated: 1,
} as const;
export type ActivationPhase = (typeof ActivationPhase)[keyof typeof ActivationPhase];

/**
 * Protected ScaledUiAmount fields. Multipliers stay as their stored 8
 * little-endian bytes: identity is byte identity, never float equality.
 */
export interface ProtectedState {
  readonly multiplier: Uint8Array;
  readonly newMultiplier: Uint8Array;
  readonly newMultiplierEffectiveTimestamp: bigint;
}

/** Inclusive refusal interval around a scheduled activation, in seconds. */
export interface ProtectionWindow {
  readonly beforeSecs: number;
  readonly afterSecs: number;
}

export interface AssertSafeExecutionRequest {
  readonly expected: ProtectedState;
  readonly expectedPhase: ActivationPhase;
  readonly window: ProtectionWindow;
}

const MULTIPLIER_LEN = 8;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U32_MAX = 2 ** 32 - 1;
/** Smallest positive normal f64; anything below is subnormal. */
const MIN_POSITIVE_NORMAL_F64 = 2.2250738585072014e-308;

/**
 * Whether bytes encode a positive, normal f64 (the program's rule). The float
 * is read only to classify it, never to compare values.
 */
export function isValidStoredMultiplier(bytes: Uint8Array): boolean {
  if (bytes.length !== MULTIPLIER_LEN) return false;
  const value = new DataView(bytes.buffer, bytes.byteOffset, MULTIPLIER_LEN).getFloat64(0, true);
  return Number.isFinite(value) && value >= MIN_POSITIVE_NORMAL_F64;
}

/** Whether a multiplier change is scheduled (stored bytes differ). */
export function hasScheduledChange(state: ProtectedState): boolean {
  return !bytesEqual(state.multiplier, state.newMultiplier);
}

/** Phase at a chain `unixTimestamp`, matching Token-2022's `>=` boundary. */
export function phaseAt(state: ProtectedState, unixTimestamp: bigint): ActivationPhase {
  return unixTimestamp >= state.newMultiplierEffectiveTimestamp
    ? ActivationPhase.Activated
    : ActivationPhase.Pending;
}

/** Byte-level equality of two stored multipliers. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Encodes and validates an ABI v1 instruction payload. */
export function encodeAssertSafeExecutionV1(request: AssertSafeExecutionRequest): Uint8Array {
  const { expected, expectedPhase, window } = request;
  if (!isValidStoredMultiplier(expected.multiplier) || !isValidStoredMultiplier(expected.newMultiplier)) {
    throw new GuardClientError("InvalidExpectedState", "multipliers must be 8 bytes encoding a positive normal f64");
  }
  const timestamp = expected.newMultiplierEffectiveTimestamp;
  if (timestamp < I64_MIN || timestamp > I64_MAX) {
    throw new GuardClientError("InvalidExpectedState", "effective timestamp outside i64 range");
  }
  if (expectedPhase !== ActivationPhase.Pending && expectedPhase !== ActivationPhase.Activated) {
    throw new GuardClientError("InvalidExpectedState", `unknown activation phase ${String(expectedPhase)}`);
  }
  for (const [name, secs] of [["beforeSecs", window.beforeSecs], ["afterSecs", window.afterSecs]] as const) {
    if (!Number.isInteger(secs) || secs < 0 || secs > U32_MAX) {
      throw new GuardClientError("InvalidProtectionWindow", `${name} must be a u32`);
    }
  }

  const out = new Uint8Array(ASSERT_SAFE_EXECUTION_V1_LEN);
  const view = new DataView(out.buffer);
  out[0] = ABI_VERSION_V1;
  out.set(expected.multiplier, 1);
  out.set(expected.newMultiplier, 9);
  view.setBigInt64(17, timestamp, true);
  out[25] = expectedPhase;
  view.setUint32(26, window.beforeSecs, true);
  view.setUint32(30, window.afterSecs, true);
  return out;
}
