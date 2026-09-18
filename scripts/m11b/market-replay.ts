#!/usr/bin/env node
/**
 * M11-B full historical replay of the sealed mainnet captures through the
 * current representation-state model and the guard's execution-time policy.
 *
 * For every captured observation of every representation it derives the
 * decoded economic state, effective multiplier, phase, pending status and
 * whether the state is verifiable. It then treats earlier observations of the
 * same mint as prior authorizations — a guard the SDK would have built at
 * that moment — and evaluates each one against the later state, at several
 * lags and protection windows.
 *
 * "Unexpected" is defined economically, not by re-running the guard's code:
 *
 * - an authorization is ECONOMICALLY STALE when a protected stored field
 *   differs, or the effective multiplier (the one Token-2022 applies at that
 *   chain time) differs from the one in effect at authorization;
 * - an UNEXPECTED ALLOW is a stale authorization the guard accepts — a
 *   security finding;
 * - an UNEXPECTED BLOCK is a non-stale authorization, outside any protection
 *   window, that the guard rejects.
 *
 * Read-only (INV-CAP-01): inputs must be sealed copies; the only output is a
 * brand-new report file. Nothing is fetched, signed or sent.
 *
 *   node scripts/m11b/market-replay.ts --chain <sealed equity-mints.jsonl> \
 *     [--api <sealed KOx-multiplier.jsonl>] [--out <new report.json>] [--rust-cases <results path>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { Address } from "@solana/kit";
import {
  ActivationPhase,
  TOKEN_2022_PROGRAM_ADDRESS,
  bytesEqual,
  checkGuardOffline,
  downstreamCommitment,
  hasScheduledChange,
  phaseAt,
  type EquityGuardErrorName,
  type ProtectedState,
} from "@equityguard/guard-client";
import {
  ObservationEventDetector,
  XStocksApiEventDetector,
  classifyChainEvidence,
  decodeCaptureLine,
  decodeXStocksApiLine,
  f64Hex,
  type CaptureRecord,
} from "@equityguard/representation-state";

import { assertSafeCaptureInput, sha256Hex } from "../observation/capture-isolation.ts";
import { packV2 } from "./differential.ts";
import { evaluateGuard } from "../../packages/guard-client/test/guard-mirror.ts";
import { ExpectKind, NO_CODE, codeOf, evaluateWithRust, guardInstructionOf, mirrorInvocation, resultByte, resultName, transferCheckedOf, type GuardCase } from "./guard-cases.ts";

// ------------------------------------------------------------------ inputs

/** The sealed chain capture M10A analysed; the replay pins it by hash. */
export const SEALED_CHAIN_SHA256 = "f137feeda9b0340559f5a98cb7ec74fdd1741d515e5d231b3144f5a0f874eb06";
export const SEALED_API_SHA256 = "1f235714b4399bf192633cf20b6aaf5d9b91c79be3c819fe799f8f2691c3d241";

/** Protection windows the replay evaluates under. None is calibrated (docs/m10a §6). */
export const REPLAY_WINDOWS = [
  { name: "zero", beforeSecs: 0, afterSecs: 0 },
  { name: "demo-900-300", beforeSecs: 900, afterSecs: 300 },
  { name: "one-day", beforeSecs: 86_400, afterSecs: 86_400 },
] as const;

/** Authorization-to-execution lags, in polls (~30 s each): 30 s, 1 min, 5 min, 1 h, 4 h, 24 h. */
export const REPLAY_LAGS = [1, 2, 10, 120, 480, 2880] as const;

/**
 * Transitions M10A found in the sealed capture (docs/m10a §3), stated before
 * this replay runs so it can report missed and unexpected ones.
 */
export const EXPECTED_TRANSITIONS = [
  { symbol: "UNHon", slot: 446835072n, type: "SCALED_UI_STATE_CHANGED", mechanism: "immediate-style update" },
  { symbol: "KOx", slot: 447067272n, type: "SCALED_UI_STATE_CHANGED", mechanism: "schedule published (pending, T = 2026-09-15T00:30:00Z)" },
  { symbol: "KOx", slot: 447067272n, type: "ACTIVATION_PHASE_CHANGED", mechanism: "schedule published: phase activated -> pending" },
  { symbol: "KOon", slot: 447108571n, type: "SCALED_UI_STATE_CHANGED", mechanism: "immediate-style update" },
  { symbol: "KOx", slot: 447113520n, type: "ACTIVATION_PHASE_CHANGED", mechanism: "Clock crossed T with identical bytes" },
] as const;

