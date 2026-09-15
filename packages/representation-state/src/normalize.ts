/**
 * INV-VAL-01 — Cross-Issuer Economic Comparability.
 *
 * Outputs of different representations are compared as share-equivalents:
 *
 *   shares_equivalent = outAmountRaw × effective_multiplier / 10^decimals
 *
 * The stored f64 multiplier is converted to its EXACT rational value
 * (every finite f64 is a dyadic rational), so the arithmetic is exact bigint
 * rational arithmetic with no floating-point rounding. Tolerance is only ever
 * applied explicitly by the caller.
 */

import { isValidStoredMultiplier } from "@equityguard/guard-client";

export type NormalizationErrorCode =
  | "InvalidMultiplier"
  | "MissingDecimals"
  | "InvalidDecimals"
  | "NegativeAmount"
  | "NotionalMismatch"
  | "UnderlyingMismatch"
  | "StateMismatch"
  | "NonPositiveOutput"
  | "InvalidTolerance";

export class NormalizationError extends Error {
  readonly code: NormalizationErrorCode;

  constructor(code: NormalizationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "NormalizationError";
    this.code = code;
  }
}

/** Non-negative rational in lowest terms with a positive denominator. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

const BPS = 10_000n;
const F64_BIAS_PLUS_MANTISSA_BITS = 1075n;
const F64_MANTISSA_MASK = (1n << 52n) - 1n;
const F64_IMPLICIT_ONE = 1n << 52n;
const MAX_DECIMALS = 255;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(num: bigint, den: bigint): Rational {
  const divisor = gcd(num, den) || 1n;
  return { num: num / divisor, den: den / divisor };
}

/**
 * Exact value of a stored multiplier. Fails closed unless the bytes encode a
 * positive, normal f64 (the same rule the on-chain guard enforces).
 */
export function multiplierToRational(bytes: Uint8Array): Rational {
  if (!isValidStoredMultiplier(bytes)) {
    throw new NormalizationError("InvalidMultiplier", "multiplier must be 8 bytes encoding a positive normal f64");
  }
  const bits = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  const exponent = (bits >> 52n) & 0x7ffn;
  const significand = F64_IMPLICIT_ONE + (bits & F64_MANTISSA_MASK);
  const shift = exponent - F64_BIAS_PLUS_MANTISSA_BITS;
  return shift >= 0n ? rational(significand << shift, 1n) : rational(significand, 1n << -shift);
}

export interface ShareInput {
  readonly outputRaw: bigint;
  /** Mint decimals from chain state; never defaulted. */
  readonly decimals: number | null | undefined;
  /** Stored bytes of the multiplier effective at the relevant chain time. */
  readonly effectiveMultiplier: Uint8Array;
}

/** Exact share-equivalents for a raw token amount. */
export function sharesEquivalent(input: ShareInput): Rational {
  if (input.decimals === null || input.decimals === undefined) {
    throw new NormalizationError("MissingDecimals", "decimals are required and are never assumed");
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > MAX_DECIMALS) {
    throw new NormalizationError("InvalidDecimals", `decimals must be an integer in [0, ${MAX_DECIMALS}]`);
  }
  if (input.outputRaw < 0n) throw new NormalizationError("NegativeAmount", "raw amount must be non-negative");
  const multiplier = multiplierToRational(input.effectiveMultiplier);
  return rational(input.outputRaw * multiplier.num, multiplier.den * 10n ** BigInt(input.decimals));
}

/** Exact comparison: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareRationals(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether |a − b| ≤ toleranceBps × max(a, b) / 10000, evaluated exactly. */
export function withinToleranceBps(a: Rational, b: Rational, toleranceBps: bigint): boolean {
  if (toleranceBps < 0n) throw new NormalizationError("InvalidTolerance", "tolerance must be non-negative");
  const diff = a.num * b.den - b.num * a.den;
  const absDiff = diff < 0n ? -diff : diff;
  const max = compareRationals(a, b) >= 0 ? a : b;
  return absDiff * BPS * max.den <= toleranceBps * max.num * a.den * b.den;
}

/** Ceiling division for a positive divisor (rounds toward +∞). */
export function ceilDiv(n: bigint, d: bigint): bigint {
  return n >= 0n ? (n + d - 1n) / d : -(-n / d);
}

/** Decimal string rounded DOWN to `places` digits, for display only. */
export function formatRationalFloor(value: Rational, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = (value.num * scale) / value.den;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(places, "0");
  return places === 0 ? whole.toString() : `${whole}.${fraction}`;
}
