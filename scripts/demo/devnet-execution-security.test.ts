/**
 * Adversarial tests of the devnet execution path against a loopback fake RPC
 * (verified devnet genesis) and a throwaway wallet: nothing touches a network.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { address, generateKeyPairSigner } from "@solana/kit";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "@equityguard/guard-client";
import { ExecutionPlanError, createExecutionPlan, type ChainObservation } from "@equityguard/representation-state";

import { connectDevnet, type DevnetContext } from "../devnet/config.ts";
import { TEST_ASSET_DISCLOSURE, type TestAsset } from "../devnet/devnet-state.ts";
import { devnetGenesis, startFakeRpc, withGenesis, writeThrowawayWallet, type FakeRpc } from "../devnet/testing/fake-rpc.ts";
import {
  DEVNET_DEMO_CONSENT,
  DEVNET_DEMO_POLICY,
  DEVNET_DEMO_REROUTE_POLICY,
  DEVNET_PLAN_FRESHNESS,
  executeGuardedPlan,
  loadDevnetQuoteFixture,
  planDevnetDemo,
} from "./devnet-execution.ts";

const EQ_A: TestAsset = { label: "EQ-A", mint: address("5ikX5JLtRXxqARxsCfLyJ1gkz43bcYFCXnhPyfpmJeRt"), decimals: 6, conceptualStock: "DEMO", disclosure: TEST_ASSET_DISCLOSURE };
const EQ_B: TestAsset = { label: "EQ-B", mint: address("AwQ8Cx4D4a1fBEcNThsG4kCskmgLNKMnvkf57iQG7wZn"), decimals: 6, conceptualStock: "DEMO", disclosure: TEST_ASSET_DISCLOSURE };
const NOW = 1_789_447_046n;
const SLOT = 498_594_300n;

const f64 = (v: number) => new Uint8Array(new Float64Array([v]).buffer);
function observation(mint: string, multiplier: number, newMultiplier: number, t: bigint): ChainObservation {
  return {
    kind: "decoded",
    mint,
    slot: SLOT,
    blockTime: null,
    observedAt: null,
    chainUnixTimestamp: NOW,
    decimals: 6,
    paused: null,
    protectedState: { multiplier: f64(multiplier), newMultiplier: f64(newMultiplier), newMultiplierEffectiveTimestamp: t },
    hasScheduledChange: multiplier !== newMultiplier,
    phase: NOW >= t ? 1 : 0,
  };
}

function consentedPlan() {
  const p = planDevnetDemo({
    preferredAsset: EQ_A,
    alternativeAsset: EQ_B,
    preferredEvidence: observation(EQ_A.mint, 1.5, 1.75, NOW + 597n),
    alternativeEvidence: observation(EQ_B.mint, 1, 1, 0n),
    fixture: loadDevnetQuoteFixture().fixture,
    policy: DEVNET_DEMO_POLICY,
    reroutePolicy: DEVNET_DEMO_REROUTE_POLICY,
    currentSlot: SLOT,
    userConsent: DEVNET_DEMO_CONSENT,
  });
  const plan = createExecutionPlan(p.consentOn, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: DEVNET_PLAN_FRESHNESS });
  return { p, plan };
}

/** A devnet RPC that lets one guarded delivery land successfully at `slot`. */
function successfulDevnet(slot: () => bigint) {
  return withGenesis(devnetGenesis, (method) => {
    switch (method) {
      case "getSlot":
        return Number(slot());
      case "getAccountInfo":
        return { context: { slot: 1 }, value: null };
      case "getLatestBlockhash":
        return { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000 } };
      case "sendTransaction":
        return "1111111111111111111111111111111111111111111111111111111111111111";
      case "getSignatureStatuses":
        return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] };
      case "getTransaction":
        return { slot: 2, blockTime: 3, meta: { err: null, logMessages: ["Program log: EquityGuard: safe"] }, transaction: {} };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

let wallet: Awaited<ReturnType<typeof writeThrowawayWallet>>;
before(async () => {
  wallet = await writeThrowawayWallet();
});
after(async () => {
  await wallet.cleanup();
});

async function withDevnet(handler: Parameters<typeof startFakeRpc>[0], body: (ctx: DevnetContext, rpc: FakeRpc) => Promise<void>): Promise<void> {
  const rpc = await startFakeRpc(handler);
  try {
    const ctx = await connectDevnet({ rpcUrl: rpc.url, walletPath: wallet.path });
    rpc.calls.length = 0;
    await body(ctx, rpc);
  } finally {
    await rpc.close();
  }
}

test("M03: a plan executes once; the second attempt fails before any RPC or signing", async () => {
  await withDevnet(successfulDevnet(() => SLOT + 1n), async (ctx, rpc) => {
    const { p, plan } = consentedPlan();
    const input = { programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, plan, quote: p.routes.alternative.quote!, comparison: p.comparison, asset: EQ_B, recipient: (await generateKeyPairSigner()).address };
    const first = await executeGuardedPlan(ctx, input);
    assert.equal(first.succeeded, true);
    assert.equal(rpc.calls.filter((c) => c === "sendTransaction").length, 1);
    rpc.calls.length = 0;
    await assert.rejects(executeGuardedPlan(ctx, input), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_CONSUMED");
    assert.deepEqual(rpc.calls, []);
  });
});

test("M03: an expired plan is consumed and refused before signing", async () => {
  await withDevnet(successfulDevnet(() => SLOT + DEVNET_PLAN_FRESHNESS.validForSlots + 1n), async (ctx, rpc) => {
    const { p, plan } = consentedPlan();
    const input = { programId: EQUITY_GUARD_DEVNET_PROGRAM_ID, plan, quote: p.routes.alternative.quote!, comparison: p.comparison, asset: EQ_B, recipient: (await generateKeyPairSigner()).address };
    await assert.rejects(executeGuardedPlan(ctx, input), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_EXPIRED");
    assert.deepEqual(rpc.calls, ["getSlot"]);
    // Burned: it cannot be retried later either.
    await assert.rejects(executeGuardedPlan(ctx, input), (e) => e instanceof ExecutionPlanError && e.code === "PLAN_CONSUMED");
  });
});
