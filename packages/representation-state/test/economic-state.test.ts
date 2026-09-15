/**
 * Economic-state binding: a normalized comparison is valid only for the exact
 * state it was built against, including the clock-evaluated phase.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  Decision,
  RepresentationState,
  StateSource,
  compareQuotes,
  decide,
  economicStateMismatches,
  economicStateOf,
  findRepresentationBySymbol,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  type ChainEvidence,
  type QuoteComparison,
  type ResolvedRepresentationState,
} from "../src/index.ts";
import { TEST_POLICY, TEST_QUOTE_CONTEXT, TOKEN_2022, mainnetMint, withPaused, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
const T = 1_789_432_200n;
const INPUT_RAW = 5_000_000n;
const OLD = 1.0183317967386898;
const NEW = 1.0225601246249238;

function observe(mint: string, data: Uint8Array, chainUnixTimestamp: bigint | null, slot = 1n): ChainEvidence {
  return observeMintAccount({ mint, owner: TOKEN_2022, data, slot, blockTime: null, observedAt: null, chainUnixTimestamp });
}

/** KOx with a scheduled change at T; KOon activated and unscheduled. */
const KOX_SCHEDULED = withScaledUi(mainnetMint("KOx"), { multiplier: OLD, newMultiplier: NEW, effectiveTimestamp: T });
const KOON_SAFE = withScaledUi(mainnetMint("KOon"), { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, effectiveTimestamp: T - 1556n });

/** Far outside the window so KOx is SAFE; KOx is preferred, KOon the alternative. */
const BEFORE = T - 3_600n;

function resolvePair(koxData: Uint8Array, koxTime: bigint, koonData: Uint8Array = KOON_SAFE, koonTime = koxTime) {
  return {
    kox: resolveXStocksState(KOX, observe(KOX.mint, koxData, koxTime), TEST_POLICY),
    koon: resolveOndoState(KOON, { chain: observe(KOON.mint, koonData, koonTime), api: null }, TEST_POLICY),
  };
}

function comparisonFor(preferred: ResolvedRepresentationState, alternative: ResolvedRepresentationState, inputRaw = INPUT_RAW): QuoteComparison {
  const quote = (r: ResolvedRepresentationState, outputRaw: bigint) => {
    const state = economicStateOf(r.chainObservation);
    assert.ok(state);
    return { ...TEST_QUOTE_CONTEXT, underlying: r.underlying, issuer: r.issuer, mint: r.mint, inputRaw, outputRaw, state };
  };
  return compareQuotes(quote(preferred, 5_450_395n), quote(alternative, 5_400_000n), { toleranceBps: 0n });
}

/** The decision a bound comparison authorizes when the preferred side is unsafe. */
function decideWith(comparison: QuoteComparison, preferred: ResolvedRepresentationState, alternative: ResolvedRepresentationState, inputRaw = INPUT_RAW) {
  const unsafe = { ...preferred, state: RepresentationState.TRANSITION, reason: "test: unsafe preferred" };
  return decide({ preferred: unsafe, alternative, policy: { allowCrossIssuerReroute: true }, inputRaw, comparison });
}

test("binding is exact values, independent of slot and observation time", () => {
  const a = economicStateOf(observe(KOX.mint, KOX_SCHEDULED, BEFORE, 10n));
  const b = economicStateOf(observe(KOX.mint, KOX_SCHEDULED, BEFORE + 600n, 99n));
  assert.ok(a && b);
  assert.deepEqual(economicStateMismatches(a, b), []);
  assert.deepEqual(
    [a.multiplierHex, a.newMultiplierHex, a.effectiveTimestamp, a.phase, a.decimals, a.paused],
    [Buffer.from(new Float64Array([OLD]).buffer).toString("hex"), Buffer.from(new Float64Array([NEW]).buffer).toString("hex"), T, ActivationPhase.Pending, 8, false],
  );
  // Unknown state or unknown chain time has no binding.
  assert.equal(economicStateOf(observe(KOX.mint, KOX_SCHEDULED, null)), null);
  assert.equal(economicStateOf(observeMintAccount({ mint: KOX.mint, owner: "11111111111111111111111111111111", data: KOX_SCHEDULED, slot: 1n, blockTime: null, observedAt: null, chainUnixTimestamp: BEFORE })), null);
});

test("7. a state-bound comparison is accepted for identical economic state", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  // Re-observed later at a different slot, same state and phase.
  const later = resolvePair(KOX_SCHEDULED, BEFORE + 60n);
  const result = decideWith(comparison, later.kox, later.koon);
  assert.deepEqual([result.decision, result.reasonCode], [Decision.USE_ALTERNATIVE, "CONSENT_GIVEN"]);
});

