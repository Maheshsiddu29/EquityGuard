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
  TRADER_BUY_KIND,
  TRADER_CONFIRM_KIND,
  TRADER_INITIAL_STEP,
  isSignatureCancelled,
  refreshedSuccessAllowed,
  refreshedSuccessMessage,
  staleReviewAllowed,
  staleReviewMessage,
  technicalEvidence,
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

test("Buy initiates the sealed pre-activation authorization and cannot pick a scenario", () => {
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  const html = readFileSync(join(ROOT, "apps/phantom-local-feasibility/web/index.html"), "utf8");
  const execution = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  assert.equal(TRADER_BUY_KIND, "STALE");
  assert.equal(TRADER_INITIAL_STEP, "READY_STALE");
  assert.match(app, /replayStep: TRADER_INITIAL_STEP/);
  assert.match(app, /submit\(TRADER_BUY_KIND\)/);
  assert.match(app, /prepared\.authorizationSource !== STALE_AUTHORIZATION_SOURCE/);
  assert.match(execution, /kind === "STALE" \? data\.stale : data\.refreshed/);
  assert.match(execution, /staleSource: sealed\.stale\.source/);
  assert.doesNotMatch(html, /<select|scenario|Sign stale|Sign SAFE|SAFE result|STALE result|REFRESHED result|No tokens were exchanged|Purchase completed on Solana mainnet|Mainnet trade completed/);
  assert.doesNotMatch(app, /submit\("SAFE"\)|runReplay\("SAFE"\)|runReplay\("STALE"\)/);
});

test("stale review copy requires a landed EquityGuard rejection and zero token movement", () => {
  const landed = outcome({ kind: "STALE" });
  assert.match(staleReviewMessage(landed) ?? "", /No tokens were exchanged/);
  assert.equal(staleReviewMessage({ ...landed, signature: "" }), null);
  assert.equal(staleReviewMessage({ ...landed, slot: 0n }), null);
  assert.equal(staleReviewMessage({ ...landed, jupiterInvoked: true }), null);
  assert.equal(staleReviewMessage({ ...landed, whirlpoolInvoked: true }), null);
  assert.equal(staleReviewMessage({ ...landed, failedInstruction: 4, customCode: 6024, guardErrorName: null }), null);
  assert.equal(staleReviewMessage({ ...landed, after: { usdc: 4_999_999n, kox: 0n } }), null);
  assert.equal(staleReviewMessage({ ...landed, after: { usdc: 5_000_000n, kox: 1n } }), null);
  assert.equal(staleReviewAllowed({ ...landed, error: null }), false);
});

test("updated order is a separate approval and success requires Jupiter and Whirlpool", () => {
  assert.throws(() => assertReplayApproval("READY_STALE", TRADER_CONFIRM_KIND), /separate approval/);
  assert.doesNotThrow(() => assertReplayApproval("STALE_REJECTED", TRADER_CONFIRM_KIND));
  const refreshed = outcome({ kind: "REFRESHED" });
  const message = refreshedSuccessMessage(refreshed);
  assert.match(message ?? "", /Protected trade replay completed/);
  assert.match(message ?? "", /0\.05504261 KOx/);
  assert.doesNotMatch(message ?? "", /mainnet/i);
  assert.equal(refreshedSuccessAllowed({ ...refreshed, jupiterInvoked: false }), false);
  assert.equal(refreshedSuccessAllowed({ ...refreshed, whirlpoolInvoked: false }), false);
  assert.equal(refreshedSuccessAllowed({ ...refreshed, skipPreflight: true }), false);
  assert.equal(refreshedSuccessAllowed({ ...refreshed, after: { usdc: 0n, kox: 5_504_260n } }), false);
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  assert.match(app, /kind === TRADER_CONFIRM_KIND && state\.approvals < 1/);
  assert.match(app, /updated-terms"\)\.hidden = false/);
  assert.doesNotMatch(app, /Phantom approvals so far/);
});

test("technical evidence uses the proved local attempts and does not count extra approvals", () => {
  const text = technicalEvidence(outcome({ kind: "STALE" }), outcome({ kind: "REFRESHED" }));
  assert.ok(text);
  assert.match(text ?? "", /Sep 15 · 00:29:46 UTC/);
  assert.match(text ?? "", /Rejected at ix0/);
  assert.match(text ?? "", /ActivationPhaseChanged/);
  assert.match(text ?? "", /Second Phantom approval:\nYes/);
  assert.match(text ?? "", /USDC:\n-5\.00/);
  assert.match(text ?? "", /KOx:\n\+0\.05504261/);
  assert.match(text ?? "", /not a mainnet EquityGuard transaction/);
  assert.doesNotMatch(text ?? "", /approvals so far/i);
  assert.equal(technicalEvidence(outcome({ kind: "STALE", jupiterInvoked: true }), outcome({ kind: "REFRESHED" })), null);
});

test("trader-facing errors stay plain and keep the raw failure for technical details", () => {
  assert.equal(traderFacingError("buy", new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected.")).headline, "Phantom not detected");
  assert.equal(traderFacingError("buy", { code: 4001, message: "User rejected the request." }).headline, "Signature request cancelled");
  assert.equal(isSignatureCancelled(new FeasibilityError("USER_REJECTED", "The user rejected the Phantom signature request.")), true);
  assert.equal(traderFacingError("buy", new FeasibilityError("LOCAL_RPC_REFUSED", "Refusing a public Solana cluster genesis hash")).headline, "Local replay environment unavailable");
  assert.equal(traderFacingError("buy", new Error("route changed")).headline, "Order could not be submitted");
  assert.equal(traderFacingError("confirm", new Error("route changed")).headline, "Updated order could not be confirmed");
});

test("trader integration does not retarget execution, route, or localhost policy", () => {
  const execution = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  const trader = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/trader-flow.ts"), "utf8");
  assert.match(execution, /assertLocalRpcUrl/);
  assert.match(execution, /skipPreflightAllowed\(prepared\.kind\)/);
  assert.match(execution, /outcome\.after\.usdc !== outcome\.before\.usdc - EXPECTED_IN_AMOUNT/);
  assert.match(execution, /ActivationPhaseChanged/);
  assert.doesNotMatch(trader, /composeGuardedJupiterTrade|sendTransaction\(/);
  assert.equal(TRADER_CONFIRM_KIND, "REFRESHED");
});
