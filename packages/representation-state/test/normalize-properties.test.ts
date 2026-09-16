/**
 * Property tests for the exact share-equivalent arithmetic (INV-VAL-01) and
 * the one-sided reroute cost.
 *
 * The properties are stated independently of how the implementation computes
 * them: `additionalCostBps` is pinned by the two inequalities that define a
 * ceiling, not by recomputing the same expression a second time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  compareQuotes,
  exceedsCostLimit,
  multiplierToRational,
  sharesEquivalent,
  type EconomicState,
  type NormalizedQuote,
  type Rational,
} from "../src/index.ts";
import { NormalizationError } from "../src/normalize.ts";
import { TEST_QUOTE_CONTEXT } from "./fixtures.ts";
import { PROPERTY_SEED, Prng } from "./prng.ts";

const BPS = 10_000n;
const MINT_P = "PreferredMint11111111111111111111111111111";
const MINT_A = "AlternateMint11111111111111111111111111111";

const hexOf = (value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Buffer.from(bytes).toString("hex");
};
const hexOfBits = (bits: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, bits, true);
  return Buffer.from(bytes).toString("hex");
};
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

function state(mint: string, decimals: number, multiplierHex: string): EconomicState {
  return {
    mint,
    decimals,
    multiplierHex,
    newMultiplierHex: multiplierHex,
    effectiveTimestamp: 0n,
    phase: ActivationPhase.Activated,
    paused: null,
  };
}

function quote(input: { mint: string; outputRaw: bigint; decimals: number; multiplierHex: string; inputRaw?: bigint }): NormalizedQuote {
  return {
    ...TEST_QUOTE_CONTEXT,
    issuer: "xStocks",
    underlying: "DEMO",
    mint: input.mint,
    inputRaw: input.inputRaw ?? 5_000_000n,
    outputRaw: input.outputRaw,
    state: state(input.mint, input.decimals, input.multiplierHex),
  };
}

/** `a / b` as an exact comparison, avoiding any division. */
const cmp = (a: Rational, b: Rational) => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
};

// ------------------------------------------------------- exact arithmetic

test("a stored multiplier becomes its exact dyadic rational, for every exponent", () => {
  // Every finite f64 is significand x 2^k. Reconstruct that independently
  // from the bit pattern and require the rational to be exactly equal.
  const prng = new Prng(PROPERTY_SEED);
  const patterns: bigint[] = [
    0x3ff0_0000_0000_0000n, // 1.0
    0x0010_0000_0000_0000n, // smallest positive normal
    0x7fef_ffff_ffff_ffffn, // largest finite
    0x3ff0_0000_0000_0001n, // one ulp above 1.0
  ];
  for (let i = 0; i < 300; i += 1) {
    const exponent = BigInt(1 + prng.below(0x7fe));
    const mantissa = prng.belowBig(1n << 52n);
    patterns.push((exponent << 52n) | mantissa);
  }
  for (const bits of patterns) {
    const exponent = (bits >> 52n) & 0x7ffn;
    const significand = (1n << 52n) + (bits & ((1n << 52n) - 1n));
    const shift = exponent - 1075n;
    const expected = shift >= 0n ? { num: significand << shift, den: 1n } : { num: significand, den: 1n << -shift };
    const actual = multiplierToRational(fromHex(hexOfBits(bits)));
    // Equal as rationals: cross-multiplication, not division.
    assert.equal(actual.num * expected.den, expected.num * actual.den, `bits ${bits.toString(16)}`);
    assert.ok(actual.den > 0n);
  }
});

test("share-equivalents stay exact far beyond Number.MAX_SAFE_INTEGER", () => {
  // A float path would round these; exact rational arithmetic cannot.
  const outputRaw = (1n << 70n) + 12_345_678_901_234_567n;
  const shares = sharesEquivalent({ outputRaw, decimals: 9, effectiveMultiplier: fromHex(hexOf(1)) });
  assert.equal(shares.num * 10n ** 9n, outputRaw * shares.den);
  assert.ok(outputRaw > BigInt(Number.MAX_SAFE_INTEGER));

  // One raw unit more must change the value; a double would not notice.
  const next = sharesEquivalent({ outputRaw: outputRaw + 1n, decimals: 9, effectiveMultiplier: fromHex(hexOf(1)) });
  assert.equal(cmp(next, shares), 1);
});

