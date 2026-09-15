import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import {
  Decision,
  RepresentationState,
  StateSource,
  compareQuotes,
  decide,
  disclosureDigestOf,
  findRepresentationBySymbol,
  type ChainObservation,
  type EconomicState,
  type NormalizedQuote,
  type QuoteComparison,
  type ResolvedRepresentationState,
} from "../src/index.ts";
import { TEST_QUOTE_CONTEXT } from "./fixtures.ts";

/** Decimals of the synthetic chain states: KOon uses 9 to exercise normalization. */
const DECIMALS: Record<string, number> = { KOon: 9 };

/** Activated, unscheduled chain observation with multiplier 1. */
function chainObservation(mint: string, decimals: number): ChainObservation {
  const one = f64(1);
  return {
    kind: "decoded",
    mint,
    slot: 1n,
    blockTime: 2n,
    observedAt: null,
    chainUnixTimestamp: 1_789_400_000n,
    decimals,
    paused: false,
    protectedState: { multiplier: one, newMultiplier: one, newMultiplierEffectiveTimestamp: 0n },
    hasScheduledChange: false,
    phase: ActivationPhase.Activated,
  };
}

function resolved(
  symbol: string,
  state: RepresentationState | null,
  stateSource: StateSource | null = StateSource.CHAIN,
): ResolvedRepresentationState {
  const rep = findRepresentationBySymbol(symbol)!;
  return {
    underlying: rep.underlying,
    issuer: rep.issuer,
    symbol,
    mint: rep.mint,
    state,
    stateSource,
    chainState: state,
    apiState: null,
    slot: 1n,
    blockTime: 2n,
    observedAt: null,
    reason: `test ${state}`,
    chainObservation: chainObservation(rep.mint, DECIMALS[symbol] ?? 8),
    transitionPolicy: null,
    apiObservation: null,
  };
}

function f64(value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return b;
}

const INPUT_RAW = 5_000_000n;
const KOX_MINT = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ";
const KOON_MINT = "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo";
const stateOf = (mint: string, decimals: number): EconomicState => ({
  mint,
  decimals,
  multiplierHex: Buffer.from(f64(1)).toString("hex"),
  newMultiplierHex: Buffer.from(f64(1)).toString("hex"),
  effectiveTimestamp: 0n,
  phase: ActivationPhase.Activated,
  paused: false,
});
/** Correctly bound comparison for KOx (preferred) vs KOon (alternative) at INPUT_RAW, on the states `resolved` carries. */
const COMPARISON: QuoteComparison = compareQuotes(
  { ...TEST_QUOTE_CONTEXT, underlying: "KO", inputRaw: INPUT_RAW, issuer: "xStocks", mint: KOX_MINT, outputRaw: 10_000n, state: stateOf(KOX_MINT, 8) } satisfies NormalizedQuote,
  { ...TEST_QUOTE_CONTEXT, underlying: "KO", inputRaw: INPUT_RAW, issuer: "Ondo", mint: KOON_MINT, outputRaw: 99_800n, state: stateOf(KOON_MINT, 9) },
  { toleranceBps: 25n },
);

/** Hard reroute policy the comparison above was computed with. */
const POLICY = { maxCostBps: 25n };

test("preferred SAFE uses the preferred representation, regardless of alternatives", () => {
  for (const alternative of [null, resolved("KOon", RepresentationState.UNKNOWN), resolved("KOon", null, StateSource.CONFLICT)]) {
    const result = decide({ preferred: resolved("KOx", RepresentationState.SAFE), alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: null });
    assert.equal(result.decision, Decision.USE_PREFERRED);
    assert.equal(result.disclosure, null);
  }
});

test("unsafe preferred with a SAFE quoted alternative within tolerance requires consent", () => {
  for (const unsafe of [RepresentationState.TRANSITION, RepresentationState.PAUSED]) {
    const result = decide({ preferred: resolved("KOx", unsafe), alternative: resolved("KOon", RepresentationState.SAFE), reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: COMPARISON });
    assert.equal(result.decision, Decision.REQUIRES_CONSENT, unsafe);
    const d = result.disclosure;
    assert.ok(d);
    assert.deepEqual([d.original.issuer, d.original.symbol, d.alternative.issuer, d.alternative.symbol], ["xStocks", "KOx", "Ondo", "KOon"]);
    assert.equal(d.conservativeCostDeltaBps, 20n); // 0.0998 vs 0.1 shares: 20 bps, derived from share-equivalents
    assert.equal(d.preferredSharesEquivalent, "0.000100000000");
    assert.equal(d.alternativeSharesEquivalent, "0.000099800000");
    assert.match(d.reason, new RegExp(unsafe));
    assert.match(d.notice, /not legally or economically identical/);
  }
});

