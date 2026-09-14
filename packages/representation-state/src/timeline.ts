/**
 * Deterministic observation timeline and evidence-quality metrics over
 * decoded capture records.
 *
 * Pure: time comes only from captured wallclock, slot and block time, never
 * the current clock, so the same input always yields the same timeline.
 * Stable periods are compressed into intervals. Changes, decode errors and
 * capture gaps are emitted in full, and an interval never spans a gap.
 */

import type { CaptureObservation, CaptureRecord } from "./capture.ts";
import { ObservationEventDetector, type ObservationEventType } from "./events.ts";
import type { ChainObservation } from "./types.ts";

/** Configured cadence of the capture recorder. */
export const CAPTURE_CADENCE_SECS = 30;
/** Consecutive observations this far apart (or more) are reported as a gap. */
export const CAPTURE_GAP_THRESHOLD_SECS = 60;

/**
 * Evidence-quality thresholds, applied in order:
 * - GOOD: ≥ 2 polls, coverage ≥ 98.00 %, largest wallclock gap ≤ 90 s, 0 decode errors.
 * - DEGRADED: ≥ 2 polls, coverage ≥ 90.00 %, largest wallclock gap ≤ 300 s.
 * - INSUFFICIENT: anything else.
 */
export const QUALITY_THRESHOLDS = {
  good: { minCoverageBps: 9_800, maxWallclockGapMs: 90_000, maxDecodeErrors: 0 },
  degraded: { minCoverageBps: 9_000, maxWallclockGapMs: 300_000 },
} as const;

export type QualityStatus = "GOOD" | "DEGRADED" | "INSUFFICIENT";

export interface StateFields {
  readonly decimals: number;
  readonly multiplierHex: string;
  /** Shortest round-trip decimal of the stored f64; display only. */
  readonly multiplierValue: string;
  readonly newMultiplierHex: string;
  readonly newMultiplierValue: string;
  readonly effectiveTimestamp: bigint;
  readonly phase: "pending" | "activated" | null;
  readonly paused: boolean | null;
}

interface Identity {
  readonly issuer: string | null;
  readonly symbol: string | null;
  readonly mint: string | null;
}

export type TimelineEntry =
  | (Identity & {
      readonly entry: "STABLE_INTERVAL";
      readonly firstWallclock: string | null;
      readonly lastWallclock: string | null;
      readonly firstSlot: bigint | null;
      readonly lastSlot: bigint | null;
      readonly firstBlockTime: bigint | null;
      readonly lastBlockTime: bigint | null;
      readonly firstLine: number;
      readonly lastLine: number;
      readonly observations: number;
      readonly stateChanges: 0;
      readonly decodeStatus: "decoded";
      readonly state: StateFields;
    })
  | (Identity & {
      readonly entry: "STATE_CHANGE";
      readonly wallclock: string | null;
      readonly slot: bigint | null;
      readonly blockTime: bigint | null;
      readonly line: number;
      readonly events: readonly ObservationEventType[];
      readonly changedFields: readonly string[];
      readonly decodeStatus: "decoded";
      readonly previous: StateFields;
      readonly current: StateFields;
    })
  | (Identity & {
      readonly entry: "DECODE_ERROR";
      readonly code: string;
      readonly message: string;
      readonly firstWallclock: string | null;
      readonly lastWallclock: string | null;
      readonly firstSlot: bigint | null;
      readonly lastSlot: bigint | null;
      readonly firstLine: number;
      readonly lastLine: number;
      readonly occurrences: number;
    })
  | (Identity & {
      readonly entry: "CAPTURE_GAP";
      readonly fromWallclock: string;
      readonly toWallclock: string;
      readonly wallclockGapMs: number;
      readonly fromSlot: bigint | null;
      readonly toSlot: bigint | null;
      readonly blockTimeGapSecs: bigint | null;
      readonly fromLine: number;
      readonly toLine: number;
    })
  | (Identity & {
      readonly entry: "OBSERVATION";
      readonly wallclock: string | null;
      readonly slot: bigint | null;
      readonly blockTime: bigint | null;
      readonly line: number;
      readonly decodeStatus: "decoded" | "decode-error";
      readonly state: StateFields | null;
      readonly error: string | null;
    });