test("decimals are honoured across the supported range and never assumed", () => {
  for (const decimals of [0, 1, 6, 9, 18, 38, 255]) {
    const shares = sharesEquivalent({ outputRaw: 1n, decimals, effectiveMultiplier: fromHex(hexOf(1)) });
    assert.equal(shares.num, 1n);
    assert.equal(shares.den, 10n ** BigInt(decimals));
  }
  for (const bad of [null, undefined]) {
    assert.throws(() => sharesEquivalent({ outputRaw: 1n, decimals: bad, effectiveMultiplier: fromHex(hexOf(1)) }), NormalizationError);
  }
  for (const bad of [-1, 256, 1.5, Number.NaN]) {
    assert.throws(() => sharesEquivalent({ outputRaw: 1n, decimals: bad, effectiveMultiplier: fromHex(hexOf(1)) }), NormalizationError);
  }
});

test("an invalid multiplier cannot be normalized at all", () => {
  for (const bits of [0n, 1n << 63n, 0x7ff0_0000_0000_0000n, 0xfff8_0000_0000_0000n, 1n]) {
    assert.throws(() => multiplierToRational(fromHex(hexOfBits(bits))), NormalizationError, `bits ${bits.toString(16)}`);
  }
});

// ------------------------------------------------- one-sided reroute cost

/**
 * The defining inequalities of `ceil((p - a) / p * 10000)`, evaluated in
 * exact integers. This pins the value without reusing the implementation's
 * expression: any other integer would violate one of the two bounds.
 */
function assertIsCeilingOfRelativeShortfall(p: Rational, a: Rational, bps: bigint, label: string): void {
  const shortfall = (p.num * a.den - a.num * p.den) * BPS; // numerator of (p - a)/p * 10000
  const denominator = p.num * a.den; // positive: p.num > 0
  assert.ok(denominator > 0n, `${label}: preferred delivers no shares`);
  assert.ok(bps * denominator >= shortfall, `${label}: ${bps} bps understates the cost`);
  assert.ok((bps - 1n) * denominator < shortfall, `${label}: ${bps} bps overstates the cost by a whole bp`);
}

test("additionalCostBps is exactly the conservative ceiling, over a seeded corpus", () => {
  const prng = new Prng(PROPERTY_SEED);
  const multipliers = [hexOf(1), hexOf(1.0183317967386898), hexOf(1.0225601246249238), hexOf(0.5), hexOf(2), hexOf(1e-9), hexOf(1e9)];
  let worse = 0;
  let better = 0;
  let equal = 0;

  for (let i = 0; i < 500; i += 1) {
    const decP = prng.pick([0, 6, 8, 9, 18]);
    const decA = prng.pick([0, 6, 8, 9, 18]);
    const mulP = prng.pick(multipliers);
    const mulA = prng.pick(multipliers);
    const outP = 1n + prng.belowBig(prng.pick([1_000n, 10n ** 9n, 10n ** 18n, 1n << 63n]));
    const outA = 1n + prng.belowBig(prng.pick([1_000n, 10n ** 9n, 10n ** 18n, 1n << 63n]));

    const preferred = quote({ mint: MINT_P, outputRaw: outP, decimals: decP, multiplierHex: mulP });
    const alternative = quote({ mint: MINT_A, outputRaw: outA, decimals: decA, multiplierHex: mulA });
    const comparison = compareQuotes(preferred, alternative);
    const label = `case ${i} (${outP}/${decP}/${mulP} vs ${outA}/${decA}/${mulA})`;

    assertIsCeilingOfRelativeShortfall(comparison.preferredSharesEquivalent, comparison.alternativeSharesEquivalent, comparison.additionalCostBps, label);

    const sign = cmp(comparison.preferredSharesEquivalent, comparison.alternativeSharesEquivalent);
    assert.equal(comparison.difference.sign, sign, label);
    if (sign > 0) {
      worse += 1;
      assert.ok(comparison.additionalCostBps > 0n, `${label}: a worse alternative must cost more than zero bps`);
      assert.equal(comparison.economicEffect.kind, "ADDITIONAL_COST");
    } else if (sign < 0) {
      better += 1;
      // A benefit may round to zero, but must never present as a cost.
      assert.ok(comparison.additionalCostBps <= 0n, `${label}: a better alternative was priced as a cost`);
      assert.equal(comparison.economicEffect.kind, "BETTER_VALUE");
    } else {
      equal += 1;
      assert.equal(comparison.additionalCostBps, 0n, label);
      assert.equal(comparison.economicEffect.kind, "ECONOMICALLY_EQUAL");
    }
  }
  assert.ok(worse > 50 && better > 50, `corpus was one-sided: ${worse} worse, ${better} better, ${equal} equal`);
});

