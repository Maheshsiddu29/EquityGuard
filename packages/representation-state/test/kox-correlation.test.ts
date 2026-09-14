/**
 * SYNTHETIC correlation scenarios. Chain records are built from the committed
 * real KOx mint bytes with edited ScaledUiAmount fields; API lines follow the
 * watcher format. They exercise semantics only and predict nothing about any
 * real corporate action.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  correlateKOx,
  decodeCaptureLine,
  decodeXStocksApiLine,
  findRepresentationBySymbol,
  timelineJson,
  type CaptureRecord,
  type XStocksApiObservation,
} from "../src/index.ts";
import { TOKEN_2022, mainnetMint, withScaledUi } from "./fixtures.ts";

const KOX = findRepresentationBySymbol("KOx")!;
const S = Date.parse("2026-09-14T23:30:00Z") / 1000;
const CURRENT = 1.0183317967386898;
const NEW = 1.0229;
const T = S + 1500; // 23:55:00Z

const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");

/** Chain state before any new update: the June change, already activated. */
const CHAIN_BEFORE = mainnetMint("KOx");
/** Chain state after a scheduled update at T (what Token-2022 would store). */
const CHAIN_PENDING = withScaledUi(mainnetMint("KOx"), { multiplier: CURRENT, newMultiplier: NEW, effectiveTimestamp: BigInt(T) });

function chainPoll(offset: number, data: Uint8Array, line: number): CaptureRecord[] {
  return decodeCaptureLine(
    JSON.stringify({
      wallclock: new Date((S + offset) * 1000).toISOString(),
      slot: 447_100_000 + offset * 2,
      blockTime: S + offset,
      accounts: [{ symbol: "KOx", issuer: "xStocks", address: KOX.mint, exists: true, owner: TOKEN_2022, data: Buffer.from(data).toString("base64"), encoding: "base64" }],
    }),
    line,
  );
}

/** Chain polls every 30 s from `from` to `to` (inclusive); state switches to pending at `pendingAt`. */
function chainSeries(from: number, to: number, pendingAt: number | null): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  for (let offset = from, line = 1; offset <= to; offset += 30, line += 1) {
    records.push(...chainPoll(offset, pendingAt !== null && offset >= pendingAt ? CHAIN_PENDING : CHAIN_BEFORE, line));
  }
  return records;
}

type Pending = { newMultiplier: number; activationDateTime: unknown; reason: string | null } | null;

/** API polls every 30 s; `pendingFrom` switches the response to `pending`. */
function apiSeries(from: number, to: number, pendingFrom: number | null, pending: Pending): XStocksApiObservation[] {
  const out: XStocksApiObservation[] = [];
  for (let offset = from, line = 1; offset <= to; offset += 30, line += 1) {
    const isPending = pendingFrom !== null && offset >= pendingFrom && pending;
    const response = isPending
      ? { currentMultiplier: CURRENT, ...pending }
      : { currentMultiplier: CURRENT, newMultiplier: 0, activationDateTime: 0, reason: null };
    const observation = decodeXStocksApiLine(JSON.stringify({ wallclock: iso(S + offset), response }), line);
    if (observation) out.push(observation);
  }
  return out;
}

const PUBLISHED: Pending = { newMultiplier: NEW, activationDateTime: `${iso(T).replace("Z", ".000Z")}`, reason: "Dividend" };

function correlate(api: XStocksApiObservation[], chain: CaptureRecord[]) {
  return correlateKOx({ api, chain, mint: KOX.mint, symbol: "KOx" });
}

test("no pending update anywhere", () => {
  const result = correlate(apiSeries(0, 300, null, null), chainSeries(0, 300, null));
  assert.deepEqual(result.outcomes, ["NO_PENDING_UPDATE_OBSERVED"]);
  assert.equal(result.crossSourceEvents.length, 0);
  assert.equal(result.quality.api.status, "GOOD");
});

