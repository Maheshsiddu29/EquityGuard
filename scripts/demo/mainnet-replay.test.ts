import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { RepresentationState, StateSource } from "@equityguard/representation-state";

import { KO_DEMO_POLICY, koDivergenceFacts, replayKoScenarios, resolveCurated } from "./mainnet-replay.ts";

test("real KO divergence facts come straight from the curated evidence", () => {
  const facts = koDivergenceFacts();
  assert.deepEqual(
    [facts.koon.mechanism, facts.koon.storedEffectiveTimestamp, facts.koon.firstNewStateObservedAt, facts.koon.pendingPhaseObserved],
    ["IMMEDIATE_UPDATE", 1789430644n, "2026-09-15T00:04:17.389Z", false],
  );
  assert.deepEqual(
    [facts.kox.mechanism, facts.kox.storedEffectiveTimestamp, facts.kox.pendingFirstObservedAt, facts.kox.apiPendingFirstObservedAt, facts.kox.activationFirstObservedAt, facts.kox.bytesUnchangedAtActivation],
    ["SCHEDULED_THEN_CLOCK_CROSSING", 1789432200n, "2026-09-14T20:26:16.355Z", "2026-09-14T20:26:53Z", "2026-09-15T00:30:17.503Z", true],
  );
  assert.equal(facts.effectiveTimestampDivergenceSecs, 25n * 60n + 56n);
  assert.deepEqual(facts.guardWouldReject, { koonSnapshotBuiltBeforeUpdate: "MultiplierChanged", koxPendingSnapshotAfterT: "ActivationPhaseChanged" });
});

test("real-state resolution of the curated observations under the demo policy", () => {
  const table = [
    ["koxLastPendingBeforeT", RepresentationState.TRANSITION],
    ["koxActivatedFirstObserved", RepresentationState.TRANSITION], // T+16 s, inside afterSecs
    ["koxAtKoonPostEvent", RepresentationState.SAFE], // pending, before T - 900 s
    ["windowEndKOx", RepresentationState.SAFE],
    ["koonPreEventLast", RepresentationState.SAFE],
    ["koonPostEventFirst", RepresentationState.TRANSITION], // T+12 s after the immediate update
    ["koonAtKoxLastPending", RepresentationState.SAFE],
    ["windowEndKOon", RepresentationState.SAFE],
  ] as const;
  for (const [key, state] of table) {
    const resolved = resolveCurated(key);
    assert.equal(resolved.state, state, key);
    assert.equal(resolved.stateSource, StateSource.CHAIN, key); // no Ondo API evidence was observed
  }
  assert.equal(KO_DEMO_POLICY.calibration, "UNCALIBRATED");
  // Without the opt-in immediate-update interval, KOon's update is not a TRANSITION.
  const { immediateUpdateAfterSecs: _omitted, ...withoutImmediateInterval } = KO_DEMO_POLICY;
  assert.equal(resolveCurated("koonPostEventFirst", withoutImmediateInterval).state, RepresentationState.SAFE);
});

test("scenario A: KOx transition with an unroutable KOon alternative is UNKNOWN_STATE", () => {
  const [a] = replayKoScenarios();
  assert.ok(a);
  assert.deepEqual(
    [a.result.preferredRepresentation.symbol, a.result.preferredState, a.result.alternativeRepresentation?.symbol, a.result.alternativeState, a.result.decision, a.result.reasonCode],
    ["KOx", "TRANSITION", "KOon", "SAFE", "UNKNOWN_STATE", "ALTERNATIVE_QUOTE_UNAVAILABLE"],
  );
  assert.deepEqual([a.result.quoteAvailability.preferred, a.result.quoteAvailability.alternative], ["AVAILABLE", "UNAVAILABLE"]);
  assert.equal(a.result.conservativeCostDeltaBps, undefined);
});

test("scenario B: KOon immediate update with an incomplete quote pair is UNKNOWN_STATE, not a reroute", () => {
  const b = replayKoScenarios()[1];
  assert.ok(b);
  assert.deepEqual(
    [b.result.preferredRepresentation.symbol, b.result.preferredState, b.result.alternativeState, b.result.decision, b.result.reasonCode, b.result.consentRequired],
    ["KOon", "TRANSITION", "SAFE", "UNKNOWN_STATE", "ALTERNATIVE_QUOTE_UNAVAILABLE", false],
  );
  assert.equal(b.result.quoteAvailability.preferred, "UNAVAILABLE");
  assert.equal(b.result.preferredSharesEquivalent, undefined);
});

test("scenario C: both SAFE uses the preferred representation", () => {
  const c = replayKoScenarios()[2];
  assert.ok(c);
  assert.deepEqual([c.result.preferredState, c.result.alternativeState, c.result.decision, c.result.reasonCode], ["SAFE", "SAFE", "USE_PREFERRED", "PREFERRED_SAFE"]);
});

test("every replay result is MAINNET_OBSERVATION with hashed evidence and no transaction", () => {
  for (const { result } of replayKoScenarios()) {
    assert.equal(result.executionEnvironment, "MAINNET_OBSERVATION");
    assert.equal(result.transactionSignature, undefined);
    assert.equal((result as { execution?: unknown }).execution, undefined);
    assert.equal(result.quoteAvailability.source, "JUPITER_MAINNET_SNAPSHOT");
    assert.ok(result.evidenceSources.every((e) => e.sha256 && e.sha256.length === 64));
  }
});

test("the mainnet observation path contains no signing, sending or RPC code", () => {
  for (const file of ["mainnet-replay.ts", "ko-fixtures.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const forbidden of [/devnet\//, /send\.ts/, /sendTransaction/, /signTransaction/, /KeyPairSigner/, /createSolanaRpc/, /fetchChainObservation/, /fetch\(/]) {
      assert.ok(!forbidden.test(source), `${file} must not match ${forbidden}`);
    }
  }
});
