import assert from "node:assert/strict";
import { test } from "node:test";

import { findRepresentationBySymbol, type ChainEvidence } from "@equityguard/representation-state";

import { decodeObservation, loadKoFixture, loadLiquiditySnapshot, type ObservationKey } from "./ko-fixtures.ts";

const fixture = loadKoFixture();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const f64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);

function decoded(key: ObservationKey) {
  const evidence: ChainEvidence = decodeObservation(fixture.observations[key]);
  assert.ok(evidence.kind === "decoded", key);
  return evidence;
}

test("fixture sources are the frozen sealed evidence hashes", () => {
  assert.deepEqual(fixture.sources, {
    finalChainSnapshotSha256: "f137feeda9b0340559f5a98cb7ec74fdd1741d515e5d231b3144f5a0f874eb06",
    finalApiSnapshotSha256: "1f235714b4399bf192633cf20b6aaf5d9b91c79be3c819fe799f8f2691c3d241",
    finalEventWindowSha256: "d364d627e7f816bfaec549add64c2ba97c680483c571d1f28aea7967aa215abe",
  });
  for (const observation of Object.values(fixture.observations)) {
    assert.ok(Object.values(fixture.sources).includes(observation.sourceSha256));
    assert.equal(observation.mint, findRepresentationBySymbol(observation.symbol)?.mint);
  }
});

test("KOon pre- and post-event states reproduce the frozen report exactly", () => {
  const pre = decoded("koonPreEventLast");
  const post = decoded("koonPostEventFirst");
  assert.deepEqual([pre.decimals, f64(pre.protectedState.multiplier), f64(pre.protectedState.newMultiplier), pre.phase, pre.paused], [9, 1.0196453194004143, 1.0196453194004143, 1, false]);
  assert.equal(fixture.observations.koonPreEventLast.wallclock, "2026-09-15T00:03:47.385Z");
  assert.deepEqual(
    [post.decimals, f64(post.protectedState.multiplier), f64(post.protectedState.newMultiplier), post.protectedState.newMultiplierEffectiveTimestamp, post.hasScheduledChange, post.phase, post.paused],
    [9, 1.0238905041551842, 1.0238905041551842, 1789430644n, false, 1, false],
  );
  assert.deepEqual([fixture.observations.koonPostEventFirst.wallclock, fixture.observations.koonPostEventFirst.slot], ["2026-09-15T00:04:17.389Z", 447108571]);
  assert.equal(new Date(Number(post.protectedState.newMultiplierEffectiveTimestamp) * 1000).toISOString(), "2026-09-15T00:04:04.000Z");
});

test("KOx pending and post-T activated states reproduce the frozen report with identical bytes", () => {
  const first = decoded("koxPendingFirstObserved");
  const pending = decoded("koxLastPendingBeforeT");
  const activated = decoded("koxActivatedFirstObserved");
  assert.equal(fixture.observations.koxPendingFirstObserved.wallclock, "2026-09-14T20:26:16.355Z");
  for (const e of [first, pending, activated]) {
    assert.deepEqual(
      [e.decimals, f64(e.protectedState.multiplier), hex(e.protectedState.newMultiplier), e.protectedState.newMultiplierEffectiveTimestamp, e.paused],
      [8, 1.0183317967386898, "df525701685cf03f", 1789432200n, false],
    );
  }
  assert.deepEqual([first.phase, pending.phase, activated.phase], [0, 0, 1]);
  assert.deepEqual([fixture.observations.koxActivatedFirstObserved.wallclock, fixture.observations.koxActivatedFirstObserved.slot], ["2026-09-15T00:30:17.503Z", 447113520]);
  assert.equal(hex(pending.protectedState.multiplier), hex(activated.protectedState.multiplier));
});

test("KOx API pending line and cross-issuer timing reproduce the frozen report", () => {
  const api = JSON.parse(fixture.api.koxApiPendingFirstObserved.rawLine) as { wallclock: string; response: { newMultiplier: number; activationDateTime: number; reason: string } };
  assert.deepEqual([api.wallclock, api.response.newMultiplier, api.response.activationDateTime, api.response.reason], ["2026-09-14T20:26:53Z", 1.0225601246249238, 1789432200, "Dividend"]);
  const koxT = decoded("koxActivatedFirstObserved").protectedState.newMultiplierEffectiveTimestamp;
  const koonT = decoded("koonPostEventFirst").protectedState.newMultiplierEffectiveTimestamp;
  assert.equal(koxT - koonT, 25n * 60n + 56n);
});

test("liquidity snapshot records dynamic, point-in-time route availability", () => {
  const snapshot = loadLiquiditySnapshot();
  assert.equal(snapshot.inputRaw, "5000000");
  assert.deepEqual(
    Object.values(snapshot.quotes).map((q) => [q.symbol, q.route]).sort(),
    [["CRMon", "UNAVAILABLE"], ["CRMx", "AVAILABLE"], ["KOon", "UNAVAILABLE"], ["KOx", "AVAILABLE"], ["UNHon", "UNAVAILABLE"], ["UNHx", "AVAILABLE"]],
  );
  assert.equal(snapshot.quotes.KOon?.error, '{"error":"No routes found"}');
  assert.equal(snapshot.quotes.KOx?.outAmountRaw, "5450395");
  assert.ok(Object.values(snapshot.quotes).every((q) => typeof q.observedAt === "string" && q.observedAt.startsWith("2026-09-15T04:22")));
});
