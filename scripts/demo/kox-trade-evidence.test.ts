import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ActivationPhase } from "@equityguard/guard-client";

import { expectationView, loadKoxTradeEvidence } from "./kox-trade-evidence.ts";

test("KOx replay evidence derives the clock-driven phase boundary", () => {
  const evidence = loadKoxTradeEvidence();
  assert.deepEqual([evidence.pre.expectation.expectedPhase, evidence.post.expectation.expectedPhase], [ActivationPhase.Pending, ActivationPhase.Activated]);
  assert.equal(evidence.pre.expectation.expected.newMultiplierEffectiveTimestamp, 1_789_432_200n);
  assert.deepEqual(expectationView(evidence.pre.expectation), {
    multiplierHex: "73833748164bf03f",
    newMultiplierHex: "df525701685cf03f",
    newMultiplierEffectiveTimestamp: "1789432200",
    expectedPhase: ActivationPhase.Pending,
    window: { beforeSecs: 0, afterSecs: 0 },
  });
  assert.equal(evidence.capture.sourceSha256, "f137feeda9b0340559f5a98cb7ec74fdd1741d515e5d231b3144f5a0f874eb06");
  assert.equal(evidence.capture.accountDataSha256, "3a5fdda06e4e678b6af829222021ea125a4b28e2c74d885d8e95cbcad8b6d876");
});

test("replay harness has no scenario selector and always runs stale before refreshed", () => {
  const source = readFileSync(new URL("../replay/execute-replay.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("--scenario"));
  assert.ok(source.indexOf('run("STALE"') < source.indexOf('run("REFRESHED"'));
});