// ------------------------------------------------------------ observations

interface Observation {
  readonly seq: number;
  readonly lineNumber: number;
  readonly wallclock: string;
  readonly slot: bigint;
  /** Block time of the observed slot: the chain time for phase decisions. */
  readonly now: bigint;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly state: ProtectedState;
  readonly phase: ActivationPhase;
  readonly scheduled: boolean;
  readonly paused: boolean | null;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const f64 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
/** Stored bytes of the multiplier Token-2022 applies in `phase`. */
const effective = (state: ProtectedState, phase: ActivationPhase) => (phase === ActivationPhase.Activated ? state.newMultiplier : state.multiplier);
const storedEqual = (a: ProtectedState, b: ProtectedState) =>
  bytesEqual(a.multiplier, b.multiplier) && bytesEqual(a.newMultiplier, b.newMultiplier) && a.newMultiplierEffectiveTimestamp === b.newMultiplierEffectiveTimestamp;
const inWindow = (state: ProtectedState, now: bigint, w: { beforeSecs: number; afterSecs: number }) =>
  hasScheduledChange(state) && state.newMultiplierEffectiveTimestamp - BigInt(w.beforeSecs) <= now && now <= state.newMultiplierEffectiveTimestamp + BigInt(w.afterSecs);

const STORED_ERRORS: readonly string[] = ["MultiplierChanged", "NewMultiplierChanged", "EffectiveTimestampChanged"];
const CLOCK_ERRORS: readonly string[] = ["InsideTransitionWindow", "ActivationPhaseChanged"];

interface SymbolStats {
  mint: string;
  issuer: string | null;
  observations: number;
  decoded: number;
  decodeFailures: number;
  verifiable: number;
  firstWallclock: string | null;
  lastWallclock: string | null;
  firstSlot: string | null;
  lastSlot: string | null;
  distinctStoredStates: number;
  phases: Record<string, number>;
  pendingObservations: number;
  scheduledObservations: number;
  paused: Record<string, number>;
  classification: Record<string, Record<string, number>>;
  effectiveMultipliers: string[];
}

export interface PairTally {
  evaluations: number;
  authorizationRefusedAtBuild: number;
  allows: number;
  blocks: number;
  verdicts: Record<string, number>;
  economicallyStale: number;
  staleBlocked: number;
  policyWindowBlocks: number;
  expectedAllows: number;
  unexpectedAllows: number;
  unexpectedPolicyAllows: number;
  unexpectedBlocks: number;
  reasonDisagreements: number;
  /** Off-chain economic-state binding (phase included) differs while the guard allows. */
  offChainBindingStricter: number;
  examples: string[];
}

const newTally = (): PairTally => ({
  evaluations: 0,
  authorizationRefusedAtBuild: 0,
  allows: 0,
  blocks: 0,
  verdicts: {},
  economicallyStale: 0,
  staleBlocked: 0,
  policyWindowBlocks: 0,
  expectedAllows: 0,
  unexpectedAllows: 0,
  unexpectedPolicyAllows: 0,
  unexpectedBlocks: 0,
  reasonDisagreements: 0,
  offChainBindingStricter: 0,
  examples: [],
});

export interface ChainReplay {
  readonly polls: number;
  readonly totalObservations: number;
  readonly decodeSuccesses: number;
  readonly decodeFailures: number;
  readonly lineErrors: number;
  readonly firstWallclock: string | null;
  readonly lastWallclock: string | null;
  readonly largestPollGapSecs: number;
  readonly bySymbol: Record<string, SymbolStats>;
  readonly transitions: {
    readonly expected: number;
    readonly observed: number;
    readonly matched: number;
    readonly missed: string[];
    readonly unexpected: string[];
    readonly events: unknown[];
    readonly effectiveMultiplierChanges: unknown[];
  };
  readonly pairs: Record<string, PairTally>;
  readonly totals: PairTally;
  readonly eventBoundaries: unknown[];
  readonly scheduledBoundaryProbes: unknown[];
}

// ----------------------------------------------------------------- replay

export type GuardPolicy = typeof checkGuardOffline;
export type ExpectedTransition = { readonly symbol: string; readonly slot: bigint; readonly type: string };

export interface ReplayOptions {
  /** Transitions to reconcile against; defaults to the sealed capture's. */
  readonly expected?: readonly ExpectedTransition[];
  /** The guard policy under test; the harness's own tests substitute a weakened one. */
  readonly guard?: GuardPolicy;
}

export function replayChain(lines: readonly string[], options: ReplayOptions = {}): { report: ChainReplay; history: Map<string, Observation[]>; symbols: Map<string, string> } {
  const guard = options.guard ?? checkGuardOffline;
  const expectedTransitions = options.expected ?? EXPECTED_TRANSITIONS;
  const detector = new ObservationEventDetector();
  const events: { symbol: string | null; type: string; slot: bigint | null; wallclock: string | null; detail: readonly string[] }[] = [];
  const history = new Map<string, Observation[]>();
  const symbols = new Map<string, string>();
  const stats: Record<string, SymbolStats> = {};
  const storedStates: Record<string, Set<string>> = {};
  const pairs: Record<string, PairTally> = {};
  const totals = newTally();
  let totalObservations = 0;
  let decodeSuccesses = 0;
  let decodeFailures = 0;
  let lineErrors = 0;
  let polls = 0;
  let firstWallclock: string | null = null;
  let lastWallclock: string | null = null;
  let previousPollMs: number | null = null;
  let largestPollGapSecs = 0;
  const effectiveChanges: unknown[] = [];

  const tally = (key: string) => (pairs[key] ??= newTally());
  const bump = (record: Record<string, number>, key: string) => (record[key] = (record[key] ?? 0) + 1);

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const records: CaptureRecord[] = decodeCaptureLine(line, lineNumber);
    if (records.length === 0) return;
    polls += 1;
    let rawAccounts: Map<string, { owner: string; data: string }> | null = null;
    for (const record of records) {
      for (const event of detector.push(record)) {
        events.push({ symbol: event.symbol, type: event.type, slot: event.slot, wallclock: event.wallclock, detail: event.detail });
      }
      if (record.kind === "line-error") {
        lineErrors += 1;
        continue;
      }
      totalObservations += 1;
      const wallclock = record.wallclock ?? "";
      firstWallclock ??= wallclock;
      lastWallclock = wallclock;
      const symbol = record.symbol ?? record.mint;
      symbols.set(record.mint, symbol);
      const s = (stats[symbol] ??= {
        mint: record.mint,
        issuer: record.issuer,
        observations: 0,
        decoded: 0,
        decodeFailures: 0,
        verifiable: 0,
        firstWallclock: null,
        lastWallclock: null,
        firstSlot: null,
        lastSlot: null,
        distinctStoredStates: 0,
        phases: {},
        pendingObservations: 0,
        scheduledObservations: 0,
        paused: {},
        classification: {},
        effectiveMultipliers: [],
      });
      s.observations += 1;
      s.firstWallclock ??= wallclock;
      s.lastWallclock = wallclock;
      s.firstSlot ??= String(record.slot);
      s.lastSlot = String(record.slot);
      const evidence = record.evidence;
      if (evidence.kind === "decode-error") {
        decodeFailures += 1;
        s.decodeFailures += 1;
        continue;
      }
      decodeSuccesses += 1;
      s.decoded += 1;
      if (evidence.phase === null || record.slot === null || record.blockTime === null) continue;
      s.verifiable += 1;
      const phaseName = evidence.phase === ActivationPhase.Activated ? "activated" : "pending";
      bump(s.phases, phaseName);
      if (evidence.hasScheduledChange) s.scheduledObservations += 1;
      if (evidence.hasScheduledChange && evidence.phase === ActivationPhase.Pending) s.pendingObservations += 1;
      bump(s.paused, String(evidence.paused));
      for (const w of REPLAY_WINDOWS) {
        const { state } = classifyChainEvidence(evidence, { beforeSecs: BigInt(w.beforeSecs), afterSecs: BigInt(w.afterSecs), calibration: "UNCALIBRATED", basis: "M11-B replay" });
        bump((s.classification[w.name] ??= {}), state);
      }
      const stored = `${hex(evidence.protectedState.multiplier)}/${hex(evidence.protectedState.newMultiplier)}/${evidence.protectedState.newMultiplierEffectiveTimestamp}`;
      (storedStates[symbol] ??= new Set()).add(stored);
      const effectiveValue = String(f64(effective(evidence.protectedState, evidence.phase)));
      if (!s.effectiveMultipliers.includes(effectiveValue)) s.effectiveMultipliers.push(effectiveValue);

      const list = history.get(record.mint) ?? [];
      history.set(record.mint, list);
      rawAccounts ??= new Map((JSON.parse(line) as { accounts: { address: string; owner: string; data: string }[] }).accounts.map((a) => [a.address, a]));
      const raw = rawAccounts.get(record.mint);
      const current: Observation = {
        seq: list.length,
        lineNumber,
        wallclock,
        slot: record.slot,
        now: record.blockTime,
        owner: raw?.owner ?? "",
        data: Uint8Array.from(Buffer.from(raw?.data ?? "", "base64")),
        state: evidence.protectedState,
        phase: evidence.phase,
        scheduled: evidence.hasScheduledChange,
        paused: evidence.paused,
      };
      const before = list.at(-1);
      if (before && !bytesEqual(effective(before.state, before.phase), effective(current.state, current.phase))) {
        effectiveChanges.push({
          symbol,
          slot: String(current.slot),
          wallclock,
          from: f64(effective(before.state, before.phase)),
          to: f64(effective(current.state, current.phase)),
        });
      }
      list.push(current);

      // Every earlier observation at each lag is a candidate prior authorization.
      for (const lag of REPLAY_LAGS) {
        const auth = list[current.seq - lag];
        if (!auth) continue;
        for (const w of REPLAY_WINDOWS) {
          evaluatePair(guard, symbol, auth, current, w, lag, tally(`lag${lag}/${w.name}`), totals);
        }
      }
    }
    const ms = Date.parse(lastWallclock ?? "");
    if (previousPollMs !== null && !Number.isNaN(ms)) largestPollGapSecs = Math.max(largestPollGapSecs, (ms - previousPollMs) / 1000);
    if (!Number.isNaN(ms)) previousPollMs = ms;
  });

  for (const [symbol, set] of Object.entries(storedStates)) {
    const s = stats[symbol];
    if (s) s.distinctStoredStates = set.size;
  }

  const observed = events;
  const key = (e: { symbol: string | null; slot: bigint | null; type: string }) => `${e.symbol}@${e.slot}:${e.type}`;
  const expectedKeys = new Set(expectedTransitions.map((e) => key(e)));
  const observedKeys = new Set(observed.map((e) => key(e)));
  const eventBoundaries = boundaries(guard, history, symbols, events);

  return {
    report: {
      polls,
      totalObservations,
      decodeSuccesses,
      decodeFailures,
      lineErrors,
      firstWallclock,
      lastWallclock,
      largestPollGapSecs,
      bySymbol: stats,
      transitions: {
        expected: expectedTransitions.length,
        observed: observed.length,
        matched: [...expectedKeys].filter((k) => observedKeys.has(k)).length,
        missed: [...expectedKeys].filter((k) => !observedKeys.has(k)),
        unexpected: [...observedKeys].filter((k) => !expectedKeys.has(k)),
        events: observed.map((e) => ({ ...e, slot: String(e.slot) })),
        effectiveMultiplierChanges: effectiveChanges,
      },
      pairs,
      totals,
      eventBoundaries,
      scheduledBoundaryProbes: scheduledProbes(guard, history, symbols),
    },
    history,
    symbols,
  };
}

