import assert from "node:assert/strict";
import { test } from "node:test";

import { address, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, Token2022Instruction, identifyToken2022Instruction } from "@solana-program/token-2022";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "@equityguard/guard-client";
import {
  Decision,
  RepresentationState,
  RegistryError,
  buildRegistry,
  decide,
  devnetExecutionResult,
  economicStateOf,
  type ChainObservation,
} from "@equityguard/representation-state";

import type { DevnetContext } from "../devnet/config.ts";
import { TEST_ASSET_DISCLOSURE, type DevnetState, type TestAsset } from "../devnet/devnet-state.ts";
import {
  DEVNET_DEMO_POLICY,
  DevnetDemoEnvironmentError,
  guardedDeliveryInstructions,
  loadDevnetQuoteFixture,
  planDevnetDemo,
  runDevnetDemo,
} from "./devnet-execution.ts";

const EQ_A: TestAsset = { label: "EQ-A", mint: address("5ikX5JLtRXxqARxsCfLyJ1gkz43bcYFCXnhPyfpmJeRt"), decimals: 6, conceptualStock: "DEMO", disclosure: TEST_ASSET_DISCLOSURE };
const EQ_B: TestAsset = { label: "EQ-B", mint: address("AwQ8Cx4D4a1fBEcNThsG4kCskmgLNKMnvkf57iQG7wZn"), decimals: 6, conceptualStock: "DEMO", disclosure: TEST_ASSET_DISCLOSURE };
const NOW = 1_789_447_046n;

const f64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
};

/** Synthetic devnet mint observation (shape only; values mirror the recorded devnet run). */
function observation(mint: string, multiplier: number, newMultiplier: number, t: bigint): ChainObservation {
  return {
    kind: "decoded",
    mint,
    slot: 498_594_300n,
    blockTime: null,
    observedAt: "2026-09-15T04:37:30.000Z",
    chainUnixTimestamp: NOW,
    decimals: 6,
    paused: null,
    protectedState: { multiplier: f64(multiplier), newMultiplier: f64(newMultiplier), newMultiplierEffectiveTimestamp: t },
    hasScheduledChange: multiplier !== newMultiplier,
    phase: NOW >= t ? 1 : 0,
  };
}

// EQ-A pending a change at NOW + 597 s; EQ-B at 1.0 with nothing scheduled.
const PREFERRED = observation(EQ_A.mint, 1.5, 1.75, NOW + 597n);
const ALTERNATIVE = observation(EQ_B.mint, 1, 1, 0n);

function plan(fixtureOverride?: Partial<ReturnType<typeof loadDevnetQuoteFixture>["fixture"]>) {
  const { fixture } = loadDevnetQuoteFixture();
  return planDevnetDemo({ preferredAsset: EQ_A, alternativeAsset: EQ_B, preferredEvidence: PREFERRED, alternativeEvidence: ALTERNATIVE, fixture: { ...fixture, ...fixtureOverride }, policy: DEVNET_DEMO_POLICY });
}

test("the devnet quote fixture is explicitly a demo fixture", () => {
  const { fixture, sha256 } = loadDevnetQuoteFixture();
  assert.equal(fixture.label, "DEVNET DEMO QUOTE / FIXTURE");
  assert.equal(fixture.environment, "DEVNET_EXECUTION");
  assert.match(fixture.notice, /NOT a live Jupiter quote/);
  assert.equal(sha256.length, 64);
});

test("devnet quotes normalize to share-equivalents and compare conservatively", () => {
  const p = plan();
  assert.deepEqual([p.preferred.state, p.alternative.state], [RepresentationState.TRANSITION, RepresentationState.SAFE]);
  assert.ok(p.comparison);
  // EQ-A 4.000000 x 1.5 = 6.0; EQ-B 5.990000 x 1.0 = 5.99; (6 - 5.99) / 6 = 16.67 bps, rounded up.
  assert.deepEqual(p.comparison.preferredSharesEquivalent, { num: 6n, den: 1n });
  assert.deepEqual(p.comparison.alternativeSharesEquivalent, { num: 599n, den: 100n });
  assert.equal(p.comparison.conservativeCostDeltaBps, 17n);
});

test("consent OFF requires consent; consent ON uses the alternative with the same disclosure", () => {
  const p = plan();
  assert.deepEqual([p.consentOff.decision, p.consentOff.reasonCode], [Decision.REQUIRES_CONSENT, "CONSENT_REQUIRED"]);
  assert.deepEqual([p.consentOn.decision, p.consentOn.reasonCode], [Decision.USE_ALTERNATIVE, "CONSENT_GIVEN"]);
  assert.deepEqual(p.consentOff.disclosure, p.consentOn.disclosure);
  assert.equal(p.consentOn.disclosure?.alternative.symbol, "EQ-B");
});

