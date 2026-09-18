/**
 * M11-B historical replay, as a regression.
 *
 * The committed part replays the curated KO and UNH mainnet observations
 * (raw account bytes lifted from the sealed capture, each carrying its source
 * hash and line) through the same harness that replays the full capture. It
 * also proves the harness is not vacuous: a guard that ignores the clock is
 * caught as an UNEXPECTED ALLOW at the real KOx activation.
 *
 * The full sealed capture is local-only (`tmp/observation/`, never
 * committed). When it is present, its exact replay counts are pinned too;
 * when it is absent the test says so and skips rather than passing silently.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { bytesEqual, type EquityGuardErrorName } from "@equityguard/guard-client";

import { EXPECTED_TRANSITIONS, SEALED_CHAIN_SHA256, replayChain, type GuardPolicy } from "./market-replay.ts";
import { sha256Hex } from "../observation/capture-isolation.ts";

interface CuratedObservation {
  readonly sourceSha256: string;
  readonly wallclock: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly symbol: string;
  readonly issuer: string;
  readonly mint: string;
  readonly owner: string;
  readonly dataBase64: string;
}

const curated = (name: string) =>
  Object.values((JSON.parse(readFileSync(new URL(`../demo/fixtures/${name}`, import.meta.url), "utf8")) as { observations: Record<string, CuratedObservation> }).observations);

/** The curated observations regrouped into poll lines, one per slot, in slot order. */
function pollLines(observations: readonly CuratedObservation[]): string[] {
  const bySlot = new Map<number, CuratedObservation[]>();
  for (const o of observations) bySlot.set(o.slot, [...(bySlot.get(o.slot) ?? []).filter((x) => x.mint !== o.mint), o]);
  return [...bySlot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, list]) =>
      JSON.stringify({
        wallclock: list[0]?.wallclock,
        slot,
        blockTime: list[0]?.blockTime,
        accounts: list.map((o) => ({ symbol: o.symbol, issuer: o.issuer, address: o.mint, exists: true, owner: o.owner, data: o.dataBase64, encoding: "base64" })),
      }),
    );
}

const KO = curated("ko-corporate-action-2026-09.json");
const UNH = curated("unh-corporate-action-2026-09.json");
const LINES = pollLines([...KO, ...UNH]);
/** What the sparse curated sequence can show: consecutive curated observations per mint. */
const CURATED_TRANSITIONS = [
  { symbol: "UNHon", slot: 446835072n, type: "SCALED_UI_STATE_CHANGED" },
  { symbol: "KOon", slot: 447108571n, type: "SCALED_UI_STATE_CHANGED" },
  { symbol: "KOx", slot: 447113520n, type: "ACTIVATION_PHASE_CHANGED" },
];

test("the curated observations all come from the sealed capture or windows cut from it", () => {
  const sources = new Set([...KO, ...UNH].map((o) => o.sourceSha256));
  assert.ok(sources.has(SEALED_CHAIN_SHA256));
  assert.ok([...sources].every((s) => s === SEALED_CHAIN_SHA256 || s === "d364d627e7f816bfaec549add64c2ba97c680483c571d1f28aea7967aa215abe"), [...sources].join(", "));
});

test("replaying the curated KO and UNH history finds every transition and no unexpected verdict", () => {
  const { report } = replayChain(LINES, { expected: CURATED_TRANSITIONS });
  assert.equal(report.decodeFailures, 0);
  assert.equal(report.lineErrors, 0);
  assert.equal(report.decodeSuccesses, report.totalObservations);
  assert.equal(report.transitions.matched, CURATED_TRANSITIONS.length);
  assert.deepEqual(report.transitions.missed, []);
  assert.deepEqual(report.transitions.unexpected, []);

  const t = report.totals;
  assert.ok(t.evaluations > 0 && t.economicallyStale > 0, "the curated sequence must contain stale authorizations");
  assert.equal(t.staleBlocked, t.economicallyStale);
  assert.equal(t.unexpectedAllows, 0);
  assert.equal(t.unexpectedPolicyAllows, 0);
  assert.equal(t.unexpectedBlocks, 0);
  assert.equal(t.reasonDisagreements, 0);
});