export interface QualityMetrics {
  readonly firstWallclock: string | null;
  readonly lastWallclock: string | null;
  readonly firstSlot: bigint | null;
  readonly lastSlot: bigint | null;
  /** All poll lines in the input with a parseable wallclock, whatever they contain. */
  readonly totalPolls: number;
  readonly expectedPolls: number;
  /** Polls in which this scope (symbol, or any selected symbol) was observed. */
  readonly observedPolls: number;
  readonly largestWallclockGapMs: number;
  readonly largestBlockTimeGapSecs: bigint | null;
  /** min(100 %, observed / expected), in basis points, integer arithmetic. */
  readonly coverageBps: number;
  readonly coveragePercent: string;
  readonly decodeErrors: number;
  readonly gaps: number;
  readonly status: QualityStatus;
}

export interface TimelineResult {
  readonly entries: readonly TimelineEntry[];
  /** Metrics across all polls that contain any selected symbol. */
  readonly overall: QualityMetrics;
  readonly bySymbol: Readonly<Record<string, QualityMetrics>>;
}

export interface TimelineOptions {
  /** Symbols to include; all when omitted. */
  readonly symbols?: ReadonlySet<string>;
  /** Emit an OBSERVATION entry for every record. */
  readonly verbose?: boolean;
}

const KIND_RANK: Record<TimelineEntry["entry"], number> = {
  CAPTURE_GAP: 0,
  DECODE_ERROR: 1,
  STATE_CHANGE: 2,
  STABLE_INTERVAL: 3,
  OBSERVATION: 4,
};

function stateFields(evidence: ChainObservation): StateFields {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  const value = (bytes: Uint8Array) =>
    String(new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true));
  return {
    decimals: evidence.decimals,
    multiplierHex: hex(evidence.protectedState.multiplier),
    multiplierValue: value(evidence.protectedState.multiplier),
    newMultiplierHex: hex(evidence.protectedState.newMultiplier),
    newMultiplierValue: value(evidence.protectedState.newMultiplier),
    effectiveTimestamp: evidence.protectedState.newMultiplierEffectiveTimestamp,
    phase: evidence.phase === null ? null : evidence.phase === 0 ? "pending" : "activated",
    paused: evidence.paused,
  };
}

function wallclockMs(record: { readonly wallclock: string | null }): number | null {
  if (record.wallclock === null) return null;
  const ms = Date.parse(record.wallclock);
  return Number.isNaN(ms) ? null : ms;
}

interface PollPoint {
  readonly line: number;
  readonly wallclock: string;
  readonly ms: number;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
}

interface OpenInterval {
  first: CaptureObservation;
  last: CaptureObservation;
  observations: number;
  state: StateFields;
}

interface OpenErrorRun {
  first: CaptureObservation;
  last: CaptureObservation;
  code: string;
  message: string;
  occurrences: number;
}

interface SymbolTrack {
  interval: OpenInterval | null;
  errors: OpenErrorRun | null;
  lastPoint: PollPoint | null;
  lastDecoded: StateFields | null;
  polls: PollPoint[];
  decodeErrors: number;
  gaps: number;
}

