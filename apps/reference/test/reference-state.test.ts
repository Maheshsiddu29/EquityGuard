import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { deriveReferenceState, loadReplayExcerpt } from "../build/derive-state.ts";

const state = deriveReferenceState();
const replay = loadReplayExcerpt();
const replayResult = (label: string) => {
  const result = replay.results.find((r) => r.label === label);
  assert.ok(result, label);
  return result;
};

test("the three-step flow is SAFE → BLOCK: ECONOMIC_STATE_CHANGED → ALLOW", () => {
  const { safe, stale, refreshed } = state.scenarios;
  assert.deepEqual(safe.decision, { type: "ALLOW", guardResult: null });
  assert.deepEqual(stale.decision, { type: "BLOCK", reason: "ECONOMIC_STATE_CHANGED", guardResult: "ActivationPhaseChanged" });
  assert.deepEqual(refreshed.decision, { type: "ALLOW", guardResult: null });
  // Stale: the authorization was taken under S and the chain is now at S′.
  assert.equal(stale.authorized.fingerprint, safe.authorized.fingerprint);
  assert.notEqual(stale.current.fingerprint, stale.authorized.fingerprint);
  assert.equal(stale.authorized.phase, "PENDING");
  assert.equal(stale.current.phase, "ACTIVATED");
  // Refreshed: a new authorization under the current state.
  assert.equal(refreshed.authorized.fingerprint, stale.current.fingerprint);
  // The Clock crossed T without any byte change: only the phase differs.
  assert.equal(stale.authorized.multiplierHex, stale.current.multiplierHex);
  assert.equal(stale.authorized.newMultiplierHex, stale.current.newMultiplierHex);
  assert.ok(Date.parse(stale.evaluatedAt) > Date.parse(stale.current.effectiveAt));
  assert.ok(Date.parse(safe.evaluatedAt) < Date.parse(safe.current.effectiveAt));
});

test("the stale and refreshed decisions match what the program did in the local replay", () => {
  const stale = replayResult("STALE_PRE_ACTIVATION");
  const safe = replayResult("SAFE");
  const { scenarios } = state;
  // Same protected bytes as the recorded mainnet KOx state.
  for (const r of [stale, safe]) {
    assert.equal(r.expectation.multiplierHex, scenarios.stale.current.multiplierHex);
    assert.equal(r.expectation.newMultiplierHex, scenarios.stale.current.newMultiplierHex);
    assert.equal(new Date(Number(r.expectation.newMultiplierEffectiveTimestamp) * 1000).toISOString().replace(".000Z", "Z"), scenarios.stale.current.effectiveAt);
  }
  // Pending-phase expectation after T: rejected by the program with the guard model's error.
  assert.equal(stale.expectation.expectedPhase, 0);
  assert.equal(stale.succeeded, false);
  assert.equal(stale.failedInstruction, "0");
  assert.equal(scenarios.stale.decision.guardResult, stale.guardErrorName);
  assert.deepEqual([stale.usdcDelta, stale.stockDelta], ["0", "0"]);
  // Activated-phase expectation: the guarded Jupiter trade executed.
  assert.equal(safe.expectation.expectedPhase, 1);
  assert.equal(safe.succeeded, true);
  assert.equal(scenarios.refreshed.decision.type, "ALLOW");
});

test("the altered-route case is the replay's commitment rejection, before Jupiter ran", () => {
  const mutated = replayResult("MUTATED_SLIPPAGE");
  const { tampered } = state.scenarios;
  assert.deepEqual(tampered.decision, { type: "BLOCK", reason: "INTENT_MISMATCH", guardResult: "DownstreamCommitmentMismatch" });
  assert.equal(tampered.commitment.status, "ALTERED");
  assert.equal(mutated.failedInstruction, "0");
  assert.deepEqual(mutated.invoked, ["EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT@1"]);
  assert.deepEqual([mutated.usdcDelta, mutated.stockDelta], ["0", "0"]);
  assert.deepEqual(tampered.backing.map((b) => b.provenance), ["LOCAL_REPLAY"]);
});

test("the consent case comes from the decision engine and is labelled illustrative", () => {
  const { consent } = state.scenarios;
  assert.equal(consent.decision.type, "REQUIRES_CONSENT");
  if (consent.decision.type !== "REQUIRES_CONSENT") return;
  assert.equal(consent.decision.reason, "REPRESENTATION_CHANGE");
  assert.equal(consent.decision.guardResult, "InsideTransitionWindow");
  assert.equal(consent.decision.disclosure.toSymbol, "KOon");
  assert.ok(BigInt(consent.decision.disclosure.additionalCostBps) <= BigInt(consent.decision.disclosure.policyMaxAdditionalCostBps));
  assert.ok(consent.backing.some((b) => b.provenance === "ILLUSTRATIVE"));
  assert.match(consent.settlement, /never executes/);
  // No other scenario uses the illustrative quote.
  for (const s of Object.values(state.scenarios).filter((s) => s.id !== "consent")) {
    assert.ok(!s.backing.some((b) => b.provenance === "ILLUSTRATIVE"), s.id);
  }
});

test("the timeline carries the observed 25m 56s divergence and mechanisms", () => {
  const { divergence } = state;
  assert.equal(divergence.seconds, 25 * 60 + 56);
  assert.equal(divergence.kox.effectiveAt, "2026-09-15T00:30:00Z");
  assert.equal(divergence.koon.effectiveAt, "2026-09-15T00:04:04Z");
  assert.equal(divergence.kox.bytesUnchangedAtActivation, true);
  assert.equal(divergence.koon.pendingPhaseObserved, false);
  assert.equal(divergence.kox.apiReason, "Dividend");
});

test("failed cases report no token movement, only a fee", () => {
  for (const id of ["stale", "tampered"] as const) {
    assert.match(state.scenarios[id].settlement, /^No tokens moved\. .* 5441 lamport network fee/);
  }
  for (const o of state.replay.outcomes.filter((o) => !o.succeeded)) {
    assert.deepEqual([o.usdcDelta, o.stockDelta, o.programsInvoked], ["0", "0", 1]);
  }
});

test("derivation is deterministic and traceable to its inputs", () => {
  assert.deepEqual(deriveReferenceState(), state);
  const excerptSha = createHash("sha256").update(readFileSync(new URL("../data/local-replay-2026-09-17.json", import.meta.url))).digest("hex");
  assert.ok(state.generatedFrom.some((g) => g.sha256 === excerptSha));
  assert.ok(state.generatedFrom.some((g) => g.sha256 === replay.sourceSha256));
});

// The full replay record lives in the gitignored tmp/; check the excerpt against it when present.
const RECORD = new URL(`../../../tmp/m9d-c1/${replay.sourceFile}`, import.meta.url);
test("the replay excerpt matches its local source record", { skip: !existsSync(RECORD) && "local replay record not present" }, () => {
  const bytes = readFileSync(RECORD);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), replay.sourceSha256);
  const record = JSON.parse(bytes.toString("utf8")) as { results: { label: string; suffixCommitmentHex: string; outcome: { signature: string; succeeded: boolean; guardErrorName: string | null } }[] };
  assert.deepEqual(
    record.results.map((r) => [r.label, r.suffixCommitmentHex, r.outcome.succeeded, r.outcome.guardErrorName]),
    replay.results.map((r) => [r.label, r.suffixCommitmentHex, r.succeeded, r.guardErrorName]),
  );
});
