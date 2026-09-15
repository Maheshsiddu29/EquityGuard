/**
 * MAINNET_OBSERVATION replay of the September 2026 KO corporate action.
 *
 * Consumes only the curated, hash-traceable KOx/KOon observations and the
 * point-in-time Jupiter liquidity snapshot. It resolves state with the
 * product state engine and decides with the product decision engine. It has
 * no RPC, signer or transaction code: this path cannot submit anything.
 */

import { ActivationPhase, bytesEqual, phaseAt } from "@equityguard/guard-client";
import {
  compareQuotes,
  decide,
  findRepresentationBySymbol,
  mainnetObservationResult,
  resolveOndoState,
  resolveXStocksState,
  type ChainObservation,
  type EvidenceReference,
  type MainnetObservationResult,
  type NormalizedQuote,
  type QuoteAvailability,
  type QuoteComparison,
  type ResolvedRepresentationState,
  type TransitionPolicy,
} from "@equityguard/representation-state";

import { decodeObservation, loadKoFixture, loadLiquiditySnapshot, type CuratedKoFixture, type LiquiditySnapshot, type ObservationKey } from "./ko-fixtures.ts";

/**
 * DEMO policy, UNCALIBRATED: chosen to illustrate the engine on the observed
 * mechanics, not derived from issuer documentation. `immediateUpdateAfterSecs`
 * applies the post-update interval to KOon's immediate update.
 */
export const KO_DEMO_POLICY: TransitionPolicy = {
  beforeSecs: 900n,
  afterSecs: 300n,
  immediateUpdateAfterSecs: 300n,
  calibration: "UNCALIBRATED",
  basis: "M6 demo policy (15 min before / 5 min after scheduled T; 5 min after an immediate update); not issuer-calibrated",
};

/** The trade notional of the recorded liquidity snapshot (5 USDC). */
const SNAPSHOT_INPUT_RAW = 5_000_000n;

export interface ScenarioResult {
  readonly id: "A" | "B" | "C";
  readonly title: string;
  readonly evaluatedAt: { readonly preferred: string; readonly alternative: string };
  readonly result: MainnetObservationResult;
}

