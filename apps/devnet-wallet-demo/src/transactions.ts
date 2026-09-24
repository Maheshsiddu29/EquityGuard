import { createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import {
  fetchGuardSnapshot,
  expectationFromSnapshot,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  ActivationPhase,
  bytesEqual,
  checkGuardOffline,
  decodeClock,
  phaseAt,
  SYSVAR_CLOCK_ADDRESS,
  type ChainClock,
  type GuardSnapshot,
  type AssertSafeExecutionRequest,
  type GuardedTransferChecked,
  type ProtectionWindow,
} from "@equityguard/guard-client";
import {
  buildGuardedTransferChecked,
} from "@equityguard/guard-client/advanced";
import { DEVNET_RPC_URL } from "./cluster-gate.ts";
import { storedMultiplier, type EquityScenario } from "./scenarios.ts";

/**
 * Chain-time delay from the Clock read that builds the setup transaction
 * until T.
 *
 * A recent blockhash lives for 150 slots. At a 400ms slot that is about 60
 * seconds, so the stale signature is fetched only once T is inside
 * {@link MAX_SIGN_LEAD_SECONDS}. The extra seconds in the delay cover the
 * setup Phantom approval, so T is still ahead of the Clock when that
 * transaction lands. Browser wall time is not an input.
 */
export const BLOCKHASH_BUDGET_SECONDS = 60;
export const MAX_SIGN_LEAD_SECONDS = 35;
export const ACTIVATION_DELAY_SECONDS = 75;
/** Inclusive window of a single second at T. Clock == T is InsideTransitionWindow. */
export const CLOCK_CROSSING_WINDOW: ProtectionWindow = { beforeSecs: 0, afterSecs: 0 };

export function validateActivationTiming(
  delay = ACTIVATION_DELAY_SECONDS,
  lead = MAX_SIGN_LEAD_SECONDS,
  budget = BLOCKHASH_BUDGET_SECONDS,
): void {
  if (!Number.isInteger(delay) || !Number.isInteger(lead) || !Number.isInteger(budget)) {
    throw new Error("Activation timing must be whole seconds");
  }
  if (lead < 20) throw new Error("Sign lead is shorter than a Phantom approval");
  if (budget - lead < 15) throw new Error("Sign lead leaves no blockhash margin");
  if (delay < lead + 25) throw new Error("Activation delay does not cover setup approval plus the sign lead");
  if (delay > 120) throw new Error("Activation delay is too long for a judge");
}

validateActivationTiming();

export function activationTimestamp(chainUnixTimestamp: bigint, delaySeconds = ACTIVATION_DELAY_SECONDS): bigint {
  if (chainUnixTimestamp < 0n) throw new Error("Chain clock is not usable");
  if (!Number.isInteger(delaySeconds) || delaySeconds <= 0) throw new Error("Activation delay must be a positive whole number of seconds");
  return chainUnixTimestamp + BigInt(delaySeconds);
}

export async function readChainClock(): Promise<ChainClock> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const account = await rpc.getAccountInfo(SYSVAR_CLOCK_ADDRESS, { commitment: "confirmed", encoding: "base64" }).send();
  const encoded = account.value?.data?.[0];
  if (!account.value || typeof encoded !== "string") throw new Error("Clock sysvar not returned");
  return decodeClock(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
}

function scheduledBytesMatch(snapshot: GuardSnapshot, scenario: EquityScenario, activation: bigint): boolean {
  return bytesEqual(snapshot.state.multiplier, storedMultiplier(scenario.initialMultiplier))
    && bytesEqual(snapshot.state.newMultiplier, storedMultiplier(scenario.newMultiplier))
    && snapshot.state.newMultiplierEffectiveTimestamp === activation
    && snapshot.hasScheduledChange
    && snapshot.phase === phaseAt(snapshot.state, snapshot.clock.unixTimestamp);
}

export type PendingSignDecision = "wait" | "sign" | "missed" | "mismatch";

/** Whether the pending authorization may be signed. Uses only the chain snapshot. */
export function pendingSignDecision(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): PendingSignDecision {
  if (!scheduledBytesMatch(snapshot, scenario, activation)) return "mismatch";
  if (snapshot.clock.unixTimestamp >= activation || snapshot.phase !== ActivationPhase.Pending) return "missed";
  const remaining = activation - snapshot.clock.unixTimestamp;
  if (remaining > BigInt(MAX_SIGN_LEAD_SECONDS)) return "wait";
  return "sign";
}

export type ActivatedReviewDecision = "wait" | "ready" | "mismatch";

/** Whether a new activated authorization may be built. Clock == T is still too early. */
export function activatedReviewDecision(
  snapshot: GuardSnapshot,
  scenario: EquityScenario,
  activation: bigint,
): ActivatedReviewDecision {
  if (!scheduledBytesMatch(snapshot, scenario, activation)) return "mismatch";
  if (snapshot.phase !== ActivationPhase.Activated || snapshot.clock.unixTimestamp <= activation) return "wait";
  const expectation = expectationFromSnapshot(snapshot, CLOCK_CROSSING_WINDOW);
  if (expectation.expectedPhase !== ActivationPhase.Activated) return "mismatch";
  return checkGuardOffline(expectation, snapshot.state, snapshot.clock.unixTimestamp) === null ? "ready" : "wait";
}

export function chainReadyForStaleSubmit(snapshot: GuardSnapshot, expectation: AssertSafeExecutionRequest): boolean {
  if (expectation.expectedPhase !== ActivationPhase.Pending) return false;
  if (expectation.window.beforeSecs !== 0 || expectation.window.afterSecs !== 0) return false;
  return checkGuardOffline(expectation, snapshot.state, snapshot.clock.unixTimestamp) === "ActivationPhaseChanged";
}

export function heldWaitDecision(input: {
  readonly blockHeight: bigint;
  readonly lastValidBlockHeight: bigint;
  readonly ready: boolean;
}): "wait" | "submit" | "expired" {
  if (input.blockHeight > input.lastValidBlockHeight) return "expired";
  return input.ready ? "submit" : "wait";
}

export function buildClockCrossingTransfer(input: {
  readonly snapshot: GuardSnapshot;
  readonly scenario: EquityScenario;
  readonly activationTimestamp: bigint;
  readonly requiredPhase: typeof ActivationPhase.Pending | typeof ActivationPhase.Activated;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly transferChecked: Instruction;
  readonly programAddress?: Address;
}): { readonly guarded: GuardedTransferChecked; readonly expectation: AssertSafeExecutionRequest } {
  if (input.requiredPhase === ActivationPhase.Pending) {
    if (pendingSignDecision(input.snapshot, input.scenario, input.activationTimestamp) !== "sign") {
      throw new Error("Pending authorization is not signable at this chain clock");
    }
  } else if (activatedReviewDecision(input.snapshot, input.scenario, input.activationTimestamp) !== "ready") {
    throw new Error("Updated authorization is not ready at this chain clock");
  }
  const expectation = expectationFromSnapshot(input.snapshot, CLOCK_CROSSING_WINDOW);
  if (expectation.expectedPhase !== input.requiredPhase) {
    throw new Error("Expectation phase does not match the chain clock");
  }
  return {
    expectation,
    guarded: buildGuardedTransferChecked({
      programAddress: input.programAddress ?? (EQUITY_GUARD_DEVNET_PROGRAM_ID as Address),
      feePayer: input.feePayer,
      mint: input.mint,
      expectation,
      transferChecked: input.transferChecked,
    }),
  };
}

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
