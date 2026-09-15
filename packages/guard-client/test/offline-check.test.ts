import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationPhase, checkGuardOffline, type AssertSafeExecutionRequest, type ProtectedState } from "../src/index.ts";

const f64 = (value: number) => new Uint8Array(new Float64Array([value]).buffer);
const T = 1_789_432_200n;
const WINDOW = { beforeSecs: 900, afterSecs: 300 };
const ZERO = { beforeSecs: 0, afterSecs: 0 };

const request = (expected: ProtectedState, expectedPhase: ActivationPhase, window = WINDOW): AssertSafeExecutionRequest => ({ expected, expectedPhase, window });

test("immediate update: a payload built from the old state fails MultiplierChanged; a fresh payload passes", () => {
  const before: ProtectedState = { multiplier: f64(1.01), newMultiplier: f64(1.01), newMultiplierEffectiveTimestamp: T - 10_000n };
  const after: ProtectedState = { multiplier: f64(1.02), newMultiplier: f64(1.02), newMultiplierEffectiveTimestamp: T };
  assert.equal(checkGuardOffline(request(before, ActivationPhase.Activated), after, T + 12n), "MultiplierChanged");
  // Unscheduled state ignores the clock, so a fresh payload passes immediately after the update.
  for (const now of [T, T + 1n, T + 12n]) assert.equal(checkGuardOffline(request(after, ActivationPhase.Activated), after, now), null);
});

test("stored-state checks run in program order", () => {
  const expected: ProtectedState = { multiplier: f64(1), newMultiplier: f64(2), newMultiplierEffectiveTimestamp: T };
  assert.equal(checkGuardOffline(request(expected, 0), { ...expected, newMultiplier: f64(3) }, 0n), "NewMultiplierChanged");
  assert.equal(checkGuardOffline(request(expected, 0), { ...expected, newMultiplierEffectiveTimestamp: T + 1n }, 0n), "EffectiveTimestampChanged");
});

test("scheduled update: same bytes, clock crosses T, stale phase fails", () => {
  const scheduled: ProtectedState = { multiplier: f64(1.0183317967386898), newMultiplier: f64(1.0225601246249238), newMultiplierEffectiveTimestamp: T };
  const pendingPayload = request(scheduled, ActivationPhase.Pending);
  assert.equal(checkGuardOffline(pendingPayload, scheduled, T - 901n), null);
  assert.equal(checkGuardOffline(pendingPayload, scheduled, T - 14n), "InsideTransitionWindow");
  assert.equal(checkGuardOffline(pendingPayload, scheduled, T + 301n), "ActivationPhaseChanged");
  assert.equal(checkGuardOffline(request(scheduled, ActivationPhase.Pending, ZERO), scheduled, T + 17n), "ActivationPhaseChanged");
  assert.equal(checkGuardOffline(request(scheduled, ActivationPhase.Activated, ZERO), scheduled, T + 17n), null);
});