test("API pending before chain pending: published first, then agreement", () => {
  const result = correlate(apiSeries(0, 600, 60, PUBLISHED), chainSeries(0, 600, 300));
  assert.deepEqual(result.outcomes, ["API_PENDING_CHAIN_NOT_YET_PENDING", "API_AND_CHAIN_PENDING_AGREE", "API_ACTIVATION_MATCHES_CHAIN_WITHIN_RESOLUTION"]);
  const api = result.derived.apiPendingFirstObservedAt;
  const chain = result.derived.chainPendingFirstObservedAt;
  assert.deepEqual([api?.firstObservedAt, api?.lastObservedBefore, api?.resolutionMs], [iso(S + 60), iso(S + 30), 30_000]);
  assert.deepEqual([chain?.firstObservedAt, chain?.lastObservedBefore, chain?.resolutionMs], [new Date((S + 300) * 1000).toISOString(), new Date((S + 270) * 1000).toISOString(), 30_000]);
  // Chain changed in (270, 300], API in (30, 60]: lead is in (210 s, 270 s].
  assert.deepEqual(result.timingDeltas.apiPublicationLead, { minExclusiveMs: 210_000, maxInclusiveMs: 270_000, order: "API_BEFORE_CHAIN" });
  assert.equal(result.timingDeltas.advertisedMinusChainEffectiveSecs, 0n);
  assert.deepEqual(result.crossSourceEvents.map((e) => e.type), ["API_PENDING_UPDATE_PUBLISHED", "CHAIN_STATE_CHANGE"]);
});

test("chain pending before API: order and missing preannouncement are reported", () => {
  const result = correlate(apiSeries(0, 600, 300, PUBLISHED), chainSeries(0, 600, 60));
  assert.ok(result.outcomes.includes("CHAIN_CHANGED_WITHOUT_API_PREANNOUNCEMENT"));
  assert.ok(!result.outcomes.includes("API_PENDING_CHAIN_NOT_YET_PENDING"));
  assert.equal(result.timingDeltas.apiPublicationLead?.order, "CHAIN_BEFORE_API");
});

test("changes inside the same polling bracket stay unresolved", () => {
  const result = correlate(apiSeries(0, 600, 300, PUBLISHED), chainSeries(10, 610, 310));
  assert.equal(result.timingDeltas.apiPublicationLead?.order, "UNRESOLVED_WITHIN_POLLING");
});

test("exact advertised activation agreement with an observed chain activation", () => {
  // Chain polled across T: pending before, activated from T on, identical bytes.
  const chain = chainSeries(1380, 1560, 1380);
  const result = correlate(apiSeries(1200, 1560, 1200, PUBLISHED), chain);
  assert.ok(result.outcomes.includes("API_ACTIVATION_MATCHES_CHAIN_WITHIN_RESOLUTION"));
  assert.equal(result.timingDeltas.advertisedMinusChainEffectiveSecs, 0n);
  const activation = result.derived.chainActivationFirstObservedAt;
  assert.equal(activation?.blockTime, BigInt(T));
  assert.equal(activation?.previousBlockTime, BigInt(T - 30));
  assert.deepEqual(result.timingDeltas.chainActivationBracketBlockTimes, { lastPending: BigInt(T - 30), firstActivated: BigInt(T) });
});

test("advertised activation within one polling interval matches within resolution, but pending details conflict", () => {
  const within: Pending = { ...PUBLISHED!, activationDateTime: iso(T + 15) };
  const result = correlate(apiSeries(1200, 1560, 1200, within), chainSeries(1380, 1560, 1380));
  assert.equal(result.timingDeltas.advertisedMinusChainEffectiveSecs, 15n);
  assert.ok(result.outcomes.includes("API_ACTIVATION_MATCHES_CHAIN_WITHIN_RESOLUTION"));
  assert.ok(result.outcomes.includes("API_AND_CHAIN_PENDING_CONFLICT"));
});

test("disagreement greater than polling resolution", () => {
  const later: Pending = { ...PUBLISHED!, activationDateTime: T + 3600 };
  const result = correlate(apiSeries(1200, 1560, 1200, later), chainSeries(1380, 1560, 1380));
  assert.equal(result.derived.apiAdvertised?.activationInterpretation, "unix-seconds");
  assert.equal(result.timingDeltas.advertisedMinusChainEffectiveSecs, 3600n);
  assert.ok(result.outcomes.includes("API_ACTIVATION_DIFFERS_FROM_CHAIN"));
  assert.ok(result.outcomes.includes("API_AND_CHAIN_PENDING_CONFLICT"));
});

test("chain change without any observed API publication", () => {
  const covered = correlate(apiSeries(0, 600, null, null), chainSeries(0, 600, 300));
  assert.deepEqual(covered.outcomes, ["CHAIN_CHANGED_WITHOUT_API_PREANNOUNCEMENT"]);
  // No API observation close before the chain change: no preannouncement claim can be made.
  const uncovered = correlate(apiSeries(0, 120, null, null), chainSeries(0, 600, 300));
  assert.deepEqual(uncovered.outcomes, ["INSUFFICIENT_API_COVERAGE"]);
});

test("correlation output is deterministic", () => {
  const run = () => timelineJson(correlate(apiSeries(0, 600, 60, PUBLISHED), chainSeries(0, 600, 300)));
  assert.equal(run(), run());
});
