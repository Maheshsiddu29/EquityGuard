/**
 * Derives the reference app's deterministic state from committed evidence.
 *
 * Every protection decision below is computed here, at build time, by the
 * existing EquityGuard code: `checkGuardOffline` (the host mirror of the
 * on-chain guard) over recorded mainnet KOx/KOon account bytes, and the
 * representation decision engine for the consent prompt. The browser never
 * computes a decision and never touches a network or a signer.
 *
 * The only non-observed value is the KOon quote in the consent scenario:
 * Jupiter returned no KOon route, so that quote is ILLUSTRATIVE and labelled.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ActivationPhase, JUPITER_ADAPTER_KIND_NAMES, checkGuardOffline, isJupiterAdapterKind, type AssertSafeExecutionRequest } from "@equityguard/guard-client";
import {
  RepresentationState,
  compareQuotes,
  decide,
  economicStateOf,
  findRepresentationBySymbol,
  routeIdentity,
  type ChainObservation,
  type NormalizedQuote,
  type ResolvedRepresentationState,
} from "@equityguard/representation-state";

import { decodeObservation, loadKoFixture, type CuratedKoFixture, type ObservationKey } from "../../../scripts/demo/ko-fixtures.ts";
import { KO_DEMO_POLICY, KO_REPLAY_REROUTE_POLICY, koDivergenceFacts, resolveCurated } from "../../../scripts/demo/mainnet-replay.ts";
import { fromGuardResult, fromRepresentationDecision, type GuardDecision } from "../src/decision.ts";
import type { EconomicStateView, ReferenceState, Scenario, ScenarioId } from "../src/model.ts";

const KO_FIXTURE_URL = new URL("../../../scripts/demo/fixtures/ko-corporate-action-2026-09.json", import.meta.url);
const REPLAY_URL = new URL("../data/local-replay-2026-09-17.json", import.meta.url);

/** Recorded observation cadence of the KO capture, seconds. */
const POLLING_SECS = 30;

/**
 * ILLUSTRATIVE KOon output for 5 USDC. Jupiter returned "No routes found" for
 * KOon, so no real KOon quote exists; this value only exercises the consent
 * disclosure and is labelled as such everywhere it appears.
 */
const ILLUSTRATIVE_KOON_OUTPUT_RAW = 54_645_000n;

export interface LocalReplayExcerpt {
  readonly kind: "equityguard-reference-local-replay-excerpt";
  readonly environment: "LOCAL_REPLAY";
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly routeSourceSha256: string;
  readonly recordedAt: string;
  readonly routeObservedAt: string;
  readonly route: {
    readonly symbol: string;
    readonly adapterKind: number;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inAmount: string;
    readonly outAmount: string;
    readonly otherAmountThreshold: string;
    readonly slippageBps: number;
    readonly venues: readonly { readonly label: string; readonly ammKey: string; readonly percent: number }[];
    readonly window: { readonly beforeSecs: number; readonly afterSecs: number };
  };
  readonly binaries: Readonly<Record<"equityGuard" | "jupiterV6" | "whirlpool", { readonly program: string; readonly sha256: string }>>;
  readonly results: readonly {
    readonly label: "SAFE" | "STALE_PRE_ACTIVATION" | "MUTATED_SLIPPAGE";
    readonly expectation: { readonly multiplierHex: string; readonly newMultiplierHex: string; readonly newMultiplierEffectiveTimestamp: string; readonly expectedPhase: number };
    readonly suffixCommitmentHex: string;
    readonly serializedTransactionBytes: number;
    readonly succeeded: boolean;
    readonly failedInstruction: string | null;
    readonly guardErrorName: string | null;
    readonly invoked: readonly string[];
    readonly usdcDelta: string;
    readonly stockDelta: string;
    readonly lamportsDelta: string;
  }[];
}

