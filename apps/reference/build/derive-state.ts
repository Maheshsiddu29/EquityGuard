/**
 * Derives the reference app's deterministic state from committed evidence.
 *
 * Every protection decision below is computed here, at build time, by the
 * existing EquityGuard code: `checkGuardOffline` (the host mirror of the
 * on-chain guard) over recorded mainnet KOx/KOon account bytes, and the
 * representation decision engine for the consent prompt. The browser never
 * computes a decision and never touches a network or a signer.
 *
 * The state-transition cases use two adjacent real KOx observations: the
 * last one before the Clock-driven activation and the first one after it.
 * The separate Sep 17 local replay is summarised on its own and never mixed
 * into those cases: it ran two days after the activation.
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
import { fromGuardResult, fromRepresentationDecision } from "../src/decision.ts";
import type { EconomicStateView, GuardWindowView, ReferenceState, ReplayCase, Scenario, ScenarioId } from "../src/model.ts";

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
  readonly localClock: { readonly slot: string; readonly unixTimestamp: string; readonly phase: number };
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

/**
 * Zero window: isolates the activation (phase) check, as `koDivergenceFacts`
 * does. Under the 15 min / 5 min demo window both adjacent observations fall
 * inside the window and would be blocked as InsideTransitionWindow.
 */
const ZERO_WINDOW: GuardWindowView = {
  beforeSecs: 0,
  afterSecs: 0,
  note: "No time window, so the check isolates the activation itself. With the 15 min / 5 min demo window, both moments would already be blocked as InsideTransitionWindow.",
};
const DEMO_WINDOW: GuardWindowView = {
  beforeSecs: Number(KO_DEMO_POLICY.beforeSecs),
  afterSecs: Number(KO_DEMO_POLICY.afterSecs),
  note: "15 min before / 5 min after a scheduled activation. Uncalibrated demo policy, not issuer-derived.",
};

