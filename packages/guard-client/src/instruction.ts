import { AccountRole, type Address, type Instruction } from "@solana/kit";

import {
  encodeAssertSafeExecutionV1,
  type AssertSafeExecutionRequest,
  type ProtectionWindow,
} from "./abi.ts";
import type { GuardSnapshot } from "./snapshot.ts";

/**
 * Builds the `assert_safe_execution` instruction. The mint is passed
 * read-only; the program also accepts it writable so the guard can compose
 * with instructions that write-lock the mint.
 */
export function getAssertSafeExecutionInstruction(input: {
  readonly programAddress: Address;
  readonly mint: Address;
  readonly request: AssertSafeExecutionRequest;
}): Instruction {
  return {
    programAddress: input.programAddress,
    accounts: [{ address: input.mint, role: AccountRole.READONLY }],
    data: encodeAssertSafeExecutionV1(input.request),
  };
}

/** Request asserting exactly the state and chain-time phase in `snapshot`. */
export function requestFromSnapshot(
  snapshot: GuardSnapshot,
  window: ProtectionWindow,
): AssertSafeExecutionRequest {
  return { expected: snapshot.state, expectedPhase: snapshot.phase, window };
}