function evaluatePair(
  guard: GuardPolicy,
  symbol: string,
  auth: Observation,
  current: Observation,
  w: { name: string; beforeSecs: number; afterSecs: number },
  lag: number,
  tally: PairTally,
  totals: PairTally,
): void {
  const window = { beforeSecs: w.beforeSecs, afterSecs: w.afterSecs };
  const request = { expected: auth.state, expectedPhase: auth.phase, window };
  // The SDK refuses to build inside the window, so no authorization exists there.
  if (guard(request, auth.state, auth.now) !== null) {
    tally.authorizationRefusedAtBuild += 1;
    totals.authorizationRefusedAtBuild += 1;
    return;
  }
  const verdict = guard(request, current.state, current.now);
  const currentPhase = phaseAt(current.state, current.now);
  const storedChanged = !storedEqual(auth.state, current.state);
  const stale = storedChanged || !bytesEqual(effective(auth.state, auth.phase), effective(current.state, currentPhase));
  const policy = !stale && inWindow(current.state, current.now, window);
  const offChainChanged = storedChanged || auth.phase !== currentPhase;

  for (const t of [tally, totals]) {
    t.evaluations += 1;
    t.verdicts[verdict ?? "ok"] = (t.verdicts[verdict ?? "ok"] ?? 0) + 1;
    if (verdict === null) t.allows += 1;
    else t.blocks += 1;
    const note = (kind: string) => {
      if (t.examples.length < 10) t.examples.push(`${kind}: ${symbol} auth line ${auth.lineNumber} -> line ${current.lineNumber} (lag ${lag}, window ${w.name}), verdict ${verdict ?? "ok"}`);
    };
    if (stale) {
      t.economicallyStale += 1;
      if (verdict === null) {
        t.unexpectedAllows += 1;
        note("UNEXPECTED ALLOW");
      } else {
        t.staleBlocked += 1;
        const expectedClass = storedChanged ? STORED_ERRORS : CLOCK_ERRORS;
        if (!expectedClass.includes(verdict)) {
          t.reasonDisagreements += 1;
          note("REASON DISAGREEMENT");
        }
      }
    } else if (policy) {
      if (verdict === "InsideTransitionWindow") t.policyWindowBlocks += 1;
      else if (verdict === null) {
        t.unexpectedPolicyAllows += 1;
        note("UNEXPECTED POLICY ALLOW");
      } else {
        t.reasonDisagreements += 1;
        note("REASON DISAGREEMENT");
      }
    } else {
      t.expectedAllows += 1;
      if (verdict !== null) {
        t.unexpectedBlocks += 1;
        note("UNEXPECTED BLOCK");
      }
    }
    if (verdict === null && offChainChanged) t.offChainBindingStricter += 1;
  }
}

