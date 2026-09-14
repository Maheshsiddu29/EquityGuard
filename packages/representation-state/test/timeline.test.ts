import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUALITY_THRESHOLDS,
  buildTimeline,
  decodeCaptureLine,
  findRepresentationBySymbol,
  timelineJson,
  type CaptureRecord,
  type TimelineEntry,
} from "../src/index.ts";
import { TOKEN_2022, mainnetMint, withPaused, withScaledUi } from "./fixtures.ts";

const KOX_T = 1_781_481_300;
const BASE_SLOT = 446_800_000;

interface Poll {
  /** Seconds after the first poll; a 30 s cadence unless a test skips polls. */
  readonly at: number;
  readonly kox?: Uint8Array;
  readonly owner?: string;
  readonly raw?: string;
  readonly blockTime?: number;
}

/** Synthetic poll-format capture built from committed real mint bytes. */
function capture(polls: readonly Poll[], startBlockTime = KOX_T + 10_000): CaptureRecord[] {
  const kox = findRepresentationBySymbol("KOx")!;
  return polls.flatMap((poll, index) => {
    if (poll.raw !== undefined) return decodeCaptureLine(poll.raw, index + 1);
    const blockTime = poll.blockTime ?? startBlockTime + poll.at;
    const line = JSON.stringify({
      wallclock: new Date((startBlockTime + poll.at) * 1000).toISOString(),
      slot: BASE_SLOT + poll.at * 2,
      blockTime,
      accounts: [
        {
          symbol: "KOx",
          issuer: "xStocks",
          address: kox.mint,
          exists: true,
          owner: poll.owner ?? TOKEN_2022,
          data: Buffer.from(poll.kox ?? mainnetMint("KOx")).toString("base64"),
          encoding: "base64",
        },
      ],
    });
    return decodeCaptureLine(line, index + 1);
  });
}

const every30 = (n: number, overrides: Record<number, Partial<Poll>> = {}): Poll[] =>
  Array.from({ length: n }, (_, i) => ({ at: i * 30, ...overrides[i] }));

const kinds = (entries: readonly TimelineEntry[]) => entries.map((e) => e.entry);

test("A: stable observations compress to one interval with zero state changes", () => {
  const { entries, overall } = buildTimeline(capture(every30(5)));
  assert.deepEqual(kinds(entries), ["STABLE_INTERVAL"]);
  const [interval] = entries;
  assert.ok(interval?.entry === "STABLE_INTERVAL");
  assert.deepEqual([interval.observations, interval.stateChanges, interval.firstLine, interval.lastLine], [5, 0, 1, 5]);
  assert.equal(interval.state.multiplierHex, "1efbb6d57038f03f");
  assert.equal(interval.state.multiplierValue, "1.013779482672994");
  assert.equal(interval.state.phase, "activated");
  assert.equal(overall.status, "GOOD");
  assert.equal(overall.coveragePercent, "100.00");
});

function changeAt(entries: readonly TimelineEntry[]) {
  const change = entries.find((e) => e.entry === "STATE_CHANGE");
  assert.ok(change?.entry === "STATE_CHANGE");
  return change;
}

test("B: a multiplier change emits the exact boundary", () => {
  const changed = withScaledUi(mainnetMint("KOx"), { multiplier: 1.05 });
  const { entries } = buildTimeline(capture(every30(5, { 2: { kox: changed }, 3: { kox: changed }, 4: { kox: changed } })));
  assert.deepEqual(kinds(entries), ["STABLE_INTERVAL", "STATE_CHANGE", "STABLE_INTERVAL"]);
  const [before, change, after] = entries;
  assert.ok(before?.entry === "STABLE_INTERVAL" && after?.entry === "STABLE_INTERVAL" && change?.entry === "STATE_CHANGE");
  assert.deepEqual([before.lastLine, before.lastSlot, change.line, change.slot, after.firstLine], [2, BigInt(BASE_SLOT + 60), 3, BigInt(BASE_SLOT + 120), 3]);
  assert.deepEqual(change.events, ["SCALED_UI_STATE_CHANGED"]);
  assert.deepEqual(change.changedFields, ["multiplier"]);
  assert.equal(change.current.multiplierValue, "1.05");
});

test("C: a new multiplier change is emitted", () => {
  const changed = withScaledUi(mainnetMint("KOx"), { newMultiplier: 1.07 });
  const change = changeAt(buildTimeline(capture(every30(3, { 1: { kox: changed }, 2: { kox: changed } }))).entries);
  assert.deepEqual(change.changedFields, ["newMultiplier"]);
});

test("D: an effective timestamp change is emitted", () => {
  // Still in the past relative to block time, so only the stored field changes.
  const changed = withScaledUi(mainnetMint("KOx"), { effectiveTimestamp: BigInt(KOX_T + 5) });
  const change = changeAt(buildTimeline(capture(every30(3, { 1: { kox: changed }, 2: { kox: changed } }))).entries);
  assert.deepEqual([change.events, change.changedFields], [["SCALED_UI_STATE_CHANGED"], ["newMultiplierEffectiveTimestamp"]]);
});

