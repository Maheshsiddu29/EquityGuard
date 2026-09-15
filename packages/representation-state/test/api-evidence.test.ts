/**
 * EG-SEC-L05: API evidence carries an explicit source class and freshness;
 * historical, stale or API-only evidence never becomes executable state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Decision,
  ExecutionEligibility,
  RepresentationState,
  StateSource,
  decideExecution,
  economicStateOf,
  findRepresentationBySymbol,
  observeMintAccount,
  resolveOndoState,
  routeIdentity,
  type ApiObservation,
  type ApiStatus,
  type ResolvedRepresentationState,
} from "../src/index.ts";
import { TEST_POLICY, TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

const KOON = findRepresentationBySymbol("KOon")!;
const NOW = 1_789_400_000n;
const OBSERVED = "2026-09-14T00:00:00Z";
const FRESH_AT = "2026-09-14T00:00:30Z";
const STALE_AT = "2026-09-14T00:02:00Z";
const VALID_UNTIL = "2026-09-14T00:01:00Z";

const chainSafe = observeMintAccount({
  mint: KOON.mint,
  owner: TOKEN_2022,
  data: withScaledUi(mainnetMint("KOon"), { multiplier: 1.02, newMultiplier: 1.02, effectiveTimestamp: NOW - 100n }),
  slot: 1n,
  blockTime: null,
  observedAt: null,
  chainUnixTimestamp: NOW,
});

function api(status: ApiStatus, overrides: Partial<ApiObservation> = {}): ApiObservation {
  return { issuer: "Ondo", symbol: "KOon", observedAt: OBSERVED, status, detail: null, calibration: "UNCALIBRATED", sourceClass: "LIVE_API_STATE", validUntil: VALID_UNTIL, ...overrides };
}

/** Whether a SAFE-looking resolution could execute, given a perfect route and quote. */
function executionOf(resolved: ResolvedRepresentationState) {
  const state = economicStateOf(chainSafe)!;
  const quote = { underlying: "KO", issuer: "Ondo" as const, inputMint: "U", mint: KOON.mint, inputRaw: 1n, outputRaw: 1n, minOutputRaw: null, route: routeIdentity("R", [{ venue: "V", poolId: null, inputMint: null, outputMint: null, percent: 100 }]), quotedAt: null, contextSlot: null, state };
  return decideExecution({
    preferred: resolved,
    alternative: null,
    reroutePolicy: { maxCostBps: 25n },
    inputRaw: 1n,
    comparison: null,
    routes: { preferred: { mint: KOON.mint, status: "AVAILABLE", quote, source: "test", detail: null }, alternative: null },
    consent: null,
    currentSlot: 1n,
  });
}

test("historical API evidence never influences state and never executes", () => {
  const historicalActive = api("active", { sourceClass: "HISTORICAL_API_STATE", validUntil: null });
  const alone = resolveOndoState(KOON, { chain: null, api: historicalActive, evaluatedAt: FRESH_AT }, TEST_POLICY);
  assert.deepEqual([alone.state, alone.stateSource], [RepresentationState.UNKNOWN, null]);
  assert.match(alone.reason, /historical API evidence .* ignored/);
  assert.equal(executionOf(alone).executionEligibility, ExecutionEligibility.STATE_UNKNOWN);

  // Beside chain state it is audit evidence only: the chain decides.
  for (const status of ["active", "paused"] as const) {
    const withChain = resolveOndoState(KOON, { chain: chainSafe, api: api(status, { sourceClass: "HISTORICAL_API_STATE" }), evaluatedAt: FRESH_AT }, TEST_POLICY);
    assert.deepEqual([withChain.state, withChain.stateSource, withChain.apiState], [RepresentationState.SAFE, StateSource.CHAIN, null], status);
    assert.equal(withChain.apiObservation?.sourceClass, "HISTORICAL_API_STATE");
  }
});

test("stale, unbounded or unevaluated live API evidence contributes UNKNOWN and fails closed", () => {
  const cases: [string, ApiObservation, string | null][] = [
    ["expired", api("active"), STALE_AT],
    ["no validUntil", api("active", { validUntil: null }), FRESH_AT],
    ["no evaluation time", api("active"), null],
    ["unparseable validUntil", api("active", { validUntil: "soon" }), FRESH_AT],
  ];
  for (const [label, observation, evaluatedAt] of cases) {
    const alone = resolveOndoState(KOON, { chain: null, api: observation, evaluatedAt }, TEST_POLICY);
    assert.deepEqual([alone.state, alone.apiState], [RepresentationState.UNKNOWN, RepresentationState.UNKNOWN], label);
    const withChain = resolveOndoState(KOON, { chain: chainSafe, api: observation, evaluatedAt }, TEST_POLICY);
    assert.deepEqual([withChain.state, withChain.stateSource], [null, StateSource.CONFLICT], label);
    for (const resolved of [alone, withChain]) {
      const d = executionOf(resolved);
      assert.deepEqual([d.stateDecision.decision, d.executionEligibility], [Decision.UNKNOWN_STATE, ExecutionEligibility.STATE_UNKNOWN], label);
    }
  }
});

test("fresh API-only evidence can describe a state but never becomes executable economic state", () => {
  const apiOnly = resolveOndoState(KOON, { chain: null, api: api("active"), evaluatedAt: FRESH_AT }, TEST_POLICY);
  assert.deepEqual([apiOnly.state, apiOnly.stateSource], [RepresentationState.SAFE, StateSource.API]);
  const d = executionOf(apiOnly);
  assert.deepEqual([d.stateDecision.decision, d.executionEligibility], [Decision.USE_PREFERRED, ExecutionEligibility.STATE_UNKNOWN]);
  assert.match(d.executionReason, /no authoritative live chain state/);
});

test("fresh live API agreeing with chain resolves; a conflict with chain still fails closed", () => {
  const agree = resolveOndoState(KOON, { chain: chainSafe, api: api("active"), evaluatedAt: FRESH_AT }, TEST_POLICY);
  assert.deepEqual([agree.state, agree.stateSource], [RepresentationState.SAFE, StateSource.BOTH_AGREE]);
  assert.equal(executionOf(agree).executionEligibility, ExecutionEligibility.EXECUTABLE);
  for (const status of ["paused", "transition", "unknown"] as const) {
    const conflict = resolveOndoState(KOON, { chain: chainSafe, api: api(status), evaluatedAt: FRESH_AT }, TEST_POLICY);
    assert.deepEqual([conflict.state, conflict.stateSource], [null, StateSource.CONFLICT], status);
    assert.equal(executionOf(conflict).executionEligibility, ExecutionEligibility.STATE_UNKNOWN, status);
  }
});
