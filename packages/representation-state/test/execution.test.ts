/**
 * Execution eligibility is separate from the state decision: a SAFE state is
 * executable only with an available route and a quote bound to its state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Decision,
  DemoResultError,
  ExecutionEligibility,
  ExecutionEligibilityError,
  RepresentationState,
  StateSource,
  assertDemoResult,
  assertExecutable,
  compareQuotes,
  decideExecution,
  economicStateOf,
  findRepresentationBySymbol,
  grantConsent,
  mainnetObservationResult,
  observeMintAccount,
  resolveOndoState,
  resolveXStocksState,
  type ExecutionDecision,
  type NormalizedQuote,
  type ResolvedRepresentationState,
  type RouteObservation,
} from "../src/index.ts";
import { TEST_POLICY, TEST_QUOTE_CONTEXT, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const KOON = findRepresentationBySymbol("KOon")!;
const T = 1_789_432_200n;
const INPUT_RAW = 5_000_000n;
const KOX_SCHEDULED = withScaledUi(mainnetMint("KOx"), { multiplier: 1.0183317967386898, newMultiplier: 1.0225601246249238, effectiveTimestamp: T });
const KOON_SAFE = withScaledUi(mainnetMint("KOon"), { multiplier: 1.0238905041551842, newMultiplier: 1.0238905041551842, effectiveTimestamp: T - 1556n });
/** KOon raw output about 10 bps below the KOx quote in share-equivalents (KOx 8 decimals, KOon 9). */
const KOON_OUT = 49_678_821n;
const SAFE_TIME = T - 3_600n;
const TRANSITION_TIME = T - 14n;

const observe = (mint: string, data: Uint8Array, time: bigint) => observeMintAccount({ mint, owner: TOKEN_2022, data, slot: 1n, blockTime: null, observedAt: null, chainUnixTimestamp: time });
const kox = (time: bigint, data = KOX_SCHEDULED) => resolveXStocksState(KOX, observe(KOX.mint, data, time), TEST_POLICY);
const koon = (time: bigint, data = KOON_SAFE) => resolveOndoState(KOON, { chain: observe(KOON.mint, data, time), api: null }, TEST_POLICY);

function quote(r: ResolvedRepresentationState, outputRaw: bigint, inputRaw = INPUT_RAW): NormalizedQuote {
  const state = economicStateOf(r.chainObservation);
  assert.ok(state);
  return { ...TEST_QUOTE_CONTEXT, underlying: r.underlying, issuer: r.issuer, mint: r.mint, inputRaw, outputRaw, state };
}
const available = (r: ResolvedRepresentationState, q: NormalizedQuote | null = quote(r, 5_000_000n)): RouteObservation => ({ mint: r.mint, status: "AVAILABLE", quote: q, source: "test", detail: null });
const unavailable = (r: ResolvedRepresentationState): RouteObservation => ({ mint: r.mint, status: "UNAVAILABLE", quote: null, source: "test", detail: "No routes found" });

function run(input: {
  preferred: ResolvedRepresentationState;
  alternative: ResolvedRepresentationState | null;
  preferredRoute?: RouteObservation | null;
  alternativeRoute?: RouteObservation | null;
  withComparison?: boolean;
  consent?: boolean;
  inputRaw?: bigint;
}): ExecutionDecision {
  const routes = { preferred: input.preferredRoute ?? null, alternative: input.alternativeRoute ?? null };
  const comparison =
    input.withComparison && input.alternative ? compareQuotes(quote(input.preferred, 5_000_000n), quote(input.alternative, KOON_OUT)) : null;
  const base = { preferred: input.preferred, alternative: input.alternative, reroutePolicy: POLICY, inputRaw: input.inputRaw ?? INPUT_RAW, comparison, routes, currentSlot: SLOT };
  const withoutConsent = decideExecution({ ...base, consent: null });
  if (!input.consent || !comparison || withoutConsent.stateDecision.decision !== Decision.REQUIRES_CONSENT) return withoutConsent;
  // The user accepts exactly this disclosure.
  const consent = grantConsent({ decision: withoutConsent.stateDecision, comparison, reroutePolicy: POLICY, currentSlot: SLOT, maxAdditionalCostBps: 25n, validForSlots: 10n });
  return decideExecution({ ...base, consent });
}

const POLICY = { maxAdditionalCostBps: 25n };
const SLOT = 100n;

const eligibility = (d: ExecutionDecision) => [d.stateDecision.decision, d.executionEligibility];

test("1. SAFE preferred with a route and a state-bound quote is EXECUTABLE", () => {
  const preferred = kox(SAFE_TIME);
  const d = run({ preferred, alternative: koon(SAFE_TIME), preferredRoute: available(preferred) });
  assert.deepEqual(eligibility(d), [Decision.USE_PREFERRED, ExecutionEligibility.EXECUTABLE]);
  assert.deepEqual([d.selectedRepresentation?.symbol, d.selectedRouteAvailable, d.quoteAvailable], ["KOx", true, true]);
  assert.deepEqual(d.executableQuote?.state, economicStateOf(preferred.chainObservation));
  assert.doesNotThrow(() => assertExecutable(d));
});

