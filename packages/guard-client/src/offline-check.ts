/**
 * Offline mirror of the program's execution-time policy
 * (`programs/equity_guard/src/guard.rs::check`), in the same order. It lets
 * replays of recorded state say which guard error a stale payload would hit
 * without submitting anything. It is not a substitute for the on-chain
 * guard; LiteSVM and devnet tests exercise the program itself.
 */

import { bytesEqual, hasScheduledChange, phaseAt, type AssertSafeExecutionRequest, type ProtectedState } from "./abi.ts";
import type { EquityGuardErrorName } from "./errors.ts";

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

export function checkGuardOffline(
  request: AssertSafeExecutionRequest,
  actual: ProtectedState,
  unixTimestamp: bigint,
): EquityGuardErrorName | null {
  const { expected } = request;
  // 1. Stored state: detects immediate updates.
  if (!bytesEqual(actual.multiplier, expected.multiplier)) return "MultiplierChanged";
  if (!bytesEqual(actual.newMultiplier, expected.newMultiplier)) return "NewMultiplierChanged";
  if (actual.newMultiplierEffectiveTimestamp !== expected.newMultiplierEffectiveTimestamp) return "EffectiveTimestampChanged";
  // 2. Clock: only a scheduled change makes crossing T economically relevant.
  if (!hasScheduledChange(actual)) return null;
  const t = actual.newMultiplierEffectiveTimestamp;
  const start = t - BigInt(request.window.beforeSecs);
  const end = t + BigInt(request.window.afterSecs);
  if (start < I64_MIN || end > I64_MAX) return "ArithmeticOverflow";
  if (start <= unixTimestamp && unixTimestamp <= end) {
    return "InsideTransitionWindow";
  }
  if (phaseAt(actual, unixTimestamp) !== request.expectedPhase) return "ActivationPhaseChanged";
  return null;
}
