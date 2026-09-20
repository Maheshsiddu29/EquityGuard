/** Validates and condenses the committed execution-derived KOx replay. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ActivationPhase } from "@equityguard/guard-client";

import { expectationView, loadKoxTradeEvidence } from "../../../scripts/demo/kox-trade-evidence.ts";
import type { ExecutionView, ReferenceState } from "../src/model.ts";

const REPLAY_URL = new URL("../data/kox-trade-replay.json", import.meta.url);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const iso = (unix: string | number) => new Date(Number(unix) * 1000).toISOString().replace(".000Z", "Z");

interface ReplayExecution {
  readonly authorizationSource: string;
  readonly authorization: ReturnType<typeof expectationView>;
  readonly suffixCommitmentHex: string;
  readonly derivedGuardDataHex: string;
  readonly submittedGuardDataHex: string;
  readonly guardDataUnchanged: boolean;
  readonly transactionBytes: number;
  readonly invoked: readonly string[];
  readonly before: { readonly usdc: string | null; readonly kox: string | null };
  readonly after: { readonly usdc: string | null; readonly kox: string | null };
  readonly deltas: { readonly usdc: string; readonly kox: string };
  readonly outcome: {
    readonly signature: string;
    readonly slot: string;
    readonly succeeded: boolean;
    readonly failedInstruction: number | null;
    readonly customCode: number | null;
    readonly guardErrorName: string | null;
    readonly computeUnitsConsumed: string;
  };
}

export interface KoxTradeReplayRecord {
  readonly kind: "equityguard-kox-trade-replay";
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly marketEvidence: {
    readonly asset: { readonly name: "Coca-Cola"; readonly symbol: "KOx"; readonly mint: string; readonly decimals: number };
    readonly sourceCapture: { readonly sourceFile: string; readonly sourceSha256: string; readonly eventWindowSha256: string };
    readonly preparedObservation: { readonly blockTime: number; readonly slot: string };
    readonly scheduledActivation: string;
    readonly postActivationObservation: { readonly blockTime: number; readonly slot: string };
    readonly rawProtectedFields: ReturnType<typeof expectationView>;
    readonly accountBytesIdenticalAcrossBoundary: boolean;
  };
  readonly routeEvidence: {
    readonly captureTimestamp: string;
    readonly fixtureSha256: string;
    readonly inputAmountRaw: string;
    readonly inputAmount: string;
    readonly outputAmountRaw: string;
    readonly outputAmount: string;
    readonly venue: string;
    readonly pool: string;
    readonly commitmentHex: string;
  };
  readonly localExecution: {
    readonly environment: "solana-test-validator";
    readonly executionDidNotOccurOnMainnet: true;
    readonly clock: { readonly unixTimestamp: string };
    readonly binaries: readonly { readonly program: string; readonly sha256: string }[];
  };
  readonly staleExecution: ReplayExecution;
  readonly refreshedExecution: ReplayExecution;
}

export function loadTradeReplay(): KoxTradeReplayRecord {
  const replay = JSON.parse(readFileSync(REPLAY_URL, "utf8")) as KoxTradeReplayRecord;
  if (replay.kind !== "equityguard-kox-trade-replay" || replay.schemaVersion !== 1) throw new Error("unexpected KOx trade replay format");
  return replay;
}

const hasProgram = (execution: ReplayExecution, prefix: string) => execution.invoked.some((program) => program.startsWith(prefix));

function executionView(execution: ReplayExecution): ExecutionView {
  return {
    authorizationSource: execution.authorizationSource,
    signature: execution.outcome.signature,
    slot: String(execution.outcome.slot),
    succeeded: execution.outcome.succeeded,
    failedInstruction: execution.outcome.failedInstruction,
    guardErrorName: execution.outcome.guardErrorName,
    equityGuard: execution.outcome.succeeded ? "PASSED" : "REJECTED",
    jupiter: hasProgram(execution, "JUP6Lkb") ? "EXECUTED" : "NOT_INVOKED",
    whirlpool: hasProgram(execution, "whirLb") ? "EXECUTED" : "NOT_INVOKED",
    usdcBefore: execution.before.usdc ?? "0",
    usdcAfter: execution.after.usdc ?? "0",
    usdcDelta: execution.deltas.usdc,
    koxBefore: execution.before.kox ?? "0",
    koxAfter: execution.after.kox ?? "0",
    koxDelta: execution.deltas.kox,
    computeUnits: execution.outcome.computeUnitsConsumed,
    transactionBytes: execution.transactionBytes,
    guardDataUnchanged: execution.guardDataUnchanged,
  };
}

export function deriveReferenceState(): ReferenceState {
  const bytes = readFileSync(REPLAY_URL);
  const replay = loadTradeReplay();
  const sealed = loadKoxTradeEvidence();
  const stale = replay.staleExecution;
  const refreshed = replay.refreshedExecution;
  const pre = expectationView(sealed.pre.expectation);
  const post = expectationView(sealed.post.expectation);

  if (JSON.stringify(stale.authorization) !== JSON.stringify(pre) || stale.authorization.expectedPhase !== ActivationPhase.Pending) throw new Error("stale authorization is not derived from sealed pre-activation evidence");
  if (JSON.stringify(refreshed.authorization) !== JSON.stringify(post) || refreshed.authorization.expectedPhase !== ActivationPhase.Activated) throw new Error("refreshed authorization is not derived from sealed post-activation evidence");
  if (!stale.guardDataUnchanged || stale.derivedGuardDataHex !== stale.submittedGuardDataHex) throw new Error("stale guard bytes changed before execution");
  if (stale.outcome.succeeded || stale.outcome.failedInstruction !== 0 || stale.outcome.guardErrorName !== "ActivationPhaseChanged") throw new Error("stale execution is not the expected guard rejection");
  if (hasProgram(stale, "JUP6Lkb") || stale.deltas.usdc !== "0" || stale.deltas.kox !== "0") throw new Error("stale execution reached Jupiter or moved tokens");
  if (!refreshed.outcome.succeeded || !hasProgram(refreshed, "JUP6Lkb") || !hasProgram(refreshed, "whirLb")) throw new Error("refreshed execution did not run Jupiter and Whirlpool");
  if (BigInt(refreshed.deltas.usdc) >= 0n || BigInt(refreshed.deltas.kox) <= 0n) throw new Error("refreshed execution has invalid token deltas");
  if (stale.suffixCommitmentHex !== refreshed.suffixCommitmentHex || stale.suffixCommitmentHex !== replay.routeEvidence.commitmentHex) throw new Error("executions do not protect the same route");
  if (replay.routeEvidence.outputAmount !== "0.05504261" || replay.marketEvidence.asset.decimals !== 8) throw new Error("KOx route display amount is not derived from mint decimals");

  const guard = replay.localExecution.binaries.find((binary) => binary.program.startsWith("EbzHf"));
  if (!guard) throw new Error("replay has no EquityGuard binary identity");
  return {
    generatedFrom: [
      { name: "apps/reference/data/kox-trade-replay.json", sha256: sha256(bytes) },
      { name: replay.marketEvidence.sourceCapture.sourceFile, sha256: replay.marketEvidence.sourceCapture.sourceSha256 },
      { name: "tmp/m9d-c1/route-fixture.json", sha256: replay.routeEvidence.fixtureSha256 },
    ],
    asset: replay.marketEvidence.asset,
    order: { side: "Buy", inputAmount: Number(replay.routeEvidence.inputAmount).toFixed(2), inputSymbol: "USDC", estimatedOutput: replay.routeEvidence.outputAmount, outputSymbol: "KOx" },
    marketEvidence: {
      sourceCapture: replay.marketEvidence.sourceCapture.sourceFile,
      sourceSha256: replay.marketEvidence.sourceCapture.sourceSha256,
      eventWindowSha256: replay.marketEvidence.sourceCapture.eventWindowSha256,
      preparedAt: iso(replay.marketEvidence.preparedObservation.blockTime),
      preparedSlot: replay.marketEvidence.preparedObservation.slot,
      activationAt: iso(replay.marketEvidence.scheduledActivation),
      postAt: iso(replay.marketEvidence.postActivationObservation.blockTime),
      postSlot: replay.marketEvidence.postActivationObservation.slot,
      multiplierHex: replay.marketEvidence.rawProtectedFields.multiplierHex,
      newMultiplierHex: replay.marketEvidence.rawProtectedFields.newMultiplierHex,
      accountBytesIdenticalAcrossBoundary: replay.marketEvidence.accountBytesIdenticalAcrossBoundary,
    },
    routeEvidence: {
      capturedAt: replay.routeEvidence.captureTimestamp,
      fixtureSha256: replay.routeEvidence.fixtureSha256,
      venue: replay.routeEvidence.venue,
      pool: replay.routeEvidence.pool,
      inputRaw: replay.routeEvidence.inputAmountRaw,
      outputRaw: replay.routeEvidence.outputAmountRaw,
      commitmentHex: replay.routeEvidence.commitmentHex,
    },
    localExecution: {
      environment: replay.localExecution.environment,
      executionDidNotOccurOnMainnet: replay.localExecution.executionDidNotOccurOnMainnet,
      clock: iso(replay.localExecution.clock.unixTimestamp),
      guardProgram: guard.program,
      guardBinarySha256: guard.sha256,
    },
    staleExecution: executionView(stale),
    refreshedExecution: executionView(refreshed),
    liveDevnetProofUrl: "//127.0.0.1:4174/",
  };
}