function requestFrom(observation: ChainObservation, window: GuardWindowView): AssertSafeExecutionRequest {
  return {
    expected: observation.protectedState,
    expectedPhase: observation.phase as ActivationPhase,
    window: { beforeSecs: window.beforeSecs, afterSecs: window.afterSecs },
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

  // Adjacent real observations around KOx's activation T = 00:30:00Z.
  const before = decoded(fixture, "koxLastPendingBeforeT");
  const after = decoded(fixture, "koxActivatedFirstObserved");
  if (before.decimals !== after.decimals) throw new Error("KOx decimals changed between observations");
  const T = after.protectedState.newMultiplierEffectiveTimestamp;
  if (!((before.chainUnixTimestamp as bigint) < T && T <= (after.chainUnixTimestamp as bigint))) {
    throw new Error("adjacent observations do not bracket the activation");
  }

  const preparedRequest = requestFrom(before, ZERO_WINDOW);
  const safeResult = evaluate(preparedRequest, before);
  const staleResult = evaluate(preparedRequest, after);
  const refreshedResult = evaluate(requestFrom(after, ZERO_WINDOW), after);

  const S = stateView(before, "Dividend adjustment scheduled, not yet active");
  const S2 = stateView(after);
  const secsTo = (o: ChainObservation) => Number(T - (o.chainUnixTimestamp as bigint));
  const guardModel = (what: string, result: string | null) => `Guard model: ${what}: ${result ?? "passes"}.`;

  // Consent prompt: KOx inside the demo window, KOon already settled.
  const koxNear = resolveCurated("koxLastPendingBeforeT");
  const koonNear = resolveCurated("koonAtKoxLastPending");
  if (koxNear.state !== RepresentationState.TRANSITION || koonNear.state !== RepresentationState.SAFE) {
    throw new Error(`consent scenario expects KOx TRANSITION and KOon SAFE, got ${koxNear.state} / ${koonNear.state}`);
  }
  const consentGuard = evaluate(requestFrom(before, DEMO_WINDOW), before);
  const comparison = compareQuotes(
    quoteFor(koxNear, BigInt(replay.route.outAmount), "ILLUSTRATIVE", fixture.observations.koxLastPendingBeforeT.wallclock),
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

  const scenario = (id: ScenarioId, fields: Omit<Scenario, "id" | "symbol" | "issuer">): Scenario => ({ id, symbol: kox.symbol, issuer: kox.issuer, ...fields });
  const stateMoment = `KOx mint state recorded on Solana mainnet`;

  const scenarios: Record<ScenarioId, Scenario> = {
    safe: scenario("safe", {
      label: "Prepared",
      illustrative: false,
      headline: "Protected execution",
      detail: `KOx's economic state matches what this trade was prepared against, ${secsTo(before)} s before its scheduled dividend adjustment. The trade can proceed.`,
      decision: fromGuardResult(safeResult),
      authorized: S,
      current: S,
      evaluatedAt: S.chainTime,
      window: ZERO_WINDOW,
      settlement: "The guard and the swap settle together in one transaction, or not at all.",
      backing: [
        { provenance: "MAINNET_OBSERVATION", text: `${stateMoment} at slot ${S.slot}, ${secsTo(before)} s before activation.` },
        { provenance: "GUARD_MODEL", text: guardModel("authorization under S, checked at that moment", safeResult) },
      ],
    }),
    stale: scenario("stale", {
      label: "Activation",
      illustrative: false,
      headline: "Trade blocked",
      detail: "KOx changed economic state after this trade was prepared: its scheduled dividend adjustment became active. The previous authorization is stale, so EquityGuard blocks the transaction before execution.",
      decision: fromGuardResult(staleResult),
      authorized: S,
      current: S2,
      evaluatedAt: S2.chainTime,
      window: ZERO_WINDOW,
      settlement: "No tokens move: the guard fails first, so the whole transaction reverts. Only the network fee would be charged.",
      backing: [
        {
          provenance: "MAINNET_OBSERVATION",
          text: `${stateMoment} at slot ${S2.slot}, ${-secsTo(after)} s after the Solana Clock passed the activation time. The account bytes did not change; only the phase did.`,
        },
        { provenance: "GUARD_MODEL", text: guardModel("authorization under S, checked against S′", staleResult) },
      ],
    }),
    refreshed: scenario("refreshed", {
      label: "Refreshed",
      illustrative: false,
      headline: "Protected execution",
      detail: "A new protected transaction was prepared against KOx's current state. The trade can proceed.",
      decision: fromGuardResult(refreshedResult),
      authorized: S2,
      current: S2,
      evaluatedAt: S2.chainTime,
      window: ZERO_WINDOW,
      settlement: "The new authorization is bound to the current state. The guard and the swap settle together, or not at all.",
      backing: [
        { provenance: "MAINNET_OBSERVATION", text: `Same recorded KOx state as the blocked check (slot ${S2.slot}).` },
        { provenance: "GUARD_MODEL", text: guardModel("authorization re-read under S′, checked against S′", refreshedResult) },
      ],
    }),
    consent: scenario("consent", {
      label: "Issuer switch",
      illustrative: true,
      headline: "Illustrative: approval needed to switch issuer",
      detail: `Under the 15-minute demo window, KOx cannot proceed ${secsTo(before)} s before its adjustment. KOon (Ondo) had already completed its update. This shows the approval step only: no KOon route existed, and switching issuer is never automatic.`,
      decision: fromRepresentationDecision(engine.decision, consentGuard, disclosure),
      authorized: S,
      current: stateView(before, `Activation in ${secsTo(before)} s: inside the demo protection window`),
      evaluatedAt: S.chainTime,
      window: DEMO_WINDOW,
      settlement: "Illustrative only. Nothing executes, and this reference app never executes an alternative representation.",
      backing: [
        { provenance: "ILLUSTRATIVE", text: "The KOon quote is made up. Jupiter returned no KOon route when checked, so no real cross-issuer price or reroute exists." },
        { provenance: "MAINNET_OBSERVATION", text: "KOx and KOon states recorded at the same mainnet slot." },
        { provenance: "GUARD_MODEL", text: `Decision engine: ${engine.decision} (${engine.reasonCode}); guard model with the demo window: ${consentGuard ?? "passes"}.` },
      ],
    }),
  };

  const replayCase = (label: LocalReplayExcerpt["results"][number]["label"], title: string, description: string): ReplayCase => {
    const r = replay.results.find((x) => x.label === label);
    if (!r) throw new Error(`replay excerpt has no ${label} result`);
    return {
      label,
      title,
      description,
      decision: fromGuardResult(r.guardErrorName),
      succeeded: r.succeeded,
      failedInstruction: r.failedInstruction === null ? null : Number(r.failedInstruction),
      programsInvoked: new Set(r.invoked.map((i) => i.split("@")[0])).size,
      jupiterRan: r.invoked.some((i) => i.startsWith("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4@")),
      usdcDelta: r.usdcDelta,
      stockDelta: r.stockDelta,
      feeLamports: r.succeeded ? null : String(BigInt(r.lamportsDelta) * -1n),
      expectedPhase: r.expectation.expectedPhase === ActivationPhase.Activated ? "ACTIVATED" : "PENDING",
    };
  };
  const replaySafe = replay.results.find((r) => r.label === "SAFE");
  if (!replaySafe) throw new Error("replay excerpt has no SAFE result");

  const apiPending = JSON.parse(fixture.api.koxApiPendingFirstObserved.rawLine) as { wallclock: string; response: { reason: string } };
  const koonPre = decoded(fixture, "koonPreEventLast");
  const koonPost = decoded(fixture, "koonPostEventFirst");
  const adapterKind = replay.route.adapterKind;
  if (!isJupiterAdapterKind(adapterKind)) throw new Error(`unexpected adapter kind ${adapterKind}`);

  return {
    generatedFrom: [
      { name: "scripts/demo/fixtures/ko-corporate-action-2026-09.json", sha256: sha256(readFileSync(KO_FIXTURE_URL)) },
      { name: "apps/reference/data/local-replay-2026-09-17.json", sha256: sha256(readFileSync(REPLAY_URL)) },
      { name: `local replay record ${replay.sourceFile}`, sha256: replay.sourceSha256 },
    ],
    asset: { name: "Coca-Cola", underlying: kox.underlying, symbol: kox.symbol, issuer: kox.issuer, mint: kox.mint, decimals: after.decimals },
    order: { inputUsdc: (Number(replay.route.inAmount) / 1e6).toFixed(2), aggregator: "Jupiter" },
    replay: {
      recordedAt: replay.recordedAt,
      routeObservedAt: replay.routeObservedAt,
      localClock: iso(BigInt(replay.localClock.unixTimestamp)),
      localClockPhase: replay.localClock.phase === ActivationPhase.Activated ? "ACTIVATED" : "PENDING",
      inputUsdc: (Number(replay.route.inAmount) / 1e6).toFixed(2),
      outputRaw: replay.route.outAmount,
      minOutputRaw: replay.route.otherAmountThreshold,
      slippageBps: replay.route.slippageBps,
      venue: replay.route.venues.map((v) => (v.label === "Whirlpool" ? "Orca Whirlpool" : v.label)).join(" + "),
      adapterKind,
      adapterName: JUPITER_ADAPTER_KIND_NAMES[adapterKind],
      transactionBytes: replaySafe.serializedTransactionBytes,
      commitmentHex: replaySafe.suffixCommitmentHex,
      window: replay.route.window,
      guardProgram: replay.binaries.equityGuard.program,
      guardBinarySha256: replay.binaries.equityGuard.sha256,
      jupiterBinarySha256: replay.binaries.jupiterV6.sha256,
      whirlpoolBinarySha256: replay.binaries.whirlpool.sha256,
      cases: [
        replayCase("SAFE", "Guarded trade executed", "Guard built from the cloned KOx mint (already activated). The guard passed and the Jupiter swap settled in the same transaction."),
        replayCase(
          "STALE_PRE_ACTIVATION",
          "Outdated state expectation rejected",
          "Guard deliberately built with the pre-activation phase for the same, already-activated mint. Rejected at the guard; Jupiter never ran.",
        ),
        replayCase("MUTATED_SLIPPAGE", "Altered swap rejected", "Slippage in the Jupiter instruction changed after the guard was built. Rejected at the guard; Jupiter never ran."),
      ],
    },
    divergence: {
      seconds: Number(facts.effectiveTimestampDivergenceSecs),
      kox: {
        mechanism: "Scheduled, then activated by the Solana Clock",
        pendingFirstObservedAt: facts.kox.pendingFirstObservedAt,
        apiAnnouncedAt: facts.kox.apiPendingFirstObservedAt,
        apiReason: apiPending.response.reason,
        effectiveAt: iso(facts.kox.storedEffectiveTimestamp),
        lastPendingBlockTime: S.chainTime,
        firstActivatedBlockTime: S2.chainTime,
        activationFirstObservedAt: facts.kox.activationFirstObservedAt,
        bytesUnchangedAtActivation: facts.kox.bytesUnchangedAtActivation,
        oldMultiplier: f64(after.protectedState.multiplier),
        newMultiplier: f64(after.protectedState.newMultiplier),
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