export function buildTimeline(records: Iterable<CaptureRecord>, options: TimelineOptions = {}): TimelineResult {
  const entries: { key: [number, number, string]; entry: TimelineEntry }[] = [];
  const push = (line: number, entry: TimelineEntry) =>
    entries.push({ key: [line, KIND_RANK[entry.entry], entry.symbol ?? ""], entry });
  const detector = new ObservationEventDetector();
  const tracks = new Map<string, SymbolTrack & Identity>();
  const overallPolls = new Map<number, PollPoint>();
  const allPollLines = new Set<number>();
  let lineErrors = 0;

  const closeInterval = (track: SymbolTrack & Identity) => {
    const i = track.interval;
    if (!i) return;
    push(i.first.lineNumber, {
      entry: "STABLE_INTERVAL",
      issuer: track.issuer,
      symbol: track.symbol,
      mint: track.mint,
      firstWallclock: i.first.wallclock,
      lastWallclock: i.last.wallclock,
      firstSlot: i.first.slot,
      lastSlot: i.last.slot,
      firstBlockTime: i.first.blockTime,
      lastBlockTime: i.last.blockTime,
      firstLine: i.first.lineNumber,
      lastLine: i.last.lineNumber,
      observations: i.observations,
      stateChanges: 0,
      decodeStatus: "decoded",
      state: i.state,
    });
    track.interval = null;
  };
  const closeErrors = (track: SymbolTrack & Identity) => {
    const run = track.errors;
    if (!run) return;
    push(run.first.lineNumber, {
      entry: "DECODE_ERROR",
      issuer: track.issuer,
      symbol: track.symbol,
      mint: track.mint,
      code: run.code,
      message: run.message,
      firstWallclock: run.first.wallclock,
      lastWallclock: run.last.wallclock,
      firstSlot: run.first.slot,
      lastSlot: run.last.slot,
      firstLine: run.first.lineNumber,
      lastLine: run.last.lineNumber,
      occurrences: run.occurrences,
    });
    track.errors = null;
  };

  for (const record of records) {
    if (record.kind === "line-error") {
      lineErrors += 1;
      push(record.lineNumber, {
        entry: "DECODE_ERROR",
        issuer: null,
        symbol: null,
        mint: null,
        code: record.code,
        message: record.message,
        firstWallclock: null,
        lastWallclock: null,
        firstSlot: null,
        lastSlot: null,
        firstLine: record.lineNumber,
        lastLine: record.lineNumber,
        occurrences: 1,
      });
      continue;
    }
    if (wallclockMs(record) !== null) allPollLines.add(record.lineNumber);
    const symbol = record.symbol ?? record.mint;
    if (options.symbols && !options.symbols.has(symbol)) continue;

    let track = tracks.get(record.mint);
    if (!track) {
      track = {
        issuer: record.issuer,
        symbol,
        mint: record.mint,
        interval: null,
        errors: null,
        lastPoint: null,
        lastDecoded: null,
        polls: [],
        decodeErrors: 0,
        gaps: 0,
      };
      tracks.set(record.mint, track);
    }

    // Change detection keeps its own state across gaps and errors.
    const events = detector.push(record).filter((e) => e.type !== "DECODE_ERROR");

    const ms = wallclockMs(record);
    if (ms !== null && record.wallclock !== null) {
      const point: PollPoint = { line: record.lineNumber, wallclock: record.wallclock, ms, slot: record.slot, blockTime: record.blockTime };
      const previous = track.lastPoint;
      if (previous && ms - previous.ms >= CAPTURE_GAP_THRESHOLD_SECS * 1000) {
        closeInterval(track);
        closeErrors(track);
        track.gaps += 1;
        push(record.lineNumber, {
          entry: "CAPTURE_GAP",
          issuer: track.issuer,
          symbol: track.symbol,
          mint: track.mint,
          fromWallclock: previous.wallclock,
          toWallclock: point.wallclock,
          wallclockGapMs: ms - previous.ms,
          fromSlot: previous.slot,
          toSlot: point.slot,
          blockTimeGapSecs: previous.blockTime !== null && point.blockTime !== null ? point.blockTime - previous.blockTime : null,
          fromLine: previous.line,
          toLine: point.line,
        });
      }
      track.lastPoint = point;
      track.polls.push(point);
      if (!overallPolls.has(point.line)) overallPolls.set(point.line, point);
    }

    const evidence = record.evidence;
    if (evidence.kind === "decode-error") {
      track.decodeErrors += 1;
      closeInterval(track);
      if (track.errors && track.errors.code === evidence.code) {
        track.errors.last = record;
        track.errors.occurrences += 1;
      } else {
        closeErrors(track);
        track.errors = { first: record, last: record, code: evidence.code, message: evidence.message, occurrences: 1 };
      }
      if (options.verbose) {
        push(record.lineNumber, {
          entry: "OBSERVATION", issuer: track.issuer, symbol: track.symbol, mint: track.mint,
          wallclock: record.wallclock, slot: record.slot, blockTime: record.blockTime, line: record.lineNumber,
          decodeStatus: "decode-error", state: null, error: `${evidence.code}: ${evidence.message}`,
        });
      }
      continue;
    }

    closeErrors(track);
    const current = stateFields(evidence);
    if (events.length > 0 && track.lastDecoded) {
      closeInterval(track);
      push(record.lineNumber, {
        entry: "STATE_CHANGE",
        issuer: track.issuer,
        symbol: track.symbol,
        mint: track.mint,
        wallclock: record.wallclock,
        slot: record.slot,
        blockTime: record.blockTime,
        line: record.lineNumber,
        events: events.map((e) => e.type),
        changedFields: events.flatMap((e) => e.detail),
        decodeStatus: "decoded",
        previous: track.lastDecoded,
        current,
      });
    }
    if (track.interval) {
      track.interval.last = record;
      track.interval.observations += 1;
    } else {
      track.interval = { first: record, last: record, observations: 1, state: current };
    }
    track.lastDecoded = current;
    if (options.verbose) {
      push(record.lineNumber, {
        entry: "OBSERVATION", issuer: track.issuer, symbol: track.symbol, mint: track.mint,
        wallclock: record.wallclock, slot: record.slot, blockTime: record.blockTime, line: record.lineNumber,
        decodeStatus: "decoded", state: current, error: null,
      });
    }
  }

  const bySymbol: Record<string, QualityMetrics> = {};
  let symbolDecodeErrors = 0;
  for (const track of tracks.values()) {
    closeInterval(track);
    closeErrors(track);
    symbolDecodeErrors += track.decodeErrors;
    bySymbol[track.symbol ?? track.mint ?? ""] = qualityMetrics(track.polls, allPollLines.size, track.decodeErrors, track.gaps);
  }

  // Locale-independent ordering keeps output byte-identical across machines.
  const byCodeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  entries.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || byCodeUnit(a.key[2], b.key[2]));
  const polls = [...overallPolls.values()].sort((a, b) => a.line - b.line);
  return {
    entries: entries.map((e) => e.entry),
    overall: qualityMetrics(polls, allPollLines.size, symbolDecodeErrors + lineErrors, countGaps(polls)),
    bySymbol,
  };
}

