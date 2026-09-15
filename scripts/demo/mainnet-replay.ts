/**
 * MAINNET_OBSERVATION replay of the September 2026 KO corporate action.
 *
 * Consumes only the curated, hash-traceable KOx/KOon observations and the
 * point-in-time Jupiter liquidity snapshot. It resolves state with the
 * product state engine, decides with the product decision engine and
 * evaluates execution eligibility against the recorded routes. It has
 * no RPC, signer or transaction code: this path cannot submit anything.
 */

import { ActivationPhase, bytesEqual, checkGuardOffline, type EquityGuardErrorName, type ProtectionWindow } from "@equityguard/guard-client";
import {
  compareQuotes,
  decideExecution,
  economicStateMismatches,
  economicStateOf,
  findRepresentationBySymbol,
  mainnetObservationResult,
  resolveOndoState,
  resolveXStocksState,
  routeIdentity,
  type ChainObservation,
  type EconomicState,
  type EvidenceReference,
  type MainnetObservationResult,
  type NormalizedQuote,
  type QuoteAvailability,
  type QuoteComparison,
  type ResolvedRepresentationState,
  type RouteObservation,
  type TransitionPolicy,
} from "@equityguard/representation-state";

import { decodeObservation, loadKoFixture, loadLiquiditySnapshot, type CuratedKoFixture, type LiquiditySnapshot, type ObservationKey } from "./ko-fixtures.ts";

/**
 * DEMO policy, UNCALIBRATED: chosen to illustrate the engine on the observed
 * mechanics, not derived from issuer documentation. It applies to scheduled
 * changes only; an immediate update has no time window.
 */
export const KO_DEMO_POLICY: TransitionPolicy = {
  beforeSecs: 900n,
  afterSecs: 300n,
  calibration: "UNCALIBRATED",
  basis: "demo policy: 15 min before / 5 min after a scheduled T; immediate updates have no window; not issuer-calibrated",
};

/**
 * DEMO reroute policy for the replay: the hard one-sided additional-cost bound any comparison must
 * meet before a reroute could even be offered for consent. No replay scenario
 * has a comparison (Ondo had no route), and no consent is ever given.
 */
export const KO_REPLAY_REROUTE_POLICY = { maxAdditionalCostBps: 50n } as const;

const windowOf = (policy: TransitionPolicy): ProtectionWindow => ({ beforeSecs: Number(policy.beforeSecs), afterSecs: Number(policy.afterSecs) });

/** The trade notional of the recorded liquidity snapshot (5 USDC). */
const SNAPSHOT_INPUT_RAW = 5_000_000n;

export interface ScenarioResult {
  readonly id: "A" | "B" | "C";
  readonly title: string;
  readonly evaluatedAt: { readonly preferred: string; readonly alternative: string };
  /** State decision and execution eligibility, kept as separate fields. Never submitted. */
  readonly result: MainnetObservationResult;
}

/** A guard payload built from one recorded state and evaluated against a later one, offline. */
export interface SnapshotCheck {
  readonly builtFrom: string;
  readonly evaluatedAgainst: string;
  readonly economicStateMismatches: readonly string[];
  readonly window: ProtectionWindow;
  readonly guardResult: EquityGuardErrorName | null;
}

