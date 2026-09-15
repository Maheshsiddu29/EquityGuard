import type { AssertSafeExecutionRequest, ProtectionWindow } from "./abi.ts";
import type { GuardSnapshot } from "./snapshot.ts";

/**
 * The state expectation (phase from chain time) in `snapshot`, for an ABI v2
 * guard built with `buildGuardedTransferChecked`.
 */
export function expectationFromSnapshot(snapshot: GuardSnapshot, window: ProtectionWindow): AssertSafeExecutionRequest {
  return { expected: snapshot.state, expectedPhase: snapshot.phase, window };
}