/** Previous and first-changed observation around every detected event, with the stale and fresh verdicts. */
function boundaries(guard: GuardPolicy, history: Map<string, Observation[]>, symbols: Map<string, string>, events: { symbol: string | null; type: string; slot: bigint | null }[]): unknown[] {
  const out: unknown[] = [];
  for (const event of events) {
    const mint = [...symbols.entries()].find(([, s]) => s === event.symbol)?.[0];
    const list = mint ? history.get(mint) : undefined;
    const index = list?.findIndex((o) => o.slot === event.slot) ?? -1;
    const current = list?.[index];
    const previous = list?.[index - 1];
    if (!current || !previous) continue;
    const describe = (o: Observation) => ({
      line: o.lineNumber,
      wallclock: o.wallclock,
      slot: String(o.slot),
      blockTime: String(o.now),
      multiplier: f64(o.state.multiplier),
      newMultiplier: f64(o.state.newMultiplier),
      effectiveTimestamp: String(o.state.newMultiplierEffectiveTimestamp),
      phase: o.phase === ActivationPhase.Activated ? "activated" : "pending",
      effectiveMultiplier: f64(effective(o.state, o.phase)),
    });
    const verdicts: Record<string, unknown> = {};
    for (const w of REPLAY_WINDOWS) {
      const window = { beforeSecs: w.beforeSecs, afterSecs: w.afterSecs };
      verdicts[w.name] = {
        staleAuthorizationAgainstNewState: guard({ expected: previous.state, expectedPhase: previous.phase, window }, current.state, current.now) ?? "ok",
        freshAuthorizationOnNewState: guard({ expected: current.state, expectedPhase: current.phase, window }, current.state, current.now) ?? "ok",
      };
    }
    out.push({ symbol: event.symbol, type: event.type, previous: describe(previous), firstChanged: describe(current), verdicts });
  }
  return out;
}

