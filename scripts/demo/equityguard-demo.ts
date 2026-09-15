#!/usr/bin/env node
/**
 * EquityGuard end-to-end demo. One state engine, one decision engine, two
 * explicitly separated environments:
 *
 *   PART 1 — MAINNET_OBSERVATION: real KO corporate-action evidence (replay)
 *   PART 2 — MAINNET_OBSERVATION: real liquidity result and decisions (replay)
 *   PART 3 — DEVNET_EXECUTION:    consented, guarded execution on devnet
 *
 * Parts 1 and 2 are offline replays of curated, hash-traceable evidence and
 * never touch a network. Part 3 signs and submits DEVNET transactions only,
 * using EQUITYGUARD_DEVNET_WALLET, and refuses any other cluster.
 *
 *   npm run demo:equityguard [-- --skip-devnet]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { generateKeyPairSigner } from "@solana/kit";
import { timelineJson, type DemoResult } from "@equityguard/representation-state";

import { connectDevnet, readDevnetConfig } from "../devnet/config.ts";
import { loadDevnetState } from "../devnet/devnet-state.ts";
import { DEVNET_DEMO_POLICY, runDevnetDemo, type DevnetDemoRun } from "./devnet-execution.ts";
import { loadLiquiditySnapshot } from "./ko-fixtures.ts";
import { KO_DEMO_POLICY, koDivergenceFacts, replayKoScenarios, type ScenarioResult, type SnapshotCheck } from "./mainnet-replay.ts";

const line = (text = "") => console.log(text);
const banner = (title: string, environment: string) => {
  line();
  line("═".repeat(78));
  line(`${title}`);
  line(`ENVIRONMENT: ${environment}`);
  line("═".repeat(78));
};

function formatDecision(result: DemoResult): void {
  line(`  preferred:    ${result.preferredRepresentation.symbol} (${result.preferredRepresentation.issuer}) → ${result.preferredState} [${result.preferredStateSource}]`);
  line(`  alternative:  ${result.alternativeRepresentation ? `${result.alternativeRepresentation.symbol} (${result.alternativeRepresentation.issuer}) → ${result.alternativeState}` : "none"}`);
  line(`  quotes:       ${result.quoteAvailability.source} preferred=${result.quoteAvailability.preferred} alternative=${result.quoteAvailability.alternative}`);
  if (result.preferredSharesEquivalent) {
    line(`  normalized:   preferred ${result.preferredSharesEquivalent} vs alternative ${result.alternativeSharesEquivalent} share-equivalents (INV-VAL-01)`);
    line(`  cost delta:   ${result.conservativeCostDeltaBps} bps (conservative, rounded against the alternative)`);
  }
  line(`  STATE:        ${result.decision} (${result.reasonCode})${result.consentRequired ? "  ← consent required" : ""}`);
  line(`  reason:       ${result.reason}`);
  const selected = result.selectedRepresentation;
  const observationOnly = result.executionEnvironment === "MAINNET_OBSERVATION" ? " [evaluated against the recorded route snapshot; observation only, never submitted]" : "";
  line(`  EXECUTION:    ${result.executionEligibility}${observationOnly}`);
  line(`  selected:     ${selected ? `${selected.symbol} (${selected.issuer}); route ${result.selectedRouteAvailable ? "available" : "UNAVAILABLE"}` : "none"}; quote ${result.quoteAvailable ? "available" : "unavailable"}`);
  line(`  why:          ${result.executionReason}`);
}

function part1(): ReturnType<typeof koDivergenceFacts> {
  banner("PART 1 — REAL MAINNET EVIDENCE: KO corporate action, September 2026", "MAINNET_OBSERVATION (read-only replay of sealed evidence; no transactions)");
  const facts = koDivergenceFacts();
  line(`KOon (Ondo):    ${facts.koon.mechanism}; stored T ${new Date(Number(facts.koon.storedEffectiveTimestamp) * 1000).toISOString()}`);
  line(`                last old state ${facts.koon.lastOldStateObservedAt}; first new state ${facts.koon.firstNewStateObservedAt}; no pending phase observed`);
  line(`KOx (xStocks):  ${facts.kox.mechanism}; stored T ${new Date(Number(facts.kox.storedEffectiveTimestamp) * 1000).toISOString()}`);
  line(`                chain pending first observed ${facts.kox.pendingFirstObservedAt}; API pending first observed ${facts.kox.apiPendingFirstObservedAt}`);
  line(`                activation first observed ${facts.kox.activationFirstObservedAt}; mint bytes unchanged at activation: ${facts.kox.bytesUnchangedAtActivation}`);
  const d = facts.effectiveTimestampDivergenceSecs;
  line(`Divergence:     stored effective timestamps differ by ${d / 60n}m${d % 60n}s`);
  const check = (label: string, c: SnapshotCheck) =>
    line(`  ${label.padEnd(44)} → ${c.guardResult ?? "passes"}${c.economicStateMismatches.length > 0 ? ` (state changed: ${c.economicStateMismatches.map((m) => m.split(" ")[0]).join(", ")})` : " (state identical)"}`);
  line("Immediate update (KOon): the risk is a payload built from the OLD state, not a timed window.");
  check("pre-update snapshot, landing after update", facts.koonImmediateUpdate.staleSnapshot);
  check(`fresh post-update snapshot [${facts.koonImmediateUpdate.freshSnapshot.state}]`, facts.koonImmediateUpdate.freshSnapshot);
  line("Scheduled update (KOx): same account bytes, but the clock crossed T.");
  check("pre-T snapshot after T, demo window", facts.koxClockCrossing.pendingSnapshotDemoWindow);
  check("pre-T snapshot after T, zero window", facts.koxClockCrossing.pendingSnapshotZeroWindow);
  check("fresh activated snapshot, zero window", facts.koxClockCrossing.freshActivatedSnapshotZeroWindow);
  line("Guard results above are an offline mirror of the program's check order over recorded state; nothing was submitted on mainnet.");
  line(`Sources:        chain ${facts.sources.finalChainSnapshotSha256}`);
  line(`                api   ${facts.sources.finalApiSnapshotSha256}`);
  line(`                window ${facts.sources.finalEventWindowSha256}`);
  line("Not observed:   Ondo API pause/status behaviour (authenticated Ondo API unavailable).");
  return facts;
}

function part2(): ScenarioResult[] {
  banner("PART 2 — REAL LIQUIDITY RESULT AND DECISIONS", "MAINNET_OBSERVATION (Jupiter route discovery snapshot + real KO states; no transactions)");
  const snapshot = loadLiquiditySnapshot();
  for (const q of Object.values(snapshot.quotes)) {
    line(`  ${q.symbol.padEnd(6)} ${q.issuer.padEnd(8)} route ${q.route.padEnd(11)} ${q.route === "AVAILABLE" ? `out ${q.outAmountRaw} via ${q.venues.map((v) => v.label).join("+")}` : q.error} @ ${q.observedAt}`);
  }
  line("  Route availability is point-in-time runtime state, not a permanent issuer property.");
  line(`  Policy: ${KO_DEMO_POLICY.basis} [${KO_DEMO_POLICY.calibration}]`);
  const scenarios = replayKoScenarios();
  for (const s of scenarios) {
    line();
    line(`Scenario ${s.id}: ${s.title}`);
    line(`  state evaluated at ${s.evaluatedAt.preferred}`);
    formatDecision(s.result);
  }
  line();
  line("EquityGuard does not fabricate a reroute: at discovery time no underlying (KO, UNH, CRM) had both issuer representations routable.");
  return scenarios;
}

async function part3(): Promise<DevnetDemoRun> {
  banner("PART 3 — DEVNET EXECUTION PROOF", "DEVNET_EXECUTION (EQ-A / EQ-B devnet TEST assets; DEVNET DEMO QUOTE / FIXTURE; real devnet transactions)");
  const ctx = await connectDevnet(readDevnetConfig(process.env));
  const state = await loadDevnetState();
  const recipient = (await generateKeyPairSigner()).address;
  line(`  cluster ${ctx.cluster}; program ${state.deployment?.programId}; recipient ${recipient}`);
  line(`  policy: ${DEVNET_DEMO_POLICY.basis} [${DEVNET_DEMO_POLICY.calibration}]`);
  const run = await runDevnetDemo(ctx, state, { preferredLabel: "EQ-A", alternativeLabel: "EQ-B", recipient });
  if (run.scheduleSignature) line(`  scheduled EQ-A transition: ${run.scheduleSignature}`);
  line();
  line("Consent OFF:");
  formatDecision(run.consentOff);
  line();
  line("Consent ON (explicit demo consent: allowCrossIssuerReroute = true):");
  formatDecision(run.consentOn);
  const exec = run.consentOn.execution;
  if (exec?.rejectedPreferredAttempt) {
    const r = exec.rejectedPreferredAttempt;
    line();
    line(`  REJECTION PROBE, non-SAFE preferred (EQ-A), not an execution of the decision: ${r.succeeded ? "SUCCEEDED (unexpected)" : `REJECTED by EquityGuard: ${r.customErrorName}`}`);
    line(`    signature ${r.signature} slot ${r.slot}`);
    line(`    recipient EQ-A balance ${r.downstreamBalanceBefore} → ${r.downstreamBalanceAfter} (downstream delivery ${r.downstreamBalanceAfter === r.downstreamBalanceBefore ? "did not settle" : "SETTLED"})`);
    if (r.explorerUrl) line(`    ${r.explorerUrl}`);
  }
  if (exec?.executed) {
    const e = exec.executed;
    line(`  EXECUTION of the EXECUTABLE decision (EQ-B): ${e.succeeded ? "SUCCEEDED, guard passed" : `FAILED: ${e.customErrorName}`}`);
    line(`    signature ${e.signature} slot ${e.slot}`);
    line(`    recipient EQ-B balance ${e.downstreamBalanceBefore} → ${e.downstreamBalanceAfter}`);
    if (e.explorerUrl) line(`    ${e.explorerUrl}`);
  }
  return run;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "skip-devnet": { type: "boolean", default: false } } });
  const facts = part1();
  const scenarios = part2();
  const devnet = values["skip-devnet"] ? null : await part3();
  await mkdir("tmp/demo", { recursive: true });
  const path = `tmp/demo/${new Date().toISOString().replaceAll(":", "")}-equityguard-demo.json`;
  await writeFile(path, `${timelineJson({ part1: facts, part2: scenarios, part3: devnet })}\n`, { flag: "wx" });
  line();
  line(`Result written to ${path}`);
  line("No mainnet transaction was signed or submitted. No real cross-issuer trade was executed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