test("quote identity binding: a comparison for another notional or pair never authorizes execution", () => {
  const p = plan();
  const wrongNotional = decide({ preferred: p.preferred, alternative: p.alternative, policy: { allowCrossIssuerReroute: true }, inputRaw: p.inputRaw + 1n, comparison: p.comparison });
  assert.deepEqual([wrongNotional.decision, wrongNotional.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_MISMATCH"]);
  const swapped = decide({ preferred: p.alternative, alternative: p.preferred, policy: { allowCrossIssuerReroute: true }, inputRaw: p.inputRaw, comparison: p.comparison });
  assert.notEqual(swapped.decision, Decision.USE_ALTERNATIVE);
});

test("a missing devnet quote yields UNKNOWN_STATE, never execution", () => {
  const p = plan({ outputsRaw: { "EQ-A": "4000000" } });
  assert.equal(p.comparison, null);
  assert.deepEqual([p.consentOn.decision, p.consentOn.reasonCode], [Decision.UNKNOWN_STATE, "ALTERNATIVE_QUOTE_UNAVAILABLE"]);
});

test("guarded delivery puts the guard first and asserts exactly the decision's bound state", async () => {
  const payer = await generateKeyPairSigner();
  const recipient = (await generateKeyPairSigner()).address;
  const p = plan();
  assert.ok(p.comparison);
  const instructions = await guardedDeliveryInstructions({ programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, payer, recipient, asset: EQ_B, boundState: p.comparison.alternativeState, policy: DEVNET_DEMO_POLICY, amount: 5_990_000n });
  assert.equal(instructions.length, 3);
  const [guard, , transfer] = instructions;
  assert.equal(guard?.programAddress, EQUITY_GUARD_DEVNET_PROGRAM_ID);
  assert.deepEqual(guard?.accounts, [{ address: EQ_B.mint, role: AccountRole.READONLY }]);
  // ABI v1: multiplier bytes, new multiplier bytes, T, phase, then the policy window (900, 300).
  const data = Uint8Array.from(guard?.data ?? []);
  const view = new DataView(data.buffer);
  const bound = p.comparison.alternativeState;
  assert.deepEqual(
    [Buffer.from(data.subarray(1, 9)).toString("hex"), Buffer.from(data.subarray(9, 17)).toString("hex"), view.getBigInt64(17, true), data[25]],
    [bound.multiplierHex, bound.newMultiplierHex, bound.effectiveTimestamp, bound.phase],
  );
  assert.deepEqual([view.getUint32(26, true), view.getUint32(30, true)], [900, 300]);
  assert.equal(transfer?.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
  assert.equal(identifyToken2022Instruction(Uint8Array.from(transfer?.data ?? [])), Token2022Instruction.TransferChecked);
  assert.ok(transfer?.accounts?.some((a) => a.address === EQ_B.mint));
  await assert.rejects(
    guardedDeliveryInstructions({ programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, payer, recipient, asset: EQ_A, boundState: bound, policy: DEVNET_DEMO_POLICY, amount: 1n }),
    /different mint/,
  );
});

test("a devnet comparison built before a state change cannot authorize execution", () => {
  const p = plan();
  // EQ-B's multiplier changes immediately after the comparison was built.
  const updated = observation(EQ_B.mint, 1.1, 1.1, NOW - 1n);
  const alternative = { ...p.alternative, chainObservation: updated };
  const result = decide({ preferred: p.preferred, alternative, policy: { allowCrossIssuerReroute: true }, inputRaw: p.inputRaw, comparison: p.comparison });
  assert.deepEqual([result.decision, result.reasonCode], [Decision.UNKNOWN_STATE, "QUOTE_COMPARISON_STALE_STATE"]);
  assert.deepEqual(p.comparison?.alternativeState, economicStateOf(ALTERNATIVE));
});

test("execution results are DEVNET_EXECUTION and cannot claim execution for unsafe decisions", () => {
  const p = plan();
  const { sha256 } = loadDevnetQuoteFixture();
  const quotes = { source: "DEVNET_DEMO_QUOTE_FIXTURE" as const, observedAt: null, preferred: "AVAILABLE" as const, alternative: "AVAILABLE" as const, note: "fixture" };
  const evidence = [{ kind: "DEVNET_DEMO_QUOTE_FIXTURE" as const, description: "fixture", sha256, observedAt: null }];
  const rejected = { signature: "r", slot: 1n, succeeded: false, customErrorName: "InsideTransitionWindow", downstreamBalanceBefore: 0n, downstreamBalanceAfter: 0n, explorerUrl: null };
  const executed = { signature: "e", slot: 2n, succeeded: true, customErrorName: null, downstreamBalanceBefore: 0n, downstreamBalanceAfter: 5_990_000n, explorerUrl: null };
  const on = devnetExecutionResult({ decision: p.consentOn, comparison: p.comparison, evidenceSources: evidence, quoteAvailability: quotes, execution: { executed, rejectedPreferredAttempt: rejected } });
  assert.deepEqual([on.executionEnvironment, on.transactionSignature, on.conservativeCostDeltaBps], ["DEVNET_EXECUTION", "e", 17n]);
  assert.throws(() => devnetExecutionResult({ decision: p.consentOff, comparison: p.comparison, evidenceSources: evidence, quoteAvailability: quotes, execution: { executed, rejectedPreferredAttempt: null } }), /nothing may execute/);
});

test("the devnet demo refuses non-devnet clusters before any network call", async () => {
  const rpc = new Proxy({}, { get: () => { throw new Error("RPC must not be called"); } });
  const payer = await generateKeyPairSigner();
  const state: DevnetState = { cluster: "devnet", deployment: { programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, deploySignature: "sig", upgradeAuthority: payer.address }, assets: [EQ_A, EQ_B] };
  const ctx = { rpc, payer, cluster: "localnet" } as unknown as DevnetContext;
  await assert.rejects(runDevnetDemo(ctx, state, { preferredLabel: "EQ-A", alternativeLabel: "EQ-B", recipient: payer.address }), DevnetDemoEnvironmentError);
});

test("devnet test assets can never enter the mainnet registry", () => {
  assert.throws(
    () => buildRegistry([{ underlying: "DEMO", name: "Demo", representations: [{ issuer: "DEVNET_TEST", symbol: "EQ-A", mint: EQ_A.mint }] }]),
    RegistryError,
  );
});
