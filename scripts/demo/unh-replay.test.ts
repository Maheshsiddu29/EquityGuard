/**
 * M10A: the hardened engine replayed against the UNH evidence.
 *
 * A second real multiplier event, found in the same sealed chain snapshot as
 * the KO event and independent of it: UNHon updated its multiplier on
 * 2026-09-14T00:04Z by the same immediate mechanism first seen on KOon. UNHx
 * did not move at all across the whole 27-hour window, while carrying a
 * scheduled-change shape whose activation is two days in the past.
 *
 * Every expectation here is derived from the captured bytes, not asserted
 * against a narrative.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ActivationPhase, checkGuardOffline } from "@equityguard/guard-client";
import {
  RepresentationState,
  StateSource,
  economicStateMismatches,
  economicStateOf,
  findRepresentationBySymbol,
  resolveOndoState,
  resolveXStocksState,
  type ChainEvidence,
  type EconomicState,
} from "@equityguard/representation-state";

import { decodeObservation, type CuratedObservation } from "./ko-fixtures.ts";
import { KO_DEMO_POLICY } from "./mainnet-replay.ts";

/** SHA-256 of the sealed chain snapshot every UNH observation comes from. */
const SEALED_CHAIN_SNAPSHOT_SHA256 = "f137feeda9b0340559f5a98cb7ec74fdd1741d515e5d231b3144f5a0f874eb06";

type UnhObservationKey =
  | "unhonPreEventLast"
  | "unhonPostEventFirst"
  | "unhxAtUnhonPreEvent"
  | "unhxAtUnhonPostEvent"
  | "unhonWindowEnd"
  | "unhxWindowEnd";

interface UnhFixture {
  readonly kind: string;
  readonly environment: string;
  readonly observations: Readonly<Record<UnhObservationKey, CuratedObservation>>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/unh-corporate-action-2026-09.json", import.meta.url), "utf8"),
) as UnhFixture;

const f64 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);

function decoded(key: UnhObservationKey) {
  const evidence: ChainEvidence = decodeObservation(fixture.observations[key]);
  assert.ok(evidence.kind === "decoded", `${key} did not decode`);
  return evidence;
}

function stateOf(key: UnhObservationKey): EconomicState {
  const state = economicStateOf(decoded(key));
  assert.ok(state, key);
  return state;
}

const UNHX = findRepresentationBySymbol("UNHx")!;
const UNHON = findRepresentationBySymbol("UNHon")!;

