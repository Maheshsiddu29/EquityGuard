/**
 * Pure comparison of already-built quotes for two representations of the same
 * underlying, at identical input notional. No quotes are fetched here.
 *
 * The cost of switching is derived only from share-equivalents (INV-VAL-01)
 * and rounded AGAINST the alternative: a cost rounds up, a benefit rounds
 * toward zero. The reported cost of switching is never understated.
 */

import {
  NormalizationError,
  ceilDiv,
  compareRationals,
  rational,
  sharesEquivalent,
  withinToleranceBps,
  type Rational,
} from "./normalize.ts";
import type { Issuer } from "./registry.ts";

const BPS = 10_000n;

export interface NormalizedQuote {
  /** Underlying equity the quoted representation is associated with. */
  readonly underlying: string;
  readonly issuer: Issuer;
  readonly mint: string;
  /** Input notional in the input token's smallest units. */
  readonly inputRaw: bigint;
  readonly outputRaw: bigint;
  readonly decimals: number | null;
  /** Stored bytes of the output mint's effective multiplier. */
  readonly effectiveMultiplier: Uint8Array;
}

export interface QuoteComparison {
  /** Identity binding: which trade this comparison belongs to. */
  readonly underlying: string;
  readonly preferredMint: string;
  readonly alternativeMint: string;
  /** Identical input notional of both quotes. */
  readonly inputRaw: bigint;
  readonly preferredSharesEquivalent: Rational;
  readonly alternativeSharesEquivalent: Rational;
  /** preferred − alternative; positive means the alternative delivers fewer shares. */
  readonly difference: { readonly sign: -1 | 0 | 1; readonly magnitude: Rational };
  /**
   * ceil((preferred − alternative) / preferred × 10000). Positive: switching
   * costs at least this many bps. Zero or negative: switching is not more
   * expensive; any benefit is understated rather than overstated.
   */
  readonly conservativeCostDeltaBps: bigint;
  readonly toleranceBps: bigint;
  /** Whether the share-equivalents are within `toleranceBps` of each other. */
  readonly withinTolerance: boolean;
}

export function compareQuotes(
  preferred: NormalizedQuote,
  alternative: NormalizedQuote,
  options: { readonly toleranceBps: bigint },
): QuoteComparison {
  if (options.toleranceBps < 0n) throw new NormalizationError("InvalidTolerance", "tolerance must be non-negative");
  if (preferred.underlying !== alternative.underlying) {
    throw new NormalizationError("UnderlyingMismatch", "quotes must be for representations of the same underlying");
  }
  if (preferred.inputRaw !== alternative.inputRaw) {
    throw new NormalizationError("NotionalMismatch", "quotes must be for identical input notional");
  }
  const p = sharesEquivalent(preferred);
  const a = sharesEquivalent(alternative);
  if (p.num === 0n) throw new NormalizationError("NonPositiveOutput", "preferred quote delivers no shares");

  // (p − a) / p × 10000 = (p.num·a.den − a.num·p.den) · 10000 / (p.num·a.den)
  const numerator = (p.num * a.den - a.num * p.den) * BPS;
  const denominator = p.num * a.den;
  const sign = compareRationals(p, a);
  const rawDiff = p.num * a.den - a.num * p.den;
  return {
    underlying: preferred.underlying,
    preferredMint: preferred.mint,
    alternativeMint: alternative.mint,
    inputRaw: preferred.inputRaw,
    preferredSharesEquivalent: p,
    alternativeSharesEquivalent: a,
    difference: { sign, magnitude: rational(rawDiff < 0n ? -rawDiff : rawDiff, p.den * a.den) },
    conservativeCostDeltaBps: ceilDiv(numerator, denominator),
    toleranceBps: options.toleranceBps,
    withinTolerance: withinToleranceBps(p, a, options.toleranceBps),
  };
}