test("the state layer never returns USE_ALTERNATIVE, and the disclosure digest commits to its content", () => {
  const input = { preferred: resolved("KOx", RepresentationState.TRANSITION), alternative: resolved("KOon", RepresentationState.SAFE), inputRaw: INPUT_RAW, comparison: COMPARISON, reroutePolicy: POLICY };
  const result = decide(input);
  assert.equal(result.decision, Decision.REQUIRES_CONSENT);
  const d = result.disclosure!;
  assert.deepEqual([d.comparisonKey, d.inputRaw, d.policyMaxCostBps], [COMPARISON.comparisonKey, INPUT_RAW, 25n]);
  assert.equal(d.disclosureDigest, disclosureDigestOf(d));
  assert.match(d.disclosureDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(disclosureDigestOf({ ...d, conservativeCostDeltaBps: 0n }), d.disclosureDigest);
  assert.deepEqual(decide(input).disclosure, d);
});

test("a SAFE alternative outside the hard tolerance is NO_ACCEPTABLE_ROUTE, never offered for consent", () => {
  const preferred = resolved("KOx", RepresentationState.TRANSITION);
  const alternative = resolved("KOon", RepresentationState.SAFE);
  const quote = (outputRaw: bigint, issuer: "xStocks" | "Ondo", mint: string, decimals: number): NormalizedQuote => ({ ...TEST_QUOTE_CONTEXT, underlying: "KO", inputRaw: INPUT_RAW, issuer, mint, outputRaw, state: stateOf(mint, decimals) });
  const cases: [string, QuoteComparison, { maxCostBps: bigint }][] = [
    ["cost above policy (20 bps > 10 bps)", compareQuotes(quote(10_000n, "xStocks", KOX_MINT, 8), quote(99_800n, "Ondo", KOON_MINT, 9), { toleranceBps: 10n }), { maxCostBps: 10n }],
    ["10,000 bps: alternative delivers 1 raw unit", compareQuotes(quote(10_000n, "xStocks", KOX_MINT, 8), quote(1n, "Ondo", KOON_MINT, 9), { toleranceBps: 25n }), POLICY],
    ["alternative delivers nothing", compareQuotes(quote(10_000n, "xStocks", KOX_MINT, 8), quote(0n, "Ondo", KOON_MINT, 9), { toleranceBps: 25n }), POLICY],
  ];
  for (const [label, comparison, reroutePolicy] of cases) {
    const result = decide({ preferred, alternative, reroutePolicy, inputRaw: INPUT_RAW, comparison });
    assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.NO_ACCEPTABLE_ROUTE, "ALTERNATIVE_OUTSIDE_TOLERANCE", null], label);
    assert.notEqual(result.decision, Decision.NO_SAFE_ROUTE, label);
  }
  // A comparison computed under a different tolerance than the policy is not this decision's comparison.
  const loose = compareQuotes(quote(10_000n, "xStocks", KOX_MINT, 8), quote(99_800n, "Ondo", KOON_MINT, 9), { toleranceBps: 10_000n });
  const mismatch = decide({ preferred, alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: loose });
  assert.deepEqual([mismatch.decision, mismatch.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_MISMATCH"]);
});

test("no SAFE alternative is NO_SAFE_ROUTE", () => {
  const preferred = resolved("KOx", RepresentationState.TRANSITION);
  const cases: [ResolvedRepresentationState | null, string][] = [
    [null, "NO_ALTERNATIVE"],
    [resolved("KOon", RepresentationState.PAUSED), "ALTERNATIVE_NOT_SAFE"],
    [resolved("KOon", RepresentationState.TRANSITION), "ALTERNATIVE_NOT_SAFE"],
    [resolved("UNHon", RepresentationState.SAFE), "ALTERNATIVE_NOT_SAME_UNDERLYING"],
    [resolved("KOx", RepresentationState.SAFE), "ALTERNATIVE_NOT_SAME_UNDERLYING"],
  ];
  for (const [alternative, reasonCode] of cases) {
    const result = decide({ preferred, alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: COMPARISON });
    assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.NO_SAFE_ROUTE, reasonCode, null]);
  }
});

test("a SAFE alternative with a missing quote is UNKNOWN_STATE, never offered, even with consent", () => {
  for (const unsafe of [RepresentationState.TRANSITION, RepresentationState.PAUSED]) {
    for (const reroutePolicy of [POLICY]) {
      const result = decide({ preferred: resolved("KOx", unsafe), alternative: resolved("KOon", RepresentationState.SAFE), reroutePolicy, inputRaw: INPUT_RAW, comparison: null });
      assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.UNKNOWN_STATE, "ALTERNATIVE_QUOTE_UNAVAILABLE", null]);
    }
  }
});