function countGaps(polls: readonly PollPoint[]): number {
  let gaps = 0;
  for (let i = 1; i < polls.length; i += 1) {
    if ((polls[i]?.ms ?? 0) - (polls[i - 1]?.ms ?? 0) >= CAPTURE_GAP_THRESHOLD_SECS * 1000) gaps += 1;
  }
  return gaps;
}

/** Evidence-quality metrics for an ordered list of polls. */
export function qualityMetrics(
  polls: readonly PollPoint[],
  totalPolls: number,
  decodeErrors: number,
  gaps: number,
): QualityMetrics {
  const first = polls[0];
  const last = polls.at(-1);
  let largestWallclockGapMs = 0;
  let largestBlockTimeGapSecs: bigint | null = null;
  for (let i = 1; i < polls.length; i += 1) {
    const prev = polls[i - 1];
    const cur = polls[i];
    if (!prev || !cur) continue;
    largestWallclockGapMs = Math.max(largestWallclockGapMs, cur.ms - prev.ms);
    if (prev.blockTime !== null && cur.blockTime !== null) {
      const gap = cur.blockTime - prev.blockTime;
      if (largestBlockTimeGapSecs === null || gap > largestBlockTimeGapSecs) largestBlockTimeGapSecs = gap;
    }
  }
  const expectedPolls = first && last ? Math.floor((last.ms - first.ms) / (CAPTURE_CADENCE_SECS * 1000)) + 1 : 0;
  const observedPolls = polls.length;
  const coverageBps = expectedPolls === 0 ? 0 : Math.min(10_000, Math.floor((observedPolls * 10_000) / expectedPolls));
  const { good, degraded } = QUALITY_THRESHOLDS;
  const status: QualityStatus =
    observedPolls >= 2 &&
    coverageBps >= good.minCoverageBps &&
    largestWallclockGapMs <= good.maxWallclockGapMs &&
    decodeErrors <= good.maxDecodeErrors
      ? "GOOD"
      : observedPolls >= 2 && coverageBps >= degraded.minCoverageBps && largestWallclockGapMs <= degraded.maxWallclockGapMs
        ? "DEGRADED"
        : "INSUFFICIENT";
  return {
    firstWallclock: first?.wallclock ?? null,
    lastWallclock: last?.wallclock ?? null,
    firstSlot: first?.slot ?? null,
    lastSlot: last?.slot ?? null,
    totalPolls,
    expectedPolls,
    observedPolls,
    largestWallclockGapMs,
    largestBlockTimeGapSecs,
    coverageBps,
    coveragePercent: `${Math.floor(coverageBps / 100)}.${String(coverageBps % 100).padStart(2, "0")}`,
    decodeErrors,
    gaps,
    status,
  };
}

/** Canonical JSON (bigints as strings) for timeline entries and metrics. */
export function timelineJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}