test("improving the alternative can never make the cost worse", () => {
  const prng = new Prng(PROPERTY_SEED);
  for (let i = 0; i < 200; i += 1) {
    const decimals = prng.pick([0, 6, 9]);
    const multiplierHex = prng.pick([hexOf(1), hexOf(1.25), hexOf(0.75)]);
    const outP = 10n ** 9n + prng.belowBig(10n ** 9n);
    const base = 1n + prng.belowBig(2n * 10n ** 9n);
    const preferred = quote({ mint: MINT_P, outputRaw: outP, decimals, multiplierHex });

    let previous: bigint | null = null;
    for (const step of [0n, 1n, 7n, 1_000n, 10n ** 6n]) {
      const comparison = compareQuotes(preferred, quote({ mint: MINT_A, outputRaw: base + step, decimals, multiplierHex }));
      if (previous !== null) {
        assert.ok(comparison.additionalCostBps <= previous, `case ${i}: cost rose from ${previous} to ${comparison.additionalCostBps} when the alternative improved`);
      }
      previous = comparison.additionalCostBps;
    }
  }
});

test("the cost limit is one-sided at the exact boundary", () => {
  // At a scale of 100000 raw units, one unit is a tenth of a basis point, so
  // the two sides of the 25 bps boundary are actually reachable.
  const preferred = quote({ mint: MINT_P, outputRaw: 100_000n, decimals: 0, multiplierHex: hexOf(1) });
  const alternative = (outputRaw: bigint) => quote({ mint: MINT_A, outputRaw, decimals: 0, multiplierHex: hexOf(1) });

  // 99750 is a shortfall of exactly 25.0 bps.
  const exact = compareQuotes(preferred, alternative(99_750n));
  assert.equal(exact.additionalCostBps, 25n);
  for (const [limit, allowed] of [[24n, false], [25n, true], [26n, true]] as const) {
    assert.equal(exceedsCostLimit(exact, { maxAdditionalCostBps: limit }) === null, allowed, `limit ${limit}`);
  }

  // 24.9 bps must round UP to 25, never down to 24: a cost is never understated.
  const justUnder = compareQuotes(preferred, alternative(99_751n));
  assert.equal(justUnder.additionalCostBps, 25n);
  assert.ok(exceedsCostLimit(justUnder, { maxAdditionalCostBps: 24n }) !== null, "24.9 bps must not slip under a 24 bps limit");
  assert.equal(exceedsCostLimit(justUnder, { maxAdditionalCostBps: 25n }), null);

  // 25.1 bps must round up to 26 and fail a 25 bps limit.
  const justOver = compareQuotes(preferred, alternative(99_749n));
  assert.equal(justOver.additionalCostBps, 26n);
  assert.ok(exceedsCostLimit(justOver, { maxAdditionalCostBps: 25n }) !== null);

  // Equal share-equivalents cost nothing and pass a zero limit.
  const equal = compareQuotes(preferred, alternative(100_000n));
  assert.equal(equal.additionalCostBps, 0n);
  assert.equal(exceedsCostLimit(equal, { maxAdditionalCostBps: 0n }), null);
});

test("a sub-basis-point shortfall still rounds up to a whole basis point", () => {
  // 1 part in 10 million: far below one bp, but it is a cost, so it is disclosed as 1 bp.
  const preferred = quote({ mint: MINT_P, outputRaw: 10_000_000n, decimals: 0, multiplierHex: hexOf(1) });
  const comparison = compareQuotes(preferred, quote({ mint: MINT_A, outputRaw: 9_999_999n, decimals: 0, multiplierHex: hexOf(1) }));
  assert.equal(comparison.additionalCostBps, 1n);
  assert.equal(comparison.economicEffect.kind, "ADDITIONAL_COST");
  assert.ok(exceedsCostLimit(comparison, { maxAdditionalCostBps: 0n }) !== null);
});

test("a sub-basis-point benefit is understated, never inflated", () => {
  const preferred = quote({ mint: MINT_P, outputRaw: 10_000_000n, decimals: 0, multiplierHex: hexOf(1) });
  const comparison = compareQuotes(preferred, quote({ mint: MINT_A, outputRaw: 10_000_001n, decimals: 0, multiplierHex: hexOf(1) }));
  assert.equal(comparison.economicEffect.kind, "BETTER_VALUE");
  assert.equal(comparison.economicEffect.bps, 0n, "an understated benefit reports 0, not 1");
  assert.ok(comparison.additionalCostBps <= 0n);
  // Better still passes the economic bound, at any limit.
  assert.equal(exceedsCostLimit(comparison, { maxAdditionalCostBps: 0n }), null);
});

