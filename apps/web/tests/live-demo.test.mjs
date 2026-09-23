/**
 * The local live-Phantom demo's gate and its fail-closed state rules.
 *
 * These are unit tests. Nothing here touches Phantom, a wallet, a validator or
 * the local coordinator: the real Phantom proof is a human procedure in
 * apps/phantom-local-feasibility and is never driven from a test command.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CANONICAL,
  IDLE_LIVE_STATE,
  LIVE_ADAPTER_MODULE,
  LIVE_COORDINATOR_ORIGIN,
  LIVE_DEMO_ENV_VAR,
  assertStaleInvariants,
  assertUpdatedInvariants,
  beginStale,
  beginUpdated,
  liveDemoAvailable,
  liveDemoFlagEnabled,
  liveFailureOffersReplaySwitch,
  livePanels,
  withFailure,
  withReview,
  withStaleResult,
  withUpdatedResult,
} from "../lib/live-demo.ts";

const COMPONENT_URL = new URL("../components/", import.meta.url);

const STALE = Object.freeze({
  leg: "STALE",
  environment: "LOCAL_EXECUTION_REPRODUCTION",
  walletPublicKey: "CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X",
  signature: "stale-signature",
  slot: "120",
  localT: "1700000100",
  summary: "STATE CHANGED",
  guard: "REJECTED at ix0",
  guardErrorName: "ActivationPhaseChanged",
  failedInstruction: 0,
  jupiterInvoked: false,
  whirlpoolInvoked: false,
  usdcDelta: "0",
  koxDelta: "0",
  logs: [],
  proof: {},
});

const UPDATED = Object.freeze({
  leg: "REFRESHED",
  environment: "LOCAL_EXECUTION_REPRODUCTION",
  walletPublicKey: STALE.walletPublicKey,
  signature: "updated-signature",
  slot: "160",
  localT: "1700000100",
  summary: "Updated authorization executed",
  guard: "PASSED",
  jupiterInvoked: true,
  whirlpoolInvoked: true,
  usdcSpentRaw: "5000000",
  koxReceivedRaw: "5504261",
  usdcDisplay: "5.00",
  koxDisplay: "0.05504261",
  logs: [],
  proof: {},
});

const failure = (overrides = {}) => ({
  headline: "Local replay environment is not ready.",
  technical: "stage=ENVIRONMENT_CHECK",
  stage: "ENVIRONMENT_CHECK",
  cancelled: false,
  walletRequested: false,
  submitted: false,
  ...overrides,
});

/** Walks a full successful attempt, which several tests start from. */
function verifiedStaleState() {
  return withStaleResult(beginStale(), STALE);
}

test("the deterministic replay is the default when the live flag is absent", () => {
  assert.equal(LIVE_DEMO_ENV_VAR, "NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO");
  for (const flag of [undefined, "", "false", "0", "TRUE", "True", "1", "yes"]) {
    assert.equal(liveDemoFlagEnabled(flag), false, String(flag));
    assert.equal(
      liveDemoAvailable({ flag, hostname: "localhost", protocol: "http:" }),
      false,
      String(flag)
    );
  }
});

test("live mode cannot activate from a hostname, a deployment, or https alone", () => {
  // The flag alone is not enough: a build that carries it and is deployed
  // anywhere other than loopback still refuses.
  for (const hostname of [
    "equityguard.vercel.app",
    "equityguard.com",
    "localhost.attacker.example",
    "127.0.0.1.attacker.example",
    "192.168.1.10",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      liveDemoAvailable({ flag: "true", hostname, protocol: "http:" }),
      false,
      String(hostname)
    );
  }
  // And loopback alone is not enough either.
  assert.equal(liveDemoAvailable({ flag: undefined, hostname: "127.0.0.1", protocol: "http:" }), false);
  // The coordinator is plain http, so an https page is refused rather than
  // offered and then blocked as mixed content.
  assert.equal(liveDemoAvailable({ flag: "true", hostname: "localhost", protocol: "https:" }), false);

  for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(liveDemoAvailable({ flag: "true", hostname, protocol: "http:" }), true, hostname);
  }
});