/**
 * The scheduled KOx activation at T: the capture has no observation at
 * exactly T (30 s polling), so the real pending bytes are evaluated at
 * T - 1, T and T + 1 with the phase a pre-T authorization carries.
 */
function scheduledProbes(guard: GuardPolicy, history: Map<string, Observation[]>, symbols: Map<string, string>): unknown[] {
  const out: unknown[] = [];
  for (const [mint, list] of history) {
    const lastPending = [...list].reverse().find((o, i, all) => o.phase === ActivationPhase.Pending && o.scheduled && all[i - 1]?.phase === ActivationPhase.Activated);
    if (!lastPending) continue;
    const firstActivated = list[lastPending.seq + 1];
    const t = lastPending.state.newMultiplierEffectiveTimestamp;
    const probes: Record<string, Record<string, string>> = {};
    for (const w of REPLAY_WINDOWS) {
      const window = { beforeSecs: w.beforeSecs, afterSecs: w.afterSecs };
      probes[w.name] = Object.fromEntries(
        [
          ["T-1", t - 1n],
          ["T", t],
          ["T+1", t + 1n],
        ].map(([label, now]) => [label as string, guard({ expected: lastPending.state, expectedPhase: ActivationPhase.Pending, window }, lastPending.state, now as bigint) ?? "ok"]),
      );
    }
    out.push({
      symbol: symbols.get(mint),
      t: String(t),
      tIso: new Date(Number(t) * 1000).toISOString(),
      lastPendingBlockTime: String(lastPending.now),
      firstActivatedBlockTime: firstActivated ? String(firstActivated.now) : null,
      exactlyTObserved: list.some((o) => o.now === t),
      protectedStateIdenticalAcrossT: firstActivated ? storedEqual(lastPending.state, firstActivated.state) : null,
      wholeAccountIdenticalAcrossT: firstActivated ? bytesEqual(lastPending.data, firstActivated.data) : null,
      pendingAuthorizationProbes: probes,
    });
  }
  return out;
}