test("2. SAFE preferred without a route keeps the SAFE state choice but is ROUTE_UNAVAILABLE", () => {
  const preferred = koon(SAFE_TIME);
  for (const preferredRoute of [unavailable(preferred), null]) {
    const d = run({ preferred, alternative: kox(SAFE_TIME), preferredRoute });
    assert.deepEqual(eligibility(d), [Decision.USE_PREFERRED, ExecutionEligibility.ROUTE_UNAVAILABLE]);
    assert.equal(d.stateDecision.preferred.state, RepresentationState.SAFE);
    assert.deepEqual([d.selectedRepresentation?.symbol, d.selectedRouteAvailable, d.quoteAvailable, d.executableQuote], ["KOon", false, false, null]);
  }
  // A route for another mint is not a route for this representation.
  const other = run({ preferred, alternative: kox(SAFE_TIME), preferredRoute: available(kox(SAFE_TIME)) });
  assert.equal(other.executionEligibility, ExecutionEligibility.ROUTE_UNAVAILABLE);
});

test("SAFE preferred with a route but no usable quote is QUOTE_UNAVAILABLE; a quote for another notional is QUOTE_MISMATCH", () => {
  const preferred = kox(SAFE_TIME);
  assert.equal(run({ preferred, alternative: null, preferredRoute: available(preferred, null) }).executionEligibility, ExecutionEligibility.QUOTE_UNAVAILABLE);
  assert.equal(run({ preferred, alternative: null, preferredRoute: available(preferred, quote(preferred, 1n, INPUT_RAW * 2n)) }).executionEligibility, ExecutionEligibility.QUOTE_MISMATCH);
});

test("3. TRANSITION preferred with a SAFE but unroutable alternative is not executable", () => {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  for (const consent of [false, true]) {
    const d = run({ preferred, alternative, preferredRoute: available(preferred), alternativeRoute: unavailable(alternative), consent });
    assert.deepEqual([d.stateDecision.reasonCode, d.executionEligibility, d.selectedRepresentation], ["ALTERNATIVE_QUOTE_UNAVAILABLE", ExecutionEligibility.ROUTE_UNAVAILABLE, null]);
    assert.throws(() => assertExecutable(d), ExecutionEligibilityError);
  }
  // Routable alternative, but no comparison: QUOTE_UNAVAILABLE.
  const noQuote = run({ preferred, alternative, alternativeRoute: available(alternative, null), consent: true });
  assert.equal(noQuote.executionEligibility, ExecutionEligibility.QUOTE_UNAVAILABLE);
});

test("4. REQUIRES_CONSENT is never executable", () => {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  const d = run({ preferred, alternative, preferredRoute: available(preferred), alternativeRoute: available(alternative), withComparison: true, consent: false });
  assert.deepEqual(eligibility(d), [Decision.REQUIRES_CONSENT, ExecutionEligibility.CONSENT_REQUIRED]);
  assert.deepEqual([d.consentRequired, d.selectedRepresentation, d.executableQuote, d.quoteAvailable], [true, null, null, true]);
  assert.throws(() => assertExecutable(d), /refusing to execute: CONSENT_REQUIRED/);
});

test("5. USE_ALTERNATIVE with consent and a route is EXECUTABLE on the alternative's bound state", () => {
  const preferred = kox(TRANSITION_TIME);
  const alternative = koon(TRANSITION_TIME);
  const d = run({ preferred, alternative, preferredRoute: unavailable(preferred), alternativeRoute: available(alternative, quote(alternative, KOON_OUT)), withComparison: true, consent: true });
  assert.deepEqual(eligibility(d), [Decision.USE_ALTERNATIVE, ExecutionEligibility.EXECUTABLE]);
  assert.deepEqual([d.selectedRepresentation?.symbol, d.selectedRouteAvailable], ["KOon", true]);
  assert.deepEqual(d.executableQuote, d.comparison?.alternativeQuote);
  // The same consented decision without an available route is not executable.
  const noRoute = run({ preferred, alternative, alternativeRoute: unavailable(alternative), withComparison: true, consent: true });
  assert.deepEqual(eligibility(noRoute), [Decision.USE_ALTERNATIVE, ExecutionEligibility.ROUTE_UNAVAILABLE]);
});

