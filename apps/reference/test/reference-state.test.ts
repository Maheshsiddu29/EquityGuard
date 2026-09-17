import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { koDivergenceFacts } from "../../../scripts/demo/mainnet-replay.ts";
import { deriveReferenceState, loadReplayExcerpt } from "../build/derive-state.ts";

const state = deriveReferenceState();
const replay = loadReplayExcerpt();
const facts = koDivergenceFacts();
const T = Date.parse(state.divergence.kox.effectiveAt);

test("the three-step flow is SAFE → BLOCK: ECONOMIC_STATE_CHANGED → ALLOW", () => {
  const { safe, stale, refreshed } = state.scenarios;
  assert.deepEqual(safe.decision, { type: "ALLOW", guardResult: null });
  assert.deepEqual(stale.decision, { type: "BLOCK", reason: "ECONOMIC_STATE_CHANGED", guardResult: "ActivationPhaseChanged" });
  assert.deepEqual(refreshed.decision, { type: "ALLOW", guardResult: null });
  assert.equal(stale.authorized.fingerprint, safe.authorized.fingerprint);
  assert.notEqual(stale.current.fingerprint, stale.authorized.fingerprint);
  assert.equal(refreshed.authorized.fingerprint, stale.current.fingerprint);
  // The Clock crossed T without any byte change: only the phase differs.
  assert.equal(stale.authorized.multiplierHex, stale.current.multiplierHex);
  assert.equal(stale.authorized.newMultiplierHex, stale.current.newMultiplierHex);
  assert.deepEqual([stale.authorized.phase, stale.current.phase], ["PENDING", "ACTIVATED"]);
});

test("the stale case uses the adjacent real observations immediately around activation", () => {
  const { safe, stale } = state.scenarios;
  // Last pending and first activated observation of the curated window.
  assert.deepEqual([stale.authorized.slot, stale.current.slot], ["447113427", "447113520"]);
  const prepared = Date.parse(stale.authorized.chainTime);
  const checked = Date.parse(stale.evaluatedAt);
  assert.ok(prepared < T && T <= checked);
  assert.ok(T - prepared <= 30_000 && checked - T <= 30_000, "both observations within one polling interval of T");
  assert.equal(checked - prepared, 30_000);
  assert.equal(safe.evaluatedAt, stale.authorized.chainTime);
});

test("the transition cases use a zero window and match the existing clock-crossing facts", () => {
  const { safe, stale, refreshed } = state.scenarios;
  for (const s of [safe, stale, refreshed]) assert.deepEqual([s.window.beforeSecs, s.window.afterSecs], [0, 0]);
  const crossing = facts.koxClockCrossing;
  assert.equal(crossing.pendingSnapshotZeroWindow.guardResult, stale.decision.guardResult);
  assert.equal(crossing.freshActivatedSnapshotZeroWindow.guardResult, refreshed.decision.guardResult);
  // The window note's claim: the demo window would have blocked these moments.
  assert.equal(crossing.pendingSnapshotDemoWindow.guardResult, "InsideTransitionWindow");
  assert.match(stale.window.note, /InsideTransitionWindow/);
});

test("the Sep 15 transition cases never draw on the Sep 17 local replay", () => {
  const replayValues = [replay.route.outAmount, replay.route.otherAmountThreshold, ...replay.results.map((r) => r.suffixCommitmentHex), replay.recordedAt.slice(0, 10)];
  for (const s of Object.values(state.scenarios)) {
    assert.ok(!s.backing.some((b) => b.provenance === "LOCAL_REPLAY"), s.id);
    const text = JSON.stringify(s);
    for (const value of replayValues) assert.ok(!text.includes(value), `${s.id} contains replay value ${value}`);
    assert.ok(!/Sep 17|replay/i.test(text), `${s.id} mentions the replay`);
  }
  assert.ok(!JSON.stringify(state.order).includes(replay.route.outAmount));
});