// -------------------------------------------------------------------- API

export interface ApiReplay {
  readonly lines: number;
  readonly decoded: number;
  readonly requestErrors: number;
  readonly malformed: number;
  readonly firstWallclock: string | null;
  readonly lastWallclock: string | null;
  readonly events: unknown[];
  readonly reasons: Record<string, number>;
  readonly chainComparison: {
    readonly compared: number;
    readonly currentAgrees: number;
    readonly currentDisagrees: number;
    readonly pendingCompared: number;
    readonly pendingAgrees: number;
    readonly disagreementIntervals: unknown[];
  };
}

/** Replays the KOx issuer-API capture and compares each poll with the latest chain observation. */
export function replayApi(lines: readonly string[], koxHistory: readonly Observation[]): ApiReplay {
  const detector = new XStocksApiEventDetector();
  const events: unknown[] = [];
  const reasons: Record<string, number> = {};
  let decoded = 0;
  let requestErrors = 0;
  let malformed = 0;
  let firstWallclock: string | null = null;
  let lastWallclock: string | null = null;
  let compared = 0;
  let currentAgrees = 0;
  let pendingCompared = 0;
  let pendingAgrees = 0;
  const intervals: { from: string; to: string; polls: number; api: number; chainEffective: number }[] = [];
  let previousDisagreed = false;
  const chainTimes = koxHistory.map((o) => Date.parse(o.wallclock));

  lines.forEach((line, i) => {
    const observation = decodeXStocksApiLine(line, i + 1);
    if (!observation) return;
    for (const e of detector.push(observation)) events.push({ type: e.type, wallclock: e.wallclock, line: e.lineNumber, detail: e.detail });
    if (observation.decodeStatus === "request-error") requestErrors += 1;
    if (observation.decodeStatus === "malformed") malformed += 1;
    if (observation.decodeStatus !== "ok" || observation.wallclockMs === null || observation.currentMultiplier === null) return;
    decoded += 1;
    firstWallclock ??= observation.wallclock;
    lastWallclock = observation.wallclock;
    reasons[String(observation.reason)] = (reasons[String(observation.reason)] ?? 0) + 1;

    // The latest chain observation at or before this API poll.
    let lo = 0;
    let hi = chainTimes.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((chainTimes[mid] ?? 0) <= observation.wallclockMs) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const chain = koxHistory[at];
    if (!chain) return;
    compared += 1;
    const chainEffective = effective(chain.state, chain.phase);
    const agrees = f64Hex(observation.currentMultiplier) === hex(chainEffective);
    if (agrees) currentAgrees += 1;
    else if (previousDisagreed && intervals.at(-1)) {
      const last = intervals.at(-1)!;
      last.to = observation.wallclock ?? "";
      last.polls += 1;
    } else {
      intervals.push({ from: observation.wallclock ?? "", to: observation.wallclock ?? "", polls: 1, api: observation.currentMultiplier, chainEffective: f64(chainEffective) });
    }
    previousDisagreed = !agrees;
    if (observation.newMultiplier !== null && observation.newMultiplier > 0) {
      pendingCompared += 1;
      const tMs = observation.activationTime?.unixMs ?? null;
      if (f64Hex(observation.newMultiplier) === hex(chain.state.newMultiplier) && tMs !== null && BigInt(tMs / 1000) === chain.state.newMultiplierEffectiveTimestamp) pendingAgrees += 1;
    }
  });

  return {
    lines: lines.filter((l) => l.trim() !== "").length,
    decoded,
    requestErrors,
    malformed,
    firstWallclock,
    lastWallclock,
    events,
    reasons,
    chainComparison: { compared, currentAgrees, currentDisagrees: compared - currentAgrees, pendingCompared, pendingAgrees, disagreementIntervals: intervals },
  };
}

