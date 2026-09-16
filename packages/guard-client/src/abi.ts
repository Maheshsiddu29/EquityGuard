/**
 * `assert_safe_execution` ABI v2 encoder. Mirrors
 * `programs/equity_guard/src/instruction.rs`, which documents the layout.
 * There is no ABI v1 encoder: the program no longer accepts v1.
 */

import { getAddressEncoder, type Address } from "@solana/kit";

import { GuardClientError } from "./errors.ts";

export const ABI_VERSION_V2 = 2;
export const ASSERT_SAFE_EXECUTION_V2_LEN = 99;

/**
 * Supported downstream actions (ABI byte). The kind alone fixes the program's
 * validator, commitment domain and commitment scope.
 *
 * Kinds 2 and 3 are USDC-specific: ABI v2 authenticates only the protected
 * mint, so the counter asset is pinned to canonical USDC rather than read
 * from the payload. They are not generic Jupiter adapters.
 */
export const DownstreamAdapterKind = {
  /** The next instruction is Token-2022 `TransferChecked` of the protected mint. */
  TOKEN_2022_TRANSFER_CHECKED: 1,
  /** Guard at 0, then a supported Jupiter `route_v2` buying the protected mint with USDC. */
  JUPITER_ROUTE_V2_BUY_USDC: 2,
  /** Guard at 0, then a supported Jupiter `route_v2` selling the protected mint for USDC. */
  JUPITER_ROUTE_V2_SELL_USDC: 3,
} as const;
export type DownstreamAdapterKind = (typeof DownstreamAdapterKind)[keyof typeof DownstreamAdapterKind];

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

/** The economic-state expectation part of a guard request. */
export interface AssertSafeExecutionRequest {
  readonly expected: ProtectedState;
  readonly expectedPhase: ActivationPhase;
  readonly window: ProtectionWindow;
}

/** A complete ABI v2 request: mint identity, state expectation and downstream binding. */
export interface AssertSafeExecutionV2Request extends AssertSafeExecutionRequest {
  readonly expectedMint: Address;
  readonly adapterKind: DownstreamAdapterKind;
  /**
   * SHA-256 commitment to the protected action, in the kind's domain: the next
   * instruction for kind 1 (downstream.ts), the whole suffix for kinds 2/3
   * (jupiter.ts).
   */
  readonly downstreamCommitment: Uint8Array;
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

export function isDownstreamAdapterKind(value: unknown): value is DownstreamAdapterKind {
  return Object.values(DownstreamAdapterKind).some((kind) => kind === value);
}

/** Encodes and validates an ABI v2 instruction payload. */
export function encodeAssertSafeExecutionV2(request: AssertSafeExecutionV2Request): Uint8Array {
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
  if (!isDownstreamAdapterKind(request.adapterKind)) {
    throw new GuardClientError("InvalidDownstream", `unsupported adapter kind ${String(request.adapterKind)}`);
  }
  if (!(request.downstreamCommitment instanceof Uint8Array) || request.downstreamCommitment.length !== 32) {
    throw new GuardClientError("InvalidDownstream", "downstream commitment must be 32 bytes");
  }
  const mint = getAddressEncoder().encode(request.expectedMint);

  const out = new Uint8Array(ASSERT_SAFE_EXECUTION_V2_LEN);
  const view = new DataView(out.buffer);
  out[0] = ABI_VERSION_V2;
  out.set(mint, 1);
  out.set(expected.multiplier, 33);
  out.set(expected.newMultiplier, 41);
  view.setBigInt64(49, timestamp, true);
  out[57] = expectedPhase;
  view.setUint32(58, window.beforeSecs, true);
  view.setUint32(62, window.afterSecs, true);
  out[66] = request.adapterKind;
  out.set(request.downstreamCommitment, 67);
  return out;
}
