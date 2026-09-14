/**
 * Correlates xStocks public API observations with Token-2022 chain
 * observations of the same mint. This is an evidence layer only: its outcomes
 * describe what was observed and never become routing policy by themselves.
 *
 * Polling resolution is explicit. Every derived moment is reported as the
 * first observation showing a state together with the last observation not
 * showing it: the change happened somewhere in (lastObservedBefore,
 * firstObservedAt], never "exactly at" a poll.
 */

import type { CaptureObservation, CaptureRecord } from "./capture.ts";
import { CAPTURE_CADENCE_SECS, CAPTURE_GAP_THRESHOLD_SECS, buildTimeline, qualityMetrics, type PollPoint, type QualityMetrics, type TimelineEntry } from "./timeline.ts";
import type { ChainObservation } from "./types.ts";
import {
  XStocksApiEventDetector,
  f64Hex,
  type ApiEvent,
  type EvidenceSource,
  type XStocksApiObservation,
} from "./xstocks-api.ts";

export type CorrelationOutcome =
  | "NO_PENDING_UPDATE_OBSERVED"
  | "API_PENDING_CHAIN_NOT_YET_PENDING"
  | "API_AND_CHAIN_PENDING_AGREE"
  | "API_AND_CHAIN_PENDING_CONFLICT"
  | "CHAIN_CHANGED_WITHOUT_API_PREANNOUNCEMENT"
  | "INSUFFICIENT_API_COVERAGE"
  | "API_ACTIVATION_MATCHES_CHAIN_WITHIN_RESOLUTION"
  | "API_ACTIVATION_DIFFERS_FROM_CHAIN";

/** First observation of a state, bracketed by the previous observation without it. */
export interface ObservedBoundary {
  readonly source: EvidenceSource;
  readonly firstObservedAt: string;
  readonly firstObservedMs: number;
  readonly firstObservedLine: number;
  /** Null when the state was already present in the first observation. */
  readonly lastObservedBefore: string | null;
  readonly lastObservedBeforeMs: number | null;
  /** Width of the bracket; the change time is not known more precisely. */
  readonly resolutionMs: number | null;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly previousBlockTime: bigint | null;
}

/** Bounds on (later event − earlier event), from two observation brackets. */
export interface DeltaBounds {
  /** Exclusive lower bound, in milliseconds. */
  readonly minExclusiveMs: number | null;
  /** Inclusive upper bound, in milliseconds. */
  readonly maxInclusiveMs: number;
  readonly order: "API_BEFORE_CHAIN" | "CHAIN_BEFORE_API" | "UNRESOLVED_WITHIN_POLLING";
}

export interface ApiInterval {
  readonly kind: "API_STABLE" | "API_ERROR" | "API_CAPTURE_GAP";
  readonly firstWallclock: string | null;
  readonly lastWallclock: string | null;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly observations: number;
  readonly currentMultiplier: number | null;
  readonly newMultiplier: number | null;
  readonly activationDateTimeRaw: unknown;
  readonly reason: string | null;
  readonly error: string | null;
}

export interface CorrelationEvent {
  readonly source: EvidenceSource;
  readonly wallclock: string | null;
  readonly wallclockMs: number | null;
  readonly type: string;
  readonly detail: readonly string[];
}