// ------------------------------------------------- Rust / compiled program

/**
 * The replay's lag-1 and lag-120 authorizations, under the zero and demo
 * windows, as guard cases for the Rust host model and the compiled program.
 * Expectation is the economic one: stale -> must block; in-window -> exactly
 * InsideTransitionWindow; otherwise allow.
 */
export function* replayCases(history: Map<string, Observation[]>): Generator<GuardCase> {
  let index = 0;
  for (const [mint, list] of history) {
    for (const current of list) {
      for (const lag of [1, 120]) {
        const auth = list[current.seq - lag];
        if (!auth) continue;
        for (const w of REPLAY_WINDOWS.slice(0, 2)) {
          const window = { beforeSecs: w.beforeSecs, afterSecs: w.afterSecs };
          if (checkGuardOffline({ expected: auth.state, expectedPhase: auth.phase, window }, auth.state, auth.now) !== null) continue;
          const decimals = current.data[44] ?? 0;
          const transfer = transferCheckedOf(mint as Address, 1_000_000n, decimals);
          const commitment = downstreamCommitment({
            programAddress: transfer.programId as Address,
            accounts: transfer.accounts.map((a) => ({ address: a.pubkey as Address, isSigner: a.isSigner, isWritable: a.isWritable })),
            data: transfer.data,
          });
          const guardData = packV2({
            expectedMint: mint as Address,
            multiplier: auth.state.multiplier,
            newMultiplier: auth.state.newMultiplier,
            t: auth.state.newMultiplierEffectiveTimestamp,
            phase: auth.phase,
            beforeSecs: w.beforeSecs,
            afterSecs: w.afterSecs,
            adapter: 1,
            commitment,
          });
          const currentPhase = phaseAt(current.state, current.now);
          const stale = !storedEqual(auth.state, current.state) || !bytesEqual(effective(auth.state, auth.phase), effective(current.state, currentPhase));
          const expect: { kind: ExpectKind; code: number } = stale
            ? { kind: ExpectKind.BLOCK_ANY, code: NO_CODE }
            : inWindow(current.state, current.now, window)
              ? { kind: ExpectKind.BLOCK_EXACT, code: codeOf("InsideTransitionWindow") }
              : { kind: ExpectKind.ALLOW, code: NO_CODE };
          yield {
            index: index++,
            category: lag,
            expectKind: expect.kind,
            expectCode: expect.code,
            mintKey: mint as Address,
            mintOwner: (current.owner || TOKEN_2022_PROGRAM_ADDRESS) as Address,
            mintData: current.data,
            guardData,
            clock: current.now,
            instructions: [guardInstructionOf(mint as Address, guardData), transfer],
            currentIndex: 0,
          };
        }
      }
    }
  }
}