test("a large better alternative passes every bound but is still only a comparison", () => {
  const preferred = quote({ mint: MINT_P, outputRaw: 1_000n, decimals: 0, multiplierHex: hexOf(1) });
  const comparison = compareQuotes(preferred, quote({ mint: MINT_A, outputRaw: 100_000n, decimals: 0, multiplierHex: hexOf(1) }));
  assert.equal(comparison.economicEffect.kind, "BETTER_VALUE");
  assert.ok(comparison.additionalCostBps < 0n);
  assert.equal(exceedsCostLimit(comparison, { maxAdditionalCostBps: 0n }), null);
});

test("zero output can never authorize a reroute", () => {
  const preferred = quote({ mint: MINT_P, outputRaw: 10_000n, decimals: 0, multiplierHex: hexOf(1) });
  // An alternative delivering nothing is refused by the economic bound
  // whatever the arithmetic says about it.
  const nothing = compareQuotes(preferred, quote({ mint: MINT_A, outputRaw: 0n, decimals: 0, multiplierHex: hexOf(1) }));
  assert.equal(nothing.additionalCostBps, BPS);
  for (const limit of [0n, 25n, BPS, 1_000_000n]) {
    assert.ok(exceedsCostLimit(nothing, { maxAdditionalCostBps: limit }) !== null, `limit ${limit} accepted a zero-output alternative`);
  }
  // A preferred quote delivering nothing has no denominator to compare against.
  assert.throws(
    () => compareQuotes(quote({ mint: MINT_P, outputRaw: 0n, decimals: 0, multiplierHex: hexOf(1) }), quote({ mint: MINT_A, outputRaw: 1n, decimals: 0, multiplierHex: hexOf(1) })),
    NormalizationError,
  );
});

test("quotes for different trades are never compared", () => {
  const preferred = quote({ mint: MINT_P, outputRaw: 10_000n, decimals: 0, multiplierHex: hexOf(1) });
  const mismatches: [string, NormalizedQuote][] = [
    ["underlying", { ...quote({ mint: MINT_A, outputRaw: 9_000n, decimals: 0, multiplierHex: hexOf(1) }), underlying: "OTHER" }],
    ["input notional", quote({ mint: MINT_A, outputRaw: 9_000n, decimals: 0, multiplierHex: hexOf(1), inputRaw: 4_000_000n })],
    ["input mint", { ...quote({ mint: MINT_A, outputRaw: 9_000n, decimals: 0, multiplierHex: hexOf(1) }), inputMint: "SomeOtherInputMint1111111111111111111111111" }],
    ["state binding", { ...quote({ mint: MINT_A, outputRaw: 9_000n, decimals: 0, multiplierHex: hexOf(1) }), state: state(MINT_P, 0, hexOf(1)) }],
  ];
  for (const [label, alternative] of mismatches) {
    assert.throws(() => compareQuotes(preferred, alternative), NormalizationError, `${label} was compared anyway`);
  }
});

test("the effective multiplier follows the phase, so crossing T changes the economics", () => {
  const pending: EconomicState = {
    mint: MINT_P,
    decimals: 6,
    multiplierHex: hexOf(1),
    newMultiplierHex: hexOf(2),
    effectiveTimestamp: 1_000n,
    phase: ActivationPhase.Pending,
    paused: null,
  };
  const activated: EconomicState = { ...pending, phase: ActivationPhase.Activated };
  const base = quote({ mint: MINT_P, outputRaw: 1_000_000n, decimals: 6, multiplierHex: hexOf(1) });
  const before = compareQuotes({ ...base, state: pending }, { ...base, mint: MINT_A, state: { ...pending, mint: MINT_A } });
  const after = compareQuotes({ ...base, state: activated }, { ...base, mint: MINT_A, state: { ...activated, mint: MINT_A } });
  // Same raw amounts, but the share-equivalents double once the phase flips.
  assert.equal(cmp(after.preferredSharesEquivalent, before.preferredSharesEquivalent), 1);
  assert.equal(after.preferredSharesEquivalent.num * before.preferredSharesEquivalent.den, 2n * before.preferredSharesEquivalent.num * after.preferredSharesEquivalent.den);
});