test("every UNH observation traces back to the sealed chain snapshot", () => {
  assert.equal(fixture.kind, "equityguard-curated-unh-corporate-action-2026-09");
  assert.equal(fixture.environment, "MAINNET_OBSERVATION");
  const keys = Object.keys(fixture.observations) as UnhObservationKey[];
  assert.equal(keys.length, 6);
  for (const key of keys) {
    const observation = fixture.observations[key];
    assert.equal(observation.sourceSha256, SEALED_CHAIN_SNAPSHOT_SHA256, key);
    assert.equal(observation.sourceFile, "2026-09-15T010424Z-equity-mints.jsonl", key);
    assert.equal(observation.owner, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", key);
    assert.ok(observation.lineNumber > 0 && observation.slot > 0 && observation.blockTime > 0, key);
    // The mint is the registry's, not a value the fixture asserts for itself.
    const expected = observation.symbol === "UNHx" ? UNHX.mint : UNHON.mint;
    assert.equal(observation.mint, expected, key);
  }
});

test("UNHon moved by the immediate mechanism: no pending phase, both sides activated", () => {
  const pre = decoded("unhonPreEventLast");
  const post = decoded("unhonPostEventFirst");

  // Before: multiplier == newMultiplier, so nothing was scheduled.
  assert.equal(pre.hasScheduledChange, false);
  assert.equal(f64(pre.protectedState.multiplier), 1.0186608863722362);
  assert.equal(f64(pre.protectedState.newMultiplier), 1.0186608863722362);
  assert.equal(pre.protectedState.newMultiplierEffectiveTimestamp, 1_788_344_044n);
  assert.equal(pre.phase, ActivationPhase.Activated);

  // After: all three fields moved together, and the new state is already activated.
  assert.equal(post.hasScheduledChange, false);
  assert.equal(f64(post.protectedState.multiplier), 1.023046908690707);
  assert.equal(f64(post.protectedState.newMultiplier), 1.023046908690707);
  assert.equal(post.protectedState.newMultiplierEffectiveTimestamp, 1_789_344_245n);
  assert.equal(post.phase, ActivationPhase.Activated);
  assert.equal(post.paused, false);

  // The stored activation time is slightly BEFORE the first observation of the
  // new state: the update was already effective when it became visible, which
  // is what "immediate" means here and why no pending phase can be observed.
  assert.ok(post.protectedState.newMultiplierEffectiveTimestamp < BigInt(fixture.observations.unhonPostEventFirst.blockTime));
  assert.equal(BigInt(fixture.observations.unhonPostEventFirst.blockTime) - post.protectedState.newMultiplierEffectiveTimestamp, 4n);

  // Same mechanism signature as KOon: the multiplier rose, and the two stored
  // multipliers stayed equal to each other throughout.
  assert.ok(f64(post.protectedState.multiplier) > f64(pre.protectedState.multiplier));
});

test("a UNHon payload built before the update is stale and the guard refuses it", () => {
  const built = stateOf("unhonPreEventLast");
  const atExecution = decoded("unhonPostEventFirst");
  // This is the whole product claim, on real bytes: the approved state is no
  // longer the state at execution.
  const result = checkGuardOffline(
    { expected: { multiplier: Uint8Array.from(Buffer.from(built.multiplierHex, "hex")), newMultiplier: Uint8Array.from(Buffer.from(built.newMultiplierHex, "hex")), newMultiplierEffectiveTimestamp: built.effectiveTimestamp }, expectedPhase: built.phase, window: { beforeSecs: 900, afterSecs: 300 } },
    atExecution.protectedState,
    BigInt(fixture.observations.unhonPostEventFirst.blockTime),
  );
  assert.equal(result, "MultiplierChanged");
  assert.deepEqual(
    economicStateMismatches(built, stateOf("unhonPostEventFirst")).map((m) => m.split(" ")[0]),
    ["multiplierHex", "newMultiplierHex", "effectiveTimestamp"],
  );
});

test("a UNHon payload built from the fresh post-update state passes immediately", () => {
  const fresh = stateOf("unhonPostEventFirst");
  const atExecution = decoded("unhonPostEventFirst");
  const result = checkGuardOffline(
    { expected: { multiplier: Uint8Array.from(Buffer.from(fresh.multiplierHex, "hex")), newMultiplier: Uint8Array.from(Buffer.from(fresh.newMultiplierHex, "hex")), newMultiplierEffectiveTimestamp: fresh.effectiveTimestamp }, expectedPhase: fresh.phase, window: { beforeSecs: 900, afterSecs: 300 } },
    atExecution.protectedState,
    BigInt(fixture.observations.unhonPostEventFirst.blockTime),
  );
  // 4 s after the stored effective timestamp, with no scheduled change: there
  // is no cooldown, because there is no window for an immediate update.
  assert.equal(result, null);

  const resolved = resolveOndoState(UNHON, { chain: decoded("unhonPostEventFirst"), api: null }, KO_DEMO_POLICY);
  assert.equal(resolved.state, RepresentationState.SAFE);
  assert.equal(resolved.stateSource, StateSource.CHAIN);
  assert.equal(resolved.reason, "no scheduled multiplier change");
});

test("UNHx did not move across the UNHon event, and stays SAFE with a long-past activation", () => {
  const before = decoded("unhxAtUnhonPreEvent");
  const after = decoded("unhxAtUnhonPostEvent");
  const end = decoded("unhxWindowEnd");

  // Byte-identical across the other issuer's event and to the end of the capture.
  for (const later of [after, end]) {
    assert.deepEqual(economicStateMismatches(economicStateOf(before)!, economicStateOf(later)!), []);
  }

  // xStocks keeps the previous multiplier in `multiplier` and the current one
  // in `newMultiplier`, so hasScheduledChange stays true long after T.
  assert.equal(before.hasScheduledChange, true);
  assert.equal(f64(before.protectedState.multiplier), 1.0229655423325776);
  assert.equal(f64(before.protectedState.newMultiplier), 1.0273478685368111);
  assert.equal(before.protectedState.newMultiplierEffectiveTimestamp, 1_789_173_000n);
  assert.equal(before.phase, ActivationPhase.Activated);

  // T is about two days before the observation, so the window is long gone.
  const ageSecs = BigInt(fixture.observations.unhxAtUnhonPreEvent.blockTime) - before.protectedState.newMultiplierEffectiveTimestamp;
  assert.ok(ageSecs > 171_000n, `activation was only ${ageSecs}s before the observation`);
  assert.ok(ageSecs > KO_DEMO_POLICY.afterSecs);

  const resolved = resolveXStocksState(UNHX, before, KO_DEMO_POLICY);
  assert.equal(resolved.state, RepresentationState.SAFE);
  assert.equal(resolved.stateSource, StateSource.CHAIN);
});

test("a UNHx payload built at the start of the capture still validates at the end", () => {
  // Nothing about UNH's own quiet 25 hours makes an xStocks payload stale:
  // staleness is a property of the bytes, not of elapsed time.
  const built = stateOf("unhxAtUnhonPreEvent");
  const atExecution = decoded("unhxWindowEnd");
  const result = checkGuardOffline(
    { expected: { multiplier: Uint8Array.from(Buffer.from(built.multiplierHex, "hex")), newMultiplier: Uint8Array.from(Buffer.from(built.newMultiplierHex, "hex")), newMultiplierEffectiveTimestamp: built.effectiveTimestamp }, expectedPhase: built.phase, window: { beforeSecs: 900, afterSecs: 300 } },
    atExecution.protectedState,
    BigInt(fixture.observations.unhxWindowEnd.blockTime),
  );
  assert.equal(result, null);
});

test("the two issuers' mechanisms differ on real data for the same underlying", () => {
  // Ondo: the two stored multipliers are always equal, so a change is only
  // ever visible after the fact.
  const unhon = decoded("unhonWindowEnd");
  assert.equal(unhon.hasScheduledChange, false);
  // xStocks: the two differ, so a scheduled change is announced in the bytes
  // before it takes effect.
  const unhx = decoded("unhxWindowEnd");
  assert.equal(unhx.hasScheduledChange, true);
  // Which means only the xStocks shape can ever produce a pending phase, and
  // only it needs a protection window.
  assert.equal(unhx.phase, ActivationPhase.Activated);
});