export function loadReplayExcerpt(): LocalReplayExcerpt {
  const excerpt = JSON.parse(readFileSync(REPLAY_URL, "utf8")) as LocalReplayExcerpt;
  if (excerpt.kind !== "equityguard-reference-local-replay-excerpt" || excerpt.environment !== "LOCAL_REPLAY") {
    throw new Error("unexpected local replay excerpt kind or environment");
  }
  return excerpt;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const iso = (unixSecs: bigint) => new Date(Number(unixSecs) * 1000).toISOString().replace(".000Z", "Z");
/** Display only: the guard compares bytes, never floats. */
const f64 = (bytes: Uint8Array) => Buffer.from(bytes).readDoubleLE(0).toString();

function decoded(fixture: CuratedKoFixture, key: ObservationKey): ChainObservation {
  const evidence = decodeObservation(fixture.observations[key]);
  if (evidence.kind !== "decoded" || evidence.phase === null || evidence.chainUnixTimestamp === null) {
    throw new Error(`curated observation ${key} did not decode with chain time`);
  }
  return evidence;
}

function stateView(observation: ChainObservation, summary?: string): EconomicStateView {
  const s = observation.protectedState;
  const phase = observation.phase === ActivationPhase.Activated ? "ACTIVATED" : "PENDING";
  return {
    tag: phase === "PENDING" ? "S" : "S′",
    summary: summary ?? (phase === "PENDING" ? "Dividend adjustment scheduled, not yet active" : "Dividend adjustment active"),
    phase,
    multiplier: f64(s.multiplier),
    newMultiplier: f64(s.newMultiplier),
    multiplierHex: hex(s.multiplier),
    newMultiplierHex: hex(s.newMultiplier),
    effectiveAt: iso(s.newMultiplierEffectiveTimestamp),
    chainTime: iso(observation.chainUnixTimestamp as bigint),
    slot: String(observation.slot),
    fingerprint: sha256(`${hex(s.multiplier)}:${hex(s.newMultiplier)}:${s.newMultiplierEffectiveTimestamp}:${phase}`).slice(0, 12),
  };
}

function requestFrom(observation: ChainObservation): AssertSafeExecutionRequest {
  return {
    expected: observation.protectedState,
    expectedPhase: observation.phase as ActivationPhase,
    window: { beforeSecs: Number(KO_DEMO_POLICY.beforeSecs), afterSecs: Number(KO_DEMO_POLICY.afterSecs) },
  };
}

const evaluate = (request: AssertSafeExecutionRequest, live: ChainObservation) =>
  checkGuardOffline(request, live.protectedState, live.chainUnixTimestamp as bigint);

function quoteFor(resolved: ResolvedRepresentationState, outputRaw: bigint, source: string, quotedAt: string): NormalizedQuote {
  const state = economicStateOf(resolved.chainObservation);
  if (!state) throw new Error(`${resolved.symbol} has no decoded chain state`);
  return {
    underlying: resolved.underlying,
    issuer: resolved.issuer,
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mint: resolved.mint,
    inputRaw: 5_000_000n,
    outputRaw,
    minOutputRaw: null,
    route: routeIdentity(source, [{ venue: source, poolId: null, inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", outputMint: resolved.mint, percent: 100 }]),
    quotedAt,
    contextSlot: resolved.chainObservation?.slot ?? null,
    state,
  };
}

export function deriveReferenceState(): ReferenceState {
  const fixture = loadKoFixture();
  const replay = loadReplayExcerpt();
  const facts = koDivergenceFacts();
  const kox = findRepresentationBySymbol("KOx");
  if (!kox) throw new Error("KOx not in registry");
  const replayResult = (label: LocalReplayExcerpt["results"][number]["label"]) => {
    const result = replay.results.find((r) => r.label === label);
    if (!result) throw new Error(`replay excerpt has no ${label} result`);
    return result;
  };
  const replaySafe = replayResult("SAFE");
  const replayStale = replayResult("STALE_PRE_ACTIVATION");
  const replayMutated = replayResult("MUTATED_SLIPPAGE");

  // S: KOx as first observed with its dividend adjustment scheduled (pending).
  const prepared = decoded(fixture, "koxPendingFirstObserved");
  // S′: KOx after the Clock crossed T and outside the demo window.
  const transitioned = decoded(fixture, "windowEndKOx");
  // KOx 14 s before T: same bytes as S, inside the demo window.
  const nearActivation = decoded(fixture, "koxLastPendingBeforeT");
  if (prepared.decimals !== transitioned.decimals) throw new Error("KOx decimals changed between observations");

  const preparedRequest = requestFrom(prepared);
  const refreshedRequest = requestFrom(transitioned);
  const safeResult = evaluate(preparedRequest, prepared);
  const staleResult = evaluate(preparedRequest, transitioned);
  const refreshedResult = evaluate(refreshedRequest, transitioned);
  const nearResult = evaluate(preparedRequest, nearActivation);

  const S = stateView(prepared);
  const S2 = stateView(transitioned);
  const commitment = replaySafe.suffixCommitmentHex;
  const noTokensMoved = (fee: string) => `No tokens moved. The trade never ran; only the ${BigInt(fee) * -1n} lamport network fee was charged.`;

  // Consent prompt: KOx inside its scheduled window, KOon already settled.
  const koxNear = resolveCurated("koxLastPendingBeforeT");
  const koonNear = resolveCurated("koonAtKoxLastPending");
  if (koxNear.state !== RepresentationState.TRANSITION || koonNear.state !== RepresentationState.SAFE) {
    throw new Error(`consent scenario expects KOx TRANSITION and KOon SAFE, got ${koxNear.state} / ${koonNear.state}`);
  }
  const comparison = compareQuotes(
    quoteFor(koxNear, BigInt(replay.route.outAmount), "JUPITER_ROUTE_SHAPE", replay.routeObservedAt),
    quoteFor(koonNear, ILLUSTRATIVE_KOON_OUTPUT_RAW, "ILLUSTRATIVE", fixture.observations.koonAtKoxLastPending.wallclock),
  );
  const engine = decide({ preferred: koxNear, alternative: koonNear, reroutePolicy: KO_REPLAY_REROUTE_POLICY, inputRaw: 5_000_000n, comparison });
  const disclosure = engine.disclosure
    ? {
        fromSymbol: engine.disclosure.original.symbol,
        fromIssuer: engine.disclosure.original.issuer,
        toSymbol: engine.disclosure.alternative.symbol,
        toIssuer: engine.disclosure.alternative.issuer,
        additionalCostBps: String(engine.disclosure.additionalCostBps),
        policyMaxAdditionalCostBps: String(engine.disclosure.policyMaxAdditionalCostBps),
        notice: engine.disclosure.notice,
        disclosureDigest: engine.disclosure.disclosureDigest,
      }
    : null;

  const scenario = (id: ScenarioId, fields: Omit<Scenario, "id" | "symbol" | "issuer"> & { decision: GuardDecision }): Scenario => ({
    id,
    symbol: kox.symbol,
    issuer: kox.issuer,
    ...fields,
  });

  const scenarios: Record<ScenarioId, Scenario> = {
    safe: scenario("safe", {
      label: "Prepared",
      headline: "Protected execution",
      detail: "KOx's economic state matches what this trade was prepared against. The trade can proceed.",
      decision: fromGuardResult(safeResult),
      authorized: S,
      current: S,
      evaluatedAt: S.chainTime,
      commitment: { status: "BOUND", hex: commitment },
      settlement: "The guard and the swap settle together in one transaction, or not at all.",
      backing: [
        { provenance: "MAINNET_OBSERVATION", text: `KOx mint state recorded on Solana mainnet at slot ${S.slot}.` },
        { provenance: "GUARD_MODEL", text: "Decision computed by EquityGuard's offline guard model over those bytes." },
      ],
    }),
    stale: scenario("stale", {
      label: "Activation",
      headline: "Trade blocked",
      detail: "KOx changed economic state after this trade was prepared. The previous authorization is stale, so EquityGuard blocked the transaction before execution.",
      decision: fromGuardResult(staleResult),
      authorized: S,
      current: S2,
      evaluatedAt: S2.chainTime,
      commitment: { status: "BOUND", hex: commitment },
      settlement: noTokensMoved(replayStale.lamportsDelta),
      backing: [
        { provenance: "MAINNET_OBSERVATION", text: `KOx's scheduled adjustment activated at ${S.effectiveAt} (Clock-driven; stored bytes unchanged).` },
        { provenance: "GUARD_MODEL", text: `Guard model result for the prepared payload against state at slot ${S2.slot}: ${staleResult ?? "passed"}.` },
        {
          provenance: "LOCAL_REPLAY",
          text: `The same stale-phase payload was sent with a real Jupiter route on a local validator: rejected at instruction ${replayStale.failedInstruction} with ${replayStale.guardErrorName}; Jupiter never ran.`,
        },
      ],
    }),
    refreshed: scenario("refreshed", {
      label: "Refreshed",
      headline: "Protected execution",
      detail: "A new protected transaction was prepared against KOx's current state. The trade can proceed.",
      decision: fromGuardResult(refreshedResult),
      authorized: S2,
      current: S2,
      evaluatedAt: S2.chainTime,
      commitment: { status: "BOUND", hex: commitment },
      settlement: "The new authorization is bound to the current state. The guard and the swap settle together, or not at all.",
      backing: [
        { provenance: "GUARD_MODEL", text: `Guard model result for a payload re-read at slot ${S2.slot}: ${refreshedResult ?? "passed"}.` },
        {
          provenance: "LOCAL_REPLAY",
          text: `With the activated state, the guarded route executed on a local validator: ${Number(replaySafe.usdcDelta) / -1e6} USDC in, ${replaySafe.stockDelta} raw KOx out.`,
        },
      ],
    }),
    tampered: scenario("tampered", {
      label: "Route altered",
      headline: "Trade blocked",
      detail: "The swap in this transaction no longer matches the one the guard was bound to. EquityGuard blocked it before execution.",
      decision: fromGuardResult(replayMutated.guardErrorName),
      authorized: S2,
      current: S2,
      evaluatedAt: S2.chainTime,
      commitment: { status: "ALTERED", hex: replayMutated.suffixCommitmentHex },
      settlement: noTokensMoved(replayMutated.lamportsDelta),
      backing: [
        {
          provenance: "LOCAL_REPLAY",
          text: `Slippage in the real Jupiter instruction was changed after the guard was built: rejected at instruction ${replayMutated.failedInstruction} with ${replayMutated.guardErrorName}; Jupiter never ran.`,
        },
      ],
    }),
    consent: scenario("consent", {
      label: "Issuer switch",
      headline: "Your approval is needed",
      detail: "KOx is inside its scheduled dividend adjustment window, so the KOx trade cannot proceed as authorized. KOon (Ondo) already completed its update. Switching issuer is never automatic.",
      decision: fromRepresentationDecision(engine.decision, nearResult, disclosure),
      authorized: S,
      current: stateView(nearActivation, `Activation in ${Number(prepared.protectedState.newMultiplierEffectiveTimestamp - (nearActivation.chainUnixTimestamp as bigint))} s: inside the protection window`),
      evaluatedAt: iso(nearActivation.chainUnixTimestamp as bigint),
      commitment: { status: "BOUND", hex: commitment },
      settlement: "Nothing executes until you choose. This reference app never executes the alternative.",
      backing: [
        { provenance: "MAINNET_OBSERVATION", text: "KOx and KOon states recorded at the same mainnet slot, 14 s before KOx's activation." },
        { provenance: "GUARD_MODEL", text: `Decision engine: ${engine.decision} (${engine.reasonCode}); guard model for the KOx payload: ${nearResult ?? "passed"}.` },
        { provenance: "ILLUSTRATIVE", text: "The KOon quote is illustrative. Jupiter returned no KOon route when checked, so no real cross-issuer price exists." },
      ],
    }),
  };

  const apiPending = JSON.parse(fixture.api.koxApiPendingFirstObserved.rawLine) as { wallclock: string; response: { reason: string } };
  const koonPre = decoded(fixture, "koonPreEventLast");
  const koonPost = decoded(fixture, "koonPostEventFirst");
  const outputRaw = BigInt(replay.route.outAmount);
  const outputUi = (Number(outputRaw) / 10 ** transitioned.decimals) * Buffer.from(transitioned.protectedState.newMultiplier).readDoubleLE(0);
  const adapterKind = replay.route.adapterKind;
  if (!isJupiterAdapterKind(adapterKind)) throw new Error(`unexpected adapter kind ${adapterKind}`);

  return {
    generatedFrom: [
      { name: "scripts/demo/fixtures/ko-corporate-action-2026-09.json", sha256: sha256(readFileSync(KO_FIXTURE_URL)) },
      { name: "apps/reference/data/local-replay-2026-09-17.json", sha256: sha256(readFileSync(REPLAY_URL)) },
      { name: `local replay record ${replay.sourceFile}`, sha256: replay.sourceSha256 },
    ],
    asset: { name: "Coca-Cola", underlying: kox.underlying, symbol: kox.symbol, issuer: kox.issuer, mint: kox.mint, decimals: transitioned.decimals },
    trade: {
      inputUsdc: (Number(replay.route.inAmount) / 1e6).toFixed(2),
      outputRaw: replay.route.outAmount,
      outputUi: outputUi.toFixed(6),
      minOutputRaw: replay.route.otherAmountThreshold,
      slippageBps: replay.route.slippageBps,
      venue: replay.route.venues.map((v) => (v.label === "Whirlpool" ? "Orca Whirlpool" : v.label)).join(" + "),
      aggregator: "Jupiter",
      routeObservedAt: replay.routeObservedAt,
      adapterKind,
      adapterName: JUPITER_ADAPTER_KIND_NAMES[adapterKind],
      transactionBytes: replaySafe.serializedTransactionBytes,
      guardWindow: { beforeSecs: Number(KO_DEMO_POLICY.beforeSecs), afterSecs: Number(KO_DEMO_POLICY.afterSecs), basis: KO_DEMO_POLICY.basis },
    },
    replay: {
      recordedAt: replay.recordedAt,
      guardProgram: replay.binaries.equityGuard.program,
      guardBinarySha256: replay.binaries.equityGuard.sha256,
      jupiterBinarySha256: replay.binaries.jupiterV6.sha256,
      whirlpoolBinarySha256: replay.binaries.whirlpool.sha256,
      outcomes: replay.results.map((r) => ({
        label: r.label,
        succeeded: r.succeeded,
        guardError: r.guardErrorName,
        failedInstruction: r.failedInstruction === null ? null : Number(r.failedInstruction),
        programsInvoked: new Set(r.invoked.map((i) => i.split("@")[0])).size,
        usdcDelta: r.usdcDelta,
        stockDelta: r.stockDelta,
        feeLamports: r.succeeded ? "n/a" : String(BigInt(r.lamportsDelta) * -1n),
      })),
    },
    divergence: {
      seconds: Number(facts.effectiveTimestampDivergenceSecs),
      kox: {
        mechanism: "Scheduled, then activated by the Solana Clock",
        pendingFirstObservedAt: facts.kox.pendingFirstObservedAt,
        apiAnnouncedAt: facts.kox.apiPendingFirstObservedAt,
        apiReason: apiPending.response.reason,
        effectiveAt: iso(facts.kox.storedEffectiveTimestamp),
        activationFirstObservedAt: facts.kox.activationFirstObservedAt,
        bytesUnchangedAtActivation: facts.kox.bytesUnchangedAtActivation,
        oldMultiplier: f64(transitioned.protectedState.multiplier),
        newMultiplier: f64(transitioned.protectedState.newMultiplier),
      },
      koon: {
        mechanism: "Immediate update: new multiplier written already active",
        lastOldObservedAt: facts.koon.lastOldStateObservedAt,
        effectiveAt: iso(facts.koon.storedEffectiveTimestamp),
        firstNewObservedAt: facts.koon.firstNewStateObservedAt,
        pendingPhaseObserved: facts.koon.pendingPhaseObserved,
        oldMultiplier: f64(koonPre.protectedState.multiplier),
        newMultiplier: f64(koonPost.protectedState.newMultiplier),
      },
      pollingSecs: POLLING_SECS,
    },
    scenarios,
  };
}
