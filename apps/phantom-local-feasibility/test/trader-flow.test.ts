import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { FeasibilityError } from "../src/feasibility.ts";
import {
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
} from "../src/local-funding.ts";
import type { ReplayOutcome } from "../src/replay-execution.ts";
import { assertReplayApproval } from "../src/replay-model.ts";
import {
  RECORDED_REFRESHED_PROOF,
  RECORDED_STALE_PROOF,
  TRADER_BUY_KIND,
  TRADER_INITIAL_STEP,
  isSignatureCancelled,
  liveSafeAllowed,
  liveSafeMessage,
  protectionStory,
  protectionTechnicalDetails,
  traderFacingError,
} from "../src/trader-flow.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PHANTOM = "CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X";

function outcome(overrides: Partial<ReplayOutcome> & Pick<ReplayOutcome, "kind">): ReplayOutcome {
  const base: ReplayOutcome = {
    kind: overrides.kind,
    signature: "landed-local-signature",
    slot: 447663875n,
    signer: PHANTOM,
    feePayer: PHANTOM,
    error: overrides.kind === "STALE" ? { InstructionError: [0, { Custom: 12 }] } : null,
    failedInstruction: overrides.kind === "STALE" ? 0 : null,
    customCode: overrides.kind === "STALE" ? 12 : null,
    guardErrorName: overrides.kind === "STALE" ? "ActivationPhaseChanged" : null,
    guardInvoked: true,
    jupiterInvoked: overrides.kind !== "STALE",
    whirlpoolInvoked: overrides.kind !== "STALE",
    before: { usdc: 5_000_000n, kox: 0n },
    after: overrides.kind === "STALE" ? { usdc: 5_000_000n, kox: 0n } : { usdc: 0n, kox: 5_504_261n },
    skipPreflight: overrides.kind === "STALE",
    logs: [],
    computeUnits: "1",
    simulation: null,
    authorizationSource: overrides.kind === "STALE" ? STALE_AUTHORIZATION_SOURCE : REFRESHED_AUTHORIZATION_SOURCE,
  };
  return { ...base, ...overrides };
}

test("live reproduction uses current local state and exposes no scenario selector", () => {
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  const local = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/local-activation.ts"), "utf8");
  const html = readFileSync(join(ROOT, "apps/phantom-local-feasibility/web/index.html"), "utf8");
  assert.match(app, /PHANTOM_NOT_DETECTED/);
  assert.match(local, /fetchGuardSnapshot/);
  assert.match(local, /expected: current.state, expectedPhase: current.phase/);
  assert.match(html, /Local execution reproduction/);
  assert.match(html, /not the historical Sep 15 timestamp/);
  assert.doesNotMatch(html, /<select|Sign SAFE|Sign stale|SAFE result|STALE result|REFRESHED result/);
});

test("live SAFE success requires preflight, Jupiter, Whirlpool, and the exact deltas", () => {
  const landed = outcome({ kind: "SAFE" });
  const message = liveSafeMessage(landed);
  assert.match(message ?? "", /Protected trade executed/);
  assert.match(message ?? "", /5\.00 USDC → 0\.05504261 KOx/);
  assert.match(message ?? "", /Local execution replay/);
  assert.doesNotMatch(message ?? "", /mainnet/i);
  assert.equal(liveSafeAllowed({ ...landed, skipPreflight: true }), false);
  assert.equal(liveSafeAllowed({ ...landed, jupiterInvoked: false }), false);
  assert.equal(liveSafeAllowed({ ...landed, whirlpoolInvoked: false }), false);
  assert.equal(liveSafeAllowed({ ...landed, guardInvoked: false }), false);
  assert.equal(liveSafeAllowed({ ...landed, after: { usdc: 0n, kox: 5_504_260n } }), false);
  assert.equal(liveSafeAllowed({ ...landed, authorizationSource: STALE_AUTHORIZATION_SOURCE }), false);
  assert.doesNotThrow(() => assertReplayApproval("READY_SAFE", "SAFE"));
  assert.throws(() => assertReplayApproval("READY_SAFE", "STALE"), /separate approval/);
});