test("the live adapter and coordinator are loopback-only and locally built", () => {
  assert.equal(LIVE_COORDINATOR_ORIGIN, "http://127.0.0.1:4175");
  assert.equal(LIVE_ADAPTER_MODULE, "/live-demo/equityguard-live-adapter.js");
});

test("the public build carries no localhost dependency it can reach", async () => {
  const [experience, hook, rootIgnore] = await Promise.all([
    readFile(new URL("demo/demo-experience.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("demo/use-live-demo.ts", COMPONENT_URL), "utf8"),
    readFile(new URL("../../../.gitignore", import.meta.url), "utf8"),
  ]);

  // The replay view holds no local endpoint of its own, and the mode it shows
  // with no live availability is the deterministic replay.
  assert.doesNotMatch(experience, /127\.0\.0\.1|localhost:\d+/);
  assert.match(experience, /modeChoice \?\? \(live\.available \? "live" : "replay"\)/);
  assert.match(experience, /const isLive = mode === "live" && live\.available/);

  // The adapter is requested only behind the gate, and is never bundled.
  assert.match(hook, /webpackIgnore: true/);
  assert.match(hook, /turbopackIgnore: true/);
  assert.match(rootIgnore, /^apps\/web\/public\/live-demo\/$/m);
});

test("the stale panel appears only from a verified stale result", () => {
  const idlePanels = livePanels(IDLE_LIVE_STATE);
  assert.equal(idlePanels.stale, null);
  assert.equal(idlePanels.showReviewCta, false);

  // A result that arrives when no stale leg is running is ignored outright.
  assert.equal(withStaleResult(IDLE_LIVE_STATE, STALE), IDLE_LIVE_STATE);

  const verified = livePanels(verifiedStaleState());
  assert.equal(verified.showReviewCta, true);
  assert.equal(verified.stale?.signature, "stale-signature");
  assert.equal(verified.updated, null);
});

test("a stale result that moved tokens or reached the router is refused", () => {
  for (const [label, overrides] of [
    ["USDC moved", { usdcDelta: "-5000000" }],
    ["KOx moved", { koxDelta: "5504261" }],
    ["Jupiter invoked", { jupiterInvoked: true }],
    ["Whirlpool invoked", { whirlpoolInvoked: true }],
    ["not stopped at ix0", { failedInstruction: 1 }],
    ["a different guard error", { guardErrorName: "SomethingElse" }],
    ["not a local execution", { environment: "SOLANA_MAINNET" }],
    ["no confirmed signature", { signature: "" }],
  ]) {
    const result = { ...STALE, ...overrides };
    assert.throws(() => assertStaleInvariants(result), /failed verification/, label);
    assert.throws(() => withStaleResult(beginStale(), result), /failed verification/, label);
  }
});

test("the second approval needs an explicit review and an explicit confirm", () => {
  // Confirming without reviewing does nothing at all.
  const verified = verifiedStaleState();
  assert.equal(beginUpdated(verified), verified);
  assert.equal(beginUpdated(IDLE_LIVE_STATE), IDLE_LIVE_STATE);

  const reviewing = withReview(verified);
  assert.equal(reviewing.kind, "REVIEWING");
  assert.equal(livePanels(reviewing).showUpdatedTerms, true);

  // Reviewing on its own starts nothing: no leg is running yet.
  assert.equal(livePanels(reviewing).busy, false);

  const running = beginUpdated(reviewing);
  assert.equal(running.kind, "RUNNING");
  assert.equal(livePanels(running).busy, true);
  assert.equal(livePanels(running).updated, null);
});

test("success renders only from a verified updated execution", () => {
  const running = beginUpdated(withReview(verifiedStaleState()));

  // An updated result cannot land on a state that never started the leg.
  assert.equal(withUpdatedResult(verifiedStaleState(), UPDATED).kind, "STALE_VERIFIED");

  for (const [label, overrides] of [
    ["Jupiter absent", { jupiterInvoked: false }],
    ["Whirlpool absent", { whirlpoolInvoked: false }],
    ["one raw unit short", { koxReceivedRaw: "5504260" }],
    ["a different USDC amount", { usdcSpentRaw: "4000000" }],
    ["a changed display amount", { koxDisplay: "0.05504262" }],
    ["not a local execution", { environment: "SOLANA_MAINNET" }],
  ]) {
    const result = { ...UPDATED, ...overrides };
    assert.throws(() => assertUpdatedInvariants(result), /failed verification/, label);
    assert.throws(() => withUpdatedResult(running, result), /failed verification/, label);
  }

  const completed = withUpdatedResult(running, UPDATED);
  assert.equal(completed.kind, "COMPLETED");
  const panels = livePanels(completed);
  assert.equal(panels.updated?.koxDisplay, "0.05504261");
  assert.equal(panels.updated?.usdcDisplay, "5.00");
  assert.equal(panels.failure, null);
});

test("a missing wallet or a rejected signature fails visibly and is not a success", () => {
  for (const [label, detail] of [
    ["Phantom missing", failure({ headline: "Connect Phantom to continue.", stage: "PHANTOM_CONNECT" })],
    ["connection rejected", failure({ headline: "Signature request cancelled.", cancelled: true, stage: "PHANTOM_CONNECT" })],
    ["signing rejected", failure({ headline: "Signature request cancelled.", cancelled: true, stage: "SIGN_REQUEST", walletRequested: true })],
    ["coordinator unavailable", failure({ headline: "Local replay environment is not ready." })],
  ]) {
    const failed = withFailure(beginStale(), "STALE", detail);
    const panels = livePanels(failed);
    assert.equal(failed.kind, "FAILED", label);
    assert.equal(panels.failure?.headline, detail.headline, label);
    assert.equal(panels.stale, null, label);
    assert.equal(panels.updated, null, label);
    assert.equal(panels.showReviewCta, false, label);
    assert.equal(panels.showUpdatedTerms, false, label);
    assert.equal(panels.busy, false, label);
  }
});

test("a failed live run never becomes the deterministic replay on its own", () => {
  const failed = withFailure(beginUpdated(withReview(verifiedStaleState())), "REFRESHED", failure({
    headline: "The transaction could not be confirmed.",
    stage: "CONFIRMATION",
    walletRequested: true,
    submitted: true,
  }));

  assert.equal(failed.kind, "FAILED");
  assert.equal(failed.leg, "REFRESHED");
  // The stale leg of this attempt really executed, so it is kept and labelled —
  // but nothing offers a success, and no transition leads back into a replay.
  assert.equal(livePanels(failed).stale?.signature, "stale-signature");
  assert.equal(livePanels(failed).updated, null);
  assert.equal(withStaleResult(failed, STALE).kind, "FAILED");
  assert.equal(withUpdatedResult(failed, UPDATED).kind, "FAILED");
  assert.equal(withReview(failed).kind, "FAILED");
  assert.equal(beginUpdated(failed).kind, "FAILED");
  // Switching back is the operator's own act, offered rather than performed.
  assert.equal(liveFailureOffersReplaySwitch(failed), true);
  assert.equal(liveFailureOffersReplaySwitch(IDLE_LIVE_STATE), false);
});

test("the canonical display amounts are exactly the proven ones", () => {
  assert.deepEqual({ ...CANONICAL }, {
    usdcIn: "5.00",
    koxOut: "0.05504261",
    usdcInRaw: "5000000",
    koxOutRaw: "5504261",
    guardError: "ActivationPhaseChanged",
    environment: "LOCAL_EXECUTION_REPRODUCTION",
  });
});

test("the live mode never claims a Solana mainnet transaction", async () => {
  const experience = await readFile(new URL("demo/demo-experience.tsx", COMPONENT_URL), "utf8");
  assert.match(experience, /Phantom · Local protected execution/);
  assert.match(experience, /not a Solana mainnet transaction/);
  assert.match(experience, /not on Solana mainnet/);
  assert.doesNotMatch(experience, /EquityGuard executed this trade on Solana mainnet/);
});
