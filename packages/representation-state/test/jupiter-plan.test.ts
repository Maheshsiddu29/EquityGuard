/**
 * Execution plans bound to a guarded Jupiter trade (adapter kinds 2/3).
 *
 * The on-chain guard cannot know the intended amounts, slippage or route; the
 * plan is where they are pinned, and the final build must equal the plan
 * field for field before anything is signed.
 *
 * Two kinds of binding appear here:
 * - REAL: built by the client from the recorded 2026-09-16 KOx BUY route_v2;
 * - SYNTHETIC: for the KOon reroute alternative. No Ondo representation is
 *   routable on Jupiter today (M9D-A §3), so no real KOon route exists; the
 *   binding is structurally valid data exercising plan logic only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AccountRole, address, type Instruction } from "@solana/kit";
import {
  ActivationPhase,
  DownstreamAdapterKind,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  USDC_MINT_ADDRESS,
  buildGuardedJupiterTrade,
  canonicalAta,
  jupiterTradeBindingOf,
  minimumOutFromQuote,
  type JupiterTradeBinding,
} from "@equityguard/guard-client";

import {
  ExecutionPlanError,
  assertPlanDownstream,
  createExecutionPlan,
  decideExecution,
  planDigestOf,
  verifyExecutionPlan,
  type DownstreamBinding,
  type ExecutionPlan,
} from "../src/index.ts";
import { INPUT_RAW, KOON, KOON_OUT, KOX, POLICY, SLOT, T, kox, quote, reroute, route } from "./scenario.ts";

const FRESHNESS = { validForSlots: 100n };
const SLIPPAGE = 50;
const TAKER = address("AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH");

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExecutionPlanError) return error.code;
    throw error;
  }
  return "accepted";
};

/** SYNTHETIC: a BUY of the KOon alternative matching the reroute quote. */
async function koonBinding(): Promise<JupiterTradeBinding> {
  const token2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const legacy = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  return {
    adapterKind: "JUPITER_ROUTE_V2_BUY_USDC",
    jupiterProgramId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    routeDiscriminatorHex: "bb64facc31c4af14",
    protectedMintRole: "DESTINATION",
    protectedMint: KOON.mint,
    counterMint: USDC_MINT_ADDRESS,
    authority: TAKER,
    sourceMint: USDC_MINT_ADDRESS,
    destinationMint: KOON.mint,
    sourceTokenAccount: await canonicalAta(TAKER, USDC_MINT_ADDRESS, legacy),
    destinationTokenAccount: await canonicalAta(TAKER, address(KOON.mint), token2022),
    inAmountRaw: INPUT_RAW,
    quotedOutRaw: KOON_OUT,
    slippageBps: SLIPPAGE,
    minOutRaw: minimumOutFromQuote(KOON_OUT, SLIPPAGE),
    suffixCommitmentHex: "c".repeat(64),
    suffixInstructionCount: 4,
  };
}

test("a consented reroute plans the alternative's own Jupiter BUY, and the build must equal it", async () => {
  const scenario = reroute({ slippageBps: SLIPPAGE });
  const binding = await koonBinding();
  const plan = createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding });
  verifyExecutionPlan(plan, { quote: scenario.alternativeQuote, comparison: scenario.comparison });
  assert.equal(plan.selectedRepresentation.mint, KOON.mint);
  assert.deepEqual(plan.downstream, binding);
  assert.ok(Object.isFrozen(plan.downstream));
  // The guard asserts the alternative's own state.
  assert.equal(plan.economicState.mint, KOON.mint);
  assert.notEqual(plan.consentId, null);

  assertPlanDownstream(plan, binding);
  assertPlanDownstream(plan, { ...binding });
  const changes: [keyof JupiterTradeBinding, unknown][] = [
    ["adapterKind", "JUPITER_ROUTE_V2_SELL_USDC"],
    ["protectedMint", KOX.mint],
    ["destinationMint", KOX.mint],
    ["authority", KOON.mint],
    ["sourceTokenAccount", KOON.mint],
    ["destinationTokenAccount", KOON.mint],
    ["inAmountRaw", INPUT_RAW + 1n],
    ["quotedOutRaw", KOON_OUT + 1n],
    ["slippageBps", SLIPPAGE + 1],
    ["minOutRaw", binding.minOutRaw - 1n],
    ["suffixCommitmentHex", "d".repeat(64)],
    ["suffixInstructionCount", 3],
  ];
  for (const [field, value] of changes) {
    const presented = { ...binding, [field]: value } as DownstreamBinding;
    assert.equal(codeOf(() => assertPlanDownstream(plan, presented)), "DOWNSTREAM_COMMITMENT_MISMATCH", `${field} was accepted`);
  }
  assert.equal(codeOf(() => assertPlanDownstream(plan, { adapterKind: "TOKEN_2022_TRANSFER_CHECKED", commitmentHex: binding.suffixCommitmentHex })), "DOWNSTREAM_COMMITMENT_MISMATCH");

  // Every bound field is inside the plan digest.
  const { planDigest: _digest, ...content } = plan;
  for (const [field, value] of changes) {
    assert.notEqual(planDigestOf({ ...content, downstream: { ...binding, [field]: value } as DownstreamBinding }), plan.planDigest, field);
  }
});