test("the local replay is described as a separate test after the event", () => {
  const r = state.replay;
  assert.ok(Date.parse(r.localClock) - T > 24 * 3600 * 1000, "the replay clock is days after activation");
  assert.ok(Date.parse(r.routeObservedAt) - T > 24 * 3600 * 1000);
  assert.equal(r.localClockPhase, "ACTIVATED");
  const [safe, stale, mutated] = r.cases;
  assert.deepEqual(
    r.cases.map((c) => [c.label, c.decision.type, c.decision.guardResult, c.expectedPhase, c.jupiterRan]),
    [
      ["SAFE", "ALLOW", null, "ACTIVATED", true],
      ["STALE_PRE_ACTIVATION", "BLOCK", "ActivationPhaseChanged", "PENDING", false],
      ["MUTATED_SLIPPAGE", "BLOCK", "DownstreamCommitmentMismatch", "ACTIVATED", false],
    ],
  );
  assert.equal(mutated?.decision.type === "BLOCK" && mutated.decision.reason, "INTENT_MISMATCH");
  assert.match(stale?.description ?? "", /deliberately/);
  assert.deepEqual([safe?.usdcDelta, safe?.stockDelta], ["-5000000", "5504261"]);
  for (const c of [stale, mutated]) {
    assert.deepEqual([c?.succeeded, c?.failedInstruction, c?.usdcDelta, c?.stockDelta, c?.programsInvoked, c?.feeLamports], [false, 0, "0", "0", 1, "5441"]);
  }
});

test("the replay excerpt's expectations are the recorded KOx bytes", () => {
  const { stale } = state.scenarios;
  for (const r of replay.results) {
    assert.equal(r.expectation.multiplierHex, stale.current.multiplierHex);
    assert.equal(r.expectation.newMultiplierHex, stale.current.newMultiplierHex);
    assert.equal(Number(r.expectation.newMultiplierEffectiveTimestamp) * 1000, T);
  }
});

test("the consent case is secondary, from the decision engine, and illustrative", () => {
  const { consent } = state.scenarios;
  assert.equal(Object.keys(state.scenarios).at(-1), "consent");
  assert.deepEqual(
    Object.values(state.scenarios).filter((s) => s.illustrative).map((s) => s.id),
    ["consent"],
  );
  for (const s of Object.values(state.scenarios).filter((s) => s.id !== "consent")) {
    assert.ok(!s.backing.some((b) => b.provenance === "ILLUSTRATIVE"), s.id);
  }
  assert.equal(consent.decision.type, "REQUIRES_CONSENT");
  if (consent.decision.type !== "REQUIRES_CONSENT") return;
  assert.equal(consent.decision.reason, "REPRESENTATION_CHANGE");
  assert.equal(consent.decision.guardResult, "InsideTransitionWindow");
  assert.equal(consent.backing[0]?.provenance, "ILLUSTRATIVE");
  assert.match(consent.headline, /^Illustrative/);
  assert.match(consent.settlement, /never executes/);
  assert.deepEqual([consent.window.beforeSecs, consent.window.afterSecs], [900, 300]);
});

test("the timeline carries the observed 25m 56s divergence and mechanisms", () => {
  const { divergence } = state;
  assert.equal(divergence.seconds, 25 * 60 + 56);
  assert.equal(divergence.kox.effectiveAt, "2026-09-15T00:30:00Z");
  assert.equal(divergence.koon.effectiveAt, "2026-09-15T00:04:04Z");
  assert.equal(divergence.kox.bytesUnchangedAtActivation, true);
  assert.equal(divergence.koon.pendingPhaseObserved, false);
  assert.equal(divergence.kox.apiReason, "Dividend");
  assert.deepEqual([divergence.kox.lastPendingBlockTime, divergence.kox.firstActivatedBlockTime], ["2026-09-15T00:29:46Z", "2026-09-15T00:30:16Z"]);
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
  const record = JSON.parse(bytes.toString("utf8")) as {
    localSnapshot: { unixTimestamp: string; phase: number };
    results: { label: string; suffixCommitmentHex: string; outcome: { succeeded: boolean; guardErrorName: string | null } }[];
  };
  assert.deepEqual([record.localSnapshot.unixTimestamp, record.localSnapshot.phase], [replay.localClock.unixTimestamp, replay.localClock.phase]);
  assert.deepEqual(
    record.results.map((r) => [r.label, r.suffixCommitmentHex, r.outcome.succeeded, r.outcome.guardErrorName]),
    replay.results.map((r) => [r.label, r.suffixCommitmentHex, r.succeeded, r.guardErrorName]),
  );
});