test("NO_SAFE_ROUTE means no SAFE eligible alternative exists, independent of quotes", () => {
  for (const comparison of [COMPARISON, null]) {
    const result = decide({ preferred: resolved("KOx", RepresentationState.TRANSITION), alternative: resolved("KOon", RepresentationState.PAUSED), reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison });
    assert.equal(result.decision, Decision.NO_SAFE_ROUTE);
  }
});

test("a correctly bound comparison within tolerance reaches REQUIRES_CONSENT and no further", () => {
  const base = { preferred: resolved("KOx", RepresentationState.TRANSITION), alternative: resolved("KOon", RepresentationState.SAFE), inputRaw: INPUT_RAW, comparison: COMPARISON };
  const result = decide({ ...base, reroutePolicy: POLICY });
  assert.deepEqual([result.decision, result.reasonCode], [Decision.REQUIRES_CONSENT, "CONSENT_REQUIRED"]);
});

test("a comparison bound to a different trade never authorizes a reroute", () => {
  const preferred = resolved("KOx", RepresentationState.TRANSITION);
  const alternative = resolved("KOon", RepresentationState.SAFE);
  const cases: [string, QuoteComparison, bigint][] = [
    ["wrong preferred mint", { ...COMPARISON, preferredMint: resolved("UNHx", null).mint }, INPUT_RAW],
    ["wrong alternative mint", { ...COMPARISON, alternativeMint: resolved("CRMon", null).mint }, INPUT_RAW],
    ["wrong underlying", { ...COMPARISON, underlying: "UNH" }, INPUT_RAW],
    ["swapped mints", { ...COMPARISON, preferredMint: KOON_MINT, alternativeMint: KOX_MINT }, INPUT_RAW],
    ["wrong input amount", COMPARISON, INPUT_RAW + 1n],
  ];
  for (const [label, comparison, inputRaw] of cases) {
    for (const reroutePolicy of [POLICY]) {
      const result = decide({ preferred, alternative, reroutePolicy, inputRaw, comparison });
      assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_MISMATCH", null], label);
      assert.match(result.reason, /does not match this decision/, label);
    }
  }
});

test("UNKNOWN or conflicting required observations yield UNKNOWN_STATE", () => {
  const safeKoon = resolved("KOon", RepresentationState.SAFE, StateSource.BOTH_AGREE);
  const cases: [ResolvedRepresentationState, ResolvedRepresentationState | null, string][] = [
    [resolved("KOx", RepresentationState.UNKNOWN), safeKoon, "PREFERRED_STATE_UNKNOWN"],
    [resolved("KOon", null, StateSource.CONFLICT), resolved("KOx", RepresentationState.SAFE), "PREFERRED_STATE_CONFLICT"],
    [resolved("KOon", RepresentationState.UNKNOWN, null), null, "PREFERRED_STATE_UNKNOWN"],
    [resolved("KOx", RepresentationState.TRANSITION), resolved("KOon", RepresentationState.UNKNOWN), "ALTERNATIVE_STATE_UNKNOWN"],
    [resolved("KOx", RepresentationState.TRANSITION), resolved("KOon", null, StateSource.CONFLICT), "ALTERNATIVE_STATE_CONFLICT"],
  ];
  for (const [preferred, alternative, reasonCode] of cases) {
    const result = decide({ preferred, alternative, reroutePolicy: POLICY, inputRaw: INPUT_RAW, comparison: COMPARISON });
    assert.deepEqual([result.decision, result.reasonCode], [Decision.UNKNOWN_STATE, reasonCode]);
  }
});

test("decisions never throw for expected product states", () => {
  const states = [RepresentationState.SAFE, RepresentationState.TRANSITION, RepresentationState.PAUSED, RepresentationState.UNKNOWN, null];
  for (const p of states) {
    for (const a of [...states, undefined]) {
      for (const reroutePolicy of [POLICY]) {
        for (const comparison of [COMPARISON, null]) {
          const alternative = a === undefined ? null : resolved("KOon", a, a === null ? StateSource.CONFLICT : StateSource.CHAIN);
          const preferred = resolved("KOx", p, p === null ? StateSource.CONFLICT : StateSource.CHAIN);
          assert.doesNotThrow(() => decide({ preferred, alternative, reroutePolicy, inputRaw: INPUT_RAW, comparison }));
        }
      }
    }
  }
});