test("a Jupiter binding for anything but the planned quote is refused", async () => {
  const binding = await koonBinding();
  const cases: [string, Partial<JupiterTradeBinding>][] = [
    ["the preferred representation instead of the consented alternative", { protectedMint: KOX.mint, destinationMint: KOX.mint }],
    ["a SELL", { adapterKind: "JUPITER_ROUTE_V2_SELL_USDC", protectedMintRole: "SOURCE", sourceMint: KOON.mint, destinationMint: USDC_MINT_ADDRESS }],
    ["another input amount", { inAmountRaw: INPUT_RAW - 1n }],
    ["another quoted output", { quotedOutRaw: KOON_OUT - 1n, minOutRaw: minimumOutFromQuote(KOON_OUT - 1n, SLIPPAGE) }],
    ["another slippage", { slippageBps: SLIPPAGE + 10, minOutRaw: minimumOutFromQuote(KOON_OUT, SLIPPAGE + 10) }],
  ];
  for (const [label, change] of cases) {
    const scenario = reroute({ slippageBps: SLIPPAGE });
    assert.equal(
      codeOf(() => createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: { ...binding, ...change } as DownstreamBinding })),
      "DOWNSTREAM_NOT_FOR_QUOTE",
      label,
    );
  }
  // A quote whose minimum is not Jupiter's cannot be executed through Jupiter.
  const plainMinimum = reroute();
  assert.equal(
    codeOf(() => createExecutionPlan(plainMinimum.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding })),
    "DOWNSTREAM_NOT_FOR_QUOTE",
  );
});

test("a malformed Jupiter binding never becomes a plan", async () => {
  const binding = await koonBinding();
  const cases: [string, Record<string, unknown>][] = [
    ["foreign Jupiter program", { jupiterProgramId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" }],
    ["another entrypoint", { routeDiscriminatorHex: "d19853937cfed8e9" }],
    ["role flipped", { protectedMintRole: "SOURCE" }],
    ["non-USDC counter mint", { counterMint: KOX.mint, sourceMint: KOX.mint }],
    ["mints inconsistent with the role", { sourceMint: KOON.mint }],
    ["zero input", { inAmountRaw: 0n }],
    ["a number amount", { inAmountRaw: 5_000_000 }],
    ["an amount above u64", { quotedOutRaw: 2n ** 64n }],
    ["slippage above 100%", { slippageBps: 10_001 }],
    ["fractional slippage", { slippageBps: 0.5 }],
    ["a minimum Jupiter would not enforce", { minOutRaw: binding.minOutRaw + 1n }],
    ["uppercase commitment", { suffixCommitmentHex: "C".repeat(64) }],
    ["five instructions", { suffixInstructionCount: 5 }],
    ["not an address", { authority: "not-an-address" }],
    ["unknown kind", { adapterKind: "JUPITER_ROUTE_V2" }],
  ];
  for (const [label, change] of cases) {
    const scenario = reroute({ slippageBps: SLIPPAGE });
    assert.equal(
      codeOf(() => createExecutionPlan(scenario.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: { ...binding, ...change } as unknown as DownstreamBinding })),
      "INVALID_DOWNSTREAM",
      label,
    );
  }
});

test("the Jupiter adapter is no reroute bypass: consent stays required and single-use", async () => {
  const binding = await koonBinding();
  const unconsented = reroute({ consent: false, slippageBps: SLIPPAGE });
  assert.equal(
    codeOf(() => createExecutionPlan(unconsented.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding })),
    "NOT_EXECUTABLE",
  );
  const consented = reroute({ slippageBps: SLIPPAGE });
  createExecutionPlan(consented.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding });
  assert.equal(
    codeOf(() => createExecutionPlan(consented.decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding })),
    "CONSENT_REJECTED",
  );
  assert.equal(
    codeOf(() => createExecutionPlan(consented.decision, "MAINNET_OBSERVATION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding })),
    "OBSERVATION_ONLY_ENVIRONMENT",
  );
});