export interface KOxCorrelation {
  readonly outcomes: readonly CorrelationOutcome[];
  readonly derived: {
    readonly apiPendingFirstObservedAt: ObservedBoundary | null;
    readonly apiAdvertised: {
      readonly newMultiplier: number;
      readonly newMultiplierHex: string;
      readonly activationUnixMs: number | null;
      readonly activationInterpretation: string;
      readonly reason: string | null;
    } | null;
    readonly apiDistinctActivationValues: readonly string[];
    readonly chainPendingFirstObservedAt: ObservedBoundary | null;
    readonly chainPendingState: { readonly newMultiplierHex: string; readonly effectiveTimestamp: bigint } | null;
    readonly chainActivationFirstObservedAt: ObservedBoundary | null;
    readonly chainMultiplierChangeFirstObservedAt: ObservedBoundary | null;
  };
  readonly timingDeltas: {
    /** chain pending − API pending publication, as bounds. */
    readonly apiPublicationLead: DeltaBounds | null;
    /** API advertised activation − on-chain effective timestamp, exact seconds. */
    readonly advertisedMinusChainEffectiveSecs: bigint | null;
    /** Block times bracketing the observed chain activation. */
    readonly chainActivationBracketBlockTimes: { readonly lastPending: bigint | null; readonly firstActivated: bigint | null } | null;
  };
  readonly apiIntervals: readonly ApiInterval[];
  readonly chainTimeline: readonly TimelineEntry[];
  readonly crossSourceEvents: readonly CorrelationEvent[];
  readonly quality: { readonly api: QualityMetrics; readonly chain: QualityMetrics };
}

/** An API poll must exist this close before a chain change to claim "no preannouncement". */
const API_COVERAGE_MAX_LAG_MS = CAPTURE_GAP_THRESHOLD_SECS * 1000;

function decodedChain(records: readonly CaptureRecord[], mint: string): (CaptureObservation & { evidence: ChainObservation })[] {
  return records.filter(
    (r): r is CaptureObservation & { evidence: ChainObservation } => r.kind === "observation" && r.mint === mint && r.evidence.kind === "decoded",
  );
}

function ms(wallclock: string | null): number | null {
  if (wallclock === null) return null;
  const value = Date.parse(wallclock);
  return Number.isNaN(value) ? null : value;
}

function chainBoundary(
  observations: readonly (CaptureObservation & { evidence: ChainObservation })[],
  index: number,
): ObservedBoundary | null {
  const current = observations[index];
  const currentMs = current ? ms(current.wallclock) : null;
  if (!current || current.wallclock === null || currentMs === null) return null;
  const previous = index > 0 ? observations[index - 1] : undefined;
  const previousMs = previous ? ms(previous.wallclock) : null;
  return {
    source: "LIVE_CHAIN_STATE",
    firstObservedAt: current.wallclock,
    firstObservedMs: currentMs,
    firstObservedLine: current.lineNumber,
    lastObservedBefore: previous?.wallclock ?? null,
    lastObservedBeforeMs: previousMs,
    resolutionMs: previousMs === null ? null : currentMs - previousMs,
    slot: current.slot,
    blockTime: current.blockTime,
    previousBlockTime: previous?.blockTime ?? null,
  };
}

function apiBoundary(ok: readonly XStocksApiObservation[], index: number): ObservedBoundary | null {
  const current = ok[index];
  if (!current || current.wallclock === null || current.wallclockMs === null) return null;
  const previous = index > 0 ? ok[index - 1] : undefined;
  return {
    source: "LIVE_API_STATE",
    firstObservedAt: current.wallclock,
    firstObservedMs: current.wallclockMs,
    firstObservedLine: current.lineNumber,
    lastObservedBefore: previous?.wallclock ?? null,
    lastObservedBeforeMs: previous?.wallclockMs ?? null,
    resolutionMs: previous?.wallclockMs == null ? null : current.wallclockMs - previous.wallclockMs,
    slot: null,
    blockTime: null,
    previousBlockTime: null,
  };
}

/** Bounds on (chain − api) from their brackets (a0, a1] and (c0, c1]. */
export function deltaBounds(api: ObservedBoundary, chain: ObservedBoundary): DeltaBounds {
  const a1 = api.firstObservedMs;
  const c1 = chain.firstObservedMs;
  const a0 = api.lastObservedBeforeMs;
  const c0 = chain.lastObservedBeforeMs;
  const order =
    c0 !== null && c0 >= a1 ? "API_BEFORE_CHAIN" : a0 !== null && a0 >= c1 ? "CHAIN_BEFORE_API" : "UNRESOLVED_WITHIN_POLLING";
  return { minExclusiveMs: c0 === null ? null : c0 - a1, maxInclusiveMs: a0 === null ? c1 : c1 - a0, order };
}

