import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DemoResultError,
  RepresentationState,
  StateSource,
  assertDemoResult,
  decide,
  devnetExecutionResult,
  findRepresentationBySymbol,
  mainnetObservationResult,
  type DemoResult,
  type ResolvedRepresentationState,
} from "../src/index.ts";

function resolved(symbol: string, state: RepresentationState): ResolvedRepresentationState {
  const rep = findRepresentationBySymbol(symbol)!;
  return { underlying: rep.underlying, issuer: rep.issuer, symbol, mint: rep.mint, state, stateSource: StateSource.CHAIN, chainState: state, apiState: null, slot: 1n, blockTime: 1n, observedAt: null, reason: "test", chainObservation: null, apiObservation: null };
}

const safeDecision = decide({ preferred: resolved("KOx", RepresentationState.SAFE), alternative: null, policy: { allowCrossIssuerReroute: false }, inputRaw: 1n, comparison: null });
const mainnetQuotes = { source: "JUPITER_MAINNET_SNAPSHOT" as const, observedAt: "2026-09-15T04:22:16.045Z", preferred: "AVAILABLE" as const, alternative: "NOT_APPLICABLE" as const, note: "snapshot" };
const devnetQuotes = { source: "DEVNET_DEMO_QUOTE_FIXTURE" as const, observedAt: null, preferred: "AVAILABLE" as const, alternative: "AVAILABLE" as const, note: "DEVNET DEMO QUOTE / FIXTURE" };

test("mainnet observation results cannot carry transactions, fixture quotes or devnet evidence", () => {
  const ok = mainnetObservationResult({ decision: safeDecision, comparison: null, evidenceSources: [], quoteAvailability: mainnetQuotes });
  assert.equal(ok.executionEnvironment, "MAINNET_OBSERVATION");
  const bad: unknown[] = [
    { ...ok, transactionSignature: "sig" },
    { ...ok, execution: { executed: null, rejectedPreferredAttempt: null } },
    { ...ok, quoteAvailability: devnetQuotes },
    { ...ok, evidenceSources: [{ kind: "DEVNET_CHAIN_STATE", description: "x", sha256: null, observedAt: null }] },
    { ...ok, executionEnvironment: "MAINNET" },
  ];
  for (const r of bad) assert.throws(() => assertDemoResult(r as DemoResult), DemoResultError);
  assert.throws(() => mainnetObservationResult({ decision: safeDecision, comparison: null, evidenceSources: [], quoteAvailability: devnetQuotes }), DemoResultError);
});

test("devnet execution results cannot cite mainnet quotes or evidence, or execute on non-executable decisions", () => {
  const ok = devnetExecutionResult({ decision: safeDecision, comparison: null, evidenceSources: [], quoteAvailability: devnetQuotes });
  assert.equal(ok.executionEnvironment, "DEVNET_EXECUTION");
  assert.throws(() => devnetExecutionResult({ decision: safeDecision, comparison: null, evidenceSources: [], quoteAvailability: mainnetQuotes }), DemoResultError);
  assert.throws(
    () => devnetExecutionResult({ decision: safeDecision, comparison: null, evidenceSources: [{ kind: "JUPITER_ROUTE_DISCOVERY", description: "x", sha256: null, observedAt: null }], quoteAvailability: devnetQuotes }),
    DemoResultError,
  );
  const unknown = decide({ preferred: resolved("KOx", RepresentationState.UNKNOWN), alternative: null, policy: { allowCrossIssuerReroute: true }, inputRaw: 1n, comparison: null });
  const tx = { signature: "s", slot: 1n, succeeded: true, customErrorName: null, downstreamBalanceBefore: 0n, downstreamBalanceAfter: 1n, explorerUrl: null };
  assert.throws(() => devnetExecutionResult({ decision: unknown, comparison: null, evidenceSources: [], quoteAvailability: devnetQuotes, execution: { executed: tx, rejectedPreferredAttempt: null } }), DemoResultError);
  const executed = devnetExecutionResult({ decision: safeDecision, comparison: null, evidenceSources: [], quoteAvailability: devnetQuotes, execution: { executed: tx, rejectedPreferredAttempt: null } });
  assert.equal(executed.transactionSignature, "s");
  assert.throws(() => assertDemoResult({ ...executed, consentRequired: true }), DemoResultError);
});