test("8-10. a changed multiplier, newMultiplier or effective timestamp makes the comparison stale", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  const cases: [string, Uint8Array, RegExp][] = [
    ["multiplier", withScaledUi(KOX_SCHEDULED, { multiplier: 1.02 }), /preferred KOx: multiplierHex/],
    ["newMultiplier", withScaledUi(KOX_SCHEDULED, { newMultiplier: 1.03 }), /preferred KOx: newMultiplierHex/],
    ["effective timestamp", withScaledUi(KOX_SCHEDULED, { effectiveTimestamp: T + 60n }), /preferred KOx: effectiveTimestamp/],
  ];
  for (const [label, data, pattern] of cases) {
    const now = resolvePair(data, BEFORE);
    const result = decideWith(comparison, now.kox, now.koon);
    assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_STALE_STATE", null], label);
    assert.match(result.reason, pattern, label);
  }
  // The alternative side is bound as well: KOon's immediate update invalidates a comparison built before it.
  const koonUpdated = resolvePair(KOX_SCHEDULED, BEFORE, withScaledUi(KOON_SAFE, { multiplier: 1.03, newMultiplier: 1.03, effectiveTimestamp: BEFORE - 1n }));
  const stale = decideWith(comparison, koonUpdated.kox, koonUpdated.koon);
  assert.deepEqual([stale.decision, stale.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_STALE_STATE"]);
  assert.match(stale.reason, /alternative KOon: multiplierHex/);
});

test("11. a phase change caused only by the clock makes the comparison stale", () => {
  const built = resolvePair(KOX_SCHEDULED, T - 1n); // pending: old multiplier effective
  const comparison = comparisonFor(built.kox, built.koon);
  const after = resolvePair(KOX_SCHEDULED, T); // identical bytes, now activated
  const bytesBefore = built.kox.chainObservation;
  const bytesAfter = after.kox.chainObservation;
  assert.ok(bytesBefore?.kind === "decoded" && bytesAfter?.kind === "decoded");
  assert.deepEqual(bytesAfter.protectedState, bytesBefore.protectedState);
  const result = decideWith(comparison, after.kox, after.koon);
  assert.deepEqual([result.decision, result.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_STALE_STATE"]);
  assert.match(result.reason, /preferred KOx: phase 0 != 1/);
});

test("paused and decimals are part of the binding", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  const pausedState = economicStateOf(observe(KOX.mint, withPaused(KOX_SCHEDULED, true), BEFORE));
  assert.ok(pausedState);
  assert.deepEqual(economicStateMismatches(comparison.preferredQuote.state, pausedState), ["paused false != true"]);
  assert.deepEqual(economicStateMismatches(comparison.preferredQuote.state, { ...comparison.preferredQuote.state, decimals: 9 }), ["decimals 8 != 9"]);
});

test("12-13. a comparison cannot be reused for another mint or another input notional", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  const unh = findRepresentationBySymbol("UNHon")!;
  const otherMint = { ...built.koon, mint: unh.mint, underlying: "KO" };
  for (const [label, alternative, inputRaw] of [["mint", otherMint, INPUT_RAW], ["notional", built.koon, INPUT_RAW * 2n]] as const) {
    const result = decideWith(comparison, built.kox, alternative, inputRaw);
    assert.deepEqual([result.decision, result.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_MISMATCH"], label);
  }
});

test("a representation without a decoded chain state cannot satisfy a binding", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  const apiOnly = { ...built.koon, stateSource: StateSource.API, chainObservation: null };
  assert.equal(decideWith(comparison, built.kox, apiOnly).reasonCode, "QUOTE_COMPARISON_STALE_STATE");
});

test("14. a valid binding never rescues PAUSED, UNKNOWN or conflicting states", () => {
  const built = resolvePair(KOX_SCHEDULED, BEFORE);
  const comparison = comparisonFor(built.kox, built.koon);
  const cases: [ResolvedRepresentationState, Decision, string][] = [
    [{ ...built.koon, state: RepresentationState.PAUSED }, Decision.NO_SAFE_ROUTE, "ALTERNATIVE_NOT_SAFE"],
    [{ ...built.koon, state: RepresentationState.UNKNOWN }, Decision.UNKNOWN_STATE, "ALTERNATIVE_STATE_UNKNOWN"],
    [{ ...built.koon, state: null, stateSource: StateSource.CONFLICT }, Decision.UNKNOWN_STATE, "ALTERNATIVE_STATE_CONFLICT"],
  ];
  for (const [alternative, decision, reasonCode] of cases) {
    const result = decideWith(comparison, built.kox, alternative);
    assert.deepEqual([result.decision, result.reasonCode], [decision, reasonCode]);
  }
  const unknownPreferred = decide({ preferred: { ...built.kox, state: RepresentationState.UNKNOWN }, alternative: built.koon, policy: { allowCrossIssuerReroute: true }, inputRaw: INPUT_RAW, comparison });
  assert.deepEqual([unknownPreferred.decision, unknownPreferred.reasonCode], [Decision.UNKNOWN_STATE, "PREFERRED_STATE_UNKNOWN"]);
});