function apiIntervals(observations: readonly XStocksApiObservation[]): ApiInterval[] {
  const intervals: ApiInterval[] = [];
  let open: { first: XStocksApiObservation; last: XStocksApiObservation; count: number; key: string } | null = null;
  let lastMs: number | null = null;
  const flush = () => {
    if (!open) return;
    const { first, last, count } = open;
    intervals.push({
      kind: first.decodeStatus === "ok" ? "API_STABLE" : "API_ERROR",
      firstWallclock: first.wallclock,
      lastWallclock: last.wallclock,
      firstLine: first.lineNumber,
      lastLine: last.lineNumber,
      observations: count,
      currentMultiplier: first.currentMultiplier,
      newMultiplier: first.newMultiplier,
      activationDateTimeRaw: first.activationDateTimeRaw,
      reason: first.reason,
      error: first.error,
    });
    open = null;
  };
  for (const o of observations) {
    if (o.wallclockMs !== null && lastMs !== null && o.wallclockMs - lastMs >= CAPTURE_GAP_THRESHOLD_SECS * 1000) {
      flush();
      intervals.push({
        kind: "API_CAPTURE_GAP", firstWallclock: new Date(lastMs).toISOString(), lastWallclock: o.wallclock,
        firstLine: o.lineNumber, lastLine: o.lineNumber, observations: 0, currentMultiplier: null, newMultiplier: null,
        activationDateTimeRaw: null, reason: null, error: `${o.wallclockMs - lastMs} ms without an API observation`,
      });
    }
    if (o.wallclockMs !== null) lastMs = o.wallclockMs;
    const key =
      o.decodeStatus === "ok"
        ? JSON.stringify([o.currentMultiplier, o.newMultiplier, o.activationDateTimeRaw, o.reason])
        : `${o.decodeStatus}:${o.error}`;
    if (open && open.key === key) {
      open.last = o;
      open.count += 1;
    } else {
      flush();
      open = { first: o, last: o, count: 1, key };
    }
  }
  flush();
  return intervals;
}

