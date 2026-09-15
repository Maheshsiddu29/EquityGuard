import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DemoResultError,
  RepresentationState,
  StateSource,
  assertDemoResult,
  decideExecution,
  devnetExecutionResult,
  findRepresentationBySymbol,
  mainnetObservationResult,
  type DemoResult,
  type ResolvedRepresentationState,
} from "../src/index.ts";

function resolved(symbol: string, state: RepresentationState): ResolvedRepresentationState {
  const rep = findRepresentationBySymbol(symbol)!;
  return { underlying: rep.underlying, issuer: rep.issuer, symbol, mint: rep.mint, state, stateSource: StateSource.CHAIN, chainState: state, apiState: null, slot: 1n, blockTime: 1n, observedAt: null, reason: "test", chainObservation: null, apiObservation: null, transitionPolicy: null };
}

const NO_ROUTES = { preferred: null, alternative: null };
/** State SAFE but no route: not executable. */
const safeDecision = decideExecution({ preferred: resolved("KOx", RepresentationState.SAFE), alternative: null, reroutePolicy: { maxCostBps: 25n }, consent: null, currentSlot: 100n, inputRaw: 1n, comparison: null, routes: NO_ROUTES });
const mainnetQuotes = { source: "JUPITER_MAINNET_SNAPSHOT" as const, observedAt: "2026-09-15T04:22:16.045Z", preferred: "AVAILABLE" as const, alternative: "NOT_APPLICABLE" as const, note: "snapshot" };
const devnetQuotes = { source: "DEVNET_DEMO_QUOTE_FIXTURE" as const, observedAt: null, preferred: "AVAILABLE" as const, alternative: "AVAILABLE" as const, note: "DEVNET DEMO QUOTE / FIXTURE" };

test("mainnet observation results cannot carry transactions, fixture quotes or devnet evidence", () => {
  const ok = mainnetObservationResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: mainnetQuotes });
  assert.equal(ok.executionEnvironment, "MAINNET_OBSERVATION");
  const bad: unknown[] = [
    { ...ok, transactionSignature: "sig" },
    { ...ok, execution: { executed: null, rejectedPreferredAttempt: null } },
    { ...ok, quoteAvailability: devnetQuotes },
    { ...ok, evidenceSources: [{ kind: "DEVNET_CHAIN_STATE", description: "x", sha256: null, observedAt: null }] },
    { ...ok, executionEnvironment: "MAINNET" },
  ];
  for (const r of bad) assert.throws(() => assertDemoResult(r as DemoResult), DemoResultError);
  assert.throws(() => mainnetObservationResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: devnetQuotes }), DemoResultError);
});

test("devnet execution results cannot cite mainnet quotes or evidence, or execute on non-executable decisions", () => {
  const ok = devnetExecutionResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: devnetQuotes });
  assert.equal(ok.executionEnvironment, "DEVNET_EXECUTION");
  assert.throws(() => devnetExecutionResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: mainnetQuotes }), DemoResultError);
  assert.throws(
    () => devnetExecutionResult({ decision: safeDecision, evidenceSources: [{ kind: "JUPITER_ROUTE_DISCOVERY", description: "x", sha256: null, observedAt: null }], quoteAvailability: devnetQuotes }),
    DemoResultError,
  );
  const unknown = decideExecution({ preferred: resolved("KOx", RepresentationState.UNKNOWN), alternative: null, reroutePolicy: { maxCostBps: 25n }, consent: null, currentSlot: 100n, inputRaw: 1n, comparison: null, routes: NO_ROUTES });
  const tx = { signature: "s", slot: 1n, succeeded: true, customErrorName: null, downstreamBalanceBefore: 0n, downstreamBalanceAfter: 1n, explorerUrl: null };
  assert.throws(() => devnetExecutionResult({ decision: unknown, evidenceSources: [], quoteAvailability: devnetQuotes, execution: { executed: tx, rejectedPreferredAttempt: null } }), DemoResultError);
  // A SAFE state with no route is not executable either.
  assert.equal(safeDecision.executionEligibility, "ROUTE_UNAVAILABLE");
  assert.throws(() => devnetExecutionResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: devnetQuotes, execution: { executed: tx, rejectedPreferredAttempt: null } }), /nothing may execute when eligibility is ROUTE_UNAVAILABLE/);
  const okResult = devnetExecutionResult({ decision: safeDecision, evidenceSources: [], quoteAvailability: devnetQuotes });
  const forged = { ...okResult, executionEligibility: "EXECUTABLE" as const, execution: { executed: tx, rejectedPreferredAttempt: null }, transactionSignature: "s", executionPlanDigest: "plan" };
  assert.doesNotThrow(() => assertDemoResult(forged));
  const { executionPlanDigest: _planId, ...withoutPlan } = forged;
  assert.throws(() => assertDemoResult(withoutPlan), /must record the execution plan/);
  assert.throws(() => assertDemoResult({ ...forged, consentRequired: true }), DemoResultError);
  assert.throws(() => assertDemoResult({ ...forged, decision: "REQUIRES_CONSENT", reasonCode: "CONSENT_REQUIRED", consentRequired: true }), DemoResultError);
});