test("E: block time crossing the effective timestamp with identical bytes emits ACTIVATION_PHASE_CHANGED", () => {
  const polls = every30(4).map((p, i) => ({ ...p, blockTime: KOX_T - 60 + i * 30 }));
  const { entries } = buildTimeline(capture(polls, KOX_T - 60));
  assert.deepEqual(kinds(entries), ["STABLE_INTERVAL", "STATE_CHANGE", "STABLE_INTERVAL"]);
  const change = changeAt(entries);
  assert.deepEqual(change.events, ["ACTIVATION_PHASE_CHANGED"]);
  assert.equal(change.blockTime, BigInt(KOX_T));
  assert.deepEqual([change.previous.phase, change.current.phase], ["pending", "activated"]);
  // The protected bytes are identical on both sides of the boundary.
  assert.deepEqual(
    [change.previous.multiplierHex, change.previous.newMultiplierHex, change.previous.effectiveTimestamp],
    [change.current.multiplierHex, change.current.newMultiplierHex, change.current.effectiveTimestamp],
  );
});

test("F: a pause flag change emits PAUSE_STATE_CHANGED", () => {
  const paused = withPaused(mainnetMint("KOx"), true);
  const change = changeAt(buildTimeline(capture(every30(3, { 1: { kox: paused }, 2: { kox: paused } }))).entries);
  assert.deepEqual(change.events, ["PAUSE_STATE_CHANGED"]);
  assert.deepEqual([change.previous.paused, change.current.paused], [false, true]);
});

test("G: malformed records are explicit and do not corrupt the later timeline", () => {
  const legacy = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const { entries, overall } = buildTimeline(
    capture(every30(7, { 2: { raw: "{truncated" }, 4: { owner: legacy }, 5: { owner: legacy } })),
  );
  assert.deepEqual(kinds(entries), ["STABLE_INTERVAL", "DECODE_ERROR", "CAPTURE_GAP", "STABLE_INTERVAL", "DECODE_ERROR", "STABLE_INTERVAL"]);
  const accountError = entries[4];
  assert.ok(accountError?.entry === "DECODE_ERROR");
  assert.deepEqual([accountError.code, accountError.occurrences, accountError.firstLine, accountError.lastLine], ["InvalidMintOwner", 2, 5, 6]);
  const last = entries[5];
  assert.ok(last?.entry === "STABLE_INTERVAL");
  assert.equal(last.state.multiplierHex, "1efbb6d57038f03f");
  // Same state after the errors: no spurious STATE_CHANGE.
  assert.ok(!entries.some((e) => e.entry === "STATE_CHANGE"));
  assert.equal(overall.decodeErrors, 3);
});

test("H: a missing poll is a CAPTURE_GAP, never continuous observation", () => {
  const polls: Poll[] = [{ at: 0 }, { at: 30 }, { at: 120 }, { at: 150 }];
  const { entries, overall } = buildTimeline(capture(polls));
  assert.deepEqual(kinds(entries), ["STABLE_INTERVAL", "CAPTURE_GAP", "STABLE_INTERVAL"]);
  const gap = entries[1];
  assert.ok(gap?.entry === "CAPTURE_GAP");
  assert.deepEqual([gap.wallclockGapMs, gap.blockTimeGapSecs, gap.fromLine, gap.toLine], [90_000, 90n, 2, 3]);
  assert.deepEqual(
    [overall.expectedPolls, overall.observedPolls, overall.coveragePercent, overall.largestWallclockGapMs, overall.gaps, overall.status],
    [6, 4, "66.66", 90_000, 1, "INSUFFICIENT"],
  );
});

test("quality thresholds are explicit: GOOD, DEGRADED and INSUFFICIENT", () => {
  assert.deepEqual(QUALITY_THRESHOLDS.good, { minCoverageBps: 9_800, maxWallclockGapMs: 90_000, maxDecodeErrors: 0 });
  const series = (n: number, missing: number[]) => every30(n).filter((_, i) => !missing.includes(i));
  // 100 expected polls, one missing (a 60 s gap): 99 % coverage, still GOOD but the gap is counted.
  const one = buildTimeline(capture(series(100, [50]))).overall;
  assert.deepEqual([one.coveragePercent, one.gaps, one.status], ["99.00", 1, "GOOD"]);
  // Five consecutive missing polls (180 s gap): 95 % coverage, DEGRADED.
  const five = buildTimeline(capture(series(100, [40, 41, 42, 43, 44]))).overall;
  assert.deepEqual([five.coveragePercent, five.largestWallclockGapMs, five.status], ["95.00", 180_000, "DEGRADED"]);
  // A 330 s gap is INSUFFICIENT regardless of coverage.
  const long = buildTimeline(capture(series(1000, [500, 501, 502, 503, 504, 505, 506, 507, 508, 509]))).overall;
  assert.deepEqual([long.largestWallclockGapMs, long.status], [330_000, "INSUFFICIENT"]);
  // Any decode error caps quality at DEGRADED.
  const withError = buildTimeline(capture(every30(10, { 5: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } }))).overall;
  assert.equal(withError.status, "DEGRADED");
  assert.equal(buildTimeline([]).overall.status, "INSUFFICIENT");
});

test("symbol filtering and verbose mode", () => {
  const records = capture(every30(3));
  assert.deepEqual(buildTimeline(records, { symbols: new Set(["KOon"]) }).entries, []);
  const verbose = buildTimeline(records, { verbose: true }).entries;
  assert.deepEqual(kinds(verbose), ["STABLE_INTERVAL", "OBSERVATION", "OBSERVATION", "OBSERVATION"]);
});

test("same input yields the same timeline, byte for byte", () => {
  const polls = every30(6, { 3: { kox: withScaledUi(mainnetMint("KOx"), { multiplier: 1.1 }) } });
  const first = timelineJson(buildTimeline(capture(polls)));
  const second = timelineJson(buildTimeline(capture(polls)));
  assert.equal(first, second);
});
