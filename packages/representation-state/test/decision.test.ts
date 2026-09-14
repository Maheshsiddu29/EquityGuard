import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Decision,
  RepresentationState,
  StateSource,
  compareQuotes,
  decide,
  findRepresentationBySymbol,
  type NormalizedQuote,
  type QuoteComparison,
  type ResolvedRepresentationState,
} from "../src/index.ts";

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
    chainObservation: null,
    apiObservation: null,
  };
}

function f64(value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return b;
}

const quoteBase = { inputRaw: 5_000_000n, decimals: 8, effectiveMultiplier: f64(1) };
const COMPARISON: QuoteComparison = compareQuotes(
  { ...quoteBase, issuer: "xStocks", mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", outputRaw: 10_000n } satisfies NormalizedQuote,
  { ...quoteBase, issuer: "Ondo", mint: "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo", outputRaw: 99_800n, decimals: 9 },
  { toleranceBps: 5n },
);

const OFF = { allowCrossIssuerReroute: false };
const ON = { allowCrossIssuerReroute: true };

test("preferred SAFE uses the preferred representation, regardless of alternatives", () => {
  for (const alternative of [null, resolved("KOon", RepresentationState.UNKNOWN), resolved("KOon", null, StateSource.CONFLICT)]) {
    const result = decide({ preferred: resolved("KOx", RepresentationState.SAFE), alternative, policy: ON, comparison: null });
    assert.equal(result.decision, Decision.USE_PREFERRED);
    assert.equal(result.disclosure, null);
  }
});

test("unsafe preferred with a SAFE quoted alternative requires consent when consent is off", () => {
  for (const unsafe of [RepresentationState.TRANSITION, RepresentationState.PAUSED]) {
    const result = decide({ preferred: resolved("KOx", unsafe), alternative: resolved("KOon", RepresentationState.SAFE), policy: OFF, comparison: COMPARISON });
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

test("unsafe preferred with a SAFE quoted alternative uses it when consent is on, with the same disclosure", () => {
  const input = { preferred: resolved("KOx", RepresentationState.TRANSITION), alternative: resolved("KOon", RepresentationState.SAFE), comparison: COMPARISON };
  const withConsent = decide({ ...input, policy: ON });
  assert.equal(withConsent.decision, Decision.USE_ALTERNATIVE);
  assert.deepEqual(withConsent.disclosure, decide({ ...input, policy: OFF }).disclosure);
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
    const result = decide({ preferred, alternative, policy: ON, comparison: COMPARISON });
    assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.NO_SAFE_ROUTE, reasonCode, null]);
  }
});

test("a SAFE alternative without a normalized quote is not offered, even with consent", () => {
  for (const policy of [OFF, ON]) {
    const result = decide({ preferred: resolved("KOx", RepresentationState.PAUSED), alternative: resolved("KOon", RepresentationState.SAFE), policy, comparison: null });
    assert.deepEqual([result.decision, result.reasonCode, result.disclosure], [Decision.NO_SAFE_ROUTE, "ALTERNATIVE_QUOTE_UNAVAILABLE", null]);
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
    const result = decide({ preferred, alternative, policy: ON, comparison: COMPARISON });
    assert.deepEqual([result.decision, result.reasonCode], [Decision.UNKNOWN_STATE, reasonCode]);
  }
});

test("decisions never throw for expected product states", () => {
  const states = [RepresentationState.SAFE, RepresentationState.TRANSITION, RepresentationState.PAUSED, RepresentationState.UNKNOWN, null];
  for (const p of states) {
    for (const a of [...states, undefined]) {
      for (const policy of [OFF, ON]) {
        for (const comparison of [COMPARISON, null]) {
          const alternative = a === undefined ? null : resolved("KOon", a, a === null ? StateSource.CONFLICT : StateSource.CHAIN);
          const preferred = resolved("KOx", p, p === null ? StateSource.CONFLICT : StateSource.CHAIN);
          assert.doesNotThrow(() => decide({ preferred, alternative, policy, comparison }));
        }
      }
    }
  }
});
