/**
 * Real-transaction scenarios against the deployed program. Every guarded
 * transaction is `[assert_safe_execution, system transfer]`; the transfer to a
 * fresh recipient is the observable downstream effect.
 *
 * All timing decisions use the chain Clock sysvar, never the local clock.
 */

import { generateKeyPairSigner, type Address, type Instruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  bytesEqual,
  fetchGuardSnapshot,
  getAssertSafeExecutionInstruction,
  requestFromSnapshot,
  type AssertSafeExecutionRequest,
  type GuardSnapshot,
  type ProtectionWindow,
} from "@equityguard/guard-client";

import type { DevnetContext } from "./config.ts";
import type { TestAsset } from "./devnet-state.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  customErrorEvidence,
  describeExpected,
  describeObserved,
  explorerUrl,
  snapshotEvidence,
  storedStateError,
  toHex,
  writeEvidence,
  type EvidenceRecord,
  type ExpectedResult,
} from "./evidence.ts";
import { sendInstructions } from "./send.ts";
import { getScheduleMultiplierInstruction } from "./test-mint.ts";

/** Above the rent-exempt minimum for an empty account, so a fresh recipient can receive it. */
export const DOWNSTREAM_TRANSFER_LAMPORTS = 1_000_000n;
const CLOCK_POLL_MS = 2_000;
/**
 * Chain seconds kept between a step's intended region and its boundary.
 * Covers the gap between our Clock read and the Clock the program reads when
 * the transaction executes a few slots later.
 */
export const LANDING_MARGIN_SECS = 6n;

export interface ScenarioEnv {
  readonly ctx: DevnetContext;
  readonly programId: Address;
  readonly asset: TestAsset;
  readonly runId: string;
}

export class ScenarioPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioPreconditionError";
  }
}

/** Sends `[guard, transfer]` with `request`, records evidence, returns it. */
async function guardedTransfer(
  env: ScenarioEnv,
  scenario: string,
  step: string,
  snapshot: GuardSnapshot,
  request: AssertSafeExecutionRequest,
  expected: ExpectedResult,
): Promise<EvidenceRecord> {
  const { ctx } = env;
  const recipient = (await generateKeyPairSigner()).address;
  const balance = async () => (await ctx.rpc.getBalance(recipient, { commitment: "confirmed" }).send()).value;
  const guard = getAssertSafeExecutionInstruction({ programAddress: env.programId, mint: env.asset.mint, request });
  const transfer: Instruction = getTransferSolInstruction({
    source: ctx.payer,
    destination: recipient,
    amount: DOWNSTREAM_TRANSFER_LAMPORTS,
  });

  const recipientBalanceBefore = await balance();
  const chainNow = (await fetchGuardSnapshot(ctx.rpc, env.asset.mint)).clock.unixTimestamp;
  // Preflight is skipped so expected failures land on-chain and are verifiable by signature.
  const outcome = await sendInstructions(ctx, [guard, transfer], { skipPreflight: true });
  const recipientBalanceAfter = await balance();

  const expectedResult = describeExpected(expected);
  const observedResult = describeObserved(outcome);
  const record: EvidenceRecord = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    scenario,
    step,
    cluster: ctx.cluster,
    programId: env.programId,
    mint: env.asset.mint,
    assetLabel: env.asset.label,
    transactionSignature: outcome.signature,
    explorerUrl: explorerUrl(ctx.cluster, outcome.signature),
    slot: outcome.slot,
    blockTime: outcome.blockTime,
    guardSnapshot: snapshotEvidence(snapshot, request),
    instructionDataHex: toHex(Uint8Array.from(guard.data ?? [])),
    chainUnixTimestampBeforeSend: chainNow,
    expectedResult,
    observedResult,
    customError: customErrorEvidence(outcome),
    // A failure only counts if the downstream transfer also did not settle.
    matchedExpectation:
      expectedResult === observedResult &&
      (outcome.succeeded
        ? recipientBalanceAfter === recipientBalanceBefore + DOWNSTREAM_TRANSFER_LAMPORTS
        : recipientBalanceAfter === recipientBalanceBefore),
    downstream: {
      instruction: "system transfer",
      recipient,
      lamports: DOWNSTREAM_TRANSFER_LAMPORTS,
      recipientBalanceBefore,
      recipientBalanceAfter,
    },
    logs: outcome.logs,
    localWallclockForReferenceOnly: new Date().toISOString(),
  };
  const path = await writeEvidence(env.runId, record);
  console.error(
    `[${scenario}/${step}] expected ${expectedResult}, observed ${observedResult}, ` +
      `${record.matchedExpectation ? "OK" : "MISMATCH"} ${outcome.signature} -> ${path}`,
  );
  return record;
}

/** SAFE: a fresh snapshot executes and the transfer settles. */
export async function runSafe(env: ScenarioEnv, window: ProtectionWindow): Promise<EvidenceRecord[]> {
  const snapshot = await fetchGuardSnapshot(env.ctx.rpc, env.asset.mint);
  return [await guardedTransfer(env, "safe", "fresh-snapshot", snapshot, requestFromSnapshot(snapshot, window), "success")];
}

/**
 * STALE STORED STATE: build against S, change the multiplier immediately so
 * the mint holds S', send the stale request, then retry with a fresh snapshot.
 */
