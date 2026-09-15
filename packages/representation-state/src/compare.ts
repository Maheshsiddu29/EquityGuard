/**
 * Pure comparison of already-built quotes for two representations of the same
 * underlying, at identical input notional. No quotes are fetched here.
 *
 * The cost of switching is derived only from share-equivalents (INV-VAL-01)
 * and rounded AGAINST the alternative: a cost rounds up, a benefit rounds
 * toward zero. The reported cost of switching is never understated.
 *
 * Each quote is normalized with the decimals and effective multiplier of the
 * `EconomicState` it was built against. The comparison carries both exact
 * quote identities (raw amounts, route, state) and a canonical key, so it can
 * never be applied to another quote, route, notional or state (see `decide`
 * and `ExecutionPlan`).
 */

import { effectiveMultiplierBytes } from "./economic-state.ts";
import { canonicalKey, quoteIdentityOf, type QuoteIdentity } from "./quote-identity.ts";

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

/** A raw quote bound to its exact identity (route, amounts, state) plus the issuer label. */
export interface NormalizedQuote extends QuoteIdentity {
  readonly issuer: Issuer;
}

export interface QuoteComparison {
  /** Identity binding: which trade this comparison belongs to. */
  readonly underlying: string;
  readonly preferredMint: string;
  readonly alternativeMint: string;
  /** Identical input notional of both quotes. */
  readonly inputRaw: bigint;
  /** Quote binding: the exact quotes (and therefore economic states) both sides were normalized from. */
  readonly preferredQuote: QuoteIdentity;
  readonly alternativeQuote: QuoteIdentity;
  /** Canonical key of both quotes and the tolerance; binds disclosures and execution plans to this comparison. */
  readonly comparisonKey: string;
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
  if (preferred.inputMint !== alternative.inputMint) {
    throw new NormalizationError("InputMintMismatch", "quotes must spend the same input mint");
  }
  if (preferred.inputRaw !== alternative.inputRaw) {
    throw new NormalizationError("NotionalMismatch", "quotes must be for identical input notional");
  }
  for (const quote of [preferred, alternative]) {
    if (quote.state.mint !== quote.mint) {
      throw new NormalizationError("StateMismatch", `quote for ${quote.mint} carries state of ${quote.state.mint}`);
    }
  }
  const shares = (quote: NormalizedQuote) =>
    sharesEquivalent({ outputRaw: quote.outputRaw, decimals: quote.state.decimals, effectiveMultiplier: effectiveMultiplierBytes(quote.state) });
  const p = shares(preferred);
  const a = shares(alternative);
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
    preferredQuote: quoteIdentityOf(preferred),
    alternativeQuote: quoteIdentityOf(alternative),
    comparisonKey: canonicalKey({ preferred: quoteIdentityOf(preferred), alternative: quoteIdentityOf(alternative), toleranceBps: options.toleranceBps }),
    preferredSharesEquivalent: p,
    alternativeSharesEquivalent: a,
    difference: { sign, magnitude: rational(rawDiff < 0n ? -rawDiff : rawDiff, p.den * a.den) },
    conservativeCostDeltaBps: ceilDiv(numerator, denominator),
    toleranceBps: options.toleranceBps,
    withinTolerance: withinToleranceBps(p, a, options.toleranceBps),
  };
}