export interface DivergenceFacts {
  readonly koon: { readonly mechanism: "IMMEDIATE_UPDATE"; readonly storedEffectiveTimestamp: bigint; readonly lastOldStateObservedAt: string; readonly firstNewStateObservedAt: string; readonly pendingPhaseObserved: false };
  readonly kox: { readonly mechanism: "SCHEDULED_THEN_CLOCK_CROSSING"; readonly storedEffectiveTimestamp: bigint; readonly pendingFirstObservedAt: string; readonly apiPendingFirstObservedAt: string; readonly activationFirstObservedAt: string; readonly bytesUnchangedAtActivation: boolean };
  readonly effectiveTimestampDivergenceSecs: bigint;
  /**
   * Immediate update: the risk is a payload built from the old state, not the
   * new state. Mirrors the on-chain guard's check order; computed offline, not
   * executed on mainnet.
   */
  readonly koonImmediateUpdate: {
    readonly staleSnapshot: SnapshotCheck;
    readonly freshSnapshot: SnapshotCheck & { readonly state: string | null };
  };
  /**
   * Scheduled update: identical account bytes, but the clock crossed T, so
   * the pre-T payload's phase is stale. With the demo window the landing is
   * still inside the window; a zero window isolates the phase check.
   */
  readonly koxClockCrossing: {
    readonly pendingSnapshotDemoWindow: SnapshotCheck;
    readonly pendingSnapshotZeroWindow: SnapshotCheck;
    readonly freshActivatedSnapshotZeroWindow: SnapshotCheck;
  };
  readonly sources: CuratedKoFixture["sources"];
}

function decoded(fixture: CuratedKoFixture, key: ObservationKey): ChainObservation {
  const evidence = decodeObservation(fixture.observations[key]);
  if (evidence.kind !== "decoded") throw new Error(`curated observation ${key} did not decode: ${evidence.code}`);
  return evidence;
}

function resolve(fixture: CuratedKoFixture, key: ObservationKey, policy: TransitionPolicy): ResolvedRepresentationState {
  const observation = fixture.observations[key];
  const representation = findRepresentationBySymbol(observation.symbol);
  if (!representation) throw new Error(`${observation.symbol} not in registry`);
  const evidence = decodeObservation(observation);
  return representation.issuer === "xStocks"
    ? resolveXStocksState(representation, evidence, policy)
    : // No Ondo API evidence was observed: chain-only.
      resolveOndoState(representation, { chain: evidence, api: null }, policy);
}

/**
 * Route observations from the liquidity snapshot, with quotes normalized
 * against the replayed states. A recorded quote is usable only when its
 * recorded chain state (decimals, phase, effective multiplier) matches the
 * replayed state: a quote observed against another state is not usable for
 * this one. The comparison exists only when both quotes are usable.
 */
function routesFromSnapshot(
  snapshot: LiquiditySnapshot,
  preferred: ResolvedRepresentationState,
  alternative: ResolvedRepresentationState,
): { routes: { preferred: RouteObservation; alternative: RouteObservation }; comparison: QuoteComparison | null; availability: QuoteAvailability } {
  const p = snapshot.quotes[preferred.symbol];
  const a = snapshot.quotes[alternative.symbol];
  if (!p || !a) throw new Error("liquidity snapshot missing a representation");
  const availability: QuoteAvailability = {
    source: "JUPITER_MAINNET_SNAPSHOT",
    observedAt: p.observedAt,
    preferred: p.route,
    alternative: a.route,
    note: `Point-in-time Jupiter /build discovery at ${p.observedAt} for ${snapshot.inputRaw} USDC units; route availability is dynamic and was observed after the corporate action, not at the replayed moment.`,
  };
  const route = (q: typeof p, resolved: ResolvedRepresentationState): RouteObservation => {
    const base = { mint: resolved.mint, status: q.route, source: `JUPITER_MAINNET_SNAPSHOT@${q.observedAt}` };
    if (q.route !== "AVAILABLE" || !q.outAmountRaw) return { ...base, quote: null, detail: q.error };
    const state = economicStateOf(resolved.chainObservation);
    const effectiveHex = state?.phase === ActivationPhase.Activated ? state.newMultiplierHex : state?.multiplierHex;
    const recordedPhase = state?.phase === ActivationPhase.Activated ? "activated" : "pending";
    if (!state || q.chainAtQuote.decimals !== state.decimals || q.chainAtQuote.effectiveMultiplierHex !== effectiveHex || q.chainAtQuote.phase !== recordedPhase) {
      return { ...base, quote: null, detail: "recorded quote was observed against a different chain state than the replayed one" };
    }
    // Jupiter /build returned no route id: the identity is derived from the recorded route plan.
    const route = routeIdentity(
      "JUPITER_MAINNET_SNAPSHOT",
      q.venues.map((v) => ({ venue: v.label ?? "unknown", poolId: v.ammKey ?? null, inputMint: snapshot.inputMint, outputMint: resolved.mint, percent: v.percent ?? 100 })),
    );
    const quote: NormalizedQuote = {
      underlying: resolved.underlying,
      issuer: resolved.issuer,
      inputMint: snapshot.inputMint,
      mint: resolved.mint,
      inputRaw: BigInt(snapshot.inputRaw),
      outputRaw: BigInt(q.outAmountRaw),
      minOutputRaw: null,
      route,
      quotedAt: q.observedAt,
      contextSlot: q.chainAtQuote.slot === null ? null : BigInt(q.chainAtQuote.slot),
      state,
    };
    return { ...base, quote, detail: null };
  };
  const routes = { preferred: route(p, preferred), alternative: route(a, alternative) };
  const comparison = routes.preferred.quote && routes.alternative.quote ? compareQuotes(routes.preferred.quote, routes.alternative.quote) : null;
  return { routes, comparison, availability };
}

