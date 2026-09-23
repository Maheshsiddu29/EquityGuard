/**
 * The live adapter's fail-closed boundary.
 *
 * These are unit tests over verified-proof shapes. They do not touch Phantom,
 * a wallet, a validator or the coordinator: the real Phantom proof is this
 * app's own live procedure and is never run from a test command.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPECTED_DISPLAY, verifyStaleResult, verifyUpdatedResult } from "../src/live-adapter.ts";
import { EXPECTED_IN_AMOUNT, EXPECTED_OUT_AMOUNT, EXPECTED_PHANTOM } from "../src/local-funding.ts";

const LOCAL_T = 1_700_000_100n;
const TIMING = (relation: "BEFORE_ACTIVATION" | "AT_OR_AFTER_ACTIVATION", phase: "PENDING" | "ACTIVATED") => ({
  encodedPhase: phase,
  clockRelationToLocalT: relation,
  requiredRelationToLocalT: relation,
  clockMatchesExpectedPhase: true as const,
});
const WIRE = "a".repeat(64);
const MESSAGE = "b".repeat(64);
const DEPLOYMENT = (stage: "PRE_SIGN" | "PRE_SUBMISSION") => ({ stage, digest: "c".repeat(64), matched: true as const });

function staleProof() {
  return {
    environment: "LOCAL_EXECUTION_REPRODUCTION",
    localT: LOCAL_T,
    atSigning: { unixTimestamp: LOCAL_T - 5n, slot: 10n },
    atSubmission: { unixTimestamp: LOCAL_T + 5n, slot: 20n },
    lifetime: { valid: true, height: 20n, lastValidBlockHeight: 400n },
    exactEquality: true,
    signedWireHashBeforeActivation: WIRE,
    signedWireHashAtSubmission: WIRE,
    preSign: { proofId: "p1", messageSha256: MESSAGE, timing: TIMING("BEFORE_ACTIVATION", "PENDING"), source: "LOCAL_COORDINATOR" as const },
    signedAuthorization: {
      proofId: "p1", signedWireSha256: WIRE, messageSha256: MESSAGE, messageMatchesSimulated: true as const,
      timing: TIMING("BEFORE_ACTIVATION", "PENDING"), signatureVerified: true as const, source: "LOCAL_COORDINATOR" as const,
    },
    deploymentAttestations: [DEPLOYMENT("PRE_SIGN"), DEPLOYMENT("PRE_SUBMISSION")] as const,
    outcome: {
      kind: "STALE" as const,
      signature: "sig-stale",
      slot: 20n,
      signer: EXPECTED_PHANTOM,
      feePayer: EXPECTED_PHANTOM,
      error: { InstructionError: [0, { Custom: 12 }] },
      failedInstruction: 0,
      customCode: 12,
      guardErrorName: "ActivationPhaseChanged",
      guardInvoked: true,
      jupiterInvoked: false,
      whirlpoolInvoked: false,
      before: { usdc: EXPECTED_IN_AMOUNT, kox: 0n },
      after: { usdc: EXPECTED_IN_AMOUNT, kox: 0n },
      skipPreflight: true,
      logs: ["Program EbzHf log: ActivationPhaseChanged"],
      computeUnits: "1000",
      simulation: null,
      authorizationSource: "LOCAL_EXECUTION_REPRODUCTION",
    },
  };
}

function updatedProof() {
  const base = staleProof();
  return {
    ...base,
    preSign: { ...base.preSign, timing: TIMING("AT_OR_AFTER_ACTIVATION", "ACTIVATED") },
    signedAuthorization: { ...base.signedAuthorization, timing: TIMING("AT_OR_AFTER_ACTIVATION", "ACTIVATED") },
    outcome: {
      ...base.outcome,
      kind: "REFRESHED" as const,
      signature: "sig-updated",
      error: null as unknown,
      failedInstruction: null,
      customCode: null,
      guardErrorName: null,
      jupiterInvoked: true,
      whirlpoolInvoked: true,
      skipPreflight: false,
      after: { usdc: 0n, kox: EXPECTED_OUT_AMOUNT },
      logs: ["Program JUP6 success", "Program whirLb success"],
    },
  };
}

// The proofs are shaped by hand, so they are cast at the boundary they feed.
type Proof = Parameters<typeof verifyStaleResult>[0];
const stale = () => staleProof() as unknown as Proof;
const updated = () => updatedProof() as unknown as Proof;

test("a verified stale result reports an ix0 rejection with zero token movement", () => {
  const result = verifyStaleResult(stale(), EXPECTED_PHANTOM);
  assert.equal(result.leg, "STALE");
  assert.equal(result.guard, "REJECTED at ix0");
  assert.equal(result.guardErrorName, "ActivationPhaseChanged");
  assert.equal(result.jupiterInvoked, false);
  assert.equal(result.whirlpoolInvoked, false);
  assert.equal(result.usdcDelta, "0");
  assert.equal(result.koxDelta, "0");
  assert.equal(result.environment, "LOCAL_EXECUTION_REPRODUCTION");
  assert.match(result.summary, /Stale authorization rejected/);
  assert.equal(JSON.stringify(result.proof).includes("bigint"), false);
});

test("a stale result that moved tokens, or reached Jupiter or Whirlpool, is refused", () => {
  for (const [label, mutate] of [
    ["jupiter invoked", (p: ReturnType<typeof staleProof>) => { p.outcome.jupiterInvoked = true; }],
    ["whirlpool invoked", (p: ReturnType<typeof staleProof>) => { p.outcome.whirlpoolInvoked = true; }],
    ["usdc moved", (p: ReturnType<typeof staleProof>) => { p.outcome.after = { usdc: 0n, kox: 0n }; }],
    ["kox moved", (p: ReturnType<typeof staleProof>) => { p.outcome.after = { usdc: EXPECTED_IN_AMOUNT, kox: 1n }; }],
    ["not stopped at ix0", (p: ReturnType<typeof staleProof>) => { p.outcome.failedInstruction = 1; }],
    ["a different guard error", (p: ReturnType<typeof staleProof>) => { p.outcome.guardErrorName = "SomethingElse"; }],
    ["guard never ran", (p: ReturnType<typeof staleProof>) => { p.outcome.guardInvoked = false; }],
    ["signed after activation", (p: ReturnType<typeof staleProof>) => { p.atSigning = { unixTimestamp: LOCAL_T + 1n, slot: 10n }; }],
    ["bytes changed before submission", (p: ReturnType<typeof staleProof>) => { p.signedWireHashAtSubmission = "d".repeat(64); }],
    ["deployment changed", (p: ReturnType<typeof staleProof>) => { p.deploymentAttestations = [DEPLOYMENT("PRE_SIGN"), { stage: "PRE_SUBMISSION", digest: "e".repeat(64), matched: true }] as never; }],
    ["coordinator did not attest", (p: ReturnType<typeof staleProof>) => { p.signedAuthorization = { ...p.signedAuthorization, messageSha256: "f".repeat(64) }; }],
  ] as const) {
    const proof = staleProof();
    mutate(proof);
    assert.throws(() => verifyStaleResult(proof as unknown as Proof, EXPECTED_PHANTOM), Error, label);
  }
});

test("a verified updated result reports the exact canonical amounts", () => {
  const result = verifyUpdatedResult(updated(), EXPECTED_PHANTOM);
  assert.equal(result.leg, "REFRESHED");
  assert.equal(result.guard, "PASSED");
  assert.equal(result.jupiterInvoked, true);
  assert.equal(result.whirlpoolInvoked, true);
  assert.equal(result.usdcSpentRaw, "5000000");
  assert.equal(result.koxReceivedRaw, "5504261");
  assert.equal(result.usdcDisplay, "5.00");
  assert.equal(result.koxDisplay, "0.05504261");
  assert.deepEqual(
    { usdcIn: EXPECTED_DISPLAY.usdcIn, koxOut: EXPECTED_DISPLAY.koxOut, usdcInRaw: EXPECTED_DISPLAY.usdcInRaw, koxOutRaw: EXPECTED_DISPLAY.koxOutRaw },
    { usdcIn: "5.00", koxOut: "0.05504261", usdcInRaw: "5000000", koxOutRaw: "5504261" },
  );
});

test("an updated result missing execution, or off by any raw unit, is refused", () => {
  for (const [label, mutate] of [
    ["jupiter absent", (p: ReturnType<typeof updatedProof>) => { p.outcome.jupiterInvoked = false; }],
    ["whirlpool absent", (p: ReturnType<typeof updatedProof>) => { p.outcome.whirlpoolInvoked = false; }],
    ["guard absent", (p: ReturnType<typeof updatedProof>) => { p.outcome.guardInvoked = false; }],
    ["transaction errored", (p: ReturnType<typeof updatedProof>) => { p.outcome.error = { InstructionError: [0, { Custom: 12 }] }; }],
    ["one raw unit short of the KOx amount", (p: ReturnType<typeof updatedProof>) => { p.outcome.after = { usdc: 0n, kox: EXPECTED_OUT_AMOUNT - 1n }; }],
    ["one raw unit off the USDC amount", (p: ReturnType<typeof updatedProof>) => { p.outcome.after = { usdc: 1n, kox: EXPECTED_OUT_AMOUNT }; }],
    ["preflight skipped", (p: ReturnType<typeof updatedProof>) => { p.outcome.skipPreflight = true; }],
    ["not a local execution", (p: ReturnType<typeof updatedProof>) => { p.outcome.authorizationSource = "SOMETHING_ELSE"; }],
  ] as const) {
    const proof = updatedProof();
    mutate(proof);
    assert.throws(() => verifyUpdatedResult(proof as unknown as Proof, EXPECTED_PHANTOM), Error, label);
  }
});