interface RecordedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataHex: string;
}

test("a REAL KOx BUY binding, built by the client from the recorded route, plans a direct KOx purchase", async () => {
  const recorded = (
    JSON.parse(readFileSync(new URL("../../../scripts/research/fixtures/route-v2-builds-2026-09-16.json", import.meta.url), "utf8")) as {
      builds: { symbol: string; direction: string; quote: { outAmount: string }; jupiterInstructions: RecordedInstruction[] }[];
    }
  ).builds.find((b) => b.symbol === "KOx" && b.direction === "BUY");
  assert.ok(recorded);
  const kit = (i: RecordedInstruction): Instruction => ({
    programAddress: address(i.programId),
    accounts: i.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: Uint8Array.from(Buffer.from(i.dataHex, "hex")),
  });
  const limit: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: Uint8Array.of(2, 0x80, 0x1a, 0x06, 0) };
  const [price, setup, swap] = recorded.jupiterInstructions.map(kit) as [Instruction, Instruction, Instruction];

  // KOx is SAFE well before its scheduled activation: a direct purchase.
  const preferred = kox(T - 100_000n);
  const outputRaw = BigInt(recorded.quote.outAmount);
  const preferredQuote = quote(preferred, outputRaw, SLIPPAGE);
  const decision = decideExecution({
    preferred,
    alternative: null,
    reroutePolicy: POLICY,
    inputRaw: INPUT_RAW,
    comparison: null,
    currentSlot: SLOT,
    routes: { preferred: route(preferredQuote), alternative: null },
    consent: null,
  });
  assert.equal(decision.executionEligibility, "EXECUTABLE", decision.executionReason);

  const state = preferredQuote.state;
  const build = (suffix: Instruction[]) =>
    buildGuardedJupiterTrade({
      programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
      feePayer: TAKER,
      protectedMint: address(KOX.mint),
      adapterKind: DownstreamAdapterKind.JUPITER_ROUTE_V2_BUY_USDC,
      expectation: {
        expected: {
          multiplier: Uint8Array.from(Buffer.from(state.multiplierHex, "hex")),
          newMultiplier: Uint8Array.from(Buffer.from(state.newMultiplierHex, "hex")),
          newMultiplierEffectiveTimestamp: state.effectiveTimestamp,
        },
        expectedPhase: state.phase === 1 ? ActivationPhase.Activated : ActivationPhase.Pending,
        window: { beforeSecs: 900, afterSecs: 900 },
      },
      suffix,
    });
  const trade = await build([price, limit, setup, swap]);
  const binding = jupiterTradeBindingOf(trade);
  const plan: ExecutionPlan = createExecutionPlan(decision, "DEVNET_EXECUTION", { currentSlot: SLOT, freshness: FRESHNESS, downstream: binding });
  verifyExecutionPlan(plan, { quote: preferredQuote, comparison: null });
  assertPlanDownstream(plan, binding);
  assert.equal(plan.downstream.adapterKind, "JUPITER_ROUTE_V2_BUY_USDC");
  assert.equal(plan.minOutputRaw, binding.minOutRaw);

  // Rebuilding with a different limit is a different action.
  const other = await build([price, { ...limit, data: Uint8Array.of(2, 0x81, 0x1a, 0x06, 0) }, setup, swap]);
  assert.equal(codeOf(() => assertPlanDownstream(plan, jupiterTradeBindingOf(other))), "DOWNSTREAM_COMMITMENT_MISMATCH");
});