function evidence(fixture: CuratedKoFixture, snapshot: LiquiditySnapshot, keys: readonly ObservationKey[]): EvidenceReference[] {
  return [
    ...keys.map((key): EvidenceReference => {
      const o = fixture.observations[key];
      return { kind: "LIVE_CHAIN_STATE", description: `${o.symbol} mint at slot ${o.slot} (${o.sourceFile} line ${o.lineNumber})`, sha256: o.sourceSha256, observedAt: o.wallclock };
    }),
    { kind: "JUPITER_ROUTE_DISCOVERY", description: `read-only route discovery (${snapshot.sourceFile})`, sha256: snapshot.sourceSha256, observedAt: snapshot.quotes.KOx?.observedAt ?? null },
  ];
}

function scenario(
  id: ScenarioResult["id"],
  title: string,
  fixture: CuratedKoFixture,
  snapshot: LiquiditySnapshot,
  preferredKey: ObservationKey,
  alternativeKey: ObservationKey,
  policy: TransitionPolicy,
): ScenarioResult {
  const preferred = resolve(fixture, preferredKey, policy);
  const alternative = resolve(fixture, alternativeKey, policy);
  const { routes, comparison, availability } = routesFromSnapshot(snapshot, preferred, alternative);
  // Observation only: no consent exists, so a reroute could at most reach REQUIRES_CONSENT.
  const decision = decideExecution({
    preferred,
    alternative,
    reroutePolicy: KO_REPLAY_REROUTE_POLICY,
    inputRaw: SNAPSHOT_INPUT_RAW,
    comparison,
    routes,
    consent: null,
    currentSlot: BigInt(fixture.observations[preferredKey].slot),
  });
  return {
    id,
    title,
    evaluatedAt: { preferred: fixture.observations[preferredKey].wallclock, alternative: fixture.observations[alternativeKey].wallclock },
    result: mainnetObservationResult({ decision, evidenceSources: evidence(fixture, snapshot, [preferredKey, alternativeKey]), quoteAvailability: availability }),
  };
}

export function replayKoScenarios(policy: TransitionPolicy = KO_DEMO_POLICY): ScenarioResult[] {
  const fixture = loadKoFixture();
  const snapshot = loadLiquiditySnapshot();
  return [
    scenario("A", "KOx inside its scheduled transition; KOon observed but unroutable", fixture, snapshot, "koxLastPendingBeforeT", "koonAtKoxLastPending", policy),
    scenario("B", "Fresh KOon state right after its immediate update: SAFE, but KOon had no route", fixture, snapshot, "koonPostEventFirst", "koxAtKoonPostEvent", policy),
    scenario("C", "Both representations SAFE after the event window", fixture, snapshot, "windowEndKOx", "windowEndKOon", policy),
  ];
}