test("6. stale comparisons and stale preferred quotes are not executable", () => {
  // Comparison built while KOx was pending before T; evaluated at T (clock-only phase change).
  const builtPreferred = kox(T - 1n);
  const alternative = koon(T - 1n);
  const comparison = compareQuotes(quote(builtPreferred, 5_000_000n), quote(alternative, KOON_OUT));
  const nowPreferred = kox(T);
  const d = decideExecution({ preferred: nowPreferred, alternative, reroutePolicy: { maxAdditionalCostBps: 25n }, consent: null, currentSlot: 100n, inputRaw: INPUT_RAW, comparison, routes: { preferred: null, alternative: available(alternative) } });
  assert.deepEqual([d.stateDecision.reasonCode, d.executionEligibility], ["QUOTE_COMPARISON_STALE_STATE", ExecutionEligibility.STALE_COMPARISON]);
  assert.throws(() => assertExecutable(d), ExecutionEligibilityError);

  // SAFE preferred whose route quote was built against the previous (pre-update) state.
  const before = koon(SAFE_TIME, withScaledUi(KOON_SAFE, { multiplier: 1.01, newMultiplier: 1.01 }));
  const after = koon(SAFE_TIME);
  const staleQuote = run({ preferred: after, alternative: null, preferredRoute: available(after, quote(before, 5_000_000n)) });
  assert.deepEqual(eligibility(staleQuote), [Decision.USE_PREFERRED, ExecutionEligibility.STALE_COMPARISON]);
});

test("unsafe and unknown states map to STATE_UNSAFE and STATE_UNKNOWN", () => {
  const preferred = kox(TRANSITION_TIME);
  assert.equal(run({ preferred, alternative: null, preferredRoute: available(preferred) }).executionEligibility, ExecutionEligibility.STATE_UNSAFE);
  const unknown = { ...kox(SAFE_TIME), state: RepresentationState.UNKNOWN };
  assert.equal(run({ preferred: unknown, alternative: null, preferredRoute: available(kox(SAFE_TIME)) }).executionEligibility, ExecutionEligibility.STATE_UNKNOWN);
  const conflict = { ...koon(SAFE_TIME), state: null, stateSource: StateSource.CONFLICT };
  assert.equal(run({ preferred: preferred, alternative: conflict, alternativeRoute: available(koon(SAFE_TIME)) }).executionEligibility, ExecutionEligibility.STATE_UNKNOWN);
});

test("7. the execution gate rejects every non-executable eligibility and forged executable decisions", () => {
  const preferred = kox(SAFE_TIME);
  const executable = run({ preferred, alternative: null, preferredRoute: available(preferred) });
  for (const e of Object.values(ExecutionEligibility).filter((v) => v !== ExecutionEligibility.EXECUTABLE)) {
    assert.throws(() => assertExecutable({ ...executable, executionEligibility: e }), (err) => err instanceof ExecutionEligibilityError && err.eligibility === e, e);
  }
  assert.throws(() => assertExecutable({ ...executable, executableQuote: null }), ExecutionEligibilityError);
  assert.throws(() => assertExecutable({ ...executable, executableQuote: { ...executable.executableQuote!, mint: KOON.mint } }), /different mint/);
});

test("8. a mainnet observation result carries eligibility but can never carry a submission", () => {
  const preferred = kox(SAFE_TIME);
  const executable = run({ preferred, alternative: null, preferredRoute: available(preferred) });
  const quotes = { source: "JUPITER_MAINNET_SNAPSHOT" as const, observedAt: null, preferred: "AVAILABLE" as const, alternative: "NOT_APPLICABLE" as const, note: "snapshot" };
  const result = mainnetObservationResult({ decision: executable, evidenceSources: [], quoteAvailability: quotes });
  assert.equal(result.executionEnvironment, "MAINNET_OBSERVATION");
  assert.equal(result.executionEligibility, ExecutionEligibility.EXECUTABLE);
  const tx = { signature: "s", slot: 1n, succeeded: true, customErrorName: null, downstreamBalanceBefore: 0n, downstreamBalanceAfter: 1n, explorerUrl: null };
  assert.throws(() => assertDemoResult({ ...result, transactionSignature: "s" } as never), DemoResultError);
  assert.throws(() => assertDemoResult({ ...result, execution: { executed: tx, rejectedPreferredAttempt: null } } as never), DemoResultError);
});

test("M04: an executable decision carries its classification policy; mixed policies are POLICY_MISMATCH", () => {
  const preferred = kox(SAFE_TIME);
  const d = run({ preferred, alternative: null, preferredRoute: available(preferred) });
  assert.deepEqual(d.transitionPolicy, TEST_POLICY);
  const unbound = { ...preferred, transitionPolicy: null };
  assert.equal(run({ preferred: unbound, alternative: null, preferredRoute: available(preferred) }).executionEligibility, ExecutionEligibility.POLICY_MISMATCH);
  // Reroute where the two states were classified under different policies.
  const other = { ...TEST_POLICY, afterSecs: TEST_POLICY.afterSecs + 1n };
  const transition = kox(TRANSITION_TIME);
  const alternative = { ...koon(TRANSITION_TIME), transitionPolicy: other };
  const mixed = run({ preferred: transition, alternative, alternativeRoute: available(alternative, quote(alternative, KOON_OUT)), withComparison: true, consent: true });
  assert.deepEqual([mixed.stateDecision.decision, mixed.executionEligibility], [Decision.USE_ALTERNATIVE, ExecutionEligibility.POLICY_MISMATCH]);
});