test("each real event: the stale authorization is refused and a fresh one is not", () => {
  const { report } = replayChain(LINES, { expected: CURATED_TRANSITIONS });
  const verdicts = (symbol: string, type: string) =>
    (report.eventBoundaries as { symbol: string; type: string; verdicts: Record<string, { staleAuthorizationAgainstNewState: string; freshAuthorizationOnNewState: string }> }[]).find(
      (b) => b.symbol === symbol && b.type === type,
    )?.verdicts;
  // Immediate-style updates: stored bytes changed, no window involved.
  for (const symbol of ["UNHon", "KOon"]) {
    const v = verdicts(symbol, "SCALED_UI_STATE_CHANGED");
    assert.equal(v?.zero?.staleAuthorizationAgainstNewState, "MultiplierChanged", symbol);
    assert.equal(v?.zero?.freshAuthorizationOnNewState, "ok", symbol);
  }
  // The scheduled activation: bytes identical, the clock crossed T.
  const kox = verdicts("KOx", "ACTIVATION_PHASE_CHANGED");
  assert.equal(kox?.zero?.staleAuthorizationAgainstNewState, "ActivationPhaseChanged");
  assert.equal(kox?.zero?.freshAuthorizationOnNewState, "ok");
  assert.equal(kox?.["demo-900-300"]?.staleAuthorizationAgainstNewState, "InsideTransitionWindow");
});

test("KOx around T: the real pending bytes at T - 1, T and T + 1", () => {
  const { report } = replayChain(LINES, { expected: CURATED_TRANSITIONS });
  const [probe] = report.scheduledBoundaryProbes as {
    symbol: string;
    t: string;
    exactlyTObserved: boolean;
    protectedStateIdenticalAcrossT: boolean;
    pendingAuthorizationProbes: Record<string, Record<string, string>>;
  }[];
  assert.equal(probe?.symbol, "KOx");
  assert.equal(probe.t, "1789432200");
  // 30 s polling never landed on T itself; T is probed with the real bytes.
  assert.equal(probe.exactlyTObserved, false);
  assert.equal(probe.protectedStateIdenticalAcrossT, true);
  assert.deepEqual(probe.pendingAuthorizationProbes.zero, { "T-1": "ok", T: "InsideTransitionWindow", "T+1": "ActivationPhaseChanged" });
  assert.deepEqual(probe.pendingAuthorizationProbes["demo-900-300"], { "T-1": "InsideTransitionWindow", T: "InsideTransitionWindow", "T+1": "InsideTransitionWindow" });
});

test("the harness catches a guard that ignores the clock", () => {
  // Stored-field identity only: exactly the check that misses the KOx activation.
  const bytesOnly: GuardPolicy = (request, actual): EquityGuardErrorName | null => {
    if (!bytesEqual(actual.multiplier, request.expected.multiplier)) return "MultiplierChanged";
    if (!bytesEqual(actual.newMultiplier, request.expected.newMultiplier)) return "NewMultiplierChanged";
    if (actual.newMultiplierEffectiveTimestamp !== request.expected.newMultiplierEffectiveTimestamp) return "EffectiveTimestampChanged";
    return null;
  };
  const { report } = replayChain(LINES, { expected: CURATED_TRANSITIONS, guard: bytesOnly });
  assert.ok(report.totals.unexpectedAllows > 0);
  assert.ok(report.totals.examples.some((e) => e.startsWith("UNEXPECTED ALLOW: KOx")), report.totals.examples.join("\n"));
});

const SEALED = new URL("../../tmp/observation/2026-09-15T010424Z-equity-mints.jsonl", import.meta.url);

test("the full sealed capture replays with no unexpected verdict (local evidence)", { skip: existsSync(SEALED) ? false : "sealed capture f137… is local-only and not present" }, () => {
  const bytes = readFileSync(SEALED);
  assert.equal(sha256Hex(bytes), SEALED_CHAIN_SHA256);
  const lines = bytes.toString("utf8").split("\n").filter((l) => l !== "");
  const { report } = replayChain(lines);
  assert.equal(report.polls, 3311);
  assert.equal(report.totalObservations, 19_866);
  assert.equal(report.decodeFailures, 0);
  assert.equal(report.transitions.matched, EXPECTED_TRANSITIONS.length);
  assert.deepEqual(report.transitions.unexpected, []);
  assert.equal(report.totals.evaluations, 292_467);
  assert.equal(report.totals.economicallyStale, 6_745);
  assert.equal(report.totals.unexpectedAllows, 0);
  assert.equal(report.totals.unexpectedPolicyAllows, 0);
  assert.equal(report.totals.unexpectedBlocks, 0);
  assert.equal(report.totals.reasonDisagreements, 0);
});