// -------------------------------------------------------------------- CLI

async function readSealed(path: string): Promise<{ lines: string[]; sha256: string; bytes: number }> {
  const input = await assertSafeCaptureInput(path, { env: process.env });
  const bytes = readFileSync(input, { flag: "r" });
  const text = bytes.toString("utf8");
  return { lines: text.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === "")), sha256: sha256Hex(bytes), bytes: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { chain: { type: "string" }, api: { type: "string" }, out: { type: "string" }, "rust-results": { type: "string" }, "litesvm-every": { type: "string" } } });
  if (!values.chain) throw new Error("--chain <sealed capture copy> is required; there is no default");
  const started = performance.now();
  const chainInput = await readSealed(values.chain);
  const chain = replayChain(chainInput.lines);
  const koxMint = [...chain.symbols.entries()].find(([, s]) => s === "KOx")?.[0];
  const apiInput = values.api ? await readSealed(values.api) : null;
  const api = apiInput && koxMint ? replayApi(apiInput.lines, chain.history.get(koxMint) ?? []) : null;
  const prefixSha = sha256Hex(Buffer.from(`${chainInput.lines.slice(0, 3311).join("\n")}\n`, "utf8"));

  let rust: unknown = null;
  if (values["rust-results"]) {
    const cases = [...replayCases(chain.history)];
    const evaluation = await evaluateWithRust(cases, { resultsPath: values["rust-results"], litesvmEvery: Number(values["litesvm-every"] ?? "10") });
    const verdicts: Record<string, number> = {};
    evaluation.results.forEach((b) => (verdicts[resultName(b)] = (verdicts[resultName(b)] ?? 0) + 1));
    // The TypeScript mirror over the same cases.
    let typescriptDisagreements = 0;
    for (const [i, c] of cases.entries()) {
      if (resultByte(await evaluateGuard(mirrorInvocation(c))) !== evaluation.results[i]) typescriptDisagreements += 1;
    }
    rust = { cases: cases.length, verdicts, typescriptDisagreements, summary: evaluation.summary };
  }

  const report = {
    kind: "equityguard-m11b-market-replay",
    generatedAt: new Date().toISOString(),
    chainInput: { sha256: chainInput.sha256, bytes: chainInput.bytes, lines: chainInput.lines.length, first3311LinesSha256: prefixSha, first3311LinesAreSealedF137: prefixSha === SEALED_CHAIN_SHA256 },
    apiInput: apiInput ? { sha256: apiInput.sha256, bytes: apiInput.bytes, lines: apiInput.lines.length } : null,
    windows: REPLAY_WINDOWS,
    lagsInPolls: REPLAY_LAGS,
    chain: chain.report,
    api,
    rust,
    runtimeSecs: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
  const json = `${JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
  if (values.out) writeFileSync(values.out, json, { flag: "wx" });
  const t = chain.report.totals;
  console.log(
    JSON.stringify(
      {
        polls: chain.report.polls,
        observations: chain.report.totalObservations,
        decodeSuccesses: chain.report.decodeSuccesses,
        decodeFailures: chain.report.decodeFailures,
        transitions: { expected: chain.report.transitions.expected, observed: chain.report.transitions.observed, matched: chain.report.transitions.matched, missed: chain.report.transitions.missed, unexpected: chain.report.transitions.unexpected },
        pairEvaluations: t.evaluations,
        economicallyStale: t.economicallyStale,
        unexpectedAllows: t.unexpectedAllows,
        unexpectedPolicyAllows: t.unexpectedPolicyAllows,
        unexpectedBlocks: t.unexpectedBlocks,
        reasonDisagreements: t.reasonDisagreements,
        runtimeSecs: report.runtimeSecs,
      },
      null,
      2,
    ),
  );
}
