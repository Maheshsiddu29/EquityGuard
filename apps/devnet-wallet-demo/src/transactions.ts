import { createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import {
  fetchGuardSnapshot,
  expectationFromSnapshot,
  buildGuardedTransferChecked,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  type GuardSnapshot,
  type AssertSafeExecutionRequest,
  type GuardedTransferChecked,
  type ProtectionWindow,
} from "@equityguard/guard-client";

export const DEFAULT_PROTECTION_WINDOW: ProtectionWindow = { beforeSecs: 900, afterSecs: 300 };

/**
 * Fetches the current chain-consistent snapshot for a protected Token-2022 mint.
 */
export async function getMintGuardSnapshot(
  rpcUrl: string,
  mintAddress: Address
): Promise<GuardSnapshot> {
  const rpc = createSolanaRpc(rpcUrl);
  return fetchGuardSnapshot(rpc, mintAddress, "confirmed");
}

/**
 * Derives baseline AssertSafeExecutionRequest from a GuardSnapshot.
 */
export function getBaselineExpectation(
  snapshot: GuardSnapshot,
  windowSecs = 60
): AssertSafeExecutionRequest {
  return expectationFromSnapshot(snapshot, {
    beforeSecs: windowSecs,
    afterSecs: windowSecs,
  });
}

export function readStoredMultiplier(multiplierBytes: Uint8Array): number {
  return new DataView(multiplierBytes.buffer, multiplierBytes.byteOffset, multiplierBytes.byteLength).getFloat64(0, true);
}

/**
 * Derives an intentionally corrupted/stale AssertSafeExecutionRequest to prove
 * guard failure mode.
 *
 * It mutates expected.multiplier bytes (adds offset to float value) so the guard check will fail on-chain.
 */
export function getStaleExpectation(
  snapshot: GuardSnapshot,
  multiplierOffset = 0.05
): AssertSafeExecutionRequest {
  const baseline = getBaselineExpectation(snapshot);
  const currentMult = readStoredMultiplier(snapshot.state.multiplier);
  const corruptedVal = currentMult + multiplierOffset;
  
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, corruptedVal, true);
  const corruptedBytes = new Uint8Array(buf);

  return {
    ...baseline,
    expected: {
      ...baseline.expected,
      multiplier: corruptedBytes,
    },
  };
}

/**
 * Builds instructions for a SAFE guarded transfer.
 */
export function buildSafeGuardedTransfer(input: {
  readonly programAddress?: Address;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly snapshot: GuardSnapshot;
  readonly transferChecked: Instruction;
  readonly before?: readonly Instruction[];
}): GuardedTransferChecked {
  const programAddress = input.programAddress ?? (EQUITY_GUARD_DEVNET_PROGRAM_ID as Address);
  const expectation = getBaselineExpectation(input.snapshot);

  return buildGuardedTransferChecked({
    programAddress,
    feePayer: input.feePayer,
    mint: input.mint,
    expectation,
    transferChecked: input.transferChecked,
    ...(input.before !== undefined ? { before: input.before } : {}),
  });
}

/**
 * Builds instructions for a STALE guarded transfer (corrupted multiplier expectation).
 */
export function buildStaleGuardedTransfer(input: {
  readonly programAddress?: Address;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly snapshot: GuardSnapshot;
  readonly transferChecked: Instruction;
  readonly before?: readonly Instruction[];
  readonly multiplierOffset?: number;
}): GuardedTransferChecked {
  const programAddress = input.programAddress ?? (EQUITY_GUARD_DEVNET_PROGRAM_ID as Address);
  const expectation = getStaleExpectation(input.snapshot, input.multiplierOffset ?? 0.05);

  return buildGuardedTransferChecked({
    programAddress,
    feePayer: input.feePayer,
    mint: input.mint,
    expectation,
    transferChecked: input.transferChecked,
    ...(input.before !== undefined ? { before: input.before } : {}),
  });
}

/**
 * Refreshes snapshot and builds updated safe transfer instructions.
 */
export async function refreshAndBuildGuardedTransfer(input: {
  readonly rpcUrl: string;
  readonly programAddress?: Address;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly transferChecked: Instruction;
  readonly before?: readonly Instruction[];
}): Promise<{ snapshot: GuardSnapshot; guarded: GuardedTransferChecked }> {
  const snapshot = await getMintGuardSnapshot(input.rpcUrl, input.mint);
  const guarded = buildSafeGuardedTransfer({
    ...(input.programAddress !== undefined ? { programAddress: input.programAddress } : {}),
    feePayer: input.feePayer,
    mint: input.mint,
    snapshot,
    transferChecked: input.transferChecked,
    ...(input.before !== undefined ? { before: input.before } : {}),
  });
  return { snapshot, guarded };
}
