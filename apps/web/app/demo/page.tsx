import {
  DemoExperience,
  type DemoEvidence,
} from "@/components/demo/demo-experience";
import { createMetadata } from "@/lib/metadata";
import replaySource from "../../../reference/data/kox-trade-replay.json";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "EquityGuard Demo — Protected Trade Replay",
  description:
    "A public, deterministic reproduction of EquityGuard's proven protected-trade lifecycle.",
  path: "/demo",
});

type ReplayExecution = {
  invoked: readonly string[];
  deltas: { usdc: string; kox: string };
  outcome: {
    signature: string;
    slot: string;
    succeeded: boolean;
    failedInstruction: number | null;
    guardErrorName: string | null;
    logs: readonly string[];
  };
};

type ReplayRecord = {
  kind: string;
  schemaVersion: number;
  marketEvidence: {
    asset: { name: string; symbol: string; decimals: number };
    sourceCapture: { sourceSha256: string };
    preparedObservation: { blockTime: number };
    scheduledActivation: string;
    postActivationObservation: { blockTime: number };
  };
  routeEvidence: {
    captureTimestamp: string;
    inputAmount: string;
    outputAmount: string;
    venue: string;
    pool: string;
    commitmentHex: string;
  };
  localExecution: {
    environment: string;
    executionDidNotOccurOnMainnet: boolean;
    binaries: readonly { program: string; sha256: string }[];
  };
  staleExecution: ReplayExecution;
  refreshedExecution: ReplayExecution;
};

function formatUtc(unixSeconds: number | string): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace(".000Z", "Z");
}

function invoked(execution: ReplayExecution, prefix: string): boolean {
  return execution.invoked.some((program) => program.startsWith(prefix));
}

function movement(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "−" : "+"}${whole}${fraction ? `.${fraction}` : ""}`;
}

function buildDemoEvidence(): DemoEvidence {
  const replay = replaySource as ReplayRecord;
  const stale = replay.staleExecution;
  const updated = replay.refreshedExecution;
  const guard = replay.localExecution.binaries.find((binary) =>
    binary.program.startsWith("EbzHf")
  );

  if (
    replay.kind !== "equityguard-kox-trade-replay" ||
    replay.schemaVersion !== 1 ||
    replay.routeEvidence.outputAmount !== "0.05504261" ||
    replay.marketEvidence.asset.decimals !== 8
  ) {
    throw new Error("Unexpected canonical KOx replay shape");
  }
  if (
    stale.outcome.succeeded ||
    stale.outcome.failedInstruction !== 0 ||
    stale.outcome.guardErrorName !== "ActivationPhaseChanged" ||
    invoked(stale, "JUP6Lkb") ||
    stale.deltas.usdc !== "0" ||
    stale.deltas.kox !== "0"
  ) {
    throw new Error("Canonical stale execution no longer proves an ix0 stop");
  }
  if (
    !updated.outcome.succeeded ||
    !invoked(updated, "JUP6Lkb") ||
    !invoked(updated, "whirLb") ||
    !replay.localExecution.executionDidNotOccurOnMainnet ||
    !guard
  ) {
    throw new Error("Canonical updated execution proof is incomplete");
  }

  return {
    asset: replay.marketEvidence.asset,
    order: {
      input: `${Number(replay.routeEvidence.inputAmount).toFixed(2)} USDC`,
      output: `${replay.routeEvidence.outputAmount} KOx`,
    },
    market: {
      prepared: formatUtc(replay.marketEvidence.preparedObservation.blockTime),
      activation: formatUtc(replay.marketEvidence.scheduledActivation),
      post: formatUtc(replay.marketEvidence.postActivationObservation.blockTime),
      sourceHash: replay.marketEvidence.sourceCapture.sourceSha256,
    },
    route: {
      captured: new Date(replay.routeEvidence.captureTimestamp).toISOString(),
      venue: replay.routeEvidence.venue,
      pool: replay.routeEvidence.pool,
      commitment: replay.routeEvidence.commitmentHex,
    },
    local: {
      environment: replay.localExecution.environment,
      guardProgram: guard.program,
      guardHash: guard.sha256,
    },
    stale: {
      signature: stale.outcome.signature,
      slot: stale.outcome.slot,
      guard: `REJECTED at ix${String(stale.outcome.failedInstruction)}`,
      jupiter: "NOT INVOKED",
      whirlpool: "NOT INVOKED",
      usdc: movement(stale.deltas.usdc, 6),
      kox: movement(stale.deltas.kox, replay.marketEvidence.asset.decimals),
      logs: stale.outcome.logs,
    },
    updated: {
      signature: updated.outcome.signature,
      slot: updated.outcome.slot,
      guard: "PASSED",
      jupiter: "EXECUTED",
      whirlpool: "EXECUTED",
      usdc: movement(updated.deltas.usdc, 6),
      kox: movement(updated.deltas.kox, replay.marketEvidence.asset.decimals),
      logs: updated.outcome.logs,
    },
  };
}

export default function DemoPage(): ReactNode {
  return <DemoExperience evidence={buildDemoEvidence()} />;
}