test("protection story quotes the recorded executions and does not relabel the live Buy", () => {
  const recorded = JSON.parse(readFileSync(join(ROOT, "apps/reference/data/kox-trade-replay.json"), "utf8")) as {
    staleExecution: {
      authorizationSource: string;
      invoked: readonly string[];
      deltas: { usdc: string; kox: string };
      outcome: { signature: string; failedInstruction: number; customCode: number; guardErrorName: string; logs: readonly string[] };
    };
    refreshedExecution: {
      authorizationSource: string;
      invoked: readonly string[];
      deltas: { usdc: string; kox: string };
      outcome: { signature: string; succeeded: boolean; err: null; logs: readonly string[] };
    };
  };
  assert.equal(recorded.staleExecution.authorizationSource, RECORDED_STALE_PROOF.authorizationSource);
  assert.equal(recorded.staleExecution.outcome.signature, RECORDED_STALE_PROOF.signature);
  assert.equal(recorded.staleExecution.outcome.failedInstruction, RECORDED_STALE_PROOF.failedInstruction);
  assert.equal(recorded.staleExecution.outcome.customCode, RECORDED_STALE_PROOF.customCode);
  assert.equal(recorded.staleExecution.outcome.guardErrorName, RECORDED_STALE_PROOF.guardErrorName);
  assert.equal(recorded.staleExecution.deltas.usdc, RECORDED_STALE_PROOF.usdcDelta);
  assert.equal(recorded.staleExecution.deltas.kox, RECORDED_STALE_PROOF.koxDelta);
  assert.equal(recorded.staleExecution.invoked.some((program) => program.startsWith("JUP6")), RECORDED_STALE_PROOF.jupiterInvoked);
  assert.equal(recorded.staleExecution.invoked.some((program) => program.startsWith("whirLb")), RECORDED_STALE_PROOF.whirlpoolInvoked);
  assert.equal(recorded.refreshedExecution.authorizationSource, RECORDED_REFRESHED_PROOF.authorizationSource);
  assert.equal(recorded.refreshedExecution.outcome.signature, RECORDED_REFRESHED_PROOF.signature);
  assert.equal(recorded.refreshedExecution.outcome.succeeded, RECORDED_REFRESHED_PROOF.guardPassed);
  assert.equal(recorded.refreshedExecution.outcome.err, null);
  assert.equal(recorded.refreshedExecution.deltas.usdc, RECORDED_REFRESHED_PROOF.usdcDelta);
  assert.equal(recorded.refreshedExecution.deltas.kox, RECORDED_REFRESHED_PROOF.koxDelta);
  assert.equal(recorded.refreshedExecution.invoked.some((program) => program.startsWith("JUP6")), RECORDED_REFRESHED_PROOF.jupiterInvoked);
  assert.equal(recorded.refreshedExecution.invoked.some((program) => program.startsWith("whirLb")), RECORDED_REFRESHED_PROOF.whirlpoolInvoked);
  assert.ok(recorded.staleExecution.outcome.logs.some((line) => line.includes("ActivationPhaseChanged")));
  assert.ok(recorded.refreshedExecution.outcome.logs.some((line) => line.includes("EquityGuard: safe")));
  assert.ok(recorded.refreshedExecution.outcome.logs.some((line) => line.includes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke")));
  assert.ok(recorded.refreshedExecution.outcome.logs.some((line) => line.includes("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke")));

  const text = protectionStory();
  for (const copy of [
    "Stale authorization blocked", "Previously verified local execution evidence",
    "Separate from the live Buy above", "EquityGuard: Rejected before protected execution",
    "Jupiter: Not invoked", "Whirlpool: Not invoked", "USDC movement: 0", "KOx movement: 0",
    "Updated authorization executed", "Previously recorded recovery execution",
    "EquityGuard: Passed", "Jupiter: Executed", "Whirlpool: Executed",
    "USDC: -5.00", "KOx: +0.05504261", "Sep 15 00:29:46 UTC", "00:30:00 UTC", "00:30:16 UTC",
    "not a Solana mainnet EquityGuard transaction", "did not cross the Sep 15 event",
    "independently captured mainnet-derived evidence",
  ]) assert.ok(text.includes(copy), copy);
  const technical = JSON.parse(protectionTechnicalDetails());
  assert.deepEqual(technical.stale, recorded.staleExecution);
  assert.deepEqual(technical.refreshed, recorded.refreshedExecution);
  assert.doesNotMatch(text, /ActivationPhaseChanged|3tR4WJV/);
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  assert.match(app, /text\("recorded-details", protectionTechnicalDetails\(\)\)/);

});

test("trader-facing errors stay plain and keep the raw failure for technical details", () => {
  assert.equal(
    traderFacingError("buy", new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected."), "PHANTOM_CONNECT").headline,
    "Connect Phantom to continue.",
  );
  assert.equal(
    traderFacingError("buy", { code: 4001, message: "User rejected the request." }, "SIGN_REQUEST").headline,
    "Signature request cancelled.",
  );
  assert.equal(isSignatureCancelled(new FeasibilityError("USER_REJECTED", "The user rejected the Phantom signature request.")), true);
  assert.equal(
    traderFacingError("buy", new FeasibilityError("LOCAL_RPC_REFUSED", "Refusing a public Solana cluster genesis hash"), "ENVIRONMENT_CHECK").headline,
    "Local replay environment is not ready.",
  );
  assert.equal(traderFacingError("buy", new Error("route changed"), "SUBMISSION").headline, "The order could not be submitted.");
  assert.equal(traderFacingError("confirm", new Error("route changed"), "CONFIRMATION").headline, "The transaction could not be confirmed.");
  const signing = traderFacingError("buy", new Error("Unexpected error"), "SIGN_REQUEST");
  assert.equal(signing.headline, "The signature request could not be completed.");
  assert.match(signing.technical, /Stage: SIGN_REQUEST/);
  assert.notEqual(signing.technical, "Unexpected error");
});

test("trader integration does not retarget execution, route, or localhost policy", () => {
  const execution = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  const trader = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/trader-flow.ts"), "utf8");
  assert.match(execution, /assertLocalRpcUrl/);
  assert.match(execution, /skipPreflightAllowed\(prepared\.kind\)/);
  assert.match(execution, /outcome\.after\.usdc !== outcome\.before\.usdc - EXPECTED_IN_AMOUNT/);
  assert.match(execution, /ActivationPhaseChanged/);
  assert.doesNotMatch(trader, /composeGuardedJupiterTrade|sendTransaction\(/);
  assert.equal(TRADER_BUY_KIND, "SAFE");
});

 test("consumed fixture gives reset guidance and keeps stage details", () => {
  const error = traderFacingError("buy", new Error("Phantom USDC is 0, expected 5000000. Reseed the local fixture."), "TRANSACTION_BUILD");
  assert.match(error.headline, /^Demo environment needs reset/);
  assert.match(error.technical, /Stage: TRANSACTION_BUILD/);
  assert.match(error.technical, /5000000/);
});

test("live success rejects missing confirmation, errors, and nonbaseline balances", () => {
  const landed = outcome({ kind: "SAFE" });
  for (const bad of [
    { slot: 0n }, { signature: "" }, { error: { InstructionError: [0, { Custom: 12 }] } },
    { before: { usdc: 10_000_000n, kox: 0n }, after: { usdc: 5_000_000n, kox: 5_504_261n } },
    { feePayer: "another-payer" },
  ]) assert.equal(liveSafeAllowed({ ...landed, ...bad }), false);
});