export interface DivergenceFacts {
  readonly koon: { readonly mechanism: "IMMEDIATE_UPDATE"; readonly storedEffectiveTimestamp: bigint; readonly lastOldStateObservedAt: string; readonly firstNewStateObservedAt: string; readonly pendingPhaseObserved: false };
  readonly kox: { readonly mechanism: "SCHEDULED_THEN_CLOCK_CROSSING"; readonly storedEffectiveTimestamp: bigint; readonly pendingFirstObservedAt: string; readonly apiPendingFirstObservedAt: string; readonly activationFirstObservedAt: string; readonly bytesUnchangedAtActivation: boolean };
  readonly effectiveTimestampDivergenceSecs: bigint;
  /** Mirrors the on-chain guard's check order; computed offline, not executed on mainnet. */
  readonly guardWouldReject: {
    readonly koonSnapshotBuiltBeforeUpdate: "MultiplierChanged" | null;
    readonly koxPendingSnapshotAfterT: "ActivationPhaseChanged" | null;
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

/** Quote pair from the liquidity snapshot; null unless BOTH routes were available. */
function quotePair(
  snapshot: LiquiditySnapshot,
  preferredSymbol: string,
  alternativeSymbol: string,
): { comparison: QuoteComparison | null; availability: QuoteAvailability } {
  const p = snapshot.quotes[preferredSymbol];
  const a = snapshot.quotes[alternativeSymbol];
  if (!p || !a) throw new Error("liquidity snapshot missing a representation");
  const availability: QuoteAvailability = {
    source: "JUPITER_MAINNET_SNAPSHOT",
    observedAt: p.observedAt,
    preferred: p.route,
    alternative: a.route,
    note: `Point-in-time Jupiter /build discovery at ${p.observedAt} for ${snapshot.inputRaw} USDC units; route availability is dynamic and was observed after the corporate action, not at the replayed moment.`,
  };
  if (p.route !== "AVAILABLE" || a.route !== "AVAILABLE" || !p.outAmountRaw || !a.outAmountRaw) {
    return { comparison: null, availability };
  }
  const quote = (q: typeof p): NormalizedQuote => {
    const rep = findRepresentationBySymbol(q.symbol);
    if (!rep) throw new Error(`${q.symbol} not in registry`);
    return {
      underlying: rep.underlying,
      issuer: rep.issuer,
      mint: rep.mint,
      inputRaw: BigInt(snapshot.inputRaw),
      outputRaw: BigInt(q.outAmountRaw ?? "0"),
      decimals: q.chainAtQuote.decimals,
      effectiveMultiplier: Uint8Array.from(Buffer.from(q.chainAtQuote.effectiveMultiplierHex, "hex")),
    };
  };
  return { comparison: compareQuotes(quote(p), quote(a), { toleranceBps: 0n }), availability };
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
  const { comparison, availability } = quotePair(snapshot, preferred.symbol, alternative.symbol);
  const decision = decide({ preferred, alternative, policy: { allowCrossIssuerReroute: true }, inputRaw: SNAPSHOT_INPUT_RAW, comparison });
  return {
    id,
    title,
    evaluatedAt: { preferred: fixture.observations[preferredKey].wallclock, alternative: fixture.observations[alternativeKey].wallclock },
    result: mainnetObservationResult({ decision, comparison, evidenceSources: evidence(fixture, snapshot, [preferredKey, alternativeKey]), quoteAvailability: availability }),
  };
}

export function replayKoScenarios(policy: TransitionPolicy = KO_DEMO_POLICY): ScenarioResult[] {
  const fixture = loadKoFixture();
  const snapshot = loadLiquiditySnapshot();
  return [
    scenario("A", "KOx inside its scheduled transition; KOon observed but unroutable", fixture, snapshot, "koxLastPendingBeforeT", "koonAtKoxLastPending", policy),
    scenario("B", "KOon just updated immediately; KOx SAFE but the quote pair is incomplete", fixture, snapshot, "koonPostEventFirst", "koxAtKoonPostEvent", policy),
    scenario("C", "Both representations SAFE after the event window", fixture, snapshot, "windowEndKOx", "windowEndKOon", policy),
  ];
}

export function koDivergenceFacts(): DivergenceFacts {
  const fixture = loadKoFixture();
  const koonPre = decoded(fixture, "koonPreEventLast");
  const koonPost = decoded(fixture, "koonPostEventFirst");
  const koxPending = decoded(fixture, "koxLastPendingBeforeT");
  const koxActivated = decoded(fixture, "koxActivatedFirstObserved");
  const apiPending = JSON.parse(fixture.api.koxApiPendingFirstObserved.rawLine) as { wallclock: string };

  // Program order: multiplier, new multiplier, timestamp; then phase for a scheduled change.
  const staleStored = !bytesEqual(koonPre.protectedState.multiplier, koonPost.protectedState.multiplier)
    ? ("MultiplierChanged" as const)
    : null;
  const koxBytesUnchanged =
    bytesEqual(koxPending.protectedState.multiplier, koxActivated.protectedState.multiplier) &&
    bytesEqual(koxPending.protectedState.newMultiplier, koxActivated.protectedState.newMultiplier) &&
    koxPending.protectedState.newMultiplierEffectiveTimestamp === koxActivated.protectedState.newMultiplierEffectiveTimestamp;
  const phaseAfterT = koxActivated.chainUnixTimestamp === null ? null : phaseAt(koxActivated.protectedState, koxActivated.chainUnixTimestamp);

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
    guardWouldReject: {
      koonSnapshotBuiltBeforeUpdate: staleStored,
      koxPendingSnapshotAfterT:
        koxBytesUnchanged && koxPending.phase === ActivationPhase.Pending && phaseAfterT === ActivationPhase.Activated ? "ActivationPhaseChanged" : null,
    },
    sources: fixture.sources,
  };
}

/** Exposed for tests: resolved states at a curated observation. */
export function resolveCurated(key: ObservationKey, policy: TransitionPolicy = KO_DEMO_POLICY): ResolvedRepresentationState {
  return resolve(loadKoFixture(), key, policy);
}