export function correlateKOx(input: {
  readonly api: readonly XStocksApiObservation[];
  readonly chain: readonly CaptureRecord[];
  readonly mint: string;
  readonly symbol: string;
}): KOxCorrelation {
  const api = [...input.api].sort((a, b) => a.lineNumber - b.lineNumber);
  const ok = api.filter((o) => o.decodeStatus === "ok");
  const chainRecords = input.chain.filter((r) => r.kind === "line-error" || r.mint === input.mint);
  const chain = decodedChain(input.chain, input.mint);

  // API derivations.
  const apiPendingIndex = ok.findIndex((o) => o.hasPendingUpdate === true);
  const apiPending = apiPendingIndex >= 0 ? ok[apiPendingIndex] : undefined;
  const apiPendingFirstObservedAt = apiPendingIndex >= 0 ? apiBoundary(ok, apiPendingIndex) : null;
  const apiAdvertised =
    apiPending && apiPending.newMultiplier !== null
      ? {
          newMultiplier: apiPending.newMultiplier,
          newMultiplierHex: f64Hex(apiPending.newMultiplier),
          activationUnixMs: apiPending.activationTime?.unixMs ?? null,
          activationInterpretation: apiPending.activationTime?.interpretation ?? "none",
          reason: apiPending.reason,
        }
      : null;
  const apiDistinctActivationValues = [...new Set(ok.filter((o) => o.hasPendingUpdate).map((o) => JSON.stringify(o.activationDateTimeRaw)))];

  // Chain derivations.
  const pendingIndex = chain.findIndex((o) => o.evidence.hasScheduledChange && o.evidence.phase === 0);
  const chainPendingFirstObservedAt = pendingIndex >= 0 ? chainBoundary(chain, pendingIndex) : null;
  const pendingObs = pendingIndex >= 0 ? chain[pendingIndex] : undefined;
  const chainPendingState = pendingObs
    ? {
        newMultiplierHex: Buffer.from(pendingObs.evidence.protectedState.newMultiplier).toString("hex"),
        effectiveTimestamp: pendingObs.evidence.protectedState.newMultiplierEffectiveTimestamp,
      }
    : null;
  const activationIndex = chain.findIndex((o, i) => i > 0 && chain[i - 1]?.evidence.phase === 0 && o.evidence.phase === 1);
  const chainActivationFirstObservedAt = activationIndex >= 0 ? chainBoundary(chain, activationIndex) : null;
  const multiplierChangeIndex = chain.findIndex(
    (o, i) => i > 0 && Buffer.compare(Buffer.from(chain[i - 1]?.evidence.protectedState.multiplier ?? []), Buffer.from(o.evidence.protectedState.multiplier)) !== 0,
  );
  const chainMultiplierChangeFirstObservedAt = multiplierChangeIndex >= 0 ? chainBoundary(chain, multiplierChangeIndex) : null;

  // Outcomes.
  const outcomes: CorrelationOutcome[] = [];
  const chainChange = [chainPendingFirstObservedAt, chainMultiplierChangeFirstObservedAt, chainActivationFirstObservedAt]
    .filter((b): b is ObservedBoundary => b !== null)
    .sort((a, b) => a.firstObservedMs - b.firstObservedMs)[0];

  if (!apiPendingFirstObservedAt && !chainChange) outcomes.push("NO_PENDING_UPDATE_OBSERVED");

  if (apiPendingFirstObservedAt) {
    const chainAtPublication = chain.filter((o) => (ms(o.wallclock) ?? Number.POSITIVE_INFINITY) <= apiPendingFirstObservedAt.firstObservedMs).at(-1);
    if (chainAtPublication && !(chainAtPublication.evidence.hasScheduledChange && chainAtPublication.evidence.phase === 0)) {
      outcomes.push("API_PENDING_CHAIN_NOT_YET_PENDING");
    }
  }

  if (apiAdvertised && chainPendingState) {
    const multiplierAgrees = apiAdvertised.newMultiplierHex === chainPendingState.newMultiplierHex;
    const activationAgrees =
      apiAdvertised.activationUnixMs !== null && BigInt(apiAdvertised.activationUnixMs) === chainPendingState.effectiveTimestamp * 1000n;
    outcomes.push(multiplierAgrees && activationAgrees ? "API_AND_CHAIN_PENDING_AGREE" : "API_AND_CHAIN_PENDING_CONFLICT");
  }

  if (chainChange) {
    const announcedBefore = ok.some((o) => o.hasPendingUpdate && o.wallclockMs !== null && o.wallclockMs <= chainChange.firstObservedMs);
    if (!announcedBefore) {
      const coveredBefore = api.some(
        (o) => o.wallclockMs !== null && o.wallclockMs <= chainChange.firstObservedMs && chainChange.firstObservedMs - o.wallclockMs <= API_COVERAGE_MAX_LAG_MS,
      );
      outcomes.push(coveredBefore ? "CHAIN_CHANGED_WITHOUT_API_PREANNOUNCEMENT" : "INSUFFICIENT_API_COVERAGE");
    }
  }

  let advertisedMinusChainEffectiveSecs: bigint | null = null;
  let bracket: { lastPending: bigint | null; firstActivated: bigint | null } | null = null;
  if (apiAdvertised?.activationUnixMs != null && chainPendingState) {
    const advertisedSecs = BigInt(Math.floor(apiAdvertised.activationUnixMs / 1000));
    advertisedMinusChainEffectiveSecs = advertisedSecs - chainPendingState.effectiveTimestamp;
    bracket = chainActivationFirstObservedAt
      ? { lastPending: chainActivationFirstObservedAt.previousBlockTime, firstActivated: chainActivationFirstObservedAt.blockTime }
      : null;
    // Resolution: the observed activation bracket when available, otherwise one capture interval.
    const resolutionSecs =
      bracket?.lastPending != null && bracket.firstActivated != null ? bracket.firstActivated - bracket.lastPending : BigInt(CAPTURE_CADENCE_SECS);
    const delta = advertisedMinusChainEffectiveSecs < 0n ? -advertisedMinusChainEffectiveSecs : advertisedMinusChainEffectiveSecs;
    outcomes.push(delta <= resolutionSecs ? "API_ACTIVATION_MATCHES_CHAIN_WITHIN_RESOLUTION" : "API_ACTIVATION_DIFFERS_FROM_CHAIN");
  }

  // Cross-source events, chronological by wallclock; ties keep API before chain.
  const detector = new XStocksApiEventDetector();
  const apiEvents: ApiEvent[] = api.flatMap((o) => detector.push(o));
  const chainTimeline = buildTimeline(chainRecords, { symbols: new Set([input.symbol]) });
  const crossSourceEvents: CorrelationEvent[] = [
    ...apiEvents.map((e) => ({ source: "LIVE_API_STATE" as const, wallclock: e.wallclock, wallclockMs: e.current.wallclockMs, type: e.type, detail: e.detail })),
    ...chainTimeline.entries
      .filter((e) => e.entry === "STATE_CHANGE" || e.entry === "DECODE_ERROR" || e.entry === "CAPTURE_GAP")
      .map((e) => {
        const wallclock = e.entry === "STATE_CHANGE" ? e.wallclock : e.entry === "CAPTURE_GAP" ? e.toWallclock : e.firstWallclock;
        const detail = e.entry === "STATE_CHANGE" ? [...e.events, ...e.changedFields] : e.entry === "CAPTURE_GAP" ? [`${e.wallclockGapMs} ms gap`] : [e.code];
        return { source: "LIVE_CHAIN_STATE" as const, wallclock, wallclockMs: ms(wallclock), type: `CHAIN_${e.entry}`, detail };
      }),
  ].sort((a, b) => (a.wallclockMs ?? 0) - (b.wallclockMs ?? 0) || (a.source === b.source ? 0 : a.source === "LIVE_API_STATE" ? -1 : 1));

  const apiPolls: PollPoint[] = api
    .filter((o): o is XStocksApiObservation & { wallclock: string; wallclockMs: number } => o.wallclock !== null && o.wallclockMs !== null)
    .filter((o) => o.decodeStatus === "ok")
    .map((o) => ({ line: o.lineNumber, wallclock: o.wallclock, ms: o.wallclockMs, slot: null, blockTime: null }));
  const apiErrors = api.filter((o) => o.decodeStatus !== "ok").length;
  let apiGaps = 0;
  for (let i = 1; i < apiPolls.length; i += 1) {
    if ((apiPolls[i]?.ms ?? 0) - (apiPolls[i - 1]?.ms ?? 0) >= CAPTURE_GAP_THRESHOLD_SECS * 1000) apiGaps += 1;
  }

  return {
    outcomes,
    derived: {
      apiPendingFirstObservedAt,
      apiAdvertised,
      apiDistinctActivationValues,
      chainPendingFirstObservedAt,
      chainPendingState,
      chainActivationFirstObservedAt,
      chainMultiplierChangeFirstObservedAt,
    },
    timingDeltas: {
      apiPublicationLead: apiPendingFirstObservedAt && chainPendingFirstObservedAt ? deltaBounds(apiPendingFirstObservedAt, chainPendingFirstObservedAt) : null,
      advertisedMinusChainEffectiveSecs,
      chainActivationBracketBlockTimes: bracket,
    },
    apiIntervals: apiIntervals(api),
    chainTimeline: chainTimeline.entries,
    crossSourceEvents,
    quality: {
      api: qualityMetrics(apiPolls, api.filter((o) => o.wallclockMs !== null).length, apiErrors, apiGaps),
      chain: chainTimeline.bySymbol[input.symbol] ?? chainTimeline.overall,
    },
  };
}
