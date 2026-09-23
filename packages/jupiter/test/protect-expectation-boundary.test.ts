/**
 * EG-A-01: the canonical path cannot emit an economic-state expectation that
 * is not the live one.
 *
 * The on-chain program compares the expectation the transaction carries
 * against the mint and the Clock at execution time. It cannot know when that
 * expectation was written, so a builder that encodes the post-activation
 * phase while the chain is still pre-activation gets a transaction the guard
 * *accepts* once the Clock passes T — and the user trades under a multiplier
 * they were never shown.
 *
 * `protectJupiterSwap` closes that by construction: it derives the phase from
 * the same snapshot it validates against, and refuses to build anything the
 * program would reject at that moment. These tests assert that on the encoded
 * ABI bytes, not on the shape of the call.
 *
 * The complementary half — that the trusted-builder APIs still accept a
 * caller-chosen expectation, and are classified as such — is in
 * `packages/guard-client/test/advanced.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase, decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS, type ProtectedState } from "@equityguard/guard-client";

import { protectJupiterSwap, type ProtectJupiterSwapResult } from "../src/protect.ts";
import {
  KOX_ACTIVATION_TIMESTAMP,
  KOX_MINT,
  SETTLED_TIMESTAMP,
  TAKER,
  fakeRpc,
  mainnetMint,
  recordedKoxBuyBuild,
  token2022Account,
} from "./protect-fixtures.ts";

/** Offset of the activation-phase byte in the ABI v2 payload (`instruction.rs`). */
const EXPECTED_PHASE_OFFSET = 57;
/** Wide enough that the window, not the phase check, would fire near T. */
const WINDOW = { beforeSecs: 900, afterSecs: 300 };
/** Comfortably outside the window on the pre-activation side. */
const BEFORE_ACTIVATION = KOX_ACTIVATION_TIMESTAMP - 10_000n;

const KOX_STATE: ProtectedState = decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, mainnetMint("KOx"));

function protect(unixTimestamp: bigint, quoted?: { expectedState: ProtectedState; expectedPhase?: ActivationPhase }): Promise<ProtectJupiterSwapResult> {
  const { rpc } = fakeRpc({ accounts: { [KOX_MINT]: token2022Account(mainnetMint("KOx")) }, unixTimestamp });
  return protectJupiterSwap({
    build: recordedKoxBuyBuild(),
    userPublicKey: TAKER,
    rpc,
    protectionWindow: WINDOW,
    ...(quoted?.expectedState === undefined ? {} : { expectedState: quoted.expectedState }),
    ...(quoted?.expectedPhase === undefined ? {} : { expectedPhase: quoted.expectedPhase }),
  });
}

/** The activation phase actually encoded in the guard instruction that was built. */
function encodedPhase(result: ProtectJupiterSwapResult): number {
  assert.equal(result.status, "PROTECTED", `expected PROTECTED, got ${"message" in result ? result.message : result.status}`);
  if (result.status !== "PROTECTED") throw new Error("unreachable");
  const guard = result.instructions[0];
  assert.ok(guard?.data, "guard instruction carries ABI bytes");
  return guard.data[EXPECTED_PHASE_OFFSET]!;
}

function assertRefused(result: ProtectJupiterSwapResult, guardError: string, label: string): void {
  assert.equal(result.status, "ERROR", label);
  if (result.status !== "ERROR") throw new Error("unreachable");
  assert.equal(result.code, "ECONOMIC_STATE_CHANGED", label);
  assert.equal(result.guardError, guardError, label);
  // A refusal must never hand back something signable.
  assert.ok(!("transaction" in result) && !("instructions" in result), `${label}: no signable bytes`);
}

test("EG-A-01: before the activation, the canonical path encodes Pending", async () => {
  const result = await protect(BEFORE_ACTIVATION);
  assert.equal(encodedPhase(result), ActivationPhase.Pending);
  assert.equal(result.status === "PROTECTED" && result.snapshot.phase, ActivationPhase.Pending);
});

test("EG-A-01: after the activation, the canonical path encodes Activated", async () => {
  const result = await protect(SETTLED_TIMESTAMP);
  assert.equal(encodedPhase(result), ActivationPhase.Activated);
  assert.equal(result.status === "PROTECTED" && result.snapshot.phase, ActivationPhase.Activated);
});

test("EG-A-01: a caller cannot force Activated while the chain is still Pending", async () => {
  // The exact shape of the finding: the future state is quoted, the user would
  // sign it pre-activation, and it would pass the guard after T.
  const result = await protect(BEFORE_ACTIVATION, { expectedState: KOX_STATE, expectedPhase: ActivationPhase.Activated });
  assertRefused(result, "ActivationPhaseChanged", "future-dated Activated");
});

test("EG-A-01: a caller cannot force Pending once the chain has activated", async () => {
  const result = await protect(SETTLED_TIMESTAMP, { expectedState: KOX_STATE, expectedPhase: ActivationPhase.Pending });
  assertRefused(result, "ActivationPhaseChanged", "stale Pending");
});

test("EG-A-01: the encoded phase always equals the snapshot's, on both sides of T", async () => {
  // Every input the canonical API accepts, at each side of the activation.
  // None of them can move the byte away from the snapshot's phase.
  for (const [label, clock, phase] of [
    ["pre-activation", BEFORE_ACTIVATION, ActivationPhase.Pending],
    ["post-activation", SETTLED_TIMESTAMP, ActivationPhase.Activated],
  ] as const) {
    const derived = await protect(clock);
    assert.equal(encodedPhase(derived), phase, `${label}: no quote`);

    // Quoting the live state under the live phase is the only accepted quote,
    // and it still yields the snapshot's phase rather than the caller's.
    const quoted = await protect(clock, { expectedState: KOX_STATE, expectedPhase: phase });
    assert.equal(encodedPhase(quoted), phase, `${label}: matching quote`);
  }
});

test("EG-A-01: a scheduled-change quote without its phase fails closed rather than defaulting", async () => {
  const result = await protect(BEFORE_ACTIVATION, { expectedState: KOX_STATE });
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "INVALID_GUARD_REQUEST");
  assert.match(
    result.status === "ERROR" ? result.message : "",
    /depends on the phase it was quoted under/,
    "the refusal names the reason rather than silently picking a side",
  );
});