export async function runStale(env: ScenarioEnv, window: ProtectionWindow): Promise<EvidenceRecord[]> {
  const { ctx, asset } = env;
  const stale = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  const staleRequest = requestFromSnapshot(stale, window);

  const effective = stale.phase === 0 ? stale.state.multiplier : stale.state.newMultiplier;
  const newMultiplier = readF64(effective) + 0.25;
  // An effective timestamp at or before chain time applies immediately.
  await sendInstructions(
    ctx,
    [getScheduleMultiplierInstruction({ mint: asset.mint, authority: ctx.payer, newMultiplier, effectiveTimestamp: 0n })],
    { skipPreflight: false },
  );

  const changed = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  const expectedError = storedStateError(stale.state, changed.state);
  if (!expectedError) throw new ScenarioPreconditionError("multiplier update did not change protected state");

  return [
    await guardedTransfer(env, "stale", "stale-snapshot", stale, staleRequest, { guardError: expectedError }),
    await guardedTransfer(env, "stale", "fresh-snapshot", changed, requestFromSnapshot(changed, window), "success"),
  ];
}

/**
 * CLOCK TRANSITION: schedule a change at chain time T and replay one pending
 * guard payload before the window, inside it, and after it, with identical
 * mint bytes; then build fresh with the activated phase.
 */
export async function runTransition(
  env: ScenarioEnv,
  window: ProtectionWindow,
  leadSecs: bigint,
): Promise<EvidenceRecord[]> {
  const { ctx, asset } = env;
  const before = BigInt(window.beforeSecs);
  const after = BigInt(window.afterSecs);
  if (leadSecs <= before + 2n * LANDING_MARGIN_SECS) {
    throw new ScenarioPreconditionError("lead time must leave room for a send before the protection window");
  }

  const initial = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  const effective = initial.phase === 0 ? initial.state.multiplier : initial.state.newMultiplier;
  const activation = initial.clock.unixTimestamp + leadSecs;
  await sendInstructions(
    ctx,
    [
      getScheduleMultiplierInstruction({
        mint: asset.mint,
        authority: ctx.payer,
        newMultiplier: readF64(effective) + 0.25,
        effectiveTimestamp: activation,
      }),
    ],
    { skipPreflight: false },
  );

  const pending = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  if (pending.phase !== 0 || !pending.hasScheduledChange) {
    throw new ScenarioPreconditionError("expected a pending scheduled change after scheduling");
  }
  // This exact payload is replayed in every pending step below.
  const pendingRequest = requestFromSnapshot(pending, window);
  const records: EvidenceRecord[] = [];

  const beforeWindowDeadline = activation - before - LANDING_MARGIN_SECS;
  const now = await chainTime(env);
  if (now > beforeWindowDeadline) {
    throw new ScenarioPreconditionError(`chain time ${now} already too close to the window; increase lead time`);
  }
  records.push(await guardedTransfer(env, "transition", "pending-before-window", pending, pendingRequest, "success"));

  await waitForChainTime(env, activation - before + 1n);
  await assertBytesUnchanged(env, pending);
  records.push(
    await guardedTransfer(env, "transition", "pending-inside-window", pending, pendingRequest, {
      guardError: "InsideTransitionWindow",
    }),
  );

  await waitForChainTime(env, activation + after + LANDING_MARGIN_SECS);
  await assertBytesUnchanged(env, pending);
  records.push(
    await guardedTransfer(env, "transition", "pending-after-window", pending, pendingRequest, {
      guardError: "ActivationPhaseChanged",
    }),
  );

  const activated = await fetchGuardSnapshot(ctx.rpc, asset.mint);
  if (activated.phase !== 1) throw new ScenarioPreconditionError("expected activated phase after T");
  records.push(
    await guardedTransfer(
      env,
      "transition",
      "fresh-activated-snapshot",
      activated,
      requestFromSnapshot(activated, window),
      "success",
    ),
  );
  return records;
}

async function chainTime(env: ScenarioEnv): Promise<bigint> {
  return (await fetchGuardSnapshot(env.ctx.rpc, env.asset.mint)).clock.unixTimestamp;
}

async function waitForChainTime(env: ScenarioEnv, target: bigint): Promise<void> {
  for (;;) {
    const now = await chainTime(env);
    if (now >= target) return;
    console.error(`[transition] chain time ${now}, waiting for ${target} (${target - now}s)`);
    await new Promise((resolve) => setTimeout(resolve, CLOCK_POLL_MS));
  }
}

/** The clock-only steps are meaningful only if the mint bytes did not move. */
async function assertBytesUnchanged(env: ScenarioEnv, reference: GuardSnapshot): Promise<void> {
  const current = await fetchGuardSnapshot(env.ctx.rpc, env.asset.mint);
  const same =
    bytesEqual(current.state.multiplier, reference.state.multiplier) &&
    bytesEqual(current.state.newMultiplier, reference.state.newMultiplier) &&
    current.state.newMultiplierEffectiveTimestamp === reference.state.newMultiplierEffectiveTimestamp;
  if (!same) throw new ScenarioPreconditionError("mint state changed during a clock-only step");
}

function readF64(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}
