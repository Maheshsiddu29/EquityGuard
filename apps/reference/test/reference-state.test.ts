import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import { expectationView, loadKoxTradeEvidence } from "../../../scripts/demo/kox-trade-evidence.ts";
import { deriveReferenceState, loadTradeReplay } from "../build/derive-state.ts";

const state = deriveReferenceState();
const replay = loadTradeReplay();
const sealed = loadKoxTradeEvidence();

test("stale and refreshed expectations derive from the adjacent sealed observations", () => {
  assert.deepEqual(replay.staleExecution.authorization, expectationView(sealed.pre.expectation));
  assert.deepEqual(replay.refreshedExecution.authorization, expectationView(sealed.post.expectation));
  assert.equal(replay.staleExecution.authorization.expectedPhase, ActivationPhase.Pending);
  assert.equal(replay.refreshedExecution.authorization.expectedPhase, ActivationPhase.Activated);
  assert.deepEqual([sealed.pre.source.blockTime, sealed.post.source.blockTime], [1_789_432_186, 1_789_432_216]);
  assert.equal(sealed.pre.expectation.expected.newMultiplierEffectiveTimestamp, 1_789_432_200n);
});

test("the submitted stale authorization was unchanged and rejection came from execution", () => {
  const stale = replay.staleExecution;
  assert.equal(stale.guardDataUnchanged, true);
  assert.equal(stale.submittedGuardDataHex, stale.derivedGuardDataHex);
  assert.deepEqual(
    [stale.outcome.succeeded, stale.outcome.failedInstruction, stale.outcome.customCode, stale.outcome.guardErrorName],
    [false, 0, 12, "ActivationPhaseChanged"],
  );
  assert.match(stale.outcome.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
});

test("stale execution stops before Jupiter and moves no tokens", () => {
  assert.equal(replay.staleExecution.invoked.length, 1);
  assert.match(replay.staleExecution.invoked[0] ?? "", /^EbzHfao/);
  assert.ok(!replay.staleExecution.invoked.some((program) => program.startsWith("JUP6Lkb")));
  assert.deepEqual(replay.staleExecution.deltas, { usdc: "0", kox: "0" });
});

test("refreshed execution uses the same route and executes Jupiter and Whirlpool", () => {
  const refreshed = replay.refreshedExecution;
  assert.equal(refreshed.outcome.succeeded, true);
  assert.ok(refreshed.invoked.some((program) => program.startsWith("JUP6Lkb")));
  assert.ok(refreshed.invoked.some((program) => program.startsWith("whirLb")));
  assert.deepEqual(refreshed.deltas, { usdc: "-5000000", kox: "5504261" });
  assert.equal(refreshed.suffixCommitmentHex, replay.staleExecution.suffixCommitmentHex);
  assert.equal(refreshed.suffixCommitmentHex, replay.routeEvidence.commitmentHex);
});

test("frontend amounts and provenance come only from the structured replay", () => {
  assert.deepEqual(state.order, { side: "Buy", inputAmount: "5.00", inputSymbol: "USDC", estimatedOutput: "0.05504261", outputSymbol: "KOx" });
  assert.equal(state.asset.decimals, 8);
  assert.equal(state.routeEvidence.outputRaw, "5504261");
  assert.equal(state.routeEvidence.fixtureSha256, "d5d76b2ccf222ea9f9a53e340a9cd76540a24e133966838168a726a428cc1914");
  assert.equal(state.marketEvidence.sourceSha256, "f137feeda9b0340559f5a98cb7ec74fdd1741d515e5d231b3144f5a0f874eb06");
  assert.equal(state.localExecution.environment, "solana-test-validator");
  assert.equal(state.localExecution.executionDidNotOccurOnMainnet, true);
});

test("browser contains no scenario selector or hard-coded economic phase", () => {
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const web = new URL("../web/", import.meta.url);
  const html = readdirSync(web)
    .filter((file) => file.endsWith(".html"))
    .map((file) => readFileSync(new URL(file, web), "utf8"))
    .join("\n");
  for (const forbidden of [/data-scenario/, /ScenarioId/, /expectedPhase/, /ActivationPhase/, /multiplierHex/]) {
    assert.ok(!forbidden.test(`${app}\n${html}`), `browser contains ${forbidden}`);
  }
  assert.equal((html.match(/id="run-trade"/g) ?? []).length, 1);
});

test("derivation is deterministic and traceable", () => {
  assert.deepEqual(deriveReferenceState(), state);
  const artifact = readFileSync(new URL("../data/kox-trade-replay.json", import.meta.url));
  const artifactSha = createHash("sha256").update(artifact).digest("hex");
  assert.ok(state.generatedFrom.some((source) => source.sha256 === artifactSha));
});

const LOCAL_REPORT = new URL("../../../tmp/m9d-c1/kox-trade-replay-final.json", import.meta.url);
test("committed replay is byte-identical to the local execution output", { skip: !existsSync(LOCAL_REPORT) && "local replay output absent" }, () => {
  assert.deepEqual(readFileSync(new URL("../data/kox-trade-replay.json", import.meta.url)), readFileSync(LOCAL_REPORT));
});