function snapshotCheck(fixture: CuratedKoFixture, builtFrom: ObservationKey, evaluatedAgainst: ObservationKey, window: ProtectionWindow): SnapshotCheck {
  const built = decoded(fixture, builtFrom);
  const live = decoded(fixture, evaluatedAgainst);
  const builtState = economicStateOf(built) as EconomicState;
  const liveState = economicStateOf(live) as EconomicState;
  if (built.phase === null || live.chainUnixTimestamp === null) throw new Error("curated observations must carry chain time");
  return {
    builtFrom,
    evaluatedAgainst,
    economicStateMismatches: economicStateMismatches(builtState, liveState),
    window,
    guardResult: checkGuardOffline({ expected: built.protectedState, expectedPhase: built.phase, window }, live.protectedState, live.chainUnixTimestamp),
  };
}

export function koDivergenceFacts(policy: TransitionPolicy = KO_DEMO_POLICY): DivergenceFacts {
  const fixture = loadKoFixture();
  const koonPost = decoded(fixture, "koonPostEventFirst");
  const koxPending = decoded(fixture, "koxLastPendingBeforeT");
  const koxActivated = decoded(fixture, "koxActivatedFirstObserved");
  const apiPending = JSON.parse(fixture.api.koxApiPendingFirstObserved.rawLine) as { wallclock: string };
  const demoWindow = windowOf(policy);
  const zeroWindow: ProtectionWindow = { beforeSecs: 0, afterSecs: 0 };

  const koxBytesUnchanged =
    bytesEqual(koxPending.protectedState.multiplier, koxActivated.protectedState.multiplier) &&
    bytesEqual(koxPending.protectedState.newMultiplier, koxActivated.protectedState.newMultiplier) &&
    koxPending.protectedState.newMultiplierEffectiveTimestamp === koxActivated.protectedState.newMultiplierEffectiveTimestamp;

  return {
    koon: {
      mechanism: "IMMEDIATE_UPDATE",
      storedEffectiveTimestamp: koonPost.protectedState.newMultiplierEffectiveTimestamp,
      lastOldStateObservedAt: fixture.observations.koonPreEventLast.wallclock,
      firstNewStateObservedAt: fixture.observations.koonPostEventFirst.wallclock,
      pendingPhaseObserved: false,
    },
    kox: {
      mechanism: "SCHEDULED_THEN_CLOCK_CROSSING",
      storedEffectiveTimestamp: koxActivated.protectedState.newMultiplierEffectiveTimestamp,
      pendingFirstObservedAt: fixture.observations.koxPendingFirstObserved.wallclock,
      apiPendingFirstObservedAt: apiPending.wallclock,
      activationFirstObservedAt: fixture.observations.koxActivatedFirstObserved.wallclock,
      bytesUnchangedAtActivation: koxBytesUnchanged,
    },
    effectiveTimestampDivergenceSecs:
      koxActivated.protectedState.newMultiplierEffectiveTimestamp - koonPost.protectedState.newMultiplierEffectiveTimestamp,
    koonImmediateUpdate: {
      staleSnapshot: snapshotCheck(fixture, "koonPreEventLast", "koonPostEventFirst", demoWindow),
      freshSnapshot: { ...snapshotCheck(fixture, "koonPostEventFirst", "koonPostEventFirst", demoWindow), state: resolve(fixture, "koonPostEventFirst", policy).state },
    },
    koxClockCrossing: {
      pendingSnapshotDemoWindow: snapshotCheck(fixture, "koxLastPendingBeforeT", "koxActivatedFirstObserved", demoWindow),
      pendingSnapshotZeroWindow: snapshotCheck(fixture, "koxLastPendingBeforeT", "koxActivatedFirstObserved", zeroWindow),
      freshActivatedSnapshotZeroWindow: snapshotCheck(fixture, "koxActivatedFirstObserved", "koxActivatedFirstObserved", zeroWindow),
    },
    sources: fixture.sources,
  };
}

/** Exposed for tests: resolved states at a curated observation. */
export function resolveCurated(key: ObservationKey, policy: TransitionPolicy = KO_DEMO_POLICY): ResolvedRepresentationState {
  return resolve(loadKoFixture(), key, policy);
}

