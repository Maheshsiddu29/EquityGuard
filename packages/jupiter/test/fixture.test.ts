/**
 * Offline tests over a REAL recorded Jupiter Swap V2 /build response
 * (USDC -> KOx, mainnet, 2026-09-14) and the real KOx mainnet snapshot it was
 * composed with. HISTORICAL sizing evidence: the recording used the ABI v1
 * guard layout and ordering, reproduced here by test-only code. The current
 * composer (adapter kind 2) is exercised on the same response in
 * `compose.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { address, type Address } from "@solana/kit";
import { ActivationPhase, EQUITY_GUARD_DEVNET_PROGRAM_ID, type AssertSafeExecutionRequest } from "@equityguard/guard-client";

import { MAX_TRANSACTION_BYTES, compileAndMeasure, parseBuildResponse, type BuildResponse } from "../src/index.ts";
import {
  encodeHistoricalAbiV1,
  historicalAbiV1GuardInstruction,
  historicalComposeWithGuard as composeWithGuard,
  historicalOrderInstructions as orderInstructions,
  type HistoricalGuard as GuardComponent,
} from "./historical-v1-guard.ts";

interface Fixture {
  recordedAt: string;
  request: { inputMint: string; outputMint: string; amount: string; taker: string; maxAccounts: number | null };
  snapshot: {
    mint: string;
    multiplierHex: string;
    newMultiplierHex: string;
    newMultiplierEffectiveTimestamp: string;
    phase: "pending" | "activated";
  };
  guardInstructionDataHex: string;
  expectedComposition: ReturnType<typeof composeWithGuard>;
  response: unknown;
}

const PROGRAM_ID = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const JUPITER_V6_PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const KOX_MINT = address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ");
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const UNHX_MINT = address("XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe");
/** Same as the recording script; the ABI is fixed-size so it does not affect sizing. */
const ILLUSTRATIVE_WINDOW = { beforeSecs: 900, afterSecs: 900 };

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/KOx-usdc-build.json", import.meta.url), "utf8"),
) as Fixture;
const build: BuildResponse = parseBuildResponse(fixture.response);
const taker = address(fixture.request.taker);

function recordedRequest(): AssertSafeExecutionRequest {
  const s = fixture.snapshot;
  return {
    expected: {
      multiplier: Uint8Array.from(Buffer.from(s.multiplierHex, "hex")),
      newMultiplier: Uint8Array.from(Buffer.from(s.newMultiplierHex, "hex")),
      newMultiplierEffectiveTimestamp: BigInt(s.newMultiplierEffectiveTimestamp),
    },
    expectedPhase: s.phase === "pending" ? ActivationPhase.Pending : ActivationPhase.Activated,
    window: ILLUSTRATIVE_WINDOW,
  };
}

function guardFor(mint: Address): GuardComponent {
  return {
    mint,
    instruction: historicalAbiV1GuardInstruction({ programAddress: PROGRAM_ID, mint, request: recordedRequest() }),
  };
}

test("real /build response decodes for USDC -> KOx", () => {
  assert.equal(build.inputMint, USDC_MINT);
  assert.equal(build.outputMint, KOX_MINT);
  assert.equal(fixture.request.outputMint, KOX_MINT);
  assert.equal(build.swapInstruction.programId, JUPITER_V6_PROGRAM);
  assert.ok(build.routePlan.length > 0);
  assert.equal(build.routePlan.at(-1)?.swapInfo.outputMint, KOX_MINT);
  assert.ok(BigInt(build.otherAmountThreshold) <= BigInt(build.outAmount));
});

test("recorded historical ABI v1 guard bytes are reproduced from the recorded mainnet KOx state", () => {
  assert.equal(fixture.snapshot.mint, KOX_MINT);
  assert.equal(Buffer.from(encodeHistoricalAbiV1(recordedRequest())).toString("hex"), fixture.guardInstructionDataHex);
});

test("guard bound to anything but Jupiter's outputMint is rejected", () => {
  for (const wrong of [USDC_MINT, UNHX_MINT]) {
    assert.throws(() => composeWithGuard(build, taker, guardFor(wrong)));
  }
  assert.doesNotThrow(() => composeWithGuard(build, taker, guardFor(KOX_MINT)));
});

test("composition and sizing are deterministic for the recorded response", () => {
  const result = composeWithGuard(build, taker, guardFor(KOX_MINT));
  assert.deepEqual(result, fixture.expectedComposition);
  assert.ok(result.guarded.serializedTransactionBytes <= MAX_TRANSACTION_BYTES);
});

test("guard overhead is exactly one instruction, one program account and 70 bytes", () => {
  const { delta } = composeWithGuard(build, taker, guardFor(KOX_MINT));
  // 32-byte program ID + program index (1) + account count (1) + mint index (1)
  // + data length (1) + 34-byte ABI v1 payload = 70. The KOx mint is already in
  // the transaction for the Jupiter setup and swap, so it adds no account.
  assert.deepEqual(delta, { serializedBytes: 70, staticAccounts: 1, instructions: 1, lookedUpAddresses: 0 });
});

test("Jupiter lookup tables are applied, and only to non-signer accounts", () => {
  const instructions = orderInstructions(build, guardFor(KOX_MINT));
  const { metrics } = compileAndMeasure(build, taker, instructions);
  assert.equal(metrics.addressLookupTableCount, Object.keys(build.addressesByLookupTableAddress).length);
  assert.ok(metrics.lookedUpAddressCount > 0);

  const withoutAlts = compileAndMeasure({ ...build, addressesByLookupTableAddress: {} }, taker, instructions).metrics;
  assert.equal(withoutAlts.lookedUpAddressCount, 0);
  assert.equal(withoutAlts.staticAccountCount, metrics.staticAccountCount + metrics.lookedUpAddressCount);
  assert.ok(withoutAlts.serializedTransactionBytes > metrics.serializedTransactionBytes);
  assert.equal(metrics.requiredSignatures, 1);
});

test("guard is ordered before every Jupiter setup and swap instruction", () => {
  const instructions = orderInstructions(build, guardFor(KOX_MINT));
  const guardIndex = instructions.findIndex((i) => i.programAddress === PROGRAM_ID);
  const firstSetup = instructions.findIndex((i) => i.programAddress === build.setupInstructions[0]?.programId);
  const swapIndex = instructions.findIndex((i) => i.programAddress === JUPITER_V6_PROGRAM);
  assert.ok(guardIndex >= 0 && guardIndex < firstSetup && firstSetup < swapIndex);
});
