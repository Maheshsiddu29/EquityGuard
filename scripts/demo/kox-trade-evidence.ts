import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { address } from "@solana/kit";
import { ActivationPhase, expectationFromSnapshot, type AssertSafeExecutionRequest, type GuardSnapshot } from "../../packages/guard-client/src/index.ts";
import type { ChainObservation } from "../../packages/representation-state/src/index.ts";
import { decodeObservation, loadKoFixture, type CuratedObservation } from "./ko-fixtures.ts";

export const ZERO_WINDOW = { beforeSecs: 0, afterSecs: 0 } as const;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function decoded(observation: CuratedObservation): ChainObservation {
  const result = decodeObservation(observation);
  if (result.kind !== "decoded" || result.phase === null || result.chainUnixTimestamp === null || result.slot === null) {
    throw new Error(`sealed KOx observation at line ${observation.lineNumber} did not decode with chain time`);
  }
  return result;
}

function expectationFromObservation(observation: ChainObservation): AssertSafeExecutionRequest {
  if (observation.phase === null || observation.chainUnixTimestamp === null || observation.slot === null) {
    throw new Error("cannot derive a guard expectation without phase, chain time, and slot");
  }
  const snapshot: GuardSnapshot = {
    mint: address(observation.mint),
    contextSlot: observation.slot,
    clock: { slot: observation.slot, unixTimestamp: observation.chainUnixTimestamp },
    state: observation.protectedState,
    phase: observation.phase,
    hasScheduledChange: observation.hasScheduledChange,
  };
  return expectationFromSnapshot(snapshot, ZERO_WINDOW);
}

export interface KoxTradeEvidence {
  readonly asset: { readonly name: "Coca-Cola"; readonly symbol: "KOx"; readonly mint: string; readonly decimals: number };
  readonly capture: {
    readonly sourceFile: string;
    readonly sourceSha256: string;
    readonly eventWindowSha256: string;
    readonly accountDataSha256: string;
  };
  readonly pre: { readonly source: CuratedObservation; readonly observation: ChainObservation; readonly expectation: AssertSafeExecutionRequest };
  readonly post: { readonly source: CuratedObservation; readonly observation: ChainObservation; readonly expectation: AssertSafeExecutionRequest };
}

/**
 * Derives both authorizations from the committed extracts of the sealed KOx
 * capture. Phase comes from the captured block time through the production
 * representation-state decoder and `expectationFromSnapshot`.
 */
export function loadKoxTradeEvidence(): KoxTradeEvidence {
  const fixture = loadKoFixture();
  const preSource = fixture.observations.koxLastPendingBeforeT;
  const postSource = fixture.observations.koxActivatedFirstObserved;
  const pre = decoded(preSource);
  const post = decoded(postSource);
  const activation = pre.protectedState.newMultiplierEffectiveTimestamp;

  if (preSource.blockTime !== 1_789_432_186 || postSource.blockTime !== 1_789_432_216 || activation !== 1_789_432_200n) {
    throw new Error("KOx replay evidence no longer identifies the reviewed Sep 15 activation boundary");
  }
  if (pre.phase !== ActivationPhase.Pending || post.phase !== ActivationPhase.Activated) {
    throw new Error("KOx replay observations do not bracket pending and activated phases");
  }
  const protectedFields = (o: ChainObservation) =>
    `${hex(o.protectedState.multiplier)}:${hex(o.protectedState.newMultiplier)}:${o.protectedState.newMultiplierEffectiveTimestamp}`;
  if (protectedFields(pre) !== protectedFields(post)) {
    throw new Error("KOx protected fields changed across the adjacent activation observations");
  }
  const preBytes = Buffer.from(preSource.dataBase64, "base64");
  const postBytes = Buffer.from(postSource.dataBase64, "base64");
  if (!preBytes.equals(postBytes)) throw new Error("KOx account bytes changed across the adjacent activation observations");
  if (pre.decimals !== 8 || post.decimals !== 8) throw new Error(`unexpected KOx decimals ${pre.decimals}/${post.decimals}`);

  return {
    asset: { name: "Coca-Cola", symbol: "KOx", mint: pre.mint, decimals: pre.decimals },
    capture: {
      sourceFile: preSource.sourceFile,
      sourceSha256: fixture.sources.finalChainSnapshotSha256,
      eventWindowSha256: fixture.sources.finalEventWindowSha256,
      accountDataSha256: sha256(preBytes),
    },
    pre: { source: preSource, observation: pre, expectation: expectationFromObservation(pre) },
    post: { source: postSource, observation: post, expectation: expectationFromObservation(post) },
  };
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function expectationView(request: AssertSafeExecutionRequest) {
  return {
    multiplierHex: hex(request.expected.multiplier),
    newMultiplierHex: hex(request.expected.newMultiplier),
    newMultiplierEffectiveTimestamp: request.expected.newMultiplierEffectiveTimestamp.toString(),
    expectedPhase: request.expectedPhase,
    window: request.window,
  };
}
