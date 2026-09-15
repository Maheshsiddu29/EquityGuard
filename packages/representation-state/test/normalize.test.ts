/**
 * INV-VAL-01 — Cross-Issuer Economic Comparability.
 * Route quality across representations is compared in share-equivalents
 * (outAmountRaw × effective multiplier / 10^decimals), never raw amounts, and
 * rounding never understates the cost of switching representation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  NormalizationError,
  compareQuotes,
  compareRationals,
  formatRationalFloor,
  multiplierToRational,
  sharesEquivalent,
  withinToleranceBps,
  type NormalizedQuote,
} from "../src/index.ts";

function f64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

/** Quote whose bound state is activated with `effectiveMultiplier` and no scheduled change. */
function quote(partial: Partial<Omit<NormalizedQuote, "state">> & { decimals?: number; effectiveMultiplier?: Uint8Array }): NormalizedQuote {
  const { decimals = 8, effectiveMultiplier = f64(1), ...rest } = partial;
  const base = { underlying: "KO", issuer: "xStocks" as const, mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", inputRaw: 5_000_000n, outputRaw: 100_000_000n, ...rest };
  const multiplierHex = Buffer.from(effectiveMultiplier).toString("hex");
  return {
    ...base,
    state: { mint: base.mint, decimals, multiplierHex, newMultiplierHex: multiplierHex, effectiveTimestamp: 0n, phase: ActivationPhase.Activated, paused: null },
  };
}

test("A: same economic output, different decimals, same multiplier compare equal", () => {
  const eightDecimals = sharesEquivalent({ outputRaw: 5_529_727n, decimals: 8, effectiveMultiplier: f64(1.0183317967386898) });
  const nineDecimals = sharesEquivalent({ outputRaw: 55_297_270n, decimals: 9, effectiveMultiplier: f64(1.0183317967386898) });
  assert.equal(compareRationals(eightDecimals, nineDecimals), 0);
  assert.ok(withinToleranceBps(eightDecimals, nineDecimals, 0n));
});

test("B: same raw output with different multipliers is not economically equal", () => {
  const a = sharesEquivalent({ outputRaw: 5_529_727n, decimals: 8, effectiveMultiplier: f64(1) });
  const b = sharesEquivalent({ outputRaw: 5_529_727n, decimals: 8, effectiveMultiplier: f64(1.0183317967386898) });
  assert.equal(compareRationals(a, b), -1);
  assert.ok(!withinToleranceBps(a, b, 1n));
});

test("C: different raw outputs and decimals with the same share output compare equal", () => {
  const scaled = sharesEquivalent({ outputRaw: 100_000_000n, decimals: 8, effectiveMultiplier: f64(1.25) });
  const unscaled = sharesEquivalent({ outputRaw: 1_250_000_000n, decimals: 9, effectiveMultiplier: f64(1) });
  assert.equal(compareRationals(scaled, unscaled), 0);
});

test("D: an f64 representation discrepancy falls within an explicit tolerance, not exact equality", () => {
  // 1.1 has no exact binary representation.
  const viaMultiplier = sharesEquivalent({ outputRaw: 1_000_000_000n, decimals: 9, effectiveMultiplier: f64(1.1) });
  const direct = sharesEquivalent({ outputRaw: 1_100_000_000n, decimals: 9, effectiveMultiplier: f64(1) });
  assert.notEqual(compareRationals(viaMultiplier, direct), 0);
  assert.ok(withinToleranceBps(viaMultiplier, direct, 1n));
  assert.ok(!withinToleranceBps(viaMultiplier, direct, 0n));
});

test("E: a fractional-bps benefit of the alternative is not overstated", () => {
  // Alternative delivers 1/30000 more shares: a 0.333 bps benefit rounds to 0, not to -1.
  const comparison = compareQuotes(quote({ outputRaw: 30_000n }), quote({ issuer: "Ondo", outputRaw: 30_001n }), { toleranceBps: 0n });
  assert.equal(compareRationals(comparison.alternativeSharesEquivalent, comparison.preferredSharesEquivalent), 1);
  assert.equal(comparison.conservativeCostDeltaBps, 0n);
});

test("F: an alternative worse by a tiny amount is never displayed as cheaper or free", () => {
  // 0.333 bps worse rounds up to a 1 bps cost.
  const comparison = compareQuotes(quote({ outputRaw: 30_000n }), quote({ issuer: "Ondo", outputRaw: 29_999n }), { toleranceBps: 0n });
  assert.equal(comparison.conservativeCostDeltaBps, 1n);
  assert.ok(comparison.conservativeCostDeltaBps > 0n);
});

test("G: invalid or non-positive multipliers fail closed", () => {
  for (const bad of [f64(0), f64(-0), f64(-1), f64(Number.NaN), f64(Number.POSITIVE_INFINITY), f64(5e-324), new Uint8Array(7)]) {
    assert.throws(
      () => sharesEquivalent({ outputRaw: 1n, decimals: 8, effectiveMultiplier: bad }),
      (e) => e instanceof NormalizationError && e.code === "InvalidMultiplier",
    );
  }
});

test("H: missing or invalid decimals are an explicit error, never guessed", () => {
  for (const decimals of [null, undefined, -1, 1.5, 256]) {
    assert.throws(
      () => sharesEquivalent({ outputRaw: 1n, decimals, effectiveMultiplier: f64(1) }),
      (e) => e instanceof NormalizationError && (e.code === "MissingDecimals" || e.code === "InvalidDecimals"),
      String(decimals),
    );
  }
});

test("cost delta derives from share-equivalents, not raw output", () => {
  // Raw output is 10x larger for the 9-decimal alternative, but economically identical.
  const comparison = compareQuotes(
    quote({ outputRaw: 5_529_727n, decimals: 8 }),
    quote({ issuer: "Ondo", outputRaw: 55_297_270n, decimals: 9 }),
    { toleranceBps: 0n },
  );
  assert.equal(comparison.conservativeCostDeltaBps, 0n);
  assert.ok(comparison.withinTolerance);

  // Same raw output, but the alternative's lower multiplier delivers fewer shares: a real cost.
  const worse = compareQuotes(
    quote({ outputRaw: 1_000_000n, effectiveMultiplier: f64(1.02) }),
    quote({ issuer: "Ondo", outputRaw: 1_000_000n, effectiveMultiplier: f64(1) }),
    { toleranceBps: 1n },
  );
  assert.equal(worse.conservativeCostDeltaBps, 197n); // (1.02 - 1) / 1.02 = 196.08 bps, rounded up
  assert.ok(!worse.withinTolerance);
});

test("quotes must share the same input notional and a positive preferred output", () => {
  assert.throws(
    () => compareQuotes(quote({}), quote({ inputRaw: 4_999_999n }), { toleranceBps: 0n }),
    (e) => e instanceof NormalizationError && e.code === "NotionalMismatch",
  );
  assert.throws(
    () => compareQuotes(quote({ outputRaw: 0n }), quote({}), { toleranceBps: 0n }),
    (e) => e instanceof NormalizationError && e.code === "NonPositiveOutput",
  );
  assert.throws(
    () => compareQuotes(quote({}), quote({}), { toleranceBps: -1n }),
    (e) => e instanceof NormalizationError && e.code === "InvalidTolerance",
  );
  assert.throws(
    () => compareQuotes(quote({}), quote({ underlying: "UNH" }), { toleranceBps: 0n }),
    (e) => e instanceof NormalizationError && e.code === "UnderlyingMismatch",
  );
});

test("comparisons carry the identity and economic states of the quotes they were computed from", () => {
  const koon = "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo";
  const preferred = quote({});
  const alternative = quote({ issuer: "Ondo", mint: koon });
  const comparison = compareQuotes(preferred, alternative, { toleranceBps: 0n });
  assert.deepEqual(
    [comparison.underlying, comparison.preferredMint, comparison.alternativeMint, comparison.inputRaw],
    ["KO", "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", koon, 5_000_000n],
  );
  assert.deepEqual([comparison.preferredState, comparison.alternativeState], [preferred.state, alternative.state]);
});

test("a quote cannot be normalized with another mint's state", () => {
  const koon = "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo";
  const borrowed = { ...quote({ issuer: "Ondo", mint: koon }), state: quote({}).state };
  assert.throws(() => compareQuotes(quote({}), borrowed, { toleranceBps: 0n }), (e) => e instanceof NormalizationError && e.code === "StateMismatch");
});

test("normalization uses the phase-effective multiplier of the bound state", () => {
  const pending = quote({ effectiveMultiplier: f64(1) });
  const scheduled = { ...pending.state, newMultiplierHex: Buffer.from(f64(2)).toString("hex"), effectiveTimestamp: 100n };
  const atPending = compareQuotes({ ...pending, state: { ...scheduled, phase: ActivationPhase.Pending } }, pending, { toleranceBps: 0n });
  const atActivated = compareQuotes({ ...pending, state: { ...scheduled, phase: ActivationPhase.Activated } }, pending, { toleranceBps: 0n });
  assert.equal(atPending.conservativeCostDeltaBps, 0n);
  assert.equal(atActivated.conservativeCostDeltaBps, 5000n); // 2 vs 1 share-equivalents
});

test("stored multipliers convert to their exact dyadic rational value", () => {
  assert.deepEqual(multiplierToRational(f64(1.25)), { num: 5n, den: 4n });
  assert.deepEqual(multiplierToRational(f64(2 ** 60)), { num: 2n ** 60n, den: 1n });
  // 1.1 is stored as 2476979795053773 / 2^51, not 11/10.
  assert.deepEqual(multiplierToRational(f64(1.1)), { num: 2476979795053773n, den: 2n ** 51n });
  // Real KOx effective multiplier at the Jupiter fixture recording.
  const kox = multiplierToRational(Uint8Array.from(Buffer.from("73833748164bf03f", "hex")));
  assert.equal(kox.den, 2n ** 52n);
});

test("display formatting rounds down and never adds precision", () => {
  const shares = sharesEquivalent({ outputRaw: 5_529_727n, decimals: 8, effectiveMultiplier: f64(1.0183317967386898) });
  assert.equal(formatRationalFloor(shares, 6), "0.056310");
  assert.equal(formatRationalFloor({ num: 7n, den: 2n }, 0), "3");
});
