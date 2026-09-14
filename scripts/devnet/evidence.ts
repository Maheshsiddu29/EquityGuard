/**
 * Devnet execution evidence, schema v1. One JSON file per transaction under
 * `evidence/devnet/` (gitignored); curated signatures go in docs/devnet.md.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  bytesEqual,
  equityGuardErrorName,
  type AssertSafeExecutionRequest,
  type EquityGuardErrorName,
  type GuardSnapshot,
  type ProtectedState,
} from "@equityguard/guard-client";

import type { TransactionOutcome } from "./send.ts";

export const EVIDENCE_SCHEMA_VERSION = 1;

/** `success`, or the guard error the step is designed to trigger. */
export type ExpectedResult = "success" | { readonly guardError: EquityGuardErrorName };

export interface EvidenceRecord {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly scenario: string;
  readonly step: string;
  readonly cluster: "devnet" | "localnet";
  readonly programId: string;
  readonly mint: string;
  readonly assetLabel: string;
  readonly transactionSignature: string;
  /** Only for devnet; a localnet signature has no public explorer page. */
  readonly explorerUrl: string | null;
  readonly slot: bigint;
  readonly blockTime: bigint | null;
  /** State and chain-time phase the guard instruction asserts. */
  readonly guardSnapshot: SnapshotEvidence;
  readonly instructionDataHex: string;
  /** Chain Clock read just before sending; the program reads its own Clock at execution. */
  readonly chainUnixTimestampBeforeSend: bigint;
  readonly expectedResult: string;
  readonly observedResult: string;
  readonly customError: { readonly code: number; readonly name: EquityGuardErrorName | null } | null;
  readonly matchedExpectation: boolean;
  readonly downstream: {
    readonly instruction: "system transfer";
    readonly recipient: string;
    readonly lamports: bigint;
    readonly recipientBalanceBefore: bigint;
    readonly recipientBalanceAfter: bigint;
  };
  readonly logs: readonly string[];
  readonly localWallclockForReferenceOnly: string;
}

export interface SnapshotEvidence {
  readonly contextSlot: bigint;
  readonly chainUnixTimestamp: bigint;
  readonly multiplierHex: string;
  readonly newMultiplierHex: string;
  readonly newMultiplierEffectiveTimestamp: bigint;
  readonly phase: "pending" | "activated";
  readonly protectionBeforeSecs: number;
  readonly protectionAfterSecs: number;
}

export function snapshotEvidence(snapshot: GuardSnapshot, request: AssertSafeExecutionRequest): SnapshotEvidence {
  return {
    contextSlot: snapshot.contextSlot,
    chainUnixTimestamp: snapshot.clock.unixTimestamp,
    multiplierHex: toHex(request.expected.multiplier),
    newMultiplierHex: toHex(request.expected.newMultiplier),
    newMultiplierEffectiveTimestamp: request.expected.newMultiplierEffectiveTimestamp,
    phase: request.expectedPhase === 0 ? "pending" : "activated",
    protectionBeforeSecs: request.window.beforeSecs,
    protectionAfterSecs: request.window.afterSecs,
  };
}

export function describeExpected(expected: ExpectedResult): string {
  return expected === "success" ? "success" : `failure:${expected.guardError}`;
}

export function describeObserved(outcome: TransactionOutcome): string {
  if (outcome.succeeded) return "success";
  const name = outcome.customError ? equityGuardErrorName(outcome.customError.code) : undefined;
  return name && outcome.customError?.instructionIndex === 0 ? `failure:${name}` : "failure:other";
}

/**
 * Stored-state error the program returns for `expected` vs `actual`, checked
 * in the program's order, or null if all protected fields match.
 */
export function storedStateError(expected: ProtectedState, actual: ProtectedState): EquityGuardErrorName | null {
  if (!bytesEqual(expected.multiplier, actual.multiplier)) return "MultiplierChanged";
  if (!bytesEqual(expected.newMultiplier, actual.newMultiplier)) return "NewMultiplierChanged";
  if (expected.newMultiplierEffectiveTimestamp !== actual.newMultiplierEffectiveTimestamp) {
    return "EffectiveTimestampChanged";
  }
  return null;
}

export function explorerUrl(cluster: "devnet" | "localnet", signature: string): string | null {
  return cluster === "devnet" ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null;
}

export function customErrorEvidence(outcome: TransactionOutcome): EvidenceRecord["customError"] {
  if (!outcome.customError) return null;
  return { code: outcome.customError.code, name: equityGuardErrorName(outcome.customError.code) ?? null };
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** bigint-safe JSON used for evidence files and console output. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function evidenceDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EQUITYGUARD_EVIDENCE_DIR ?? join("evidence", "devnet");
}

/** Writes one record and returns its path. */
export async function writeEvidence(runId: string, record: EvidenceRecord): Promise<string> {
  const dir = evidenceDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runId}-${record.scenario}-${record.step}.json`);
  await writeFile(path, `${toJson(record)}\n`);
  return path;
}

