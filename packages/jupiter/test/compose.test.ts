import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountRole, address, type Instruction } from "@solana/kit";
import { ActivationPhase, getAssertSafeExecutionInstruction } from "@equityguard/guard-client";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  CompositionError,
  GuardBindingError,
  compileAndMeasure,
  composeWithGuard,
  getSetComputeUnitLimitInstruction,
  orderInstructions,
  parseBuildResponse,
  toKitInstruction,
  type GuardComponent,
} from "../src/index.ts";
import { INPUT_MINT, OUTPUT_MINT, POOL_ACCOUNTS, SWAP_PROGRAM, TAKER, syntheticAddress, syntheticBuild } from "./synthetic.ts";

const PROGRAM_ID = address("EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT");
const ONE = new Uint8Array([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);

function guardFor(mint: ReturnType<typeof syntheticAddress>, instructionMint = mint): GuardComponent {
  return {
    mint,
    instruction: getAssertSafeExecutionInstruction({
      programAddress: PROGRAM_ID,
      mint: instructionMint,
      request: {
        expected: { multiplier: ONE, newMultiplier: ONE, newMultiplierEffectiveTimestamp: 0n },
        expectedPhase: ActivationPhase.Activated,
        window: { beforeSecs: 0, afterSecs: 0 },
      },
    }),
  };
}

const isGuard = (i: Instruction) => i.programAddress === PROGRAM_ID;
const isLimit = (i: Instruction) => i.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS && i.data?.[0] === 2;

test("instructions decode base64 data and account roles", () => {
  const swap = toKitInstruction(parseBuildResponse(syntheticBuild()).swapInstruction);
  assert.deepEqual([...(swap.data ?? [])], [9, 9, 9]);
  assert.equal(swap.accounts?.[0]?.role, AccountRole.READONLY_SIGNER);
  assert.equal(swap.accounts?.[1]?.role, AccountRole.WRITABLE);
  assert.equal(swap.accounts?.[2]?.role, AccountRole.READONLY);
  const setup = toKitInstruction(parseBuildResponse(syntheticBuild()).setupInstructions[0]!);
  assert.equal(setup.accounts?.[0]?.role, AccountRole.WRITABLE_SIGNER);
});

test("guard mint must equal Jupiter outputMint", () => {
  const build = parseBuildResponse(syntheticBuild());
  assert.throws(() => orderInstructions(build, guardFor(INPUT_MINT)), GuardBindingError);
  assert.throws(() => orderInstructions(build, guardFor(syntheticAddress(99))), GuardBindingError);
  // Declared mint matches, but the instruction guards a different account.
  assert.throws(() => orderInstructions(build, guardFor(OUTPUT_MINT, syntheticAddress(99))), GuardBindingError);
  assert.throws(() => composeWithGuard(build, TAKER, guardFor(INPUT_MINT)), GuardBindingError);
  assert.doesNotThrow(() => orderInstructions(build, guardFor(OUTPUT_MINT)));
});

test("guard precedes setup and swap, with exactly one compute unit limit", () => {
  const build = parseBuildResponse(syntheticBuild());
  const ordered = orderInstructions(build, guardFor(OUTPUT_MINT));
  const guardIndex = ordered.findIndex(isGuard);
  const swapIndex = ordered.findIndex((i) => i.programAddress === SWAP_PROGRAM);
  assert.ok(guardIndex > 0 && guardIndex < swapIndex);
  assert.ok(ordered.slice(0, guardIndex).every((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS));
  assert.equal(ordered.filter(isLimit).length, 1);
  assert.equal(orderInstructions(build, null).filter(isGuard).length, 0);
});

test("a Jupiter-provided compute unit limit is not duplicated", () => {
  const limit = getSetComputeUnitLimitInstruction(200_000);
  const apiLimit = { programId: limit.programAddress, accounts: [], data: Buffer.from(limit.data ?? []).toString("base64") };
  const withLimit = parseBuildResponse(syntheticBuild({ computeBudgetInstructions: [apiLimit] }));
  assert.equal(orderInstructions(withLimit, null).filter(isLimit).length, 1);
  const twoLimits = parseBuildResponse(syntheticBuild({ computeBudgetInstructions: [apiLimit, apiLimit] }));
  assert.throws(() => orderInstructions(twoLimits, null), CompositionError);
});

test("lookup tables compress non-signer accounts and sizing is deterministic", () => {
  const build = parseBuildResponse(syntheticBuild());
  const first = compileAndMeasure(build, TAKER, orderInstructions(build, guardFor(OUTPUT_MINT)));
  const second = compileAndMeasure(build, TAKER, orderInstructions(build, guardFor(OUTPUT_MINT)));
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.wireBytes, second.wireBytes);
  assert.equal(first.metrics.addressLookupTableCount, 1);
  assert.equal(first.metrics.lookedUpAddressCount, POOL_ACCOUNTS.length);
  assert.equal(first.metrics.requiredSignatures, 1);

  const noAlt = parseBuildResponse(syntheticBuild({ addressesByLookupTableAddress: {} }));
  const uncompressed = compileAndMeasure(noAlt, TAKER, orderInstructions(noAlt, guardFor(OUTPUT_MINT))).metrics;
  assert.equal(uncompressed.lookedUpAddressCount, 0);
  assert.ok(uncompressed.serializedTransactionBytes > first.metrics.serializedTransactionBytes);
});

test("guard overhead is one instruction and one static program account plus its mint", () => {
  const result = composeWithGuard(parseBuildResponse(syntheticBuild()), TAKER, guardFor(OUTPUT_MINT));
  assert.equal(result.delta.instructions, 1);
  // Program IDs cannot be looked up; the synthetic output mint is not in the ALT.
  assert.equal(result.delta.staticAccounts, 2);
  assert.ok(result.guarded.fitsSizeLimit);
});
