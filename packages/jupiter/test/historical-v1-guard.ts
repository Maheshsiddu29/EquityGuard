/**
 * TEST-ONLY, HISTORICAL. The ABI v1 guard layout that the recorded M4 Jupiter
 * composition fixture (2026-09-14) was sized with. It exists only to
 * reproduce that recorded evidence byte-for-byte.
 *
 * It is not exported by any package and is never submit-capable: the
 * program rejects ABI v1 with `UnsupportedVersion`. Guarded Jupiter trades use
 * ABI v2 adapter kinds 2 and 3 (`composeGuardedJupiterTrade`).
 */

import { AccountRole, type Address, type Instruction } from "@solana/kit";
import type { AssertSafeExecutionRequest } from "@equityguard/guard-client";

import {
  UNSIMULATED_COMPUTE_UNIT_LIMIT,
  compileAndMeasure,
  getSetComputeUnitLimitInstruction,
  toKitInstruction,
  type BuildResponse,
} from "../src/index.ts";

export function encodeHistoricalAbiV1(request: AssertSafeExecutionRequest): Uint8Array {
  const out = new Uint8Array(34);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out.set(request.expected.multiplier, 1);
  out.set(request.expected.newMultiplier, 9);
  view.setBigInt64(17, request.expected.newMultiplierEffectiveTimestamp, true);
  out[25] = request.expectedPhase;
  view.setUint32(26, request.window.beforeSecs, true);
  view.setUint32(30, request.window.afterSecs, true);
  return out;
}

export function historicalAbiV1GuardInstruction(input: { readonly programAddress: Address; readonly mint: Address; readonly request: AssertSafeExecutionRequest }): Instruction {
  return { programAddress: input.programAddress, accounts: [{ address: input.mint, role: AccountRole.READONLY }], data: encodeHistoricalAbiV1(input.request) };
}

/**
 * TEST-ONLY, HISTORICAL. The ABI-v1-era composition the M4 fixture recorded:
 * compute budget (plus a 1.4M limit), guard, setup, swap, cleanup, other,
 * tip. Under ABI v2 this order is wrong — the guard's committed "next
 * instruction" would be the setup — and the product composer
 * (`composeGuardedJupiterTrade`) replaced it. Kept only so the recorded sizing
 * evidence stays reproducible.
 */
export interface HistoricalGuard {
  readonly mint: Address;
  readonly instruction: Instruction;
}

export function historicalOrderInstructions(build: BuildResponse, guard: HistoricalGuard | null): Instruction[] {
  if (guard && guard.mint !== build.outputMint) throw new Error("historical guard bound to a different mint than outputMint");
  const computeBudget = build.computeBudgetInstructions.map(toKitInstruction);
  if (!computeBudget.some((i) => i.data?.[0] === 2)) computeBudget.push(getSetComputeUnitLimitInstruction(UNSIMULATED_COMPUTE_UNIT_LIMIT));
  return [
    ...computeBudget,
    ...(guard ? [guard.instruction] : []),
    ...build.setupInstructions.map(toKitInstruction),
    toKitInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toKitInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toKitInstruction),
    ...(build.tipInstruction ? [toKitInstruction(build.tipInstruction)] : []),
  ];
}

export function historicalComposeWithGuard(build: BuildResponse, feePayer: Address, guard: HistoricalGuard) {
  const baseline = compileAndMeasure(build, feePayer, historicalOrderInstructions(build, null)).metrics;
  const guarded = compileAndMeasure(build, feePayer, historicalOrderInstructions(build, guard)).metrics;
  return {
    baseline,
    guarded,
    delta: {
      serializedBytes: guarded.serializedTransactionBytes - baseline.serializedTransactionBytes,
      staticAccounts: guarded.staticAccountCount - baseline.staticAccountCount,
      instructions: guarded.instructionCount - baseline.instructionCount,
      lookedUpAddresses: guarded.lookedUpAddressCount - baseline.lookedUpAddressCount,
    },
  };
}
